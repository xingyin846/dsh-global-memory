# global_memory

> A "global memory" plugin for DeepSeek Harness. Fork of [meow-memory](https://github.com/Phant0Meow/dsh-meow-memory) 0.31.1 (MIT),
> adding a shared database, capped first-turn injection, three-layer forgetting, an audit revision table and room visibility.
>
> Repo: <https://github.com/xingyin846/dsh-global-memory>

## WHERE DOES THE MEMORY LIVE (read this first)

**Not global by default.** Location is decided by one setting, `dbPath`:

| Setup | Where the DB lands | Truly global? |
|---|---|---|
| Installed, no config | one DB **per workspace**: `<workspace>/.dsh-meow/memory.db` | no |
| `dbPath` set to an absolute path | that single file, shared by all workspaces | yes |
| Used in one workspace only | that workspace `.dsh-meow/memory.db` | looks global, but there is only one DB |

```js
if (dbPath) return dbPath;                          // set = shared
return join(workspace, projectDir, "memory.db");    // unset = per workspace
```

Two common confusions: `homeDir` (default `~/.dsh-meow`) only holds instance logs (`gm-runtime.json`, `perf.log`, ...), **not memory**;
and `project: "全局"` on a memory is **just a tag** — without `dbPath` it stays inside the workspace that wrote it.

### Recommendations

1. **Set an absolute `dbPath`** (and optionally `homeDir`). `~` is **not** expanded in the current version. Restart DSH after editing.
2. **Run `node tools/doctor.mjs` right after install** — its first line prints `dbPath=`, so you immediately know which mode you are in.
3. **Do not share one DB file across machines** (SQLite over sync folders causes lock conflicts); use backup/merge instead.

## Why

By default DSH keeps one memory DB per workspace, so a new window cannot see other projects. This plugin makes **all workspaces share one DB**
and injects only "user preferences + global rules" on the first turn (with a character budget).

## Install

```bash
dsh plugin add ./global_memory-0.31.1-gm.3.tgz
```

Restart DSH afterwards.

## Minimal config (`profiles/<profile>/cordis.patch.yml`)

```yaml
- id: global_memory
  config:
    dbPath: '/absolute/path/to/memory.db'   # empty = one DB per workspace
    projectDir: '.dsh-memory'
    homeDir: '/absolute/path/to/home'        # instance-level logs (optional)
    hitTopK: 3
    inject: { userMaxChars: 12000, rulesMaxChars: 12000, keepProjectList: true }
    forget:  { enabled: true, mode: 'dry-run', maxAgeDays: 180, maxImportance: 2 }
    backup:  { enabled: true }
    audit:   { enabled: true, keepPerId: 20, keepDays: 90 }
    scope:   { enabled: false }
```

Restart is required for any config change; check `gm-runtime.json` (`at`) to confirm it took effect.

## Boundaries

1. The database is **plain SQLite** — rooms are polite isolation, not encryption.
2. Room membership is bound to session ids; new sessions/machines must be added again.
3. Deletion is always soft (`status=archived`); uninstalling never deletes data.

## Tools

| Command | Purpose |
|---|---|
| `node tools/doctor.mjs` | Health: DB path, row counts, effective config, rooms, audit, backup (exit 0 = healthy) |
| `node tools/verify.mjs` | 18 self-checks on a fresh fixture (`GM_VERIFY_PROD=1` uses a copy of the production DB) |
| `node tools/rev.mjs recent/list/diff/rollback` | Audit revision table: who changed what, and rollback |
| `node tools/rooms.mjs ...` | Rooms: create / members / delegation / temporary grants |

DB path resolution: `GM_DB` → `gm-runtime.json` `dbPath` → walk up from cwd for `.dsh-memory`/`.dsh-meow` → home dir.

## Requirements

Node >= 22.5 (`node:sqlite`), DSH 0.2.x, upstream meow-memory 0.31.x.

## License

MIT; upstream copyright belongs to the original author.
