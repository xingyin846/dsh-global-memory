// tools/patch.mjs — 把上游 meow-memory 的 lib/index.js 打成 global_memory 的 bundle。
//
// 用法：
//   node tools/patch.mjs                 # 用 lib/index.upstream.js 生成 lib/index.js
//   node tools/patch.mjs <上游 index.js>  # 升级上游后：先把新 bundle 存成 index.upstream.js 再跑
//
// 设计：所有改动都以「唯一锚点」定位，命中数 ≠ 1 直接报错退出，绝不静默写坏。
// 我们新增的代码只放在 tools/curator_block.js 与 tools/inject_body.js 两个文件里，
// 便于与上游 diff、也便于重放。
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const upstreamPath = process.argv[2] ? resolve(process.argv[2]) : join(root, "lib", "index.upstream.js");
const outPath = process.argv[3] ? resolve(process.argv[3]) : join(root, "lib", "index.js");

if (!existsSync(upstreamPath)) {
  console.error(`找不到上游 bundle: ${upstreamPath}`);
  process.exit(2);
}

const curatorBlock = readFileSync(join(here, "curator_block.js"), "utf8").trimEnd();
const injectBody = readFileSync(join(here, "inject_body.js"), "utf8").trimEnd();

let code = readFileSync(upstreamPath, "utf8");
const report = [];

function countOf(haystack, needle) {
  let n = 0;
  let i = 0;
  for (;;) {
    const p = haystack.indexOf(needle, i);
    if (p === -1) return n;
    n += 1;
    i = p + needle.length;
  }
}

/** 字符串替换：必须唯一命中。 */
function edit(name, find, replace) {
  const n = countOf(code, find);
  if (n !== 1) throw new Error(`[${name}] 锚点命中 ${n} 次（要求 1 次）:\n${find.slice(0, 160)}`);
  code = code.replace(find, replace);
  report.push(`${name}: ok`);
}

/** 区间替换：从 start 锚点切到 end 锚点（保留 end）。 */
function sliceEdit(name, start, end, replacement) {
  const a = code.indexOf(start);
  if (a === -1 || countOf(code, start) !== 1) throw new Error(`[${name}] start 锚点不唯一或缺失`);
  const b = code.indexOf(end, a + start.length);
  if (b === -1) throw new Error(`[${name}] end 锚点缺失`);
  code = code.slice(0, a) + replacement + code.slice(b);
  report.push(`${name}: ok`);
}

// ---------------------------------------------------------------------------
// 1) 共享库：memoryDbPath 优先返回配置的全局库路径
// ---------------------------------------------------------------------------
sliceEdit(
  "memoryDbPath",
  'function memoryDbPath(workspace, dir = ".dsh-meow") {',
  'var MemoryDb = class {',
  [
    'function memoryDbPath(workspace, dir = ".dsh-meow") {',
    '  if (typeof gmSharedDbPath === "string" && gmSharedDbPath.length > 0) return gmSharedDbPath;',
    '  return join3(workspace, dir, "memory.db");',
    '}',
    ''
  ].join("\n")
);

// ---------------------------------------------------------------------------
// 2) getDb：缓存键改成「真实库路径」，让所有工作区共用同一个连接/实例
// ---------------------------------------------------------------------------
sliceEdit(
  "getDb-cache-key",
  'function getDb(workspace, dir = ".dsh-meow") {',
  'function closeAllDbs() {',
  [
    'function getDb(workspace, dir = ".dsh-meow") {',
    '  const key = memoryDbPath(workspace, dir);',
    '  let db = dbCache.get(key);',
    '  if (!db) {',
    '    db = new MemoryDb(key);',
    '    dbCache.set(key, db);',
    '  }',
    '  return db;',
    '}',
    ''
  ].join("\n")
);

// ---------------------------------------------------------------------------
// 3) 首轮注入：user/rules 按 importance+更新时间排序后按字符上限截断；可关项目名列表；末尾加「记忆优先」
// ---------------------------------------------------------------------------
sliceEdit(
  "buildInjectionBody",
  'function buildInjectionBody(db, o) {',
  'function buildInjection(db, workspace, sessionId, _firstUserText = "", opts = {}, dir = ".dsh-meow") {',
  injectBody + "\n"
);

// ---------------------------------------------------------------------------
// 4) 配置 schema：dbPath / inject / forget
// ---------------------------------------------------------------------------
edit(
  "config-schema",
  [
    '  backup: z2.object({',
    '    enabled: z2.boolean().default(false)',
    '  }).default({}),'
  ].join("\n"),
  [
    '  backup: z2.object({',
    '    enabled: z2.boolean().default(false)',
    '  }).default({}),',
    '  /** 共享记忆库绝对路径（global_memory）：空 = 每个工作区各自 .dsh-meow/memory.db。',
    '   *  非空时所有工作区读写同一个库（跨工作区检索/写入天然互相可见）。 */',
    '  dbPath: z2.string().default(""),',
    '  /** 首轮注入收窄（global_memory）：只注 soul + user + 全局 rules + 项目名列表。',
    '   *  字符上限按 importance desc / updated_at desc 依次取，0 = 不限制。 */',
    '  inject: z2.object({',
    '    userMaxChars: z2.number().min(0).default(12000),',
    '    rulesMaxChars: z2.number().min(0).default(12000),',
    '    keepProjectList: z2.boolean().default(true),',
    '    preferLine: z2.boolean().default(true)',
    '  }).default({}),',
    '  /** 三层遗忘之存储面（global_memory）：默认 dry-run 预览；只归档不删除。 */',
    '  forget: z2.object({',
    '    enabled: z2.boolean().default(true),',
    '    mode: z2.string().default("dry-run"),',
    '    maxAgeDays: z2.number().min(1).default(180),',
    '    maxImportance: z2.number().min(1).default(2),',
    '    batchLimit: z2.number().min(1).max(200).default(50),',
    '    levels: z2.array(z2.string()).default(["fact", "lesson", "topic"]),',
    '    requireZeroHits: z2.boolean().default(true),',
    '    archiveDir: z2.string().default(""),',
    '    checkHours: z2.number().min(1).default(24)',
    '  }).default({}),'
  ].join("\n")
);

// ---------------------------------------------------------------------------
// 5) resolveConfig：给新配置兜默认值
// ---------------------------------------------------------------------------
edit(
  "resolveConfig-vars",
  '  const bk = c.backup ?? {};',
  ['  const bk = c.backup ?? {};', '  const ij = c.inject ?? {};', '  const fg = c.forget ?? {};'].join("\n")
);

edit(
  "resolveConfig-fields",
  ['    backup: {', '      enabled: bk.enabled ?? false', '    }', '  };'].join("\n"),
  [
    '    backup: {',
    '      enabled: bk.enabled ?? false',
    '    },',
    '    dbPath: typeof c.dbPath === "string" && c.dbPath.trim() ? resolve(c.dbPath.trim()) : "",',
    '    inject: {',
    '      userMaxChars: ij.userMaxChars ?? 12000,',
    '      rulesMaxChars: ij.rulesMaxChars ?? 12000,',
    '      keepProjectList: ij.keepProjectList ?? true,',
    '      preferLine: ij.preferLine ?? true',
    '    },',
    '    forget: {',
    '      enabled: fg.enabled ?? true,',
    '      mode: fg.mode === "apply" ? "apply" : "dry-run",',
    '      maxAgeDays: fg.maxAgeDays ?? 180,',
    '      maxImportance: fg.maxImportance ?? 2,',
    '      batchLimit: fg.batchLimit ?? 50,',
    '      levels: Array.isArray(fg.levels) ? fg.levels.map((x) => String(x)) : ["fact", "lesson", "topic"],',
    '      requireZeroHits: fg.requireZeroHits ?? true,',
    '      archiveDir: typeof fg.archiveDir === "string" ? fg.archiveDir.trim() : "",',
    '      checkHours: fg.checkHours ?? 24',
    '    }',
    '  };'
  ].join("\n")
);

// ---------------------------------------------------------------------------
// 7) 插件名
// ---------------------------------------------------------------------------
edit("plugin-name", 'var name = "meow-memory";', 'var name = "@xxmy/dsh-global-memory";');

// ---------------------------------------------------------------------------
// 7b) 设置命名空间：宿主按插件名注册 settings section（实测 ns 列表里出现 global_memory），
//     服务端读写层必须跟着改，否则设置页读到空层。
// ---------------------------------------------------------------------------
edit("settings-ns", 'var SETTINGS_NS = "meow-memory";', 'var SETTINGS_NS = "@xxmy/dsh-global-memory";');

// ---------------------------------------------------------------------------
// 7) apply：解析完配置后写入 gm 运行时（库路径/注入上限/遗忘配置）
// ---------------------------------------------------------------------------
edit(
  "setGmRuntime",
  '  setPromptLang(resolved.promptLang ?? "zh");',
  ['  setPromptLang(resolved.promptLang ?? "zh");', '  setGmRuntime(resolved);'].join("\n")
);

// ---------------------------------------------------------------------------
// 8) 注册 memory_forget 工具
// ---------------------------------------------------------------------------
edit(
  "register-forget-tool",
  ['function registerMemoryTools(register, dir = ".dsh-meow") {', '  register(rememberTool(dir));'].join("\n"),
  [
    'function registerMemoryTools(register, dir = ".dsh-meow") {',
    '  register(rememberTool(dir));'
  ].join("\n") + "\n" + '  register(forgetTool(dir));'
);

// ---------------------------------------------------------------------------
// 9) 遗忘定时器：挂到 dream 调度之后，并在 dispose 时清理
// ---------------------------------------------------------------------------
edit(
  "schedule-forget",
  '  const stopDream = scheduleDream(ctx, resolved.dream, resolved.projectDir, windowIndex, signalDreamState, workspaceDisabled);',
  [
    '  const stopDream = scheduleDream(ctx, resolved.dream, resolved.projectDir, windowIndex, signalDreamState, workspaceDisabled);',
    '  const stopForget = scheduleForget(ctx, resolved);'
  ].join("\n")
);

edit("dispose-forget", ['    stopDream();', '    disposeDreamHeartbeats();'].join("\n"), ['    stopForget();', '    stopDream();', '    disposeDreamHeartbeats();'].join("\n"));

// ---------------------------------------------------------------------------
// 10) 插入 gm 主体（共享库状态 + 注入收窄工具 + 遗忘 curator）
// ---------------------------------------------------------------------------
edit(
  "insert-curator-block",
  '// src/index.ts\nvar WELCOME_GUIDE_SEEN_ID = "__welcomeGuide__";',
  curatorBlock + '\n\n// src/index.ts\nvar WELCOME_GUIDE_SEEN_ID = "__welcomeGuide__";'
);

// ---------------------------------------------------------------------------
// 11) 导出测试/维护所需的内部符号
// ---------------------------------------------------------------------------
edit(
  "exports",
  ['  memoryDbPath,', '  mergeConfigLayer,'].join("\n"),
  ['  memoryDbPath,', '  buildInjectionBody,', '  gmCapRows,', '  gmForgetCandidates,', '  gmRunForget,', '  setGmRuntime,', '  gmStatusWeight,', '  setGmScope,', '  gmSetActor,', '  gmVisible,', '  gmRoomsOf,', '  mergeConfigLayer,'].join("\n")
);


// ---------------------------------------------------------------------------
// 10b) 检索状态面（2026-10-25 用户拍板）：stale 仍可检索但降权；archived 默认不检索
// ---------------------------------------------------------------------------
sliceEdit(
  "listSearchable-stale",
  "  /** 可检索条目：active 全部；project.subcategory='todo' 的 stale 视为 done 参与检索。",
  "  bumpHit(level, id) {",
  [
    '  /** 可检索条目：active 全部 + 所有 stale（已完成/阶段性任务）。',
    '   *  用户拍板 2026-10-25：已标完成的记忆还能检索、但不优先；archived 默认不检索，',
    '   *  只有显式传 status: "archived" 或 "all" 时才查（用户特别要求找被删的记忆时）。 */',
    '  listSearchable(level) {',
    '    const active2 = this.list(level, { status: "active" });',
    '    const stale2 = this.list(level, { status: "stale" });',
    '    return [...active2, ...stale2];',
    '  }',
    ''
  ].join("\n")
);

edit(
  "gm-status-weight",
  "function search(query, docs, opts = {}) {",
  [
    'function gmStatusWeight(doc) {',
    '  return doc && doc.status === "stale" ? 0.4 : 1;',
    '}',
    'function search(query, docs, opts = {}) {'
  ].join("\n")
);

edit("search-stale-weight", "      score: raw[di] * w,", "      score: raw[di] * w * gmStatusWeight(docs[di]),");

sliceEdit(
  "docs-with-status",
  "      const docs = filtered.map((r) => ({",
  "      const ranked = search(query, docs, { k: docs.length, explain });",
  [
    '      const docs = filtered.map((r) => ({',
    '        id: r.id,',
    '        level: r.level,',
    '        title: r.title,',
    '        content: r.content,',
    '        keywords: r.keywords,',
    '        importance: r.importance,',
    '        created_at: r.created_at,',
    '        updated_at: r.updated_at,',
    '        status: r.status',
    '      }));',
    ''
  ].join("\n")
);


// ---------------------------------------------------------------------------
// 10c) 初阶审计与版本表（2026-10-25）：memory_rev 记录每次 insert/update 的前后整行
//      白名单会话只用于「标记留痕」，不做拦截（进阶 scope 房间后续再做）
// ---------------------------------------------------------------------------
edit(
  "audit-schema",
  ['    checkHours: z2.number().min(1).default(24)', '  }).default({}),'].join("\n"),
  [
    '    checkHours: z2.number().min(1).default(24)',
    '  }).default({}),',
    '  /** 审计/版本表（global_memory 初阶）：记录每次改动的前后整行，白名单会话只做标记。 */',
    '  audit: z2.object({',
    '    enabled: z2.boolean().default(true),',
    '    whitelist: z2.array(z2.string()).default([]),',
    '    keepPerId: z2.number().min(1).default(20),',
    '    keepDays: z2.number().min(1).default(90)',

    '  }).default({}),'
  ].join("\n")
);

edit(
  "audit-resolve",
  ['      checkHours: fg.checkHours ?? 24', '    }', '  };'].join("\n"),
  [
    '      checkHours: fg.checkHours ?? 24',
    '    },',
    '    audit: {',
    '      enabled: (c.audit ?? {}).enabled !== false,',
    '      whitelist: Array.isArray((c.audit ?? {}).whitelist) ? (c.audit.whitelist).map((x) => String(x)) : [],',
    '      keepPerId: Number((c.audit ?? {}).keepPerId ?? 20),',
    '      keepDays: Number((c.audit ?? {}).keepDays ?? 90)',

    '    }',
    '  };'
  ].join("\n")
);

edit(
  "audit-session",
  "function sessionIdOf(exec) {",
  [
    '// 每次工具调用先标记「谁在动记忆」，供 memory_rev 的 actor / actor_wl 使用',
    'var gmOrigSessionIdOf = sessionIdOf;',
    'sessionIdOf = function (exec) {',
    '  const gmId = gmOrigSessionIdOf(exec);',
    '  try {',
    '    gmSetActor(gmId);',
    '  } catch {',
    '  }',
    '  return gmId;',
    '};',
    'function sessionIdOf(exec) {'
  ].join("\n")
);

edit("audit-apply", '  setGmRuntime(resolved);', ['  setGmRuntime(resolved);', '  setGmAudit(resolved.audit);'].join("\n"));

edit(
  "audit-hooks",
  "function closeAllDbs() {",
  [
    '// ---- global_memory 初阶审计：memory_rev 记录前后整行 ----',
    'var gmAudit = { enabled: true, whitelist: [], keepPerId: 20, keepDays: 90 };',
    'var gmCtx = { actor: "unknown", wl: 0 };',
    'function setGmAudit(cfg) {',
    '  if (!cfg) return;',
    '  gmAudit = { enabled: cfg.enabled !== false, whitelist: Array.isArray(cfg.whitelist) ? cfg.whitelist.map(String) : [], keepPerId: Number(cfg.keepPerId ?? 20), keepDays: Number(cfg.keepDays ?? 90) };',
    '}',
    'function gmSetActor(sessionId) {',
    '  const sid = typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null;',
    '  gmCtx = { actor: sid !== null ? "session:" + sid : "unknown", wl: sid !== null && gmAudit.whitelist.includes(sid) ? 1 : 0 };',
    '}',
    'var gmRevReady = /* @__PURE__ */ new WeakSet();',
    'var gmRevWrites = 0;',
    'function gmPruneRev(db, id) {',
    '  gmRevWrites += 1;',
    '  // 每次写入都裁剪本 id（便宜）；全表按天清理每 20 次做一次',
    '  try {',
    '    const keep = Math.max(1, Number(gmAudit.keepPerId ?? 20));',
    '    const days = Math.max(1, Number(gmAudit.keepDays ?? 90));',
    '    if (id) db.prepare("DELETE FROM memory_rev WHERE id = ? AND rev NOT IN (SELECT rev FROM memory_rev WHERE id = ? ORDER BY rev DESC LIMIT " + keep + ")").run(id, id);',
    '    if (gmRevWrites % 20 === 0) db.prepare("DELETE FROM memory_rev WHERE at < ?").run(Date.now() - days * 86400000);',
    '  } catch {',
    '  }',
    '}',
    'function gmRecordRev(db, level, id, action, before, after) {',
    '  if (gmAudit.enabled === false || !db) return;',
    '  try {',
    '    if (!gmRevReady.has(db)) {',
    '      db.exec("CREATE TABLE IF NOT EXISTS memory_rev (rev INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT NOT NULL, id TEXT NOT NULL, action TEXT NOT NULL, before TEXT, after TEXT, actor TEXT, actor_wl INTEGER, at INTEGER NOT NULL)");',
    '      gmRevReady.add(db);',
    '    }',
    '    db.prepare("INSERT INTO memory_rev (level,id,action,before,after,actor,actor_wl,at) VALUES (?,?,?,?,?,?,?,?)").run(',
    '      String(level), String(id), String(action), before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, gmCtx.actor, gmCtx.wl, Date.now());',
    '    gmPruneRev(db, id);',

    '  } catch {',
    '  }',
    '}',
    'const gmOrigInsert = MemoryDb.prototype.insert;',
    'MemoryDb.prototype.insert = function (row) {',
    '  const out = gmOrigInsert.call(this, row);',
    '  try {',
    '    const id = (out && out.id) || (row && row.id) || null;',
    '    if (id !== null) {',
    '      const f = this.findById(id);',
    '      gmRecordRev(this.db, (row && row.level) || "?", id, "insert", null, f ? f.row : null);',
    '    }',
    '  } catch {',
    '  }',
    '  return out;',
    '};',
    'const gmOrigUpdate = MemoryDb.prototype.update;',
    'MemoryDb.prototype.update = function (level, id, patch) {',
    '  let before = null;',
    '  try {',
    '    const f0 = this.findById(id);',
    '    before = f0 ? f0.row : null;',
    '  } catch {',
    '  }',
    '  const changed = gmOrigUpdate.call(this, level, id, patch);',
    '  try {',
    '    if (changed) {',
    '      const f1 = this.findById(before ? before.id : id);',
    '      gmRecordRev(this.db, level, f1 ? f1.row.id : id, "update", before, f1 ? f1.row : null);',
    '    }',
    '  } catch {',
    '  }',
    '  return changed;',
    '};',
    'function closeAllDbs() {'
  ].join("\n")
);


// ---------------------------------------------------------------------------
// 10d) 高阶：房间 scope（2026-10-25 拍板：白名单会话；无权=可见存在 + 弹窗索权）
// ---------------------------------------------------------------------------
edit(
  "scope-schema",
  ['    keepDays: z2.number().min(1).default(90)', '  }).default({}),'].join("\n"),
  [
    '    keepDays: z2.number().min(1).default(90)',
    '  }).default({}),',
    '  /** 房间（高阶）：记忆 scope=global 或 room:<名字>；rooms 值是逗号分隔的会话 id。 */',
    '  scope: z2.object({',
    '    enabled: z2.boolean().default(false),',
    '    owner: z2.array(z2.string()).default([]),',
    '    rooms: z2.dict(z2.string()).default({}),',
    '    failMode: z2.string().default("closed"),',
    '    grantMinutes: z2.number().min(1).default(30)',
    '  }).default({}),'
  ].join("\n")
);

edit(
  "scope-resolve",
  ['      keepDays: Number((c.audit ?? {}).keepDays ?? 90)', '    }', '  };'].join("\n"),
  [
    '      keepDays: Number((c.audit ?? {}).keepDays ?? 90)',
    '    },',
    '    scope: {',
    '      enabled: (c.scope ?? {}).enabled === true,',
    '      owner: Array.isArray((c.scope ?? {}).owner) ? (c.scope.owner).map((x) => String(x)) : [],',
    '      rooms: (c.scope ?? {}).rooms && typeof (c.scope ?? {}).rooms === "object" ? (c.scope.rooms) : {},',
    '      failMode: (c.scope ?? {}).failMode === "open" ? "open" : "closed",',
    '      grantMinutes: Number((c.scope ?? {}).grantMinutes ?? 30)',
    '    }',
    '  };'
  ].join("\n")
);

edit("scope-apply", '  setGmAudit(resolved.audit);', ['  setGmAudit(resolved.audit);', '  setGmScope(resolved.scope);'].join("\n"));

edit(
  "scope-runtime",
  "function closeAllDbs() {",
  [
    '// ---- 高阶：房间可见性（白名单会话 + 弹窗索权） ----',
    'var gmScope = { enabled: false, owner: [], rooms: {}, failMode: "closed", grantMinutes: 30 };',
    'var gmOrigSetActor = gmSetActor;',
    'gmSetActor = function (sessionId) {',
    '  gmOrigSetActor(sessionId);',
    '  gmCtx.sid = typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null;',
    '  gmCtx.prompted = false;',
    '  gmCtx.lastDenied = null;',
    '};',
    'function setGmScope(cfg) {',
    '  if (!cfg) return;',
    '  gmScope = {',
    '    enabled: cfg.enabled === true,',
    '    owner: Array.isArray(cfg.owner) ? cfg.owner.map(String) : [],',
    '    rooms: cfg.rooms && typeof cfg.rooms === "object" ? cfg.rooms : {},',
    '    failMode: cfg.failMode === "open" ? "open" : "closed",',
    '    grantMinutes: Number(cfg.grantMinutes ?? 30)',
    '  };',
    '}',
    'function gmRoomsOf(sid) {',
    '  if (!sid) return [];',
    '  const out = [];',
    '  for (const k of Object.keys(gmScope.rooms)) {',
    '    const ids = String(gmScope.rooms[k] ?? "").split(",").map((s) => s.trim()).filter(Boolean);',
    '    if (ids.indexOf(sid) !== -1) out.push(k);',
    '  }',
    '  return out;',
    '}',
    'function gmIsOwner(sid) { return typeof sid === "string" && sid.length > 0 && gmScope.owner.indexOf(sid) !== -1; }',
    'function gmScopesOf(row) {',
    '  const raw = row && typeof row.scope === "string" ? row.scope.trim() : "";',
    '  if (raw === "" || raw === "global") return [];',
    '  return raw.split(",").map((s) => s.trim()).filter(Boolean).map((s) => (s.indexOf("room:") === 0 ? s.slice(5) : s));',
    '}',
    'var gmGrantReady = /* @__PURE__ */ new WeakSet();',
    'function gmGrants(db, sid) {',
    '  if (!db || !sid) return [];',
    '  try {',
    '    if (!gmGrantReady.has(db)) {',
    '      db.exec("CREATE TABLE IF NOT EXISTS scope_grant (session_id TEXT NOT NULL, room TEXT NOT NULL, granted_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, granted_by TEXT, PRIMARY KEY (session_id, room))");',
    '      gmGrantReady.add(db);',
    '    }',
    '    return db.prepare("SELECT room FROM scope_grant WHERE session_id = ? AND expires_at > ?").all(sid, Date.now()).map((r) => r.room);',
    '  } catch {',
    '    return [];',
    '  }',
    '}',
    'function gmAddGrant(db, sid, room) {',
    '  try {',
    '    gmGrants(db, sid);',
    '    const now = Date.now();',
    '    db.prepare("INSERT OR REPLACE INTO scope_grant (session_id, room, granted_at, expires_at, granted_by) VALUES (?,?,?,?,?)").run(sid, room, now, now + gmScope.grantMinutes * 6e4, "user-dialog");',
    '  } catch {',
    '  }',
    '}',
    '// ---- 房间元数据：过期时间 / 读写权限 / 成员表 ----',
    'var gmRoomReady = /* @__PURE__ */ new WeakSet();',
    'function gmEnsureRoomTables(db) {',
    '  if (!db || gmRoomReady.has(db)) return;',
    '  try {',
    '    db.exec("CREATE TABLE IF NOT EXISTS scope_room (name TEXT PRIMARY KEY, expires_at INTEGER, can_read INTEGER NOT NULL DEFAULT 1, can_write INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, note TEXT)");',
    '    db.exec("CREATE TABLE IF NOT EXISTS scope_member (room TEXT NOT NULL, session_id TEXT NOT NULL, added_at INTEGER NOT NULL, can_read INTEGER, can_write INTEGER, parent_session TEXT, PRIMARY KEY (room, session_id))");',
    '    try {',
    '      const gmMC = db.prepare("PRAGMA table_info(scope_member)").all().map((c) => c.name);',
    '      for (const [c, t] of [["can_read", "INTEGER"], ["can_write", "INTEGER"], ["parent_session", "TEXT"]]) {',
    '        if (gmMC.indexOf(c) === -1) db.exec("ALTER TABLE scope_member ADD COLUMN " + c + " " + t);',
    '      }',
    '    } catch {',
    '    }',

    '  } catch {',
    '  }',
    '  gmRoomReady.add(db);',
    '}',
    'function gmRoomMeta(db, name) {',
    '  let row = null;',
    '  const cfgIds = String(gmScope.rooms[name] ?? "").split(",").map((x) => x.trim()).filter(Boolean);',
    '  let members = cfgIds.slice();',
    '  const memberPerm = {};',
    '  try {',
    '    gmEnsureRoomTables(db);',
    '    row = db.prepare("SELECT * FROM scope_room WHERE name = ?").get(name);',
    '    for (const r of db.prepare("SELECT session_id, can_read, can_write FROM scope_member WHERE room = ?").all(name)) {',
    '      members.push(r.session_id);',
    '      memberPerm[r.session_id] = { read: r.can_read == null ? null : r.can_read !== 0, write: r.can_write == null ? null : r.can_write !== 0 };',
    '    }',
    '  } catch {',
    '  }',
    '  const meta = row ? { expires_at: row.expires_at, can_read: row.can_read !== 0, can_write: row.can_write !== 0 } : { expires_at: null, can_read: true, can_write: true };',
    '  meta.members = members;',
    '  meta.memberPerm = memberPerm;',
    '  meta.expired = meta.expires_at != null && Date.now() > Number(meta.expires_at);',
    '  return meta;',
    '}',
    'function gmActiveRooms(db, sid, mode) {',
    '  const names = new Set(Object.keys(gmScope.rooms));',
    '  try {',
    '    gmEnsureRoomTables(db);',
    '    for (const r of db.prepare("SELECT name FROM scope_room").all()) names.add(r.name);',
    '  } catch {',
    '  }',
    '  const out = [];',
    '  for (const name of names) {',
    '    const m = gmRoomMeta(db, name);',
    '    if (m.expired) continue;',
    '    if (!sid || m.members.indexOf(sid) === -1) continue;',
    '    const mp = m.memberPerm && m.memberPerm[sid] ? m.memberPerm[sid] : null;',
    '    const canRead = mp && mp.read !== null ? mp.read : m.can_read === true;',
    '    const canWrite = mp && mp.write !== null ? mp.write : m.can_write === true;',
    '    if (mode === "write" && canWrite !== true) continue;',
    '    if (mode === "read" && canRead !== true) continue;',
    '    out.push(name);',
    '  }',
    '  return out;',
    '}',
    'function gmNeedRooms(db, row, sid) {',
    '  const need = gmScopesOf(row);',
    '  if (need.length === 0) return [];',
    '  if (gmIsOwner(sid)) return [];',
    '  const mine = gmActiveRooms(db, sid, "read").concat(gmGrants(db, sid));',
    '  return need.filter((r) => mine.indexOf(r) === -1);',
    '}',
    'function gmDialogGrant(room, sid, sample) {',
    '  // 2026-10-25 用户拍板：不再弹系统窗，改为在对话里向用户提问（agent 用 ask_user_question）',
    '  return false;',
    '  // eslint-disable-next-line no-unreachable',
    '  try {',
    '    const req = createRequire(import.meta.url);',
    '    const cp = req("node:child_process");',
    '    const who = String(sid ?? "unknown").slice(0, 30);',
    '    const body = "记忆插件请求授权\\n\\n房间: " + room + "\\n会话: " + who + "\\n条目: " + String(sample ?? "").slice(0, 40) + "\\n\\n允许这个会话访问该房间的记忆吗？（允许 = " + gmScope.grantMinutes + " 分钟内有效）";',
    '    const ps = "Add-Type -AssemblyName System.Windows.Forms;" + "$r=[System.Windows.Forms.MessageBox]::Show(" + JSON.stringify(body) + ", \'global_memory 权限请求\', \'YesNo\', \'Question\', \'Button2\'); if ($r -eq \'Yes\') { exit 0 } else { exit 1 }";',
    '    cp.execFileSync("powershell", ["-NoProfile", "-Command", ps], { timeout: 60000, windowsHide: true });',
    '    return true;',
    '  } catch {',
    '    return false;',
    '  }',
    '}',
    'function gmVisible(db, row, sid, injectOnly) {',
    '  if (!gmScope.enabled) return true;',
    '  const need = gmScopesOf(row);',
    '  if (need.length === 0) return true;',
    '  if (injectOnly === true) return false;',
    '  if (gmIsOwner(sid)) return true;',
    '  const gmMine = gmActiveRooms(db, sid, "read").concat(gmGrants(db, sid));',
    '  return need.some((r) => gmMine.indexOf(r) !== -1);',
    '}',
    'var gmOrigList = MemoryDb.prototype.list;',
    'MemoryDb.prototype.list = function (level, opts = {}) {',
    '  const rows = gmOrigList.call(this, level, opts);',
    '  if (!gmScope.enabled || opts.includeHidden === true) return rows;',
    '  return rows.filter((r) => gmVisible(this.db, r, gmCtx.sid, gmCtx.injectOnly === true));',
    '};',
    'var gmOrigFindById = MemoryDb.prototype.findById;',
    'MemoryDb.prototype.findById = function (id) {',
    '  const hit = gmOrigFindById.call(this, id);',
    '  if (!hit || !gmScope.enabled) return hit;',
    '  if (gmVisible(this.db, hit.row, gmCtx.sid, false)) return hit;',
    '  const miss = gmNeedRooms(this.db, hit.row, gmCtx.sid);',
    '  const room = miss.length > 0 ? miss[0] : null;',
    '  if (room && gmCtx.injectOnly !== true && gmCtx.prompted !== true) {',
    '    gmCtx.prompted = true;',
    '    if (gmDialogGrant(room, gmCtx.sid, hit.row.content)) {',
    '      gmAddGrant(this.db, gmCtx.sid, room);',
    '      if (gmVisible(this.db, hit.row, gmCtx.sid, false)) return hit;',
    '    }',
    '  }',
    '  gmCtx.lastDenied = { level: hit.level, id: hit.row.id, room };',
    '  return void 0;',
    '};',
    'var gmOrigFindByIdAll = MemoryDb.prototype.findByIdAll;',
    'MemoryDb.prototype.findByIdAll = function (id) {',
    '  const hits = gmOrigFindByIdAll.call(this, id);',
    '  if (!gmScope.enabled) return hits;',
    '  return hits.filter((h) => gmVisible(this.db, h.row, gmCtx.sid, false));',
    '};',
    'var gmOrigBuildInjectionBody = buildInjectionBody;',
    'buildInjectionBody = function (db, o) {',
    '  const prev = gmCtx.injectOnly;',
    '  gmCtx.injectOnly = true;',
    '  try { return gmOrigBuildInjectionBody(db, o); } finally { gmCtx.injectOnly = prev; }',
    '};',
    'var gmOrigHitQuery = hitQuery;',
    'hitQuery = function (db, workspace, sessionId, userText, o, dir) {',
    '  const prev = gmCtx.injectOnly;',
    '  gmCtx.injectOnly = true;',
    '  try { return gmOrigHitQuery(db, workspace, sessionId, userText, o, dir); } finally { gmCtx.injectOnly = prev; }',
    '};',
    'var gmOrigInsertScoped = MemoryDb.prototype.insert;',
    'MemoryDb.prototype.insert = function (row) {',
    '  if (gmScope.enabled && row) {',
    '    const want = typeof row.scope === "string" ? row.scope.trim() : "";',
    '    if (want === "") {',
    '      const mine = gmActiveRooms(this.db, gmCtx.sid, "write");',
    '      row = Object.assign({}, row, { scope: mine.length > 0 ? "room:" + mine[0] : "global" });',
    '    } else if (want !== "global") {',
    '      const need = want.split(",").map((s) => s.trim()).filter(Boolean).map((s) => (s.indexOf("room:") === 0 ? s.slice(5) : s));',
    '      const mine = gmActiveRooms(this.db, gmCtx.sid, "write");',
    '      const bad = need.filter((r) => mine.indexOf(r) === -1);',
    '      if (!gmIsOwner(gmCtx.sid) && bad.length > 0) throw new Error("scope 拒绝：当前会话不在房间 " + bad.join(",") + " 里");',
    '    }',
    '  }',
    '  gmEnsureScopeColumns(this.db);',
    '  const gmOut = gmOrigInsertScoped.call(this, row);',
    '  try {',
    '    const gmId = (gmOut && gmOut.id) || (row && row.id);',
    '    if (gmId && row && typeof row.scope === "string" && row.scope.trim() !== "") this.db.prepare("UPDATE " + row.level + " SET scope = ? WHERE id = ?").run(row.scope.trim(), gmId);',
    '  } catch {',
    '  }',
    '  return gmOut;',
    '};',
    'var gmOrigUpdateScoped = MemoryDb.prototype.update;',
    'MemoryDb.prototype.update = function (level, id, patch) {',
    '  if (gmScope.enabled && typeof id === "string" && id.length > 0) {',
    '    try {',
    '      const raw = this.db.prepare("SELECT scope FROM " + level + " WHERE id LIKE ?").get(id + "%");',
    '      if (raw && !gmVisible(this.db, { scope: raw.scope }, gmCtx.sid, false)) {',
    '        throw new Error("scope 拒绝：当前会话无权修改该条目（" + String(raw.scope) + "）");',
    '      }',
    '      if (raw && !gmIsOwner(gmCtx.sid)) {',
    '        const gmNeedW = gmScopesOf({ scope: raw.scope });',
    '        const gmWritable = gmActiveRooms(this.db, gmCtx.sid, "write");',
    '        if (gmNeedW.length > 0 && !gmNeedW.some((r) => gmWritable.indexOf(r) !== -1)) throw new Error("scope 拒绝：该房间只读（" + String(raw.scope) + "）");',
    '      }',
    '    } catch (e) {',
    '      if (e && String(e.message).indexOf("scope 拒绝") === 0) throw e;',
    '    }',
    '  }',
    '  return gmOrigUpdateScoped.call(this, level, id, patch);',
    '};',
    'function closeAllDbs() {'
  ].join("\n")
);

// ---------------------------------------------------------------------------
// 10e) 房间：scope 列（幂等迁移）+ 读写带上 scope（2026-10-25）
// ---------------------------------------------------------------------------
edit(
  "scope-fromrow",
  ['      last_accessed_at: r.last_accessed_at == null ? null : Number(r.last_accessed_at)', '    };'].join("\n"),
  [
    '      last_accessed_at: r.last_accessed_at == null ? null : Number(r.last_accessed_at),',
    '      scope: r.scope == null || r.scope === "" ? "global" : String(r.scope)',
    '    };'
  ].join("\n")
);

edit(
  "scope-migrate",
  "var gmGrantReady = /* @__PURE__ */ new WeakSet();",
  [
    'var gmGrantReady = /* @__PURE__ */ new WeakSet();',
    'var gmScopeColReady = /* @__PURE__ */ new WeakSet();',
    'function gmEnsureScopeColumns(db) {',
    '  if (!db || gmScopeColReady.has(db)) return;',
    '  for (const lv of LEVELS) {',
    '    try {',
    '      const cols = db.prepare("PRAGMA table_info(" + lv + ")").all().map((c) => c.name);',
    '      if (cols.indexOf("scope") === -1) db.exec("ALTER TABLE " + lv + " ADD COLUMN scope TEXT NOT NULL DEFAULT " + JSON.stringify("global"));',
    '    } catch {',
    '    }',
    '  }',
    '  gmScopeColReady.add(db);',
    '}'
  ].join("\n")
);


// ---------------------------------------------------------------------------
// 10f) 修：id 迁移误改写自定义 id（2026-10-25 行消失的根因）
//     原条件只放过「9 位字母数字 + 连字符」，其它 id 一律被静默改写成新 id。
// ---------------------------------------------------------------------------
edit(
  "rekey-condition",
  '        if (/^[0-9a-z]{9}-/.test(id)) continue;',
  [
    '        const gmLegacyId = /^[0-9]{10,}$/.test(id) || /^[0-9a-f]{8}$/.test(id);',
    '        if (!gmLegacyId) continue;',
    '        if (/^[0-9a-z]{9}-/.test(id)) continue;'
  ].join("\n")
);

writeFileSync(outPath, code, "utf8");
console.log(`patched: ${upstreamPath}\n     -> ${outPath} (${code.length} bytes)`);
for (const line of report) console.log("  " + line);

// ---------------------------------------------------------------------------
// 12) 客户端 bundle：只改「设置命名空间」四处（i18n NS 与消息来源标记保持 meow-memory，
//     以免折叠横条与界面字典失配）。
// ---------------------------------------------------------------------------
const clientUpstream = join(root, "lib", "client.upstream.js");
if (existsSync(clientUpstream)) {
  const clientOut = join(root, "lib", "client.js");
  let client = readFileSync(clientUpstream, "utf8");
  const clientEdits = [
    // 客户端插件 id 必须 = 包名（宿主按包名等它注册；实测 @linxin666/dsh-pet 的 client id 就是包名）
    ['window.__ModuleLoader__.load({\n  id: "meow-memory",', 'window.__ModuleLoader__.load({\n  id: "@xxmy/dsh-global-memory",'],
    ['var NS = "meow-memory";', 'var NS = "@xxmy/dsh-global-memory";'],
    ['var SETTINGS_NS = "meow-memory";', 'var SETTINGS_NS = "@xxmy/dsh-global-memory";'],
    ['row?.ns === "meow-memory"', 'row?.ns === "@xxmy/dsh-global-memory"'],
    ['remote.mutate("meow-memory",', 'remote.mutate("@xxmy/dsh-global-memory",'],
    ['remote.update("meow-memory",', 'remote.update("@xxmy/dsh-global-memory",']
  ];
  for (const [find, repl] of clientEdits) {
    const n = countOf(client, find);
    if (n === 0) {
      if (countOf(client, repl) >= 1) continue;
      throw new Error(`[client] 锚点缺失（上游结构可能变了）: ${find}`);
    }
    if (n !== 1) throw new Error(`[client] 锚点命中 ${n} 次: ${find}`);
    client = client.replace(find, repl);
  }
  writeFileSync(clientOut, client, "utf8");
  console.log(`patched client: ${clientOut} (${client.length} bytes)`);
}
