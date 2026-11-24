# 本地 Claude Code（CLI 和桌面端）

同一台服务器、同一份记忆也可以在你自己的电脑上用（macOS、Linux、Windows，只依赖 Python 3 标准库）。本地会话沿用 Claude Code 原生的目录结构：项目记忆在 `~/.claude/projects/<项目>/memory/`（不覆盖 `autoMemoryDirectory`），全局记忆在 `~/.claude/CLAUDE.md`。设计和依据见 [design-local.md](design-local.md)。

```bash
# 1. 取得客户端（放哪都行）；2. install：复制到 ~/.claude/memsync/，并把 hook 写进 ~/.claude/settings.json
curl -fsS https://memory.example.com/client/memsync.py -o memsync.py
printf '%s' "$MEMORY_TOKEN" | python3 memsync.py install --url https://memory.example.com --token-stdin
```

Windows（PowerShell）：`Invoke-WebRequest https://memory.example.com/client/memsync.py -OutFile memsync.py`，然后 `$env:MEMORY_TOKEN | python memsync.py install --url https://memory.example.com --token-stdin`。

- **Token。** 本地没有代理帮忙注入。`--token-stdin` 把它写到 `~/.claude/memsync/token`（POSIX 下权限 0600，Windows 用 `icacls` 限制）；`--token-file <路径>` 记录一个已有的文件；也可以在启动 Claude Code 的环境里设 `MEMSYNC_TOKEN`，它优先。token 不会写进 `settings.json`。
- **Hook。** `install` 把三个 hook（`SessionStart` 拉取，`Stop` 和 `SessionEnd` 推送）合并进用户级 `settings.json`，其他设置和 hook 原样保留，改之前先备份成 `settings.json.memsync-bak-<时间>`。重复运行只更新自己的条目。`settings.json` 不是合法 JSON 时不做任何修改。
- **第一次同步只合并。** 一台机器上第一次同步某个项目（或全局文件）时，本地和服务器的内容取并集，两边都不删：只在一边存在的文件复制过去；同名但内容不同的文件，服务器版本留在原名，本地版本改名为 `<名字>.local.md`；`MEMORY.md` 和 `CLAUDE.md` 按行取并集。原文件备份在 `~/.claude/memsync/projects/<key>/backup/`。
- **已有记忆。** `python3 ~/.claude/memsync/memsync.py migrate` 列出所有能对应到带 `origin` 的 git 仓库的 `~/.claude/projects/*/memory/`（通过 transcript 里记录的 `cwd` 判断）；`migrate --apply` 立即全部同步。平时打开的项目会在第一次会话时由 hook 同步。不是 git 仓库的目录，记忆留在本地，只同步全局文件。
- **检查和卸载。** `memsync.py where [目录]` 打印某个目录的记忆目录和项目。`memsync.py uninstall` 删除 hook 和写进 `CLAUDE.md` 的开头说明；加 `--purge` 同时删除 `~/.claude/memsync/`（配置、token、状态）。记忆文件不会被动。
- **限制。** 同一台机器上的多个会话靠文件锁串行。会话启动时 CLI 可能在 hook 拉取完成前就读了 `MEMORY.md`，所以新拉到的内容可能晚一个会话才出现。`MEMSYNC_LANG=zh` 让 hook 提示改成中文。
- **共用的记忆目录。** 如果用户级 `settings.json` 设了 `autoMemoryDirectory`（所有项目共用一个目录），项目记忆不同步，只同步 `CLAUDE.md`；`memsync.py where` 会显示 `"shared_dir": true`。
