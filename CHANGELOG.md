# CHANGELOG

## 0.31.1-gm.3（2026-10-26）

- 审计保留策略：每个 id 保留最近 20 条 `memory_rev`，全表按 90 天清理（`audit.keepPerId` / `audit.keepDays` 可配）
- 修复：旧 id 迁移条件过宽（只放过 9 位字母数字+连字符），会静默改写自定义 id；现只迁移纯数字时间戳 / 8 位 hex
- 修复：房间成员写入被误判为非成员（改为按成员权限解析的 `gmActiveRooms`）
- 新增：房间过期、只读房间、多房间归属（任一命中）、子会话委派（不可越权）、临时授权 grant / revoke
- 打包：`files` 补 `tools/**` 与文档；声明 `engines.node >= 22.5`（依赖 `node:sqlite`）

## 0.31.1-gm.2

- 检索状态面：stale 可检索但降权（×0.4），archived 默认不检索
- 初阶审计：`memory_rev` 记录每次改动前后整行 + actor / actor_wl

## 0.31.1-gm.1

- fork 自 meow-memory 0.31.1：共享库 `dbPath`、首轮注入字符上限、三层遗忘（curator）
