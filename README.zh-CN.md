# claude-code-cloud-memory

[English](README.md) | 简体中文

给 Claude Code **cloud session**（claude.ai/code）补上跨会话记忆。记忆存在你自己部署的 Cloudflare Worker + D1 里。

Cloud session 每次都在全新的容器里运行，并且默认关闭了原生自动记忆。这个项目在容器里把原生自动记忆重新打开，再把记忆目录同步到你的 Worker：新会话启动时拉取，每轮回复结束时推送。记忆的格式、加载方式、写入规则都沿用 Claude Code 原生机制，所有项目、所有会话共用同一个记忆库。

主要特性：

- 原生自动记忆（`MEMORY.md` 索引加每条记忆一个 `.md` 文件），模型侧没有任何自定义逻辑。
- 服务端：sha 乐观锁、按文件后写者胜、`MEMORY.md` 三方行合并、完整历史和回滚。
- 管理后台（浏览器）放在 Cloudflare Access 后面：查看、编辑、新建、删除，单个文件的历史，整体回滚，同步状态面板。中英文界面。
- 访问 token 不出现在环境变量、URL 和仓库里（它是 cloud 环境的 network secret）。
- 出错看得见：对话里的 hook `systemMessage`、管理后台状态面板、Workers Logs。

## 工作原理

```
新会话启动（容器由你的环境 setup script 预先配置好）
  └─ SessionStart hook: memsync.py pull
       GET https://<你的域名>/v1/pull  →  写入 /root/memory/
       └─ Claude Code 按原生机制加载 /root/memory/MEMORY.md（前 200 行或 25 KB）
工作中
  └─ Claude 按原生规则写记忆：每条一个 .md 文件（带 frontmatter），并更新 MEMORY.md 索引
每轮回复结束（Stop hook）/ 会话结束（SessionEnd hook）
  └─ memsync.py push：把和上次同步相比有变化的文件 POST 到 /v1/push

              ┌──────────────────────────── Claude cloud 容器 ────────────────────────────────┐
              │ ~/.claude/settings.json（由 setup script 写入）                                │
              │   env: CLAUDE_CODE_DISABLE_AUTO_MEMORY=0, MEMSYNC_URL, MEMSYNC_DIR            │
              │   autoMemoryDirectory: /root/memory                                            │
              │   hooks: SessionStart pull · Stop push · SessionEnd push                       │
              └───────────────┬────────────────────────────────────────────────────────────────┘
                              │ HTTPS（出口代理自动加  Authorization: Bearer <network secret>）
                              ▼
                  Cloudflare Worker  ──  D1（files、history、sync_events）
                        ▲
        /admin（Cloudflare Access JWT）  ←  你的浏览器
```

## 为什么在 cloud 里能这样做

下面这些结论来自读 Claude Code CLI 源码和在真实 cloud session 里的测试，整个设计建立在它们之上。

- **开关。** 设置了 `CLAUDE_CODE_REMOTE`（所有 cloud session 都有）且没设置 `CLAUDE_CODE_REMOTE_MEMORY_DIR` 时，CLI 会关闭原生自动记忆。
- **文档没写的开关。** 把 `CLAUDE_CODE_DISABLE_AUTO_MEMORY` 设成 `0` 会走「强制开启」分支，不管上面那个条件。官方文档里没有这个行为（见「风险和限制」）。
- **`settings.json` 会被读取。** 文档说 cloud 不读用户级 `~/.claude/settings.json`，意思只是你本机的那个文件不会被带上云。**容器里由 setup script 写入的同一个文件会被正常读取**，其中的 `hooks`、`env`、`autoMemoryDirectory` 都生效。
- **时序。** SessionStart hook 写入的 `MEMORY.md` 来得及在第一轮被加载。
- **network secret 注入。** 在环境里配置的 network secret 会让出口代理给发往该主机的请求加上 `Authorization: Bearer <secret>`。Hook 发出的请求走代理，所以 `memsync.py` 自己不持有 token。setup script 执行时代理不会注入 secret，所以客户端下载接口（`/client/memsync.py`）是公开的，里面也没有任何密钥。
- **setup script 快照缓存。** Setup script 的执行结果会作为容器快照缓存约 7 天，修改 setup script（或允许的网络主机）会让缓存重建。所以更新客户端要靠改 setup script，见「更新客户端」。

## 目录结构

| 路径 | 作用 |
|---|---|
| `worker/index.js` | Worker 入口：bearer 鉴权、pull、push、history、restore、status，`/admin*` 转给 `admin.js` |
| `worker/store.js` | 共用写入路径：`writeRow`（sha 乐观锁 + 历史行）、`applyOne`、`restoreAt`、`recordStatus` |
| `worker/admin.js`、`worker/admin.html` | 管理后台：Access JWT 校验、`/admin/api/*`、单文件前端（EN/中文） |
| `worker/memsync.py` | Hook 客户端（只用 Python 标准库），由 Worker 以 `/client/memsync.py` 公开提供，内容不含任何密钥 |
| `worker/schema.sql` | D1 表结构（`files`、`history`、`sync_events`） |
| `deploy.sh` | 用 Cloudflare REST API 部署：D1、schema、Worker、可选的 Custom Domain |
| `deploy.env.example` | 部署配置模板（复制为 `deploy.env`，该文件已被 gitignore） |
| `setup-script.template.sh` | 环境 setup script 模板，`deploy.sh` 会填入你的 URL |
| `tests/` | 本地测试（`wrangler dev --local`），用 `npm test` 运行 |

## 快速开始

需要：Cloudflare 账号；部署所在的机器上有 `bash`、`curl`、`jq`，以及 `openssl` 或 `python3`。

### 1. 创建 Cloudflare API token

Cloudflare 控制台 → My Profile → API Tokens → Create Token，权限：

- Account · Workers Scripts · Edit
- Account · D1 · Edit
- Account · Account Settings · Read（让 `deploy.sh` 自动识别账户）
- 只有用自定义域名时才需要：Zone · DNS · Edit 和 Zone · Zone · Read，范围限定到你的 zone

可以从「Edit Cloudflare Workers」模板出发，再加上 「Account · D1 · Edit」和「Zone · DNS · Edit」。客户端 IP 过滤留空。

### 2. 配置并部署

```bash
cp deploy.env.example deploy.env
$EDITOR deploy.env          # 至少看一下 HOST（可选），注释里有说明
export CF_API_TOKEN=...     # 也可以写进 deploy.env
./deploy.sh
```

配置项（写在 `deploy.env` 或环境变量里，环境变量优先）：

| 变量 | 默认值 | 含义 |
|---|---|---|
| `CF_API_TOKEN` | 无 | Cloudflare API token。不设置时不发鉴权头（只在有代理注入鉴权的环境里可用） |
| `CF_ACCOUNT_ID` | 自动 | token 能看到多个账户时才需要 |
| `WORKER_NAME` | `claude-memory` | Worker 名称 |
| `D1_NAME` | `claude-memory` | D1 数据库名（已存在则复用） |
| `HOST` | 空 | 自定义域名，如 `memory.example.com`。zone 从你的 zone 列表里按最长后缀匹配找出。留空则保持 `workers.dev` 开启，并使用它的地址 |
| `ACCESS_TEAM_DOMAIN` | 空 | 管理后台用，如 `https://myteam.cloudflareaccess.com` |
| `ACCESS_AUD` | 空 | 管理后台用，Access 应用的 AUD tag |
| `TOKEN_SHA256` | 自动生成 | 访问 token 的 SHA-256 十六进制值 |

第一次运行时，`deploy.sh` 会生成一个随机访问 token，**只打印一次**，本地只把它的 SHA-256 存进 `.token_sha256`（已 gitignore）。打印出来后马上存好：下面要把它填进 network secret，而且无法找回。之后再运行不会意外换掉它：脚本会复用 `.token_sha256`；这个文件不在时（比如换了一台机器、重新 clone 后部署），会保留 Worker 上已有的 token。需要换新 token 时见「常用运维操作」里的轮换步骤。脚本可以重复执行：已有的 D1 会复用，schema 用的是 `IF NOT EXISTS`。

脚本最后会打印填好 URL 的 setup script，以及 network secret 要填的主机。

设置了 `HOST` 时会关闭 `workers.dev` 路由；没设置时保持开启，打印的地址是 `https://<worker>.<你的子域>.workers.dev`。

### 3. 配置 Claude cloud 环境

在 claude.ai/code 的环境设置里：

1. **Network secret**：主机填 `deploy.sh` 打印的那个（如 `memory.example.com`），类型 Bearer，值填第 2 步打印的访问 token。确认该环境的网络访问策略允许这个主机。
2. **Setup script**：粘贴 `deploy.sh` 打印的 setup script（同时保存在 `setup-script.rendered.sh`）。环境原来就有 setup script 的话，把这份追加进去；如果原来的脚本也写 `~/.claude/settings.json`，要手动合并。

想让 hook 的提示用中文，把脚本开头的 `MEMSYNC_LANG=en` 改成 `MEMSYNC_LANG=zh`。

### 4. 验证

在该环境里开一个新的 cloud session，让 Claude 记一件事（「记住我偏好 X」）。然后：

```bash
# 在该环境的任意 cloud session 里运行（代理会自动带上 token）
curl -sS https://memory.example.com/v1/pull | jq -r '.files[] | "== \(.path)\n\(.content)"'
```

再开一个新会话，启动时就会加载这条记忆。同时看一下新会话的系统提示里有没有自动记忆的说明（指向 `/root/memory/`）；没有的话，说明开关没生效，见「排错」。

## 管理后台和 Cloudflare Access

浏览器打开 `https://<你的域名>/admin`：查看、编辑、新建、删除记忆文件，查看每个文件的历史并恢复单个版本，或者整体回滚到某个时间点。页面是单个 HTML，没有外部依赖，手机宽度可用，随系统切换深浅色。语言跟随浏览器（`navigator.language`），顶部有 EN/中文 切换按钮（选择会被记住）。左侧按 frontmatter 的 `metadata.type` 分组，可搜索；新建文件会预填原生 frontmatter，并可顺手在 `MEMORY.md` 末尾追加一行索引。

所有写入都走和同步接口相同的 `writeRow`（sha 乐观锁、写历史，session 标记为 `admin`）。编辑器带着打开时的 sha 提交，服务器上的版本已变就返回 409，页面会提示并保留你未保存的内容。

### 鉴权

管理后台**只认** Cloudflare Access 的 JWT，不接受 bearer token（`/v1/*` 则只认 bearer）。Worker 用 WebCrypto 校验 `Cf-Access-Jwt-Assertion` 头（没有则读 `CF_Authorization` cookie）：RS256 签名（公钥取自 `${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`，缓存约 1 小时）、`aud` 包含 `ACCESS_AUD`、`iss` 等于团队域名、`exp` 和 `nbf`。

**默认关闭**：`ACCESS_TEAM_DOMAIN` 或 `ACCESS_AUD` 任一为空时，所有 `/admin*` 请求返回 403；校验失败同样是 403。用自定义域名（`HOST`）是用 Access 保护 `/admin` 最直接的办法。

### 启用步骤

1. Cloudflare Zero Trust → Access → Applications → Add an application → Self-hosted。
2. Application domain 填你的 `HOST`，Path 填 `admin`（Access 保护 `/admin` 及其下所有路径，`/v1` 和 `/health` 不受影响）。
3. Policy：Allow，Include 选 Emails，只填你自己的邮箱。
4. 找团队域名和 AUD：
   - 团队域名：Zero Trust → Settings → General → Team domain，形如 `https://<team>.cloudflareaccess.com`。
   - AUD：Access 应用详情里的 **Application Audience (AUD) Tag**。
   - 更省事：Access 应用建好后、Worker 还没配置时，打开 `/admin` 登录一次，403「尚未启用」的提示页会直接显示 `ACCESS_AUD` 和 `ACCESS_TEAM_DOMAIN`（取自 Access 下发的 JWT，只用于配置，不做信任判断）。没登录时，跳转到 Access 登录页的链接里 `kid` 参数同样是 AUD。
5. 把两个值写进 `deploy.env`，重新运行 `./deploy.sh`。

这个 403 提示页有中英文两个版本：按 `Accept-Language` 选择，`?lang=zh` 或 `?lang=en` 可以强制指定。

## 接口和并发规则

除 `/health` 和 `/client/memsync.py` 外，都需要 `Authorization: Bearer <token>`。在已配置 network secret 的 cloud 会话里直接 `curl` 就行，代理会自动带上这个头。

| 方法和路径 | 说明 |
|---|---|
| `GET /health` | 健康检查 |
| `GET /client/memsync.py` | 下载 hook 客户端 |
| `GET /v1/pull` | 全部现存记忆文件 `{files:[{path,content,sha,modified}]}` |
| `POST /v1/push` | `{session, files:[{path, content\|null, base_sha, added_lines?, removed_lines?}]}` |
| `GET /v1/history?path=&limit=&content=1` | 修改历史 |
| `POST /v1/status` | 客户端上报同步结果 `{session, event: pull\|push, ok, error, files, cli_version, auto_memory, cwd_name}`，写入 `sync_events`（只保留最新约 2000 条） |
| `POST /v1/restore` `{at: 毫秒时间戳}` | 把全部文件恢复到该时间点的状态（恢复操作本身也会记入历史，可以撤销） |

`sha` 是文件内容 UTF-8 的 SHA-256 十六进制值。路径只允许字母、数字和 `._-/`，以 `.md` 结尾，最长 200 个字符，不能含 `..`；单个文件上限 200 KB；每次 push 最多 500 个文件。

规则：

- **普通记忆文件。** 服务器上的版本和客户端的 `base_sha` 一致就直接写入；不一致时以后写的为准，旧版本保留在 `history` 里。
- **`MEMORY.md`。** 冲突时服务器做三方行合并：保留其他会话加的行，删掉本客户端删掉的行，追加本客户端新增的行。合并结果会回写到本地。
- **删除。** 只有服务器版本没变过才删除；别的会话改过的话，保留修改后的版本，并恢复到本地。
- **原子性。** 同一路径的写入带乐观锁（`WHERE sha = ?`），冲突时最多重试 4 次。

## 更新客户端

容器里运行的是 setup script 下载下来的那份 `memsync.py`，部署只会更新 Worker 上提供下载的那份。

1. 修改 `worker/memsync.py`，运行 `./deploy.sh`。
2. **改一下环境的 setup script**（比如改第一行注释里的版本号），触发快照缓存重建。不改的话，旧客户端最多会被缓存约 7 天。
3. 每个用这份脚本的环境都要改。

## 排错

同步失败有四个入口，从近到远：

| 在哪看 | 看到什么 | 怎么办 |
|---|---|---|
| **对话里的提示**（hook 的 `systemMessage`） | `记忆同步：拉取失败（…），本次会话没有加载持久记忆。` / `记忆同步：推送失败（HTTP 401），N 个文件未同步，下次回复结束时会重试。` / `记忆同步已恢复，N 个文件已推送。` / `记忆同步：有文件未能同步：xxx.md（路径不合法）`（`MEMSYNC_LANG=zh` 时；默认是英文）。推送失败第一次就提示，之后每 10 分钟最多一次；成功时什么都不显示。拉取失败时 Claude 也会通过 `additionalContext` 知道本次没有记忆 | `HTTP 401`：network secret 没配或不对（主机、Bearer 类型）。`连接超时`/`连接失败`：Worker 或网络问题，先看 `/health`。`路径不合法`/`文件过大`：改文件名（字母数字 `._-/`，以 `.md` 结尾）或拆小文件（上限 200 KB）。`MEMSYNC_URL` 未设置：setup script 没执行，或 `settings.json` 被覆盖了。失败的推送下次回复结束时会自动重试，不会丢 |
| **管理后台 →「同步状态」** | 健康徽章、最近 20 条同步记录、每个 Claude Code 版本的首次出现时间 | 见下表 |
| **Workers Logs** | Cloudflare 控制台 → Workers & Pages → 你的 Worker → Logs。500 错误和 Access 校验失败会记 `console.error`（只有路由和错误信息，没有记忆内容、token 和请求头） | 服务端异常时查这里 |
| **容器里的 `sync.log`** | `/root/.claude/memsync/sync.log`，每次 pull/push 一行，失败带异常详情。同目录的 `status_queue.json` 是还没发出去的状态上报（最多 50 条，下次请求成功时补发） | 单个会话的细节，在会话里 `cat` 即可 |

「同步状态」面板里的徽章：

| 徽章 | 含义 | 怎么办 |
|---|---|---|
| 红：同步连续失败 N 次 | 最近的记录都是失败，之后没有成功 | 看最近错误，按上表处理。新会话没有记忆，多半就是这个 |
| 红：自动记忆未启用 | 最近 7 天有上报 `auto_memory=false` | 原生自动记忆被关掉了，按「风险和限制」一节排查开关 |
| 黄：超过 3 天没有同步记录 | 没有新会话，或者客户端没在上报（hook 没装好、旧版客户端） | 开一个新会话看是否出现记录；没有就检查 setup script |
| 黄：Claude Code 升级到 X | 出现了新的 CLI 版本（首次出现不到 7 天，且之前见过别的版本） | 开新会话确认系统提示里仍有自动记忆说明，记忆内容能加载 |

**`auto_memory` 的含义。** Hook 看不到系统提示，但 Claude Code 会把完整的系统提示写进会话 transcript，作为一条 `type: attachment`、`attachment.type: prompt_snapshot` 的记录。开启自动记忆时，这份快照里会出现记忆目录（`/root/memory`）；没开启时则没有。推送时客户端读取 Stop hook 传来的 `transcript_path` 里最新的一份快照，上报 `true` 或 `false`。SessionStart 时快照还没生成，所以拉取事件上报 `unknown`。如果以后的 CLI 不再写这份快照，值会一直是 `unknown`，这时靠黄色的「Claude Code 升级」提醒，手动确认。

## 常用运维操作

在该环境的 cloud 会话里运行（代理会自动带 token），或者自己加 `-H "Authorization: Bearer $TOKEN"`：

```bash
# 查看当前全部记忆
curl -sS https://memory.example.com/v1/pull | jq -r '.files[] | "== \(.path)\n\(.content)"'

# 最近 20 次修改
curl -sS "https://memory.example.com/v1/history?limit=20" | jq -c '.history[] | {path, deleted, session, at}'

# 回滚到某个时间点（毫秒时间戳）
curl -sS -X POST -d '{"at": 1790000000000}' https://memory.example.com/v1/restore
```

**轮换访问 token。** 生成新 token（`python3 -c "import secrets;print(secrets.token_urlsafe(32))"`），计算 `printf %s "$NEW" | sha256sum`，用 `TOKEN_SHA256=<哈希> ./deploy.sh` 重新部署，再把每个环境里 network secret 的值换成新 token。

**新增环境。** 把 setup script 粘贴进新环境（如果它已经在写 `settings.json`，手动合并），再加一条 network secret（同样的主机、Bearer、同一个 token）。

## 风险和限制

- **依赖文档没写的行为。** `CLAUDE_CODE_DISABLE_AUTO_MEMORY=0` 能在云端打开自动记忆，依据是 CLI 源码（设置了 `CLAUDE_CODE_REMOTE` 且没设置 `CLAUDE_CODE_REMOTE_MEMORY_DIR` 时默认关闭；值为 `0` 时强制开启）。以后的版本可能会变。如果哪天新会话里突然没有记忆了，按这个顺序排查：
  1. 看新会话的系统提示里还有没有自动记忆的说明（指向 `/root/memory/`）。没有的话，就是开关失效了。
  2. `cat /root/.claude/memsync/sync.log`，看有没有 `pull ok`。
  3. `curl -sS https://<域名>/v1/pull | jq '.files|length'`，确认服务器上有数据；返回 401 说明 network secret 无效。
  4. 开关失效时可以试的替代办法：在 `settings.json` 的 `env` 里设置 `CLAUDE_CODE_REMOTE_MEMORY_DIR`（源码里的另一个开关）；或者让 SessionStart hook 把 `/root/memory/MEMORY.md` `cat` 到 stdout（会作为上下文注入，上限 10,000 字符），再在 `~/.claude/CLAUDE.md` 里写上记忆的保存规则。
  5. 官方如果推出了云端记忆（CLI 源码里已经能看到还没上线的「memory stores」同步代码），可以把 D1 里的文件导出迁移过去，格式本来就是原生格式。

  数据都在 D1 里，客户端或开关出问题不会丢数据。
- **auto-dream 在云端不会运行。** 原生的 auto-dream（后台整理）需要本地有若干个新的会话记录，而每个容器里只有当前这一个。`MEMORY.md` 只加载前 200 行或 25 KB，共用的记忆库需要不时整理。可以自己加一个定期任务：拉取，合并重复条目，删除过时条目，压缩索引，推送。建议的规则：只合并不删除；索引里每条记忆一行；索引控制在 150 行左右；整理错了用 `/v1/restore` 回滚。
- **单用户设计。** 一个 token、一个共享记忆库，没有按用户隔离。不要把 token 或管理后台的 Access 策略共享给不该看到全部记忆的人。
- **不要在记忆里存密钥。** 记忆文件在 D1 里是明文，会显示在管理后台，也会加载进每个会话的上下文。
- **Hook 不会打断会话。** `memsync.py` 任何失败都以 exit 0 结束，代价是同步问题只能通过上面的提示和面板看到。
- **未实现的想法：** 给 Worker 加一个 MCP 连接器，让 claude.ai 聊天端也能查同一份记忆。它需要单独做一套 OAuth（自定义连接器不接受静态 bearer token），所以没有做。

## 卸载

1. 从每个环境里删掉 setup script（或其中 memsync 的部分），并删除 network secret。
2. 需要的话先导出记忆：`curl -sS https://<域名>/v1/pull | jq -r '.files[] | "== \(.path)\n\(.content)"'`。
3. 在 Cloudflare 控制台删除 Worker、D1 数据库、自定义域名路由和 Access 应用。

## 开发

```bash
npm install
npm run check   # node --check + python -m py_compile
npm test        # test.mjs（后台、Access JWT、API）+ test2.mjs（memsync.py 端到端），基于 wrangler dev --local
```

测试在本地启动 Worker 和一个本地 JWKS 服务，不需要 Cloudflare 账号。`tests/ui.mjs` 和 `tests/ui2.mjs` 是可选的 Playwright 截图脚本（先 `npm install playwright`）。

## 许可证

MIT，见 [LICENSE](LICENSE)。
