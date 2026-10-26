// tools/repair-profile.mjs — 修复 global_memory 在 profile 里的注册。
//
// 用法：
//   node tools/repair-profile.mjs            # 重装插件目录 + 确保 bundles 里有 global_memory
//   node tools/repair-profile.mjs --rollback # 回到 meow-memory（读 package.json.bak-gm）
//   node tools/repair-profile.mjs --status   # 只检查当前状态，不改任何东西
import { existsSync, readFileSync, writeFileSync, cpSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, "..");
const PROFILE = "C:/Users/13357/AppData/Roaming/dsh-launcher/dsh-packs/pack-test/profiles/pack-test";
const DST = join(PROFILE, "node_modules", "global_memory");
const PKG = join(PROFILE, "package.json");
const PATCH = join(PROFILE, "cordis.patch.yml");
const mode = process.argv[2] ?? "";

function status() {
  const pkg = readFileSync(PKG, "utf8");
  const bundles = JSON.parse(pkg).dsh?.profile?.bundles ?? [];
  const patch = existsSync(PATCH) ? readFileSync(PATCH, "utf8") : "";
  const clientId = existsSync(join(DST, "lib", "client.js"))
    ? (/id: "([^"]+)"/.exec(readFileSync(join(DST, "lib", "client.js"), "utf8").slice(0, 200))?.[1] ?? "?")
    : "(missing)";
  let marker = "(missing)";
  try {
    const m = join(process.env.USERPROFILE ?? "C:/Users/13357", ".dsh-meow", "gm-runtime.json");
    if (existsSync(m)) marker = JSON.parse(readFileSync(m, "utf8")).at;
  } catch {
  }
  console.log(JSON.stringify({
    bundles,
    hasGlobalMemoryBundle: bundles.includes("global_memory"),
    bundleDirExists: existsSync(DST),
    clientBundleId: clientId,
    patchHasConfig: /- id: global_memory/.test(patch),
    lastApplyAt: marker
  }, null, 2));
}

function copyTree(from, to) {
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, {
    recursive: true,
    filter: (p) => !p.endsWith(".map") && !p.endsWith(".upstream.js") && !p.includes(`${SRC}\\tools`) && !p.includes(`${SRC}/tools`)
  });
}

function ensureBundle() {
  const raw = readFileSync(PKG, "utf8");
  if (raw.includes('"global_memory"')) {
    console.log("bundles 已含 global_memory，无需改动");
    return;
  }
  const anchor = '        "@linxin666/dsh-web-all"\n';
  if (!raw.includes(anchor)) throw new Error("找不到 bundles 锚点（@linxin666/dsh-web-all 行），请手工检查 package.json");
  const next = raw.replace(anchor, '        "@linxin666/dsh-web-all",\n        "global_memory"\n');
  JSON.parse(next); // 写前先验证是合法 JSON
  writeFileSync(PKG, next, "utf8");
  console.log("已把 global_memory 加回 bundles");
}

if (mode === "--status") {
  status();
} else if (mode === "--rollback") {
  for (const [from, to] of [["package.json.bak-gm", "package.json"], ["cordis.patch.yml.bak-gm", "cordis.patch.yml"]]) {
    const a = join(PROFILE, from), b = join(PROFILE, to);
    if (!existsSync(a)) throw new Error(`缺少回滚文件 ${a}`);
    writeFileSync(b, readFileSync(a));
    console.log(`rolled back: ${to}`);
  }
  console.log("已回滚到 meow-memory；刷新页面生效。");
} else {
  copyTree(SRC, DST);
  console.log(`插件目录已重装: ${DST}`);
  ensureBundle();
  console.log("完成。等 3~10 秒让宿主热加载，然后刷新页面；用 --status 复核。");
  status();
}
