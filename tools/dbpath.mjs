// tools/dbpath.mjs —— 统一解析记忆库路径（rev / rooms / doctor 共用）
// 优先级：GM_DB → GM_HOME/DSH_MEOW_HOME → 从 cwd 向上找 .dsh-memory/gm-runtime.json → ~/.dsh-meow
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

function ancestors(start, max = 5) {
  const out = [];
  let cur = start;
  for (let i = 0; i < max; i += 1) {
    out.push(cur);
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return out;
}

export function resolveHome() {
  const explicit = [process.env.GM_HOME, process.env.DSH_MEOW_HOME].filter(Boolean);
  const found = explicit.find((h) => existsSync(join(h, "gm-runtime.json")));
  if (found) return found;
  for (const dir of ancestors(process.cwd())) {
    for (const name of [".dsh-memory", ".dsh-meow"]) {
      const h = join(dir, name);
      if (existsSync(join(h, "gm-runtime.json"))) return h;
    }
  }
  for (const name of [".dsh-memory", ".dsh-meow"]) {
    const h = join(homedir(), name);
    if (existsSync(join(h, "gm-runtime.json"))) return h;
  }
  return join(homedir(), ".dsh-meow");
}

export function resolveMarker() {
  try { return JSON.parse(readFileSync(join(resolveHome(), "gm-runtime.json"), "utf8")); } catch { return {}; }
}

export function resolveDbPath() {
  if (process.env.GM_DB) return process.env.GM_DB;
  const m = resolveMarker();
  if (typeof m.dbPath === "string" && m.dbPath.length > 0) return m.dbPath;
  return join(resolveHome(), "memory.db");
}
