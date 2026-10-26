// tools/verify.mjs — global_memory 功能自检（不碰生产库：先 VACUUM INTO 一份副本）。
//
// 用法（在插件根目录）：node tools/verify.mjs
// 退出码 0 = 全过；非 0 = 有断言失败。
import { existsSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { MemoryDb, buildInjectionBody, setGmRuntime, gmRunForget, memoryDbPath, search, gmStatusWeight, setGmScope, gmSetActor } from "../lib/index.js";
import { resolveHome, resolveMarker } from "./dbpath.mjs";

// 自检只读/只写副本，绝不改写生产标记文件
process.env.GM_NO_MARKER = "1";
process.env.GM_NO_PROMPT = "1";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const HOME = resolveHome();
const RUNTIME = join(HOME, "gm-runtime.json");
const TMP = join(tmpdir(), "gm-verify");
const COPY = join(TMP, "memory.db");
const ARCHIVE = join(TMP, "archive");

const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail ?? "" });
  } catch (e) {
    results.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) });
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ---------- 1. 运行态配置 ----------
let cfg = null;
check("运行时配置文件存在且可解析", () => {
  assert(existsSync(RUNTIME), `缺少 ${RUNTIME}（插件没加载过？）`);
  cfg = JSON.parse(readFileSync(RUNTIME, "utf8"));
  assert(cfg.plugin === "global_memory", `plugin=${cfg.plugin}`);
  return `pid=${cfg.pid} at=${cfg.at}`;
});
check("dbPath 指向共享库", () => {
  // 不写死目录名：只要指向一个绝对路径的共享库、且不在工作区子目录里即可（2026-10-25 目录归并后改为 .dsh-memory）
  assert(cfg && typeof cfg.dbPath === "string" && /^[A-Za-z]:\\.*memory\.db$/.test(cfg.dbPath), `dbPath=${cfg?.dbPath}`);
  assert(!/\\\\(node_modules|sessions)\\\\/i.test(cfg.dbPath), "dbPath 落在不该有的子目录里");
  return cfg.dbPath;
});
check("注入上限已生效配置", () => {
  assert(cfg?.inject?.userMaxChars === 12000 && cfg?.inject?.rulesMaxChars === 12000, JSON.stringify(cfg?.inject));
  assert(cfg?.inject?.keepProjectList === true && cfg?.inject?.preferLine === true, "keepProjectList/preferLine 未开启");
  return "12k / 12k / 保留项目名 / 记忆优先行";
});
check("遗忘配置", () => {
  assert(cfg?.forget?.enabled === true, "forget 未启用");
  assert(cfg.forget.mode === "dry-run" || cfg.forget.mode === "apply", `mode=${cfg.forget.mode}`);
  return `mode=${cfg.forget.mode} maxAge=${cfg.forget.maxAgeDays}d maxImp=${cfg.forget.maxImportance}`;
});

// ---------- 2. 共享库路径解析 ----------
check("不同工作区解析到同一个库", () => {
  setGmRuntime({ dbPath: cfg?.dbPath ?? "", projectDir: ".dsh-meow", inject: cfg?.inject, forget: cfg?.forget });
  const a = memoryDbPath("D:/work", ".dsh-meow");
  const b = memoryDbPath("D:/work/网络安全", ".dsh-meow");
  assert(a === b, `不一致: ${a} vs ${b}`);
  return a;
});

// ---------- 3. 注入收窄（副本） ----------
// 默认自建夹具（不依赖本机生产库）；GM_VERIFY_PROD=1 时改用生产库副本
check("测试库准备（默认自建夹具 / GM_VERIFY_PROD=1 用生产库副本）", () => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  if (process.env.GM_VERIFY_PROD === "1" && cfg?.dbPath && existsSync(cfg.dbPath)) {
    const src = new DatabaseSync(cfg.dbPath, { readOnly: true });
    src.exec(`VACUUM INTO '${COPY.replace(/\\/g, "/")}'`);
    src.close();
    assert(existsSync(COPY), "生产库副本未生成");
    return "生产库副本 " + COPY;
  }
  const db = new MemoryDb(COPY);
  const pad = (n) => "夹具内容".repeat(Math.ceil(n / 4)).slice(0, n);
  for (let i = 0; i < 60; i += 1) db.insert({ level: "rules", content: "夹具全局规则 " + i + " " + pad(400), importance: 2, project: "全局" });
  for (let i = 0; i < 60; i += 1) db.insert({ level: "user", content: "夹具用户偏好 " + i + " " + pad(400), importance: 2 });
  for (let i = 0; i < 12; i += 1) db.insert({ level: "project", content: "夹具项目条目 " + i, importance: 2, project: "dsh", subcategory: "overview" });
  for (let i = 0; i < 12; i += 1) db.insert({ level: "fact", content: "夹具事实条目 " + i, importance: 1, project: "全局" });
  for (let i = 0; i < 6; i += 1) db.insert({ level: "topic", content: "夹具话题 " + i, importance: 1, project: "全局" });
  db.close();
  assert(existsSync(COPY), "夹具库未生成");
  return "自建夹具 " + COPY;
});
let capped = null;
check("首轮注入有字符上限且含记忆优先行", () => {
  const db = new MemoryDb(COPY);
  setGmRuntime({ dbPath: COPY, projectDir: ".dsh-meow", inject: cfg.inject, forget: cfg.forget });
  capped = buildInjectionBody(db, { titleMax: 40 });
  assert(capped && capped.body, "注入体为空");
  assert(capped.body.length < 30000, `注入 ${capped.body.length} 字符，仍过大`);
  assert(capped.body.includes("【记忆优先】"), "缺少记忆优先行");
  assert(capped.body.includes("用户的所有 project"), "缺少项目名列表");
  db.close();
  return `${capped.body.length} 字符 / ${capped.injectedIds.length} 条`;
});
check("注入上限确实按条截断（无上限对照）", () => {
  const db = new MemoryDb(COPY);
  setGmRuntime({ dbPath: COPY, projectDir: ".dsh-meow", inject: { userMaxChars: 0, rulesMaxChars: 0, keepProjectList: true, preferLine: false }, forget: cfg.forget });
  const full = buildInjectionBody(db, { titleMax: 40 });
  db.close();
  assert(full.body.length > capped.body.length, `无上限 ${full.body.length} 不大于有上限 ${capped.body.length}`);
  return `${full.body.length} → ${capped.body.length} 字符`;
});

// ---------- 4. 遗忘（副本） ----------
check("遗忘白名单与阈值：造老数据后 dry-run 只预览", () => {
  const db = new MemoryDb(COPY);
  setGmRuntime({ dbPath: COPY, projectDir: ".dsh-meow", inject: cfg.inject, forget: cfg.forget });
  db.db.prepare("UPDATE fact SET created_at = created_at - 34560000000, updated_at = updated_at - 34560000000, last_accessed_at = NULL, hit_count = 0, importance = 1 WHERE id IN (SELECT id FROM fact WHERE status='active' LIMIT 5)").run();
  const before = counts(db);
  const r = gmRunForget({ apply: false, limit: 50 });
  const after = counts(db);
  assert(r.ok, r.note);
  assert(r.candidates >= 5, `候选 ${r.candidates} < 5`);
  assert(r.applied === 0, `dry-run 却归档了 ${r.applied}`);
  assert(r.archive && existsSync(r.archive), "归档案未生成");
  assert(JSON.stringify(before) === JSON.stringify(after), "dry-run 改动了库");
  db.close();
  return `候选 ${r.candidates} / 归档 0 / 档案 ${r.archive.split(/[\\/]/).pop()}`;
});
check("apply 归档后 status/白名单/可复活都正确", () => {
  const db = new MemoryDb(COPY);
  setGmRuntime({ dbPath: COPY, projectDir: ".dsh-meow", inject: cfg.inject, forget: { ...cfg.forget, archiveDir: ARCHIVE } });
  const before = counts(db);
  const r = gmRunForget({ apply: true, force: true, limit: 2 });
  assert(r.applied === 2, `归档 ${r.applied} != 2`);
  const after = counts(db);
  assert(after.rules === before.rules && after.user === before.user && after.project === before.project && after.corrected === before.corrected, "白名单被改动");
  const row = db.db.prepare("SELECT id FROM fact WHERE status='archived' LIMIT 1").get();
  db.db.prepare("UPDATE fact SET status='active' WHERE id = ?").run(row.id);
  const back = db.db.prepare("SELECT count(*) c FROM fact WHERE status='active'").get().c;
  db.close();
  return `归档 2 条；白名单不变；复活后 active=${back}`;
});

// ---------- 检索状态面（2026-10-25 用户拍板：stale 可检索但不优先；archived 默认不检索） ----------
check("检索：stale 仍可命中但排在 active 之后", () => {
  const now = Date.now();
  const mk = (id, status) => ({ id, level: "fact", title: "权重探针", content: "权重探针 降权验证 关键词", keywords: [], importance: 1, created_at: now, updated_at: now, status });
  const hits = search("权重探针", [mk("s1", "stale"), mk("a1", "active"), mk("x1", "archived")], { k: 5 });
  assert(hits.length === 3, "期望 3 条命中，实得 " + hits.length);
  assert(hits[0].id === "a1", "active 未排首位：" + hits.map((h) => h.id).join(","));
  const stale = hits.find((h) => h.id === "s1");
  const active = hits.find((h) => h.id === "a1");
  assert(stale.score < active.score, "stale 未降权：" + stale.score + " !< " + active.score);
  assert(gmStatusWeight({ status: "stale" }) === 0.4 && gmStatusWeight({ status: "active" }) === 1, "权重常量不符");
  return "stale=" + stale.score.toFixed(2) + " < active=" + active.score.toFixed(2);
});

check("检索：listSearchable 含 stale、不含 archived", () => {
  const db = new MemoryDb(COPY);
  try {
    const rows = db.listSearchable("fact");
    const st = new Set(rows.map((r) => r.status));
    assert(!st.has("archived"), "listSearchable 混入了 archived");
    const activeCount = db.db.prepare("SELECT count(*) c FROM fact WHERE status='active'").get().c;
    assert(rows.filter((r) => r.status === "active").length === activeCount, "active 行数不一致");
    return "active=" + activeCount + " 行，状态集合=" + ([...st].join(",") || "(空)");
  } finally {
    db.close();
  }
});

// ---------- 初阶审计：memory_rev 记录前后整行（2026-10-25） ----------
check("审计：memory_rev 记录 insert 与 update 的前后整行", () => {
  const db = new MemoryDb(COPY);
  try {
    const id = "gm-audit-" + Date.now();
    db.insert({ id, level: "fact", content: "审计自检 v1", importance: 1, project: "全局" });
    db.update("fact", id, { content: "审计自检 v2", importance: 2 });
    const rows = db.db.prepare("SELECT action, actor, actor_wl, before, after FROM memory_rev WHERE id = ? ORDER BY rev").all(id);
    assert(rows.length === 2, "期望 2 条 rev，实得 " + rows.length);
    assert(rows[0].action === "insert" && rows[0].before === null, "insert 那条不符");
    assert(rows[1].action === "update" && rows[1].before && rows[1].after, "update 缺 before/after");
    assert(typeof rows[1].actor === "string" && rows[1].actor.length > 0, "缺 actor");
    const b = JSON.parse(rows[1].before), a = JSON.parse(rows[1].after);
    assert(b.content === "审计自检 v1" && a.content === "审计自检 v2", "before/after 内容不符");
    return "2 条 rev；before=v1 / after=v2；actor=" + rows[1].actor + " wl=" + rows[1].actor_wl;
  } finally {
    db.close();
  }
});

// ---------- 高阶：房间 scope（2026-10-25） ----------
check("房间：非成员看不见/改不动，成员可见可改，global 不受影响", () => {
  const db = new MemoryDb(COPY);
  try {
    const ts = Date.now();
    const rid = "gm-scope-r-" + ts;
    const gid = "gm-scope-g-" + ts;
    setGmScope({ enabled: false });
    db.insert({ id: rid, level: "fact", content: "房间测试 personal 甲", importance: 1, scope: "room:personal" });
    db.insert({ id: gid, level: "fact", content: "房间测试 global 乙", importance: 1, scope: "global" });
    setGmScope({ enabled: true, owner: ["sid-owner"], rooms: { personal: "sid-member" }, failMode: "closed", grantMinutes: 30 });
    gmSetActor("sid-stranger");
    assert(db.findById(rid) === undefined, "非成员竟读到房间条目");
    assert(db.findById(gid) !== undefined, "global 条目被误挡");
    assert(!db.list("fact", { status: "active" }).some((r) => r.id === rid), "非成员 list 里出现房间条目");
    let threw = false;
    try { db.update("fact", rid, { content: "非成员试图修改" }); } catch (e) { threw = true; }
    assert(threw, "非成员竟然改成功");
    gmSetActor("sid-member");
    assert(db.findById(rid) !== undefined, "成员读不到房间条目");
    assert(db.list("fact", { status: "active" }).some((r) => r.id === rid), "成员 list 里没有房间条目");
    assert(db.update("fact", rid, { content: "成员改过了" }) === true, "成员改不动");
    gmSetActor("sid-owner");
    assert(db.findById(rid) !== undefined, "owner 读不到房间条目");
    return "非成员不可见/不可改；成员可见可改；owner 全可见；global 不受影响";
  } finally {
    setGmScope({ enabled: false });
    db.close();
  }
});

// ---------- 高阶：房间过期 / 只读 / 多房间归属（2026-10-25） ----------
check("房间：过期即失效、只读不可改、多房间归属任一命中即可见", () => {
  const db = new MemoryDb(COPY);
  try {
    const ts = Date.now();
    const rid = "gm-room-multi-" + ts;
    const rid2 = "gm-room-ro-" + ts;
    setGmScope({ enabled: false });
    db.insert({ id: rid, level: "fact", content: "多房间归属测试", importance: 1, scope: "room:alpha,room:beta" });
    db.insert({ id: rid2, level: "fact", content: "只读房间测试", importance: 1, scope: "room:ro" });
    db.db.exec("CREATE TABLE IF NOT EXISTS scope_room (name TEXT PRIMARY KEY, expires_at INTEGER, can_read INTEGER NOT NULL DEFAULT 1, can_write INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, note TEXT)");
    db.db.exec("CREATE TABLE IF NOT EXISTS scope_member (room TEXT NOT NULL, session_id TEXT NOT NULL, added_at INTEGER NOT NULL, can_read INTEGER, can_write INTEGER, parent_session TEXT, PRIMARY KEY (room, session_id))");
    db.db.prepare("INSERT OR REPLACE INTO scope_room (name,expires_at,can_read,can_write,created_at) VALUES (?,?,?,?,?)").run("beta", ts - 1000, 1, 1, ts);
    db.db.prepare("INSERT OR REPLACE INTO scope_room (name,expires_at,can_read,can_write,created_at) VALUES (?,?,?,?,?)").run("ro", null, 1, 0, ts);
    db.db.prepare("INSERT OR REPLACE INTO scope_member (room,session_id,added_at) VALUES (?,?,?)").run("beta", "sid-beta", ts);
    db.db.prepare("INSERT OR REPLACE INTO scope_member (room,session_id,added_at) VALUES (?,?,?)").run("ro", "sid-ro", ts);
    setGmScope({ enabled: true, owner: [], rooms: { alpha: "sid-alpha" }, failMode: "closed", grantMinutes: 30 });
    gmSetActor("sid-alpha");
    assert(db.findById(rid) !== undefined, "alpha 成员读不到多房间条目");
    gmSetActor("sid-beta");
    assert(db.findById(rid) === undefined, "过期房间 beta 的成员仍然读到了条目");
    gmSetActor("sid-ro");
    assert(db.findById(rid2) !== undefined, "只读房间成员读不到");
    let threw = false;
    try { db.update("fact", rid2, { content: "只读房间试图改" }); } catch (e) { threw = true; }
    assert(threw, "只读房间竟然改成功");
    return "多房间任一命中可见；过期房间失效；只读房间可读不可改";
  } finally {
    setGmScope({ enabled: false });
    db.close();
  }
});

// ---------- 房间：授权三态 + id 稳定（2026-10-25 修 rekey 后补） ----------
check("房间：未授权不可见 → 授权可见 → 过期不可见", () => {
  const db = new MemoryDb(COPY);
  try {
    const id = "gm-grant-" + Date.now();
    setGmScope({ enabled: false });
    db.insert({ id, level: "fact", content: "授权三态测试", importance: 1, scope: "room:gr" });
    setGmScope({ enabled: true, owner: ["owner-o"], rooms: {}, failMode: "closed", grantMinutes: 30 });
    gmSetActor("sid-g");
    assert(db.findById(id) === undefined, "未授权却可见");
    db.db.prepare("INSERT OR REPLACE INTO scope_grant (session_id, room, granted_at, expires_at, granted_by) VALUES (?,?,?,?,?)").run("sid-g", "gr", Date.now(), Date.now() + 60000, "test");
    gmSetActor("sid-g");
    assert(db.findById(id) !== undefined, "授权后仍不可见");
    db.db.prepare("UPDATE scope_grant SET expires_at = ? WHERE session_id = ? AND room = ?").run(Date.now() - 1000, "sid-g", "gr");
    gmSetActor("sid-g");
    assert(db.findById(id) === undefined, "授权过期后仍可见");
    return "未授权不可见 / 授权可见 / 过期不可见";
  } finally {
    setGmScope({ enabled: false });
    db.close();
  }
});

check("id 稳定：自定义 id 重开库后不被改写", () => {
  const id = "gm-idstable-" + Date.now();
  setGmScope({ enabled: false });
  const a = new MemoryDb(COPY);
  a.insert({ id, level: "fact", content: "id 稳定性测试", importance: 1 });
  a.close();
  const b = new MemoryDb(COPY);
  const row = b.db.prepare("SELECT id FROM fact WHERE id = ?").get(id);
  b.close();
  assert(row, "重开库后自定义 id 被改写（rekey 误伤）");
  return "自定义 id 重开后保持不变";
});

// ---------- 审计保留策略（2026-10-26） ----------
check("审计保留：同一 id 的 rev 保留最近 N 条，不会无限增长", () => {
  const db = new MemoryDb(COPY);
  try {
    const id = "gm-revkeep-" + Date.now();
    db.insert({ id, level: "fact", content: "保留策略测试 v0", importance: 1 });
    for (let i = 1; i <= 25; i += 1) db.update("fact", id, { content: "保留策略测试 v" + i });
    const n = db.db.prepare("SELECT count(*) c FROM memory_rev WHERE id = ?").get(id).c;
    assert(n <= 21, "rev 未按策略裁剪，实际 " + n + " 条");
    return "25 次修改后该 id 只留 " + n + " 条 rev";
  } finally {
    db.close();
  }
});

// ---------- 汇总 ----------
function counts(db) {
  const q = (s) => db.db.prepare(s).get();
  return {
    user: q("SELECT count(*) c FROM user WHERE status='active'").c,
    rules: q("SELECT count(*) c FROM rules WHERE status='active'").c,
    project: q("SELECT count(*) c FROM project WHERE status='active'").c,
    corrected: q("SELECT count(*) c FROM lesson WHERE corrected=1 AND status='active'").c
  };
}

let failed = 0;
for (const r of results) {
  if (!r.ok) failed += 1;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  — " + r.detail : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} 通过`);
try {
  rmSync(TMP, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
} catch {
  console.log(`（临时目录未清理：${TMP}，可手工删）`);
}
process.exit(failed === 0 ? 0 : 1);
