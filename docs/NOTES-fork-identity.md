# 本地身份 vs 发布身份（2026-10-26 定）

**背景**：把包名改成 `@xxmy/dsh-global-memory` 后，本机 profile 的 `bundles`/`cordis id` 一旦同步改，
宿主热重载会以默认配置启动（`dbPath=null`）并误建一个空库 —— 说明 DSH 认插件 id 的规则尚未查清，
**不能拿热重载当验证手段**。

**现行做法（解耦）**：
- **发布身份** = `@xxmy/dsh-global-memory`：源码与 `npm pack` 产物都是这个身份；
- **本机身份** = `global_memory`：本机 profile 的 `bundles` 与 `cordis.patch.yml` 永远指 `global_memory`，
  安装目录是 `node_modules/global_memory`，**不再改动**。

**要把新构建装到本机时**（机械两步，别手改 profile）：

```bash
node tools/patch.mjs
# 然后把产物里的发布身份替换成本机身份：
python -c "import io;p=r'lib/index.js';s=io.open(p,encoding='utf-8').read();io.open(p,'w',encoding='utf-8').write(s.replace('@xxmy/dsh-global-memory','global_memory'))"
# 同样处理 lib/client.js，再复制到 profile 的 node_modules/global_memory/lib/
```

⚠️ 踩过的坑：直接改 profile 的 `bundles`/`cordis id` 会触发**热重载**，配置不匹配就回落默认值并新建空库
（2026-10-26 12:35 实际发生，主库无损，已回滚）。
