// tools/doctor.mjs —— 一条命令看清记忆系统现状（库/配置/房间/审计/备份）
// 用法：node tools/doctor.mjs     （退出码 0=一切正常，1=有 WARN）
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveDbPath, resolveHome } from "./dbpath.mjs";

const LEVELS = ["soul", "user", "project", "fact", "lesson", "topic", "rules"];
const warns = [];
const ok = (s) => console.log("  " + s);

const homes = [resolveHome()].filter(Boolean);
let home = null;
for (const h of homes) { if (existsSync(join(h, "gm-runtime.json"))) { home = h; break; } }
if (home === null) { console.log("找不到 gm-runtime.json（试过：" + homes.join(" / ") + "）"); process.exit(1); }

console.log("== 运行时（" + home + "）");
let marker = {};
try { marker = JSON.parse(readFileSync(join(home, "gm-runtime.json"), "utf8")); } catch { }
const ageMin = marker.at ? Math.round((Date.now() - new Date(marker.at).getTime()) / 60000) : null;
ok("plugin=" + (marker.plugin ?? "?") + " pid=" + (marker.pid ?? "?") + " at=" + (marker.at ?? "?"));
ok("dbPath=" + (marker.dbPath ?? "(空=每工作区一份)"));
ok("projectDir=" + (marker.projectDir ?? "?") + "  inject=" + JSON.stringify(marker.inject?.userMaxChars ?? "?"));
ok("forget=" + JSON.stringify({ mode: marker.forget?.mode, maxAgeDays: marker.forget?.maxAgeDays, maxImp: marker.forget?.maxImportance }));
if (marker.forget?.mode !== "apply") warns.push("遗忘仍是 dry-run：不会真的归档（要生效先把 forget.mode 改 apply 并重启）");

const dbPath = marker.dbPath && marker.dbPath.length > 0 ? marker.dbPath : join(home, "memory.db");
console.log("== 记忆库 " + dbPath);
if (!existsSync(dbPath)) { console.log("  库文件不存在（插件还没写入过？）"); process.exit(1); }
const st = statSync(dbPath);
ok("大小 " + (st.size / 1048576).toFixed(2) + " MB，最后修改 " + st.mtime.toISOString().replace("T", " ").slice(0, 19));
const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  const ic = db.prepare("PRAGMA quick_check").get();
  ok("quick_check=" + Object.values(ic)[0]);
  let total = 0, active = 0;
  for (const lv of LEVELS) {
    try {
      const r = db.prepare("SELECT COUNT(*) c, SUM(status='active') a FROM " + lv).get();
      total += r.c ?? 0; active += r.a ?? 0;
      if ((r.c ?? 0) > 0) ok(lv.padEnd(8) + " 总数 " + r.c + " / active " + (r.a ?? 0));
    } catch { }
  }
  ok("合计 " + total + " 条，active " + active + " 条");
  try {
    const rev = db.prepare("SELECT COUNT(*) c, MIN(at) m FROM memory_rev").get();
    ok("memory_rev " + rev.c + " 条" + (rev.m ? "，最早 " + new Date(rev.m).toISOString().slice(0, 10) : ""));
    if ((rev.c ?? 0) > 50000) warns.push("memory_rev 已 " + rev.c + " 条，考虑调小 audit.keepPerId / keepDays");
  } catch { warns.push("没有 memory_rev 表（审计未启用或插件未重启）"); }

  console.log("== 房间");
  try {
    const rooms = db.prepare("SELECT * FROM scope_room").all();
    if (rooms.length === 0) ok("（没有房间，全部记忆对所有者可见）");
    for (const r of rooms) {
      const members = db.prepare("SELECT session_id, can_read, can_write, parent_session FROM scope_member WHERE room = ?").all(r.name);
      const expired = r.expires_at != null && Date.now() > Number(r.expires_at);
      ok(r.name + "  读=" + r.can_read + " 写=" + r.can_write + " 过期=" + (r.expires_at ? new Date(Number(r.expires_at)).toISOString().slice(0, 10) : "永久") + (expired ? " [已过期]" : "") + "  成员 " + members.length);
      if (members.length === 0) warns.push("房间 " + r.name + " 没有成员（除了 owner 谁都进不去）");
    }
    const grants = db.prepare("SELECT session_id, room, expires_at FROM scope_grant WHERE expires_at > ?").all(Date.now());
    for (const g of grants) ok("临时授权 " + g.session_id + " → " + g.room + " 至 " + new Date(Number(g.expires_at)).toISOString().slice(0, 16));
  } catch { ok("（无 scope_room 表：房间功能未启用）"); }
} finally { db.close(); }

console.log("== 备份");
const bak = dbPath + ".bak";
if (!existsSync(bak)) { warns.push("没有自动备份文件（backup.enabled 未开，或 dream 还没跑过）"); }
else {
  const b = statSync(bak);
  const days = Math.round((Date.now() - b.mtime.getTime()) / 86400000);
  ok("memory.db.bak " + (b.size / 1048576).toFixed(2) + " MB，" + days + " 天前");
  if (days > 7) warns.push("自动备份已 " + days + " 天没更新（dream 没跑或 backup 关了）");
}

if (warns.length > 0) {
  console.log("== WARN（" + warns.length + "）");
  for (const w of warns) console.log("  ! " + w);
} else {
  console.log("== 一切正常，无告警");
}
process.exit(warns.length > 0 ? 1 : 0);
