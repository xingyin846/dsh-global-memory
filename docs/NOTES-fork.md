# global_memory

基于 **meow-memory 0.31.1** 的 fork（路线 B：复制包 + 在产物上定点打补丁）。
给 DSH 提供：**跨工作区共享同一个记忆库 + 首轮注入收窄 + 三层遗忘**。

- 运行位置：`<profile>/node_modules/global_memory`（profile 的 `dsh.profile.bundles` 里已从 `meow-memory` 换成 `global_memory`）
- 上游原件：`lib/index.upstream.js`（**只读基线**，不要改）
- 产物：`lib/index.js`（由 `tools/patch.mjs` 从上游 + 两个增补文件生成）
- 版本：`0.31.1-gm.1` = 上游 0.31.1 + 我们的第 1 版补丁

## 改了哪 5 处（全部在 tools/patch.mjs 里可查）

| # | 改动 | 目的 |
|---|---|---|
| 1 | `memoryDbPath()` 优先返回配置的 `dbPath` | 所有工作区读写同一个 SQLite 库 |
| 2 | `getDb()` 缓存键改成真实库路径 | 同一个库只开一条连接，不按工作区重复打开 |
| 3 | `buildInjectionBody()`：user/rules 按 importance+更新时间排序后按字符上限截断；可关项目名列表；末尾加「记忆优先」硬指令 | 首轮从 6.9 万字符降到约 2.5 万 |
| 4 | 新增配置 `dbPath` / `inject{...}` / `forget{...}` + `resolveConfig` 兜默认值 | 全部行为可配，不用改代码 |
| 5 | 新增 `memory_forget` 工具 + 定时 curator（`scheduleForget`），并注册/清理 | 三层遗忘的存储面（只归档不删除） |

> 未改的部分：客户端 `lib/client.js`（折叠横条、设置页）原样保留；消息来源标记仍是 `plugin:meow-memory`（保证旧会话的折叠横条照常识别）；`SETTINGS_NS` 仍是 `meow-memory`（设置页仍能读写同一份配置）。

## 配置（profile 的 cordis.patch.yml）

```yaml
- id: global_memory
  config:
    promptLang: 'zh'
    dbPath: 'D:\work\.dsh-meow\memory.db'   # 空 = 退回“每个工作区各一份库”
    hitTopK: 3
    inject:
      userMaxChars: 12000    # 0 = 不限
      rulesMaxChars: 12000
      keepProjectList: true
      preferLine: true
    forget:
      enabled: true
      mode: dry-run          # dry-run | apply（双轨期先 dry-run）
      maxAgeDays: 180
      maxImportance: 2
      batchLimit: 50
      archiveDir: 'D:\work\记忆\遗忘'
      checkHours: 24
```

生效确认：插件加载时会写 `C:\Users\13357\.dsh-meow\gm-runtime.json`（含 pid/时间/实际生效配置）。
**这个文件的时间戳就是“新插件真的加载了”的证据。**

## 三层遗忘

| 面 | 实现 | 现状 |
|---|---|---|
| 检索面 | 上游 `recencyWeight`（1 天 1.0 → 半年 0.08，只压 `importance<3` 且非榜首） | 已有，未改 |
| 注入面 | `inject.userMaxChars / rulesMaxChars` | 已生效：6.87 万 → 2.47 万字符 |
| 存储面 | `memory_forget` 工具 + 每 `checkHours` 定时 curator：候选 = `levels` 内 `importance ≤ maxImportance` 且 `hit_count=0` 且最后活动 ≥ `maxAgeDays`；动作 = 先写归档案，再 `status='archived'` | 默认 dry-run；今天命中 0 条（库最老 54 天） |

**白名单（代码强制，不受配置影响）**：`user` / `soul` 永不入选；`rules` 跳过；`project` 只允许 `subcategory='todo'`；`lesson.corrected=1` 跳过；`importance > maxImportance` 跳过。

**dry-run 也会写归档案**（`archiveDir`，默认 `<库目录>/forget-archive`），便于复核。
**复活一条**：`UPDATE <level> SET status='active' WHERE id='<完整 id>'`。

## 升级上游（每次 meow-memory 发新版）

```powershell
# 1. 取新版（npm pack 或从 profile 的 node_modules 取）
npm pack meow-memory@<新版> --cache D:\work\_dl_tmp\.npmcache
tar -xzf meow-memory-<新版>.tgz
# 2. 覆盖基线
cp package/lib/index.js  D:\work\dsh相关\global_memory\lib\index.upstream.js
# 3. 重放补丁（锚点不匹配会直接报错，不会写坏）
cd D:\work\dsh相关\global_memory
node tools/patch.mjs
node --check lib/index.js
# 4. 装机（先备份 profile 两个文件）
copy /y profile\package.json profile\package.json.bak-gm
copy /y profile\cordis.patch.yml profile\cordis.patch.yml.bak-gm
# 5. 覆盖 node_modules\global_memory 后刷新页面，看 gm-runtime.json 是否更新
```

若上游改了被锚定的函数（`memoryDbPath` / `getDb` / `buildInjectionBody` / `registerMemoryTools` / `scheduleDream` / dispose 块），patch.mjs 会报“锚点命中 N 次”并退出——按新结构改 `tools/patch.mjs` 对应条目即可。

## 回滚

```powershell
cd <profile>
copy /y package.json.bak-gm package.json
copy /y cordis.patch.yml.bak-gm cordis.patch.yml
# 刷新页面即回到 meow-memory（包仍在 node_modules 里，没删）
```

## 客户端 bundle 的 id 规则（2026-10-25 事故记录）

**客户端 `lib/client.js` 里 `__ModuleLoader__.load({ id })` 的 id 必须等于包名**（本例 `global_memory`）。
写成上游名会得到：

```
web boot: 1 entry did not activate
global_memory: import failed: ... loaded without registering "global_memory" via __ModuleLoader__.load
```

随后**启动器会把 `global_memory` 从 `profile\package.json` 的 bundles 里自动摘掉**，记忆工具整组消失。
修法：改 client id → 重装插件目录 → 把 bundle 加回 bundles → 等热加载（`perf.log` 出现新的 `apply #`，`gm-runtime.json` 时间戳更新）。
保持上游名的只有两处：消息来源标记 `PLUGIN_NAME = "meow-memory"`（折叠横条靠它识别历史消息）与 `style.dataset.plugin`（纯装饰）。

## 修复 / 自检 / 回滚（一条命令）

```powershell
cd D:\work\dsh相关\global_memory
node tools/repair-profile.mjs --status    # 只看状态：bundles、目录、client id、配置块、最后 apply 时间
node tools/repair-profile.mjs             # 重装目录 + 确保 bundles 里有 global_memory（改前先验证 JSON）
node tools/repair-profile.mjs --rollback  # 回到 meow-memory（读 package.json.bak-gm / cordis.patch.yml.bak-gm）
```

## 已知限制

1. 客户端设置页不显示 `dbPath/inject/forget` 三个新字段（页面字段是硬编码的）——这些配置走 `cordis.patch.yml`；只改新字段时不会与设置页冲突。
2. 插件 id 与设置命名空间仍沿用 `meow-memory`（为了不打断折叠横条与既有设置）；日志前缀也还是 `meow-memory:`。
3. `dbPath` 指向的网络/移动盘不建议：SQLite 需要本地文件系统语义。

## 验收记录（2026-10-25，临时库副本实测）

| 断言 | 结果 |
|---|---|
| 注入无上限（对照上游） | 68,742 字符 / 179 条 |
| 注入 12k 上限 | **24,699 字符 / 54 条** |
| 末尾「记忆优先」行 | 已插入 |
| dry-run | 造 8 条 400 天老数据 → 命中 8、归档 0、归档案已写 |
| apply（force, limit=3） | 归档 3 条，`status='archived'` |
| 白名单 | rules/user/project/corrected 计数前后不变 |
| 复活 | 一行 SQL → `fact active` 回到 306 |
| 插件真的加载 | `gm-runtime.json` 于 21:38:36 由 pid 22564 写入，`memory_forget` 工具可用 |
| 实库第一次 dry-run | 命中 0 条（库最老 54 天，符合预期） |
