// ===== global_memory (gm) 增补：共享库 / 注入收窄 / 三层遗忘 =====
// 本段由 tools/patch.mjs 插入上游 bundle，不依赖任何新 import（复用文件内已有的
// join8 / dirname6 / mkdirSync5 / writeFileSync4 / getDb / LEVELS / refuseOrThrow）。
var gmSharedDbPath = null;
var gmRuntime = {
  projectDir: ".dsh-meow",
  inject: { userMaxChars: 12000, rulesMaxChars: 12000, keepProjectList: true, preferLine: true },
  forget: {
    enabled: true,
    mode: "dry-run",
    maxAgeDays: 180,
    maxImportance: 2,
    batchLimit: 50,
    levels: ["fact", "lesson", "topic"],
    requireZeroHits: true,
    archiveDir: "",
    checkHours: 24
  }
};
function setGmRuntime(resolved) {
  const r = resolved ?? {};
  const dbPath = typeof r.dbPath === "string" ? r.dbPath.trim() : "";
  gmSharedDbPath = dbPath.length > 0 ? dbPath : null;
  gmRuntime = {
    projectDir: typeof r.projectDir === "string" && r.projectDir.length > 0 ? r.projectDir : ".dsh-meow",
    inject: { ...gmRuntime.inject, ...(r.inject ?? {}) },
    forget: { ...gmRuntime.forget, ...(r.forget ?? {}) }
  };
  // 可观测性：把「实际生效的配置」落一个小文件，用来确认新插件是否真的加载了。
  // 自检脚本会设 GM_NO_MARKER=1，避免把临时库路径写进生产标记文件。
  if (process.env.GM_NO_MARKER === "1") return gmRuntime;
  try {
    const dir = (() => {
      try {
        return activeHomeDir();
      } catch {
        return null;
      }
    })();
    const target = typeof dir === "string" && dir.length > 0
      ? join8(dir, "gm-runtime.json")
      : join8(process.cwd(), "gm-runtime.json");
    writeFileSync4(target, JSON.stringify({
      plugin: "global_memory",
      pid: process.pid,
      at: new Date().toISOString(),
      dbPath: gmSharedDbPath,
      projectDir: gmRuntime.projectDir,
      inject: gmRuntime.inject,
      forget: gmRuntime.forget
    }, null, 2), "utf8");
  } catch {
  }
  return gmRuntime;
}
function gmRankRows(rows) {
  return [...rows].sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0) || (b.updated_at ?? 0) - (a.updated_at ?? 0));
}
/** 首轮注入的字符上限：按 importance desc + updated_at desc 取，放不下就跳过（不提前截断单条）。 */
function gmCapRows(rows, maxChars) {
  const ranked = gmRankRows(rows);
  if (!(typeof maxChars === "number" && maxChars > 0)) return ranked;
  const out = [];
  let used = 0;
  for (const r of ranked) {
    const len = typeof r.content === "string" ? r.content.length : 0;
    if (used + len > maxChars) continue;
    out.push(r);
    used += len;
  }
  return out;
}
function gmNowStamp(now) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function gmForgetDb(workspace, dir) {
  const d = typeof dir === "string" && dir.length > 0 ? dir : gmRuntime.projectDir;
  if (gmSharedDbPath !== null) return getDb(workspace ?? process.cwd(), d);
  const ws = typeof workspace === "string" && workspace.length > 0 ? workspace : getDreamWorkspace();
  if (typeof ws !== "string" || ws.length === 0) return null;
  return getDb(ws, d);
}
/** 白名单在 SQL 之外强制：user/soul 永不入选；project 只允许 todo；corrected 教训跳过。 */
function gmForgetCandidates(db, cfg, now = Date.now()) {
  const want = Array.isArray(cfg.levels) && cfg.levels.length > 0 ? cfg.levels : ["fact", "lesson", "topic"];
  const levels = want.filter((l) => LEVELS.includes(l) && l !== "user" && l !== "soul");
  const out = [];
  for (const level of levels) {
    let rows = [];
    try {
      rows = db.list(level, { status: "active" });
    } catch {
      continue;
    }
    for (const r of rows) {
      if (level === "rules") continue;
      if (level === "project" && r.subcategory !== "todo") continue;
      if (level === "lesson" && r.corrected) continue;
      const imp = Number(r.importance ?? 1);
      if (imp > Number(cfg.maxImportance ?? 2)) continue;
      if (cfg.requireZeroHits !== false && Number(r.hit_count ?? 0) > 0) continue;
      const last = Math.max(Number(r.last_accessed_at ?? 0), Number(r.updated_at ?? 0), Number(r.created_at ?? 0));
      const ageDays = Math.floor((now - last) / 864e5);
      if (ageDays < Number(cfg.maxAgeDays ?? 180)) continue;
      out.push({
        level,
        id: r.id,
        title: r.title ?? "",
        content: r.content ?? "",
        project: r.project ?? null,
        importance: imp,
        hit_count: Number(r.hit_count ?? 0),
        ageDays,
        updated_at: Number(r.updated_at ?? 0)
      });
    }
  }
  out.sort((a, b) => b.ageDays - a.ageDays || a.importance - b.importance);
  return out;
}
function gmArchiveFile(cfg, dir, now) {
  const custom = typeof cfg.archiveDir === "string" ? cfg.archiveDir.trim() : "";
  const base = custom.length > 0
    ? custom
    : join8(gmSharedDbPath !== null ? dirname6(gmSharedDbPath) : dirname6(join8(process.cwd(), dir, "memory.db")), "forget-archive");
  return join8(base, `${gmNowStamp(now)}.md`);
}
function gmWriteArchive(file, entries, header) {
  try {
    mkdirSync5(dirname6(file), { recursive: true });
    const lines = [header, ""];
    for (const e of entries) {
      lines.push(`## ${e.level} · ${e.id}`, "", `- project: ${e.project ?? "(none)"}`, `- importance: ${e.importance} · hit_count: ${e.hit_count} · ${e.ageDays} 天未活动`, "", e.content, "");
    }
    writeFileSync4(file, lines.join("\n"), "utf8");
    return file;
  } catch {
    return "";
  }
}
/**
 * 三层遗忘之存储面：只归档不删除。
 * opts = { workspace?, apply?, force?, limit?, config? }
 *  - apply 必须同时满足 (配置 mode='apply' 或 force=true)，否则一律 dry-run。
 *  - dry-run 也会写归档案，便于复核；库内一条不改。
 */
function gmRunForget(opts = {}) {
  const cfg = { ...gmRuntime.forget, ...(opts.config ?? {}) };
  if (cfg.enabled === false) {
    return { ok: false, candidates: 0, picked: 0, applied: 0, archive: "", note: "遗忘已关闭（forget.enabled=false）", preview: [] };
  }
  const db = gmForgetDb(opts.workspace, gmRuntime.projectDir);
  if (db === null) {
    return { ok: false, candidates: 0, picked: 0, applied: 0, archive: "", note: "当前没有可用记忆库（非共享模式下需要先有 dream 工作区）", preview: [] };
  }
  const now = Date.now();
  const all = gmForgetCandidates(db, cfg, now);
  const limit = Math.max(1, Math.min(200, Number(opts.limit ?? cfg.batchLimit ?? 50)));
  const picked = all.slice(0, limit);
  const apply = opts.apply === true && (cfg.mode === "apply" || opts.force === true);
  let archive = "";
  if (picked.length > 0) {
    const header = [
      `# 遗忘归档 ${new Date(now).toISOString()}（${apply ? "已归档" : "dry-run 预览，库内未改"}）`,
      "",
      `阈值：最后活动 ≥ ${cfg.maxAgeDays} 天 · importance ≤ ${cfg.maxImportance} · 要求 hit_count=0：${cfg.requireZeroHits === false ? "否" : "是"} · levels=${cfg.levels.join(",")}`,
      "",
      `本次命中 ${all.length} 条，处理 ${picked.length} 条（limit=${limit}）`,
      ""
    ].join("\n");
    archive = gmWriteArchive(gmArchiveFile(cfg, gmRuntime.projectDir, now), picked, header);
  }
  let applied = 0;
  if (apply) {
    for (const e of picked) {
      try {
        if (db.update(e.level, e.id, { status: "archived" })) applied += 1;
      } catch {
      }
    }
  }
  try {
    db.db.prepare("INSERT INTO dream_log (run_at, summary, changes, note) VALUES (?, ?, ?, ?)").run(
      now,
      `forget ${apply ? "apply" : "dry-run"} candidates=${all.length} picked=${picked.length} applied=${applied}`,
      JSON.stringify(picked.map((e) => `${e.level}:${e.id}`)),
      "global_memory"
    );
  } catch {
  }
  return {
    ok: true,
    candidates: all.length,
    picked: picked.length,
    applied,
    archive,
    note: apply ? "已归档（复活：UPDATE <level> SET status='active' WHERE id='<id>'）" : "dry-run：只写归档案，库内未改",
    preview: picked.slice(0, 10).map((e) => ({
      id: e.id,
      level: e.level,
      project: e.project,
      importance: e.importance,
      ageDays: e.ageDays,
      preview: String(e.content ?? "").slice(0, 80)
    }))
  };
}
function forgetTool(dir) {
  return {
    name: "memory_forget",
    description: "记忆遗忘（存储面，global_memory）：按阈值筛出「长期未活动 + 重要性低 + 从未被检索」的旧条目。默认只做 dry-run 预览并写归档案；apply=true 且（配置 mode=apply 或 force=true）才真正归档为 status=archived（一行 SQL 可复活）。永不遗忘：user / rules / project 的 overview·decisions·quotes·ops / corrected 教训 / importance 超阈值。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        apply: { type: "boolean", description: "true=真正归档；默认 false 只预览" },
        limit: { type: "integer", description: "本次最多处理条数（默认取配置 forget.batchLimit）" },
        force: { type: "boolean", description: "配置为 dry-run 模式时，仍要真正归档需传 true" }
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["ok"],
        properties: {
          ok: { type: "boolean" },
          candidates: { type: "integer" },
          picked: { type: "integer" },
          applied: { type: "integer" },
          archive: { type: "string" },
          note: { type: "string" },
          preview: { type: "array", items: { type: "object", additionalProperties: true } }
        }
      },
      render: (_args, value) => {
        const v = value;
        const lines = [v.ok ? `遗忘扫描：命中 ${v.candidates} 条 · 处理 ${v.picked} 条 · 实际归档 ${v.applied} 条` : `遗忘未执行：${String(v.note ?? "")}`];
        if (v.archive) lines.push(`归档案：${v.archive}`);
        if (v.note) lines.push(String(v.note));
        for (const p of v.preview ?? []) {
          lines.push(`- [${p.level}] ${String(p.id ?? "").slice(0, 12)} · ${p.project ?? "(无项目)"} · imp ${p.importance} · ${p.ageDays} 天未动 · ${String(p.preview ?? "").slice(0, 50)}`);
        }
        return lines.map((t) => ({ type: "text", text: t }));
      }
    },
    async execute(args, exec) {
      refuseOrThrow("write", exec);
      const parsed = args;
      return gmRunForget({
        workspace: workspaceOf(exec),
        apply: parsed.apply === true,
        force: parsed.force === true,
        limit: coerceNumber(parsed.limit)
      });
    },
    presentCall(args) {
      const parsed = args;
      return { card: "generic", title: `memory_forget${parsed.apply === true ? "（归档）" : "（dry-run）"}`, kind: "write" };
    }
  };
}
function scheduleForget(ctx, resolved) {
  const cfg = resolved?.forget ?? {};
  if (cfg.enabled === false) return () => {
  };
  const everyMs = Math.max(1, Number(cfg.checkHours ?? 24)) * 3600e3;
  const tick = () => {
    try {
      const r = gmRunForget({ apply: cfg.mode === "apply" });
      if (r.ok && (r.candidates > 0 || cfg.mode === "apply")) {
        ctx.logger.info(`global_memory: forget ${cfg.mode === "apply" ? "apply" : "dry-run"} candidates=${r.candidates} picked=${r.picked} applied=${r.applied} archive=${r.archive || "-"}`);
      }
    } catch (e) {
      ctx.logger.warn(`global_memory: forget sweep failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const first = setTimeout(tick, 5 * 60e3);
  const timer = setInterval(tick, everyMs);
  if (typeof first.unref === "function") first.unref();
  if (typeof timer.unref === "function") timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
