// tools/rooms.mjs —— 房间管理（无系统弹窗；参数显式，agent 在对话里问用户后调用）
// 委派规则（2026-10-25）：读写全权的成员可把「全部权限」分给子会话/子代理；只有部分权限的成员，
// 分给子会话的权限必须是**自己权限的子集**（不能越权）。
// 用法：
//   node tools/rooms.mjs list | show <房间>
//   node tools/rooms.mjs create <房间> [--read 0|1] [--write 0|1] [--expires 2026-12-31|never]
//   node tools/rooms.mjs add <房间> <会话id> [--as <父会话id>] [--read 0|1] [--write 0|1]
//   node tools/rooms.mjs del <房间> <会话id> | expire <房间> <日期|never> | grant <房间> <会话id> [分钟]
//   node tools/rooms.mjs can <房间> <会话id>      # 打印该会话在这个房间的有效权限
//   node tools/rooms.mjs why <记忆id或前缀>
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { resolveDbPath } from "./dbpath.mjs";

const DB = resolveDbPath();
if (!existsSync(DB)) { console.error("找不到记忆库: " + DB); process.exit(2); }
const db = new DatabaseSync(DB, { readOnly: false });
db.exec("CREATE TABLE IF NOT EXISTS scope_room (name TEXT PRIMARY KEY, expires_at INTEGER, can_read INTEGER NOT NULL DEFAULT 1, can_write INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, note TEXT)");
db.exec("CREATE TABLE IF NOT EXISTS scope_member (room TEXT NOT NULL, session_id TEXT NOT NULL, added_at INTEGER NOT NULL, PRIMARY KEY (room, session_id))");
db.exec("CREATE TABLE IF NOT EXISTS scope_grant (session_id TEXT NOT NULL, room TEXT NOT NULL, granted_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, granted_by TEXT, PRIMARY KEY (session_id, room))");
// 幂等补列：每成员的细粒度权限 + 父会话（委派来源）
const mcols = db.prepare("PRAGMA table_info(scope_member)").all().map((c) => c.name);
for (const [c, t] of [["can_read", "INTEGER"], ["can_write", "INTEGER"], ["parent_session", "TEXT"]]) {
  if (mcols.indexOf(c) === -1) db.exec("ALTER TABLE scope_member ADD COLUMN " + c + " " + t);
}

const dayEnd = (s) => {
  if (s == null || String(s).trim() === "" || /^never$/i.test(String(s).trim())) return null;
  if (/^[0-9]{9,}$/.test(String(s).trim())) return Number(String(s).trim());
  const d = new Date(String(s).trim() + "T23:59:59");
  return isNaN(d.getTime()) ? undefined : d.getTime();
};
const ts = (ms) => (ms == null ? "永久" : new Date(Number(ms)).toISOString().replace("T", " ").slice(0, 16));
const flag = (n, def) => { const i = process.argv.indexOf("--" + n); return i === -1 ? def : process.argv[i + 1]; };
const pos = process.argv.slice(2).filter((a) => a.indexOf("--") !== 0);
const [cmd, name, arg2, arg3] = pos;

function roomOf(rn) { return db.prepare("SELECT * FROM scope_room WHERE name = ?").get(rn); }
function memberOf(rn, sid) { return db.prepare("SELECT * FROM scope_member WHERE room = ? AND session_id = ?").get(rn, sid); }
function effPerm(rn, sid) {
  const r = roomOf(rn);
  if (!r) return null;
  const roomR = r.can_read !== 0, roomW = r.can_write !== 0;
  const m = memberOf(rn, sid);
  if (!m) return { member: false, read: false, write: false };
  return {
    member: true,
    read: m.can_read == null ? roomR : m.can_read !== 0,
    write: m.can_write == null ? roomW : m.can_write !== 0,
    parent: m.parent_session ?? null
  };
}

if (cmd === "list" || cmd === undefined) {
  const rows = db.prepare("SELECT name, expires_at, can_read, can_write FROM scope_room ORDER BY name").all();
  if (rows.length === 0) console.log("（还没有任何房间）");
  for (const r of rows) {
    const n = db.prepare("SELECT count(*) c FROM scope_member WHERE room = ?").get(r.name).c;
    const g = db.prepare("SELECT count(*) c FROM scope_grant WHERE room = ? AND expires_at > ?").get(r.name, Date.now()).c;
    const ex = r.expires_at != null && Date.now() > Number(r.expires_at) ? " [已过期]" : "";
    console.log(r.name + "  读=" + (r.can_read ? "是" : "否") + " 写=" + (r.can_write ? "是" : "否") + " 过期=" + ts(r.expires_at) + " 成员=" + n + " 临时=" + g + ex);
  }
} else if (cmd === "show" && name) {
  const r = roomOf(name);
  if (!r) { console.log("没有这个房间: " + name); process.exit(0); }
  console.log("房间 " + r.name + "  读=" + (r.can_read ? "是" : "否") + " 写=" + (r.can_write ? "是" : "否") + " 过期=" + ts(r.expires_at));
  for (const m of db.prepare("SELECT * FROM scope_member WHERE room = ?").all(name)) {
    const e = effPerm(name, m.session_id);
    console.log("  成员 " + m.session_id + "  读=" + (e.read ? "是" : "否") + " 写=" + (e.write ? "是" : "否") + (e.parent ? "  父=" + e.parent : ""));
  }
  for (const g of db.prepare("SELECT session_id, expires_at FROM scope_grant WHERE room = ? AND expires_at > ?").all(name, Date.now())) console.log("  临时 " + g.session_id + " 至 " + ts(g.expires_at));
} else if (cmd === "can" && name && arg2) {
  const e = effPerm(name, arg2);
  if (!e) { console.log("没有房间 " + name); process.exit(0); }
  console.log(arg2 + " 在房间 " + name + " : 成员=" + e.member + " 读=" + e.read + " 写=" + e.write + (e.parent ? " 父=" + e.parent : ""));
} else if (cmd === "create" && name) {
  const canRead = String(flag("read", "1")) !== "0";
  const canWrite = String(flag("write", "1")) !== "0";
  const exp = dayEnd(flag("expires", null));
  if (exp === undefined) { console.error("过期时间无法识别"); process.exit(2); }
  db.prepare("INSERT OR REPLACE INTO scope_room (name, expires_at, can_read, can_write, created_at) VALUES (?,?,?,?,?)").run(name, exp, canRead ? 1 : 0, canWrite ? 1 : 0, Date.now());
  console.log("已创建房间 " + name + "（读=" + canRead + " 写=" + canWrite + " 过期=" + ts(exp) + "）");
} else if (cmd === "add" && name && arg2) {
  const parent = flag("as", null);
  const wantRead = flag("read", null);
  const wantWrite = flag("write", null);
  const r = roomOf(name);
  if (!r) { console.error("没有这个房间: " + name); process.exit(2); }
  if (parent) {
    const pe = effPerm(name, parent);
    if (!pe || !pe.member || (!pe.read && !pe.write)) { console.error("委派失败：" + parent + " 不是 " + name + " 的成员（或没有权限），不能往下分发"); process.exit(3); }
    const cr = wantRead == null ? pe.read : String(wantRead) !== "0";
    const cw = wantWrite == null ? pe.write : String(wantWrite) !== "0";
    if ((cr && !pe.read) || (cw && !pe.write)) {
      console.error("委派失败：" + parent + " 只有 读=" + pe.read + " 写=" + pe.write + "，不能分发 读=" + cr + " 写=" + cw + "（不可越权）");
      process.exit(4);
    }
    db.prepare("INSERT OR REPLACE INTO scope_member (room, session_id, added_at, can_read, can_write, parent_session) VALUES (?,?,?,?,?,?)").run(name, arg2, Date.now(), cr ? 1 : 0, cw ? 1 : 0, parent);
    console.log("已把 " + arg2 + " 加入房间 " + name + "（读=" + cr + " 写=" + cw + "，父=" + parent + "）");
  } else {
    const cr = wantRead == null ? null : (String(wantRead) !== "0" ? 1 : 0);
    const cw = wantWrite == null ? null : (String(wantWrite) !== "0" ? 1 : 0);
    db.prepare("INSERT OR REPLACE INTO scope_member (room, session_id, added_at, can_read, can_write) VALUES (?,?,?,?,?)").run(name, arg2, Date.now(), cr, cw);
    console.log("已把 " + arg2 + " 加入房间 " + name + (cr == null && cw == null ? "（继承房间权限）" : "（读=" + cr + " 写=" + cw + "）"));
  }
} else if (cmd === "del" && name && arg2) {
  db.prepare("DELETE FROM scope_member WHERE room = ? AND session_id = ?").run(name, arg2);
  console.log("已把 " + arg2 + " 移出房间 " + name);
} else if (cmd === "expire" && name) {
  const exp = dayEnd(arg2 ?? "never");
  if (exp === undefined) { console.error("日期无法识别"); process.exit(2); }
  db.prepare("UPDATE scope_room SET expires_at = ? WHERE name = ?").run(exp, name);
  console.log("房间 " + name + " 过期时间 = " + ts(exp));
} else if (cmd === "grant" && name && arg2) {
  const minutes = Math.max(1, Number(arg3 ?? 30));
  const now = Date.now();
  db.prepare("INSERT OR REPLACE INTO scope_grant (session_id, room, granted_at, expires_at, granted_by) VALUES (?,?,?,?,?)").run(arg2, name, now, now + minutes * 60000, "chat-confirm");
  console.log("已授权 " + arg2 + " 访问房间 " + name + "，" + minutes + " 分钟有效");
} else if (cmd === "revoke" && name && arg2) {
  db.prepare("DELETE FROM scope_grant WHERE room = ? AND session_id = ?").run(name, arg2);
  console.log("已收回 " + arg2 + " 对房间 " + name + " 的临时授权");
} else if (cmd === "why" && name) {
  const levels = ["fact", "lesson", "project", "rules", "topic", "user", "soul"];
  let hit = null;
  for (const lv of levels) {
    try {
      const cols = db.prepare("PRAGMA table_info(" + lv + ")").all().map((c) => c.name);
      const sel = cols.indexOf("scope") >= 0 ? "id, scope, status" : "id, status";
      const r = db.prepare("SELECT " + sel + " FROM " + lv + " WHERE id LIKE ?").get(name + "%");
      if (r) { hit = { level: lv, row: r }; break; }
    } catch {
    }
  }
  if (!hit) { console.log("库里没有这条记忆: " + name); process.exit(0); }
  const scope = hit.row.scope ?? "(无)";
  console.log("记忆 " + hit.row.id + " [" + hit.level + "] status=" + hit.row.status + " scope=" + scope);
  const rooms = !scope || scope === "global" ? [] : String(scope).split(",").map((s) => s.trim()).filter(Boolean).map((s) => (s.indexOf("room:") === 0 ? s.slice(5) : s));
  for (const rn of rooms) {
    const r = roomOf(rn);
    console.log("  房间 " + rn + ": " + (r ? "读=" + r.can_read + " 写=" + r.can_write + " 过期=" + ts(r.expires_at) : "（无元数据）"));
    for (const m of db.prepare("SELECT session_id FROM scope_member WHERE room = ?").all(rn)) {
      const e = effPerm(rn, m.session_id);
      console.log("    成员 " + m.session_id + " 读=" + e.read + " 写=" + e.write + (e.parent ? " 父=" + e.parent : ""));
    }
  }
} else {
  console.log("用法: list | show <房间> | create <房间> [--read 0|1] [--write 0|1] [--expires 日期] | add <房间> <会话id> [--as 父] [--read 0|1] [--write 0|1] | del | expire | grant | can <房间> <会话id> | why <记忆id>");
}
db.close();
