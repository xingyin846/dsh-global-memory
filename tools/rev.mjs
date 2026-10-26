// tools/rev.mjs —— 记忆版本表（memory_rev）CLI
// 用法：node tools/rev.mjs recent [n] | list <id> | diff <rev> | rollback <rev>
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { resolveDbPath } from "./dbpath.mjs";

const DB = resolveDbPath();
if (!existsSync(DB)) { console.error("找不到记忆库: " + DB); process.exit(2); }
const db = new DatabaseSync(DB, { readOnly: false });
const hasRev = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_rev'").get();
if (!hasRev) { console.error("库里还没有 memory_rev 表（插件重启后才会建）"); process.exit(2); }

const [cmd, arg] = process.argv.slice(2);
const j = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const ts = (ms) => new Date(Number(ms)).toISOString().replace("T", " ").slice(0, 19);
const short = (s, n = 90) => String(s ?? "").replace(/\s+/g, " ").slice(0, n);
const tag = (r) => (r.actor_wl ? " [白名单]" : "");

if (cmd === "recent") {
  const n = Math.max(1, Math.min(200, Number(arg ?? 20)));
  for (const r of db.prepare("SELECT rev,level,id,action,actor,actor_wl,at FROM memory_rev ORDER BY rev DESC LIMIT ?").all(n)) {
    console.log("#" + r.rev + " " + ts(r.at) + " " + r.action + " " + r.level + "/" + String(r.id).slice(0, 14) + " actor=" + r.actor + tag(r));
  }
} else if (cmd === "list") {
  if (!arg) { console.error("用法: node tools/rev.mjs list <id 或前缀>"); process.exit(2); }
  const rows = db.prepare("SELECT rev,level,id,action,actor,actor_wl,at FROM memory_rev WHERE id LIKE ? ORDER BY rev").all(arg + "%");
  if (rows.length === 0) { console.log("没有该条目的版本记录"); process.exit(0); }
  for (const r of rows) console.log("#" + r.rev + " " + ts(r.at) + " " + r.action + " " + r.level + " actor=" + r.actor + tag(r));
} else if (cmd === "diff") {
  const r = db.prepare("SELECT * FROM memory_rev WHERE rev = ?").get(Number(arg));
  if (!r) { console.error("没有 rev=" + arg); process.exit(2); }
  const b = j(r.before), a = j(r.after);
  console.log("#" + r.rev + " " + ts(r.at) + " " + r.action + " " + r.level + "/" + r.id + " actor=" + r.actor + tag(r));
  const keys = new Set([...Object.keys(b ?? {}), ...Object.keys(a ?? {})]);
  for (const k of keys) {
    const bv = JSON.stringify(b ? b[k] : null), av = JSON.stringify(a ? a[k] : null);
    if (bv !== av) console.log("  " + k + ": " + short(b ? b[k] : "(null)", 120) + "\n      -> " + short(a ? a[k] : "(null)", 120));
  }
} else if (cmd === "rollback") {
  const r = db.prepare("SELECT * FROM memory_rev WHERE rev = ?").get(Number(arg));
  if (!r) { console.error("没有 rev=" + arg); process.exit(2); }
  const before = j(r.before), after = j(r.after);
  const row = before ?? after;
  if (!row) { console.error("这条 rev 没有可用快照"); process.exit(2); }
  if (!before) {
    db.prepare("UPDATE " + r.level + " SET status='archived', updated_at=? WHERE id=?").run(Date.now(), row.id);
    console.log("已把 " + r.level + "/" + row.id + " 标为 archived（该次是 insert，回滚=软删，一行 SQL 可复活）");
  } else {
    const cols = ["title", "content", "importance", "keywords", "status", "project", "subcategory", "goal", "corrected"];
    const sets = [], vals = [];
    for (const c of cols) {
      if (before[c] !== undefined) { sets.push(c + " = ?"); vals.push(c === "keywords" ? JSON.stringify(before[c] ?? []) : before[c]); }
    }
    sets.push("updated_at = ?"); vals.push(Date.now());
    db.prepare("UPDATE " + r.level + " SET " + sets.join(", ") + " WHERE id = ?").run(...vals, row.id);
    console.log("已回滚 " + r.level + "/" + row.id + " 到 rev #" + r.rev + " 之前的状态（原 updated_at=" + ts(row.updated_at) + "）");
  }
} else {
  console.log("用法: node tools/rev.mjs recent [n] | list <id> | diff <rev> | rollback <rev>");
}
db.close();
