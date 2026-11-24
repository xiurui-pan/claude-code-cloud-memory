# claude-code-cloud-memory

English | [简体中文](README.zh-CN.md)

Persistent, cross-session memory for Claude Code in **cloud sessions** (claude.ai/code) and across your machines, built on Claude Code's **native** memory: auto-memory (`MEMORY.md` + topic files) and the global `~/.claude/CLAUDE.md`. This project only syncs those files to a server you host: a Cloudflare Worker + D1 (recommended), or the same code on a small Node server.

- **Project memory**: native auto-memory, stored per git repository; a session sees only its own project. A superrepo and its submodules are one project.
- **Global memory**: `~/.claude/CLAUDE.md`, loaded in every project.
- **Server**: optimistic concurrency, 3-way merge for `MEMORY.md` and `CLAUDE.md`, full history and restore, a browser admin UI behind Cloudflare Access.
- **Where it runs**: cloud sessions, and the local CLI / desktop app (macOS, Linux, Windows).

## Why this repo

Cloud sessions start in a fresh container with native auto-memory turned off, and whatever is written there disappears with the container. Locally, auto-memory stays on one machine. The common alternatives:

| Approach | Integration | Data lives | Works in cloud sessions | Memory behaviour |
|---|---|---|---|---|
| **This repo** | Native memory files, synced by SessionStart / Stop / SessionEnd hooks | Self-hosted | Yes, outbound HTTPS only | Exactly native |
| [claude-mem](https://github.com/thedotmack/claude-mem) | Hooks capture tool use, an observer model compresses and injects it; MCP search tools | Local SQLite + Chroma, optional SaaS sync | No, needs a local background worker | Separate system with extra LLM calls |
| [Supermemory](https://github.com/supermemoryai/claude-supermemory), [Mem0](https://docs.mem0.ai/integrations/claude-code.md) plugins | Hooks + MCP tools, retrieval injected into context | Their SaaS | Needs an API key and network allowlisting | Separate system; conversation content goes to a third party |
| [basic-memory](https://github.com/basicmachines-co/basic-memory), [MCP reference memory server](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) | MCP tools the model must decide to call | Local files, or a paid cloud | Local mode is lost with the container | Separate system |
| Commit `CLAUDE.md` to the repo | Native file, arrives with the clone | The repo | Yes | Hand-written project instructions only; no auto-memory, no global layer |
| `~/.claude` sync tools (e.g. [claude-brain](https://github.com/toroleapinc/claude-brain)) | Git sync of native files | Your git remote | Their README says not supported | Native |

What this repo does differently:

- **Native behaviour.** No MCP tools, no extra prompts, no extra model calls. Claude Code decides what to remember, how to write it and how to load it, so improvements to the CLI's memory carry over as they ship.
- **Made for ephemeral containers.** No background process, vector store or third-party key in the container. The token is a cloud-environment network secret injected by the proxy; it never appears in scripts or repos.
- **Your data.** Memory lives only on your server, as native Markdown, so it can move to an official cloud memory if one ships.
- **Global and project layers** that map one to one onto the native local layout.

Pick another tool if you need semantic search over a large history (claude-mem, Mem0), automatic capture of every tool call rather than the model's own judgement, one memory shared with Codex, Cursor and other tools, or team-shared memory.

## How it works

| | Project memory | Global memory |
|---|---|---|
| Native counterpart | Per-project auto-memory | `~/.claude/CLAUDE.md` |
| In a cloud container | `/root/memory/`, this project only | `~/.claude/CLAUDE.md` = a short header + your global entries |
| Locally | Native `~/.claude/projects/<project>/memory/` | `~/.claude/CLAUDE.md` |
| On the server | `projects/<host>/<owner>/<repo>/…` | `global/CLAUDE.md` |
| Written when | Claude records a fact about this repo, service or deployment | You say "remember for all projects …", or state a working preference |

At session start the SessionStart hook runs `memsync.py pull`: it identifies the session's git repositories and pulls the global memory and that project's memory. Claude then saves memory by its native rules. After every reply and at session end, `memsync.py push` sends the changes back. Cloud sessions have no `/memory` command, so the rendered `CLAUDE.md` starts with a short header telling Claude what belongs there; the header is stripped before pushing. Memory saved in a session shows up from the next session on, as with native memory.

The underlying facts (how auto-memory is turned on in the cloud, hook timing, network secrets) are in [docs/reference.md](docs/reference.md).

## Quick start (Cloudflare)

You need a Cloudflare account and a machine with `bash`, `curl`, `jq` and `openssl` (or `python3`).

1. **API token**: Cloudflare dashboard → My Profile → API Tokens, start from "Edit Cloudflare Workers", add Account · D1 · Edit and Account · Account Settings · Read. For a custom domain also Zone · DNS · Edit and Zone · Zone · Read.
2. **Deploy**:

   ```bash
   cp deploy.env.example deploy.env    # HOST is optional: a custom domain such as memory.example.com
   export CF_API_TOKEN=...
   ./deploy.sh
   ```

   The first run generates an access token and prints it **once**; store it right away. The script ends by printing the setup script with your URL filled in. Re-running is safe: the token and D1 are reused.
3. **Cloud environment** (environment settings on claude.ai/code):
   - Add a **network secret**: your host, type Bearer, value = the access token.
   - Paste the printed **setup script** (append it if the environment already has one).
4. **Verify**: in a new session, ask Claude to remember one thing for all projects and one about the current repo. Both are loaded in the next session. Or check the server directly:

   ```bash
   curl -sS "https://memory.example.com/v1/pull?global=1&projects=github.com/owner/repo" | jq -r '.files[] | "== \(.path)\n\(.content)"'
   ```

To run without Cloudflare, see [Self-hosting](docs/selfhost.md) (Docker or Node 22+, SQLite, same code).

## Local CLI and desktop app

```bash
curl -fsS https://memory.example.com/client/memsync.py -o memsync.py
printf '%s' "$MEMORY_TOKEN" | python3 memsync.py install --url https://memory.example.com --token-stdin
```

`install` merges the hooks into `~/.claude/settings.json` without touching your other settings. The first sync merges and never deletes; `migrate` uploads the memory already on the machine. See [docs/local.md](docs/local.md).

## Documentation

| Doc | Contents |
|---|---|
| [Operations](docs/operations.md) | Admin UI and Cloudflare Access, migrating old data, updating the client, troubleshooting, routine operations, risks and limitations, uninstall |
| [Self-hosting](docs/selfhost.md) | Docker or Node, HTTPS, admin login, backups |
| [Local](docs/local.md) | Local CLI and desktop app: install, first sync, migration |
| [Reference](docs/reference.md) | Cloud integration facts, repository layout, HTTP API and concurrency rules |
| [Design: cloud](docs/design-cloud-v3.md), [Design: local](docs/design-local.md) | Design and tests |

## Main limitations

- Turning auto-memory on in the cloud relies on an undocumented CLI switch (`CLAUDE_CODE_DISABLE_AUTO_MEMORY=0`); re-check it after CLI upgrades. The admin "Sync status" panel flags new CLI versions and sessions where auto-memory was off.
- Native auto-dream consolidation does not run in the cloud; prune memory now and then (`MEMORY.md` loads only its first 200 lines).
- Single user: one token, one store. Memory is plain text on the server; don't store secrets in it.

Full list: [Operations → Risks and limitations](docs/operations.md#risks-and-limitations).

## Development

```bash
npm install
npm test        # runs against wrangler dev --local and the self-hosted server; BACKEND=cf or BACKEND=node for one
```

No Cloudflare account needed for tests.

## Planned

- An MCP connector for claude.ai chat, so chat can read the same memory.

## License

MIT, see [LICENSE](LICENSE).
