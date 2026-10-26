# global_memory

> DeepSeek Harness 的「全局记忆」插件。基于 [meow-memory](https://github.com/Phant0Meow/dsh-meow-memory) 0.31.1 的 fork（MIT），
> 增加共享库、注入收窄、三层遗忘、审计版本表与房间可见性。
>
> 仓库：<https://github.com/xingyin846/dsh-global-memory>

## ⚠️ 记忆存在哪里（装完必读）

**默认不是全局。** 位置只看 `dbPath` 这一个配置：

| 情况 | 记忆库落在哪 | 是否真全局 |
|---|---|---|
| 装完**不配置** | **每个工作区各一份**：`<工作区>/.dsh-meow/memory.db` | ❌ 换工作区看不到彼此 |
| 配了 `dbPath` 绝对路径 | 那**一个文件**，所有工作区共用 | ✅ 真全局 |
| 只在一个工作区用 | 该工作区的 `.dsh-meow/memory.db` | ⚠️ 像是全局，其实只有一份库 |

代码就是这么判的：

```js
if (dbPath 非空) return dbPath;                    // 配了 = 全局
return join(工作区, projectDir, "memory.db");      // 没配 = 按工作区
```

**两个容易混淆的地方**：

1. `homeDir`（默认 `~/.dsh-meow`）只放 `gm-runtime.json` / `perf.log` / `window-index.json` 这类**实例级日志**，**不是记忆**；
2. 记忆上的 `project: "全局"` **只是分类标签**，不代表物理全局 —— 没配 `dbPath` 时，它只存在“写它的那个工作区”的库里。

### 想开箱即全局？三条建议

1. **配一个绝对路径**（最稳）：
   ```yaml
   - id: global_memory
     config:
       dbPath: 'C:\\Users\\<你>\\.dsh-memory\\memory.db'
       homeDir: 'C:\\Users\\<你>\\.dsh-memory'   # 可选：日志也放一起
   ```
   ⚠️ 当前版本**不支持 `~` 展开**，请写绝对路径；改完必须重启 DSH。
2. **装完先自检**：`node tools/doctor.mjs`，第一行就会打印 `dbPath=` —— 一看就知道自己是“全局”还是“按工作区”。
3. **多台机器别共用同一个库文件**：本插件没有跨机同步，共用网盘同步 SQLite 会锁冲突；要跨机请用备份/合并，不要直接共享文件夹。

## 它解决什么

DSH 默认每个工作区各一份记忆库，换窗口就看不到别的项目。本插件让**所有工作区共用一份库**，
并在首轮只注入「用户偏好 + 全局准则」（带字符上限），避免每轮把全部记忆塞进上下文。

## 安装

```bash
dsh plugin add ./global_memory-0.31.1-gm.3.tgz
```

装完**重启 DSH**。首次写入会在 `<工作区>/<projectDir>/memory.db` 建库（默认 `projectDir=.dsh-meow`）。

## 最小配置（`profiles/<你的 profile>/cordis.patch.yml`）

```yaml
- id: global_memory
  config:
    dbPath: 'D:\\work\\.dsh-memory\\memory.db'   # 想共享就填绝对路径；留空 = 每工作区一份
    projectDir: '.dsh-memory'
    homeDir: 'D:\\work\\.dsh-memory'              # 实例级日志目录（可选）
    hitTopK: 3
    inject: { userMaxChars: 12000, rulesMaxChars: 12000, keepProjectList: true }
    forget:  { enabled: true, mode: 'dry-run', maxAgeDays: 180, maxImportance: 2 }
    backup:  { enabled: true }
    audit:   { enabled: true, keepPerId: 20, keepDays: 90 }
    scope:   { enabled: false }        # 房间（私密记忆），默认关
```

⚠️ 改配置后**必须重启 DSH**；是否生效看 `gm-runtime.json` 的 `at`。

## 三条安全边界（务必先读）

1. **库是明文 SQLite**：`scope` 房间是「礼貌隔离」不是加密 —— 能读文件的人都能直接查库。
2. **房间绑定会话 id**：换机器或新开会话要重新加成员。
3. **删除都是软删**：记忆不会物理消失（`status=archived` + 归档 md）；卸载插件不会删库。

## 工具（都在包内 `tools/`）

| 命令 | 作用 |
|---|---|
| `node tools/doctor.mjs` | 体检：库路径/行数/配置是否生效/房间/审计/备份；退出码 0=健康 |
| `node tools/verify.mjs` | 自检 18 条（默认自带夹具，`GM_VERIFY_PROD=1` 才用生产库副本） |
| `node tools/rev.mjs recent/list/diff/rollback` | 审计版本表：谁改了什么、怎么回滚 |
| `node tools/rooms.mjs list/show/create/add/del/expire/grant/revoke/can/why` | 房间与临时授权 |
| `node tools/patch.mjs` / `selftest.mjs` / `repair-profile.mjs` | 上游升级重放补丁 / 临时库自测 / profile 体检与重装 |

库路径解析：`GM_DB` → `gm-runtime.json` 的 `dbPath` → 从当前目录向上找 `.dsh-memory`/`.dsh-meow` → 家目录。

## 卸载

从 profile 的 `bundles` 删掉对应条目 → 删 `node_modules` 下目录 → 重启。**数据目录保留**，自行处理。

## 已知限制

- Node ≥ 22.5（依赖 `node:sqlite`）；
- 面向上游 meow-memory 0.31.x 与 DSH 0.2.x；≤0.26 在 0.2.x 上会卡 pending，不可用；
- 新增文案目前以中文为主，英文覆盖在补。

## 许可

MIT。上游 meow-memory 版权归原作者，本 fork 保留其许可与署名。
