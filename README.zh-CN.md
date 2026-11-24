# claude-code-cloud-memory

[English](README.md) | 简体中文

让 Claude Code 在 **cloud session**（claude.ai/code）里，以及在多台电脑之间，都能跨会话记住东西。它用的就是 Claude Code 原生的记忆功能：自动记忆（`MEMORY.md` 加主题文件）和全局指令 `~/.claude/CLAUDE.md`。这个项目只负责把这些文件同步到你自己部署的服务端，可以是 Cloudflare Worker + D1（推荐），也可以是一台 Node 服务器。

- **项目记忆**：原生自动记忆，按 git 仓库分开存放，一个会话只看到自己项目的记忆。超仓库和它的 submodule 算同一个项目。
- **全局记忆**：`~/.claude/CLAUDE.md`，每个项目都会加载。
- **服务端**：带乐观锁的写入，`MEMORY.md` 和 `CLAUDE.md` 冲突时做三方合并，保留完整历史，可以回滚。管理后台用浏览器访问，放在 Cloudflare Access 后面。
- **适用环境**：cloud session，以及本地 CLI 和桌面端（macOS、Linux、Windows）。

## 为什么用这个

Cloud session 每次都在新容器里运行，原生自动记忆默认关闭，就算打开，写下的内容也随容器一起消失。本地的自动记忆也只存在单台机器上。现有的几类做法：

| 方案 | 怎么接入 | 数据放在哪 | 能用在 cloud session | 模型的记忆行为 |
|---|---|---|---|---|
| **本项目** | 原生记忆文件，靠 SessionStart、Stop 和 SessionEnd hook 同步 | 自己部署 | 能，只需出站 HTTPS | 和原生完全一样 |
| [claude-mem](https://github.com/thedotmack/claude-mem) | hook 记录工具调用，另起一个模型压缩，再注入；另有 MCP 检索工具 | 本地 SQLite + Chroma，可选 SaaS 同步 | 不能，依赖本地常驻 worker | 另起一套，需要额外的 LLM 调用 |
| [Supermemory](https://github.com/supermemoryai/claude-supermemory)、[Mem0](https://docs.mem0.ai/integrations/claude-code.md) 插件 | hook 加 MCP 工具，检索后注入 | 对方的 SaaS | 要 API key，还要放行网络 | 另起一套，对话内容发给第三方 |
| [basic-memory](https://github.com/basicmachines-co/basic-memory)、[官方 MCP memory](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) | MCP 工具，由模型决定什么时候调用 | 本地文件，或付费云服务 | 本地模式不行，容器销毁就丢 | 另起一套 |
| 把 `CLAUDE.md` 提交进仓库 | 原生文件，随 clone 一起到达 | 仓库 | 能 | 只有项目级的手写指令；自动记忆不进仓库，也没有全局记忆 |
| 同步 `~/.claude` 的工具（如 [claude-brain](https://github.com/toroleapinc/claude-brain)） | 用 git 同步原生文件 | 自己的 git 远端 | 它自己的 README 写明不支持 | 原生 |

这个项目的做法：

- **用的是原生功能。** 不加 MCP 工具，不加提示词，也不调用额外的模型。什么时候记、记成什么样、怎么加载，都由 Claude Code 自己决定，CLI 改进了记忆功能，这里直接跟着受益。
- **适合临时容器。** 容器里没有常驻进程，没有向量库，不需要第三方 key。token 存在 cloud 环境的 network secret 里，由代理注入，不出现在脚本和仓库里。
- **数据自己掌握。** 记忆只存在你的服务端，格式就是原生的 Markdown；官方以后推出云端记忆的话，可以直接导出迁移过去。
- **分全局和项目两层**，和本地原生的结构一一对应。

更适合别的方案的场景：需要对大量历史做语义检索（claude-mem、Mem0），希望自动记录每次工具调用、不依赖模型自己决定记什么，同一份记忆要给 Codex、Cursor 等其他工具用，或者是团队共享的记忆。

## 工作原理

| | 项目记忆 | 全局记忆 |
|---|---|---|
| 原生对应 | 按项目的自动记忆 | `~/.claude/CLAUDE.md` |
| Cloud 容器里 | `/root/memory/`，只放当前项目 | `~/.claude/CLAUDE.md`，开头有一段说明 + 你的全局条目 |
| 本地 | 原生目录 `~/.claude/projects/<项目>/memory/` | `~/.claude/CLAUDE.md` |
| 服务端 | `projects/<host>/<owner>/<repo>/…` | `global/CLAUDE.md` |
| 谁来写 | Claude 记下关于这个仓库、服务或部署的事实 | 你说「所有项目都记住……」，或是关于工作方式的偏好 |

会话启动时，SessionStart hook 运行 `memsync.py pull`：识别会话所在的 git 仓库，拉下全局记忆和这个项目的记忆。之后 Claude 按原生规则写记忆。每轮回复结束时和会话结束时，`memsync.py push` 把改动推回服务端。Cloud session 里没有 `/memory` 命令，所以 `CLAUDE.md` 开头会加一段说明，告诉 Claude 哪些内容属于全局；这段说明在推送前去掉。记忆从下一个会话开始生效，原生也是这样。

底层依据（在 cloud 里怎么打开自动记忆、hook 的时序、network secret）见 [docs/reference.zh-CN.md](docs/reference.zh-CN.md)。

## 快速开始（Cloudflare）

需要：一个 Cloudflare 账号，以及装有 `bash`、`curl`、`jq`、`openssl`（或 `python3`）的机器。

1. **创建 API token**：Cloudflare 控制台 → My Profile → API Tokens，从「Edit Cloudflare Workers」模板开始，加上 Account · D1 · Edit 和 Account · Account Settings · Read。用自定义域名的话，再加 Zone · DNS · Edit 和 Zone · Zone · Read。
2. **部署**：

   ```bash
   cp deploy.env.example deploy.env    # HOST 可选：自定义域名，如 memory.example.com
   export CF_API_TOKEN=...
   ./deploy.sh
   ```

   第一次运行会生成访问 token，**只打印这一次**，马上存好。脚本最后打印填好地址的 setup script。可以重复运行，已有的 token 和 D1 会复用。
3. **配置 cloud 环境**（claude.ai/code 的环境设置）：
   - 添加 **network secret**：主机填你的域名，类型选 Bearer，值填访问 token。
   - 把打印出的 **setup script** 粘贴进去；环境原来就有 setup script 的话，追加在后面。想让提示用中文，就把 `MEMSYNC_LANG=en` 改成 `zh`。
4. **验证**：开一个新会话，让 Claude 记两件事，一件全局的（「所有项目都记住：……」），一件关于当前仓库的。再开一个新会话，两件都应该已经加载。也可以直接查服务端：

   ```bash
   curl -sS "https://memory.example.com/v1/pull?global=1&projects=github.com/owner/repo" | jq -r '.files[] | "== \(.path)\n\(.content)"'
   ```

不用 Cloudflare 的话见[自部署](docs/selfhost.zh-CN.md)（Docker 或 Node 22+，SQLite，跑的是同一份代码）。

## 本地 CLI 和桌面端

```bash
curl -fsS https://memory.example.com/client/memsync.py -o memsync.py
printf '%s' "$MEMORY_TOKEN" | python3 memsync.py install --url https://memory.example.com --token-stdin
```

`install` 把 hook 合并进 `~/.claude/settings.json`，原有的设置保持不变。第一次同步只合并、不删除，本机已有的记忆可以用 `migrate` 上传。详见 [docs/local.zh-CN.md](docs/local.zh-CN.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [运维](docs/operations.zh-CN.md) | 管理后台和 Cloudflare Access、迁移旧数据、更新客户端、排错、常用操作、风险和限制、卸载 |
| [自部署](docs/selfhost.zh-CN.md) | Docker 或 Node，HTTPS，管理后台登录，备份 |
| [本地](docs/local.zh-CN.md) | 本地 CLI 和桌面端的安装、首次同步、迁移 |
| [参考](docs/reference.zh-CN.md) | cloud 集成的依据、目录结构、HTTP 接口和并发规则 |
| [设计：cloud](docs/design-cloud-v3.md)、[设计：本地](docs/design-local.md) | 设计和测试（英文） |

## 主要限制

- Cloud 里打开自动记忆，依赖 CLI 里一个文档没写的开关（`CLAUDE_CODE_DISABLE_AUTO_MEMORY=0`），CLI 升级后要确认还有效。管理后台的「同步状态」面板会提示新出现的 CLI 版本，以及自动记忆没有打开的情况。
- 原生的 auto-dream 整理在 cloud 里不会运行，记忆多了需要定期整理（`MEMORY.md` 只加载前 200 行）。
- 只支持单用户：一个 token 对应一个记忆库。记忆在服务端是明文，不要在里面存密钥。

完整列表见[运维 → 风险和限制](docs/operations.zh-CN.md#风险和限制)。

## 开发

```bash
npm install
npm test        # 分别在 wrangler dev --local 和自部署服务上跑；BACKEND=cf 或 BACKEND=node 只跑其中一个
```

测试不需要 Cloudflare 账号。

## 已规划

- 给 claude.ai 聊天端用的 MCP 连接器，让聊天端也能查同一份记忆。

## 许可证

MIT，见 [LICENSE](LICENSE)。
