# 参考

cloud 集成的底层依据、目录结构和 HTTP 接口。返回 [README](../README.zh-CN.md)。

## 为什么在 cloud 里能这样做

下面这些结论来自读 Claude Code CLI 源码和在真实 cloud session 里的测试，整个设计建立在它们之上。

- **开关。** 设置了 `CLAUDE_CODE_REMOTE`（所有 cloud session 都有）且没设置 `CLAUDE_CODE_REMOTE_MEMORY_DIR` 时，CLI 会关闭原生自动记忆。
- **文档没写的开关。** 把 `CLAUDE_CODE_DISABLE_AUTO_MEMORY` 设成 `0` 会走「强制开启」分支，不管上面那个条件。官方文档里没有这个行为（见「风险和限制」）。
- **`settings.json` 会被读取。** 文档说 cloud 不读用户级 `~/.claude/settings.json`，意思只是你本机的那个文件不会被带上云。**容器里由 setup script 写入的同一个文件会被正常读取**，其中的 `hooks`、`env`、`autoMemoryDirectory` 都生效。
- **时序。** 宿主会等 SessionStart hook 执行完。Hook 写入的 `MEMORY.md` 和 `~/.claude/CLAUDE.md` 都出现在第一轮的上下文里（实测，hook 里 sleep 5 秒也一样）。Claude Code 给这个文件的标签是「user's private global instructions for all projects」，和原生一致，文件里的 `@/绝对路径` 引用也有效。Setup script 写的 `CLAUDE.md` 会被 hook 的版本覆盖。会话中途的修改不会重新渲染进上下文。
- **network secret 注入。** 在环境里配置的 network secret 会让出口代理给发往该主机的请求加上 `Authorization: Bearer <secret>`。Hook 发出的请求走代理，所以 `memsync.py` 自己不持有 token。setup script 执行时代理不会注入 secret，所以客户端下载接口（`/client/memsync.py`）是公开的，里面也没有任何密钥。
- **setup script 快照缓存。** Setup script 的执行结果会作为容器快照缓存约 7 天，修改 setup script（或允许的网络主机）会让缓存重建。所以更新客户端要靠改 setup script，见「更新客户端」。

## 目录结构

| 路径 | 作用 |
|---|---|
| `worker/index.js` | Worker 入口（自部署服务原样运行它）：bearer 鉴权、pull、push、resolve、move、history、restore、status，`/admin*` 转给 `admin.js` |
| `worker/store.js` | 共用写入路径：`writeRow`（sha 乐观锁 + 历史行）、`applyOne`、`restoreAt`、`recordStatus`，路径规则，三方行合并 |
| `worker/layers.js` | 分层：仓库 URL 归一化、`/v1/resolve` 与 submodule 归属、并入父项目、按层 pull、保留历史的移动、合并项目 |
| `worker/migrations/` | 带版本号的 SQL 迁移（`NNN_name.sql`），由 `deploy.sh` 和自部署服务应用 |
| `tools/migrate-layers.mjs` | 按 JSON 计划把已有的扁平记忆库搬进各层（默认只演练） |
| `docs/design-cloud-v3.md` | 设计文档：已验证的事实、模型、算法、上线顺序、测试、限制 |
| `worker/admin.js`、`worker/admin.html` | 管理后台：Access JWT 校验、自部署的登录 session 或代理 header 认证、`/admin/api/*`、单文件前端（EN/中文） |
| `worker/memsync.py` | Hook 客户端（只用 Python 标准库），由 Worker 以 `/client/memsync.py` 公开提供，内容不含任何密钥 |
| `worker/schema.sql` | D1 表结构（`files`、`history`、`sync_events`、`schema_version`、`repo_membership`、`projects`） |
| `deploy.sh` | 用 Cloudflare REST API 部署：D1、schema、Worker、可选的 Custom Domain |
| `deploy.env.example` | 部署配置模板（复制为 `deploy.env`，该文件已被 gitignore） |
| `setup-script.template.sh` | 环境 setup script 模板，`deploy.sh` 会填入你的 URL |
| `selfhost/server.mjs` | 自部署运行时：基于 `node:sqlite` 的 D1 shim，加一层 `node:http` 适配器包住 Worker 的 `fetch()` |
| `selfhost/text-loader.mjs` | Node 模块钩子，把 `memsync.py` 和 `admin.html` 当字符串模块加载（对应 Cloudflare 的 Text module） |
| `selfhost/Dockerfile`、`selfhost/docker-compose.yml`、`selfhost/env.example` | 容器镜像、compose 文件（含注释掉的 Caddy 示例）、配置模板 |
| `selfhost/render-setup-script.sh` | 把你的 URL 填进 setup script 模板（相当于自部署版的 `deploy.sh` 这一步） |
| `tests/` | 测试，用 `npm test` 运行，分别跑在 `wrangler dev --local` 和自部署服务上（用 `BACKEND=cf` 或 `BACKEND=node` 只跑其中一个） |

## 接口和并发规则

除 `/health` 和 `/client/memsync.py` 外，都需要 `Authorization: Bearer <token>`。在已配置 network secret 的 cloud 会话里直接 `curl` 就行，代理会自动带上这个头。

| 方法和路径 | 说明 |
|---|---|
| `GET /health` | 健康检查 |
| `GET /client/memsync.py` | 下载 hook 客户端 |
| `GET /v1/pull` | **不带参数**：只返回旧版根目录的文件（v1/v2 客户端依赖这个行为）`{files:[{path,content,sha,modified}]}` |
| `GET /v1/pull?projects=<pid>,<pid>&global=1` | `global/CLAUDE.md` 和这些项目的文件 |
| `POST /v1/resolve` | `{repos:[{url, submodules:[url...]}]}` → 记录 submodule 归属，把后来才学到归属的项目并入父项目，返回 `{projects:[pid...], map:{url: pid}}` |
| `POST /v1/move` | `{from, to}`：移动单个文件并保留历史；索引移到索引上会合并，其他重名返回 409 |
| `POST /v1/move-prefix` | `{from_prefix, to_prefix}`（都以 `/` 结尾）：移动整个文件夹；重名文件加 `.2` 后缀，索引合并 |
| `POST /v1/push` | `{session, files:[{path, content\|null, base_sha, added_lines?, removed_lines?, on_conflict?}]}` |
| `GET /v1/history?path=&limit=&content=1` | 修改历史 |
| `POST /v1/status` | 客户端上报同步结果 `{session, event: pull\|push, ok, error, files, cli_version, auto_memory, cwd_name, projects}`，写入 `sync_events`（只保留最新约 2000 条） |
| `POST /v1/restore` `{at: 毫秒时间戳}` | 把全部文件恢复到该时间点的状态（恢复操作本身也会记入历史，可以撤销） |

`sha` 是文件内容 UTF-8 的 SHA-256 十六进制值。路径只允许字母、数字和 `._-/`，以 `.md` 结尾，最长 200 个字符，不能含 `..`；单个文件上限 200 KB；每次 push 最多 500 个文件。分层路径只有 `global/CLAUDE.md` 和 `projects/<host>/<owner>/<repo>/<file>.md`（或 `projects/_norepo/<file>.md`）两种，其他路径都是旧版根目录文件。push 时可以给新文件带上 `routed_by`，表示客户端是按兜底规则选的项目。

规则：

- **普通记忆文件。** 服务器上的版本和客户端的 `base_sha` 一致就直接写入；不一致时以后写的为准，旧版本保留在 `history` 里。
- **新文件。** 带 `on_conflict: "rename"`（当前客户端都会带）的新文件（`base_sha` 为空），如果路径已被别的会话占用，服务器把它存成 `<名字>.<n>.md`，返回 `{status: "renamed", to}`；客户端随之给本地文件改名，并改好 `MEMORY.md` 里的链接。不带这个参数时按上一条处理。
- **`MEMORY.md`（任意项目）和 `global/CLAUDE.md`。** 冲突时服务器从 `history` 里找到客户端的基准版本，做按位置的三方合并（diff3）：两边的修改各自留在原来的位置，空行和小节结构都保留。两边改了同一段时，保留服务器的行，删掉本客户端删掉的行，加上本客户端新增的行。基准版本在历史里找不到时，退回到追加新增行的做法。合并结果会回写到本地。
- **删除。** 只有服务器版本没变过才删除；别的会话改过的话，保留修改后的版本，并恢复到本地。
- **原子性。** 同一路径的写入带乐观锁（`WHERE sha = ?`），冲突时最多重试 4 次。
