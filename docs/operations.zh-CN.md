# 运维

管理后台、迁移、更新客户端、排错、日常运维、风险和卸载。返回 [README](../README.zh-CN.md)。

## 管理后台和 Cloudflare Access

浏览器打开 `https://<你的域名>/admin`：查看、编辑、新建、删除记忆文件，查看每个文件的历史并恢复单个版本，或者整体回滚到某个时间点。页面是单个 HTML，没有外部依赖，手机宽度可用，随系统切换深浅色。语言跟随浏览器（`navigator.language`），顶部有 EN/中文 切换按钮（选择会被记住）。左侧按层分组（待确认、全局、各个项目、旧版根目录），可按 frontmatter 的 `metadata.type` 过滤和搜索；新建文件会预填原生 frontmatter，并可顺手在所在层的 `MEMORY.md` 末尾追加一行索引。

所有写入都走和同步接口相同的 `writeRow`（sha 乐观锁、写历史，session 标记为 `admin`）。编辑器带着打开时的 sha 提交，服务器上的版本已变就返回 409，页面会提示并保留你未保存的内容。

### 鉴权

在 Cloudflare 上，管理后台**只认** Cloudflare Access 的 JWT，不接受 bearer token（`/v1/*` 则只认 bearer）。自部署的服务改用登录页或代理 header，见[自部署](selfhost.zh-CN.md#5-管理后台登录)。Worker 用 WebCrypto 校验 `Cf-Access-Jwt-Assertion` 头（没有则读 `CF_Authorization` cookie）：RS256 签名（公钥取自 `${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`，缓存约 1 小时）、`aud` 包含 `ACCESS_AUD`、`iss` 等于团队域名、`exp` 和 `nbf`。

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

## 迁移已有的扁平记忆库

如果你之前用的是 v1/v2（所有项目共用一个记忆库），文件都在记忆库的根目录，在管理后台里显示为「旧版根目录」。`tools/migrate-layers.mjs` 按你写的计划把它们搬进各层。哪些内容算全局由你决定，工具不做判断。

```json
{
  "global_claude_md": "- 用中文回复\n- 回答尽量简短\n",
  "moves": [
    {"from": "deploy.md", "to": "projects/github.com/acme/platform/deploy.md"},
    {"from": "MEMORY.md", "to": "projects/github.com/acme/platform/MEMORY.md"}
  ],
  "drop": ["obsolete.md"],
  "project_indexes": {"github.com/acme/platform": "- [Deploy](deploy.md) — 节点顺序\n"}
}
```

- `global_claude_md`：全局 `CLAUDE.md` 的条目，不含 header；这些行会合并进已有内容。
- `moves`：旧根目录文件 → 项目路径。移动保留历史。把 `MEMORY.md` 移到已有的项目索引上，会合并各行。
- `project_indexes`：合并进某个项目 `MEMORY.md` 的索引行。
- `drop`：要删除的旧文件（历史里仍能找回）。
- 计划里没提到的旧文件留在原处，之后可以在管理后台里分类。

```bash
export MEMSYNC_URL=https://memory.example.com MEMSYNC_TOKEN=<访问 token>   # 在 cloud session 里不需要 token，但要用 NODE_USE_ENV_PROXY=1 运行 node
node tools/migrate-layers.mjs plan.json            # 演练：打印每一次移动、合并的行和删除
node tools/migrate-layers.mjs plan.json --apply    # 执行
```

上线顺序：（1）部署服务端（向后兼容），（2）更新每个环境的 setup script，（3）运行迁移，（4）在管理后台里分类剩下的文件。还停留在旧快照上的客户端，在快照过期之前继续使用旧版根目录的文件。

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
# 查看全局记忆加某个项目的记忆（不带参数的 /v1/pull 只返回旧版根目录文件）
curl -sS "https://memory.example.com/v1/pull?global=1&projects=github.com/owner/repo" | jq -r '.files[] | "== \(.path)\n\(.content)"'

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
  3. `curl -sS "https://<域名>/v1/pull?global=1" | jq '.files|length'`，确认服务器上有数据；返回 401 说明 network secret 无效。
  4. 开关失效时可以试的替代办法：在 `settings.json` 的 `env` 里设置 `CLAUDE_CODE_REMOTE_MEMORY_DIR`（源码里的另一个开关）；或者让 SessionStart hook 把 `/root/memory/MEMORY.md` `cat` 到 stdout（会作为上下文注入，上限 10,000 字符），再在 `~/.claude/CLAUDE.md` 里写上记忆的保存规则。
  5. 官方如果推出了云端记忆（CLI 源码里已经能看到还没上线的「memory stores」同步代码），可以把 D1 里的文件导出迁移过去，格式本来就是原生格式。

  数据都在 D1 里，客户端或开关出问题不会丢数据。
- **auto-dream 在云端不会运行。** 原生的 auto-dream（后台整理）需要本地有若干个新的会话记录，而每个容器里只有当前这一个。`MEMORY.md` 只加载前 200 行或 25 KB，共用的记忆库需要不时整理。可以自己加一个定期任务：拉取，合并重复条目，删除过时条目，压缩索引，推送。建议的规则：只合并不删除；索引里每条记忆一行；索引控制在 150 行左右；整理错了用 `/v1/restore` 回滚。
- **单用户设计。** 一个 token、一个记忆库，没有按用户隔离。不要把 token 或管理后台的 Access 策略共享给不该看到全部记忆的人。
- **全局还是项目，取决于模型怎么落笔。** `CLAUDE.md` 里的 header 引导保存位置（Sonnet 的 4 条测试话术全部分对），但仍可能放错，放错了在管理后台里改。
- **`CLAUDE.md` 没有 200 行上限。** 全局条目每条一行短句，定期清理。
- **会话中途的修改不会重新渲染。** 一个会话里保存的记忆，从下一个会话开始出现在上下文里，和原生一致。
- **嵌套的仓库路径**（超过 `owner/repo` 两级，例如 GitLab 子组）不会被识别为仓库，这样的会话按 `_norepo` 处理。
- **不要在记忆里存密钥。** 记忆文件在 D1 里是明文，会显示在管理后台，也会加载进每个会话的上下文。
- **Hook 不会打断会话。** `memsync.py` 任何失败都以 exit 0 结束，代价是同步问题只能通过上面的提示和面板看到。
- **本地 CLI 和桌面端**的限制见 [local.zh-CN.md](local.zh-CN.md)。

## 卸载

1. 从每个环境里删掉 setup script（或其中 memsync 的部分），并删除 network secret。
2. 需要的话先导出记忆：`curl -sS "https://<域名>/v1/pull?global=1&projects=<pid>" | jq -r '.files[] | "== \(.path)\n\(.content)"'`（管理后台里能看到所有项目 id）。
3. 在 Cloudflare 控制台删除 Worker、D1 数据库、自定义域名路由和 Access 应用。自部署的话执行 `docker compose -f selfhost/docker-compose.yml down -v`（会连数据 volume 一起删除，先做好备份）。
