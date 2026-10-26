import { MemoryDb, buildInjectionBody, setGmRuntime, gmRunForget } from "../lib/index.js";
const DB = process.argv[2] ?? "D:/work/_dl_tmp/gmtest/memory.db";
const ARCHIVE = process.argv[3] ?? "D:/work/_dl_tmp/gmtest/archive";
const base = {
  projectDir: ".dsh-meow",
  inject: { userMaxChars: 12000, rulesMaxChars: 12000, keepProjectList: true, preferLine: true },
  forget: { enabled: true, mode: "dry-run", maxAgeDays: 180, maxImportance: 2, batchLimit: 50, levels: ["fact", "lesson", "topic"], requireZeroHits: true, archiveDir: ARCHIVE, checkHours: 24 }
};
// A. 不设上限（对照上游行为）
setGmRuntime({ ...base, dbPath: DB, inject: { userMaxChars: 0, rulesMaxChars: 0, keepProjectList: true, preferLine: false } });
let db = new MemoryDb(DB);
let out = buildInjectionBody(db, { titleMax: 40 });
console.log("A 无上限:", out.body.length, "字符 /", out.injectedIds.length, "条");
// B. 默认上限 + 记忆优先行
setGmRuntime({ ...base, dbPath: DB });
out = buildInjectionBody(db, { titleMax: 40 });
console.log("B 12k 上限:", out.body.length, "字符 /", out.injectedIds.length, "条");
console.log("B 末尾:", JSON.stringify(out.body.slice(-120)));
// C. 头尾抽查
console.log("B 开头:", JSON.stringify(out.body.slice(0, 80)));
// D. 遗忘：先把 8 条 fact 的年龄推到 400 天
db.db.prepare("UPDATE fact SET created_at = created_at - 34560000000, updated_at = updated_at - 34560000000, last_accessed_at = NULL, hit_count = 0, importance = 1 WHERE id IN (SELECT id FROM fact WHERE status='active' LIMIT 8)").run();
const r1 = gmRunForget({ apply: false });
console.log("D dry-run:", JSON.stringify({ candidates: r1.candidates, picked: r1.picked, applied: r1.applied, archive: r1.archive.replace(/.*\//, "") }));
const r2 = gmRunForget({ apply: true, force: true, limit: 3 });
const left = db.db.prepare("select status, count(*) c from fact group by status").all();
console.log("E apply force limit=3:", JSON.stringify({ picked: r2.picked, applied: r2.applied }), "fact 状态:", JSON.stringify(left));
// F. 白名单核对：rules/user/project 一条没动
const guard = db.db.prepare("select (select count(*) from rules where status='active') r, (select count(*) from user where status='active') u, (select count(*) from project where status='active') p, (select count(*) from lesson where corrected=1 and status='active') lc").get();
console.log("F 白名单计数:", JSON.stringify(guard));
// G. 复原一条验证可逆
const archived = db.db.prepare("select id from fact where status='archived' limit 1").get();
if (archived) { db.db.prepare("update fact set status='active' where id=?").run(archived.id); }
console.log("G 复活后 fact active:", db.db.prepare("select count(*) c from fact where status='active'").get().c);
