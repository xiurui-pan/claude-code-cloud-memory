#!/usr/bin/env python3
"""Claude Code cloud-session memory sync client (v3).

Two kinds of memory, both native to Claude Code:
  project memory  the auto-memory dir (MEMSYNC_DIR, /root/memory) holds ONLY the current project's
                  memory (MEMORY.md + topic files); the project is identified by the git remote of the
                  session's repo(s), a superrepo and its submodules being one project
  global memory   ~/.claude/CLAUDE.md (MEMSYNC_GLOBAL_FILE): a short guidance header + the user's global
                  entries, loaded by Claude Code in every project

Runs as a hook:
  memsync.py pull   (SessionStart)  push pending local changes, resolve the workspace to projects,
                    then write the project files and CLAUDE.md
  memsync.py push   (Stop / SessionEnd)  send files that changed since the last sync

The bearer token is injected by the cloud environment's network proxy (a network secret
for the memory host), so this script never holds it. MEMSYNC_TOKEN is honoured only
for local testing.

Environment: MEMSYNC_URL (required), MEMSYNC_DIR (default /root/memory),
MEMSYNC_GLOBAL_FILE (default ~/.claude/CLAUDE.md), MEMSYNC_WORKSPACE (workspace scan root, default
CLAUDE_PROJECT_DIR), MEMSYNC_STATE (default ~/.claude/memsync), MEMSYNC_LANG (en|zh, default en).
A hook must never break the session: every failure exits 0.

Local mode (Claude Code CLI / desktop on your own machine; chosen when neither CLAUDE_CODE_REMOTE nor
MEMSYNC_DIR is set, or with MEMSYNC_MODE=local): the memory dir is the project's native one,
<config>/projects/<slug>/memory, state is kept per project under <config>/memsync, the token comes from
MEMSYNC_TOKEN / MEMSYNC_TOKEN_FILE / <config>/memsync/token, and the first sync of a dir only merges.
Extra commands: install [--url U] [--token-stdin | --token-file F], uninstall [--purge],
migrate [--apply], where [dir]. See docs/design-local.md.

Error visibility: failures are reported to the user as a hook JSON `systemMessage` (stdout is
either empty or exactly one JSON object), and a small status event is POSTed to /v1/status
(queued locally in STATE/status_queue.json when the server can't be reached).
"""
import glob
import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from pathlib import Path

try:  # POSIX
    import fcntl
except ImportError:  # Windows
    fcntl = None
try:  # Windows
    import msvcrt
except ImportError:
    msvcrt = None

URL = os.environ.get("MEMSYNC_URL", "").strip().rstrip("/")  # no default: set by the setup script
MEM = Path(os.environ.get("MEMSYNC_DIR", "/root/memory"))
STATE = Path(os.environ.get("MEMSYNC_STATE", str(Path.home() / ".claude" / "memsync")))
GLOBAL_FILE = Path(os.path.expanduser(os.environ.get("MEMSYNC_GLOBAL_FILE") or "~/.claude/CLAUDE.md"))
BASE = STATE / "base.json"
LAYOUT = STATE / "layout.json"
LOG = STATE / "sync.log"
VERSION = "v3"
INDEX = "MEMORY.md"
GLOBAL = "global/CLAUDE.md"  # server path of the global memory body
NOREPO = "_norepo"
SKIP_DIRS = ("proposals/",)  # native skill-proposal dir inside the memory dir, never synced
HEADER = """# Global memory (shared by every project and session)
This file is the user's global memory and is loaded in every project. Edit it directly (/root/.claude/CLAUDE.md) to save:
- anything the user asks you to remember for all projects or globally;
- the user's preferences about how you should work (communication, writing style, workflow, review habits)
  that do not depend on a specific repository, service or system.
Keep each entry to one short line. Facts, procedures and rules about a specific project, repo, service
or deployment belong in auto-memory instead.
"""
TIMEOUT = 10
STATUS_TIMEOUT = 3
MAX_FILE_BYTES = 200_000
THROTTLE_SECS = 600
QUEUE_MAX = 50
NOTIFY = STATE / "notify.json"
QUEUE = STATE / "status_queue.json"
CLI_CACHE = STATE / "cli_version.json"
PENDING = [0]  # files a failed push left unsynced
LANG = "zh" if os.environ.get("MEMSYNC_LANG", "en").lower().startswith("zh") else "en"

# User-facing strings (hook systemMessage). English by default, Chinese with MEMSYNC_LANG=zh.
MSG = {
    "en": {
        "bad_rejected_path": "invalid path",
        "bad_rejected_size": "file too large",
        "bad_retry_exhausted": "write conflict, retries exhausted",
        "timeout": "connection timed out, {name}",
        "conn_failed": "connection failed, {name}",
        "pull_failed": "Memory sync: pull failed ({err}), no persistent memory was loaded for this session.",
        "push_failed": "Memory sync: push failed ({err}), {pending}will retry after the next reply.",
        "pending": "{n} file(s) not synced, ",
        "recovered": "Memory sync recovered, {n} file(s) pushed.",
        "problems": "Memory sync: some files could not be synced: {names}{more}. Check file names and sizes.",
        "names_sep": ", ",
        "more": " ({n} in total)",
        "item": "{path} ({why})",
        "no_url": "Memory sync is not configured: MEMSYNC_URL is not set. Check the env section of ~/.claude/settings.json (written by your environment setup script).",
    },
    "zh": {
        "bad_rejected_path": "路径不合法",
        "bad_rejected_size": "文件过大",
        "bad_retry_exhausted": "写入冲突重试耗尽",
        "timeout": "连接超时，{name}",
        "conn_failed": "连接失败，{name}",
        "pull_failed": "记忆同步：拉取失败（{err}），本次会话没有加载持久记忆。",
        "push_failed": "记忆同步：推送失败（{err}），{pending}下次回复结束时会重试。",
        "pending": "{n} 个文件未同步，",
        "recovered": "记忆同步已恢复，{n} 个文件已推送。",
        "problems": "记忆同步：有文件未能同步：{names}{more}。请检查文件名和大小。",
        "names_sep": "、",
        "more": " 等共 {n} 个",
        "item": "{path}（{why}）",
        "no_url": "记忆同步未配置：没有设置 MEMSYNC_URL。请检查 ~/.claude/settings.json 的 env（由环境的 setup script 写入）。",
    },
}[LANG]
BAD_STATUSES = {k: MSG["bad_" + k] for k in ("rejected_path", "rejected_size", "retry_exhausted")}


def log(msg):
    try:
        STATE.mkdir(parents=True, exist_ok=True)
        with LOG.open("a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {msg}\n")
    except OSError:
        pass


def sha(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def request(method, path, body=None, timeout=TIMEOUT):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(URL + path, data=data, method=method)
    req.add_header("content-type", "application/json")
    req.add_header("user-agent", "memsync/3")
    token = os.environ.get("MEMSYNC_TOKEN")
    if token:
        req.add_header("authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def load_base():
    try:
        return json.loads(BASE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def save_base(base):
    STATE.mkdir(parents=True, exist_ok=True)
    tmp = BASE.with_suffix(".tmp")
    tmp.write_text(json.dumps(base, ensure_ascii=False), encoding="utf-8")
    tmp.replace(BASE)


def local_files():
    out = {}
    if not MEM.is_dir():
        return out
    for p in MEM.rglob("*.md"):
        if not p.is_file():
            continue
        rel = p.relative_to(MEM).as_posix()
        if rel.startswith(SKIP_DIRS):
            continue
        try:
            text = p.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        if len(text.encode("utf-8")) <= MAX_FILE_BYTES:
            out[rel] = text
    return out


def write_text(p, text):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")


def write_local(rel, text):
    write_text(MEM / rel, text)


def is_merge(path):
    """Paths that get the server's 3-way line merge (their base content is kept for line diffs)."""
    return path == GLOBAL or path.rsplit("/", 1)[-1] == INDEX


def base_entry(text, path):
    e = {"sha": sha(text)}
    if is_merge(path):
        e["content"] = text
    return e


def lines_diff(old, new):
    before, after = old.splitlines(), new.splitlines()
    sb, sa = set(before), set(after)
    return [l for l in after if l not in sb], [l for l in before if l not in sa]


# ---------- project identity ----------
def norm_repo(url):
    """Git remote -> host/owner/repo (lowercase), or None. Mirrors the server's normalization."""
    s = (url or "").strip()
    m = (re.match(r"^[a-z][a-z0-9+.\-]*://(?:[^/@]*@)?([^/:@]+)(?::\d+)?/(.+)$", s, re.I)
         or re.match(r"^(?:[^@/\s]+@)?([^/:@\s]+):(?!//)(.+)$", s)
         or re.match(r"^([^/@:\s]+\.[^/@:\s]+|localhost)/(.+)$", s, re.I))
    if not m:
        return None
    host, rest = m.group(1).lower(), re.split(r"[?#]", m.group(2))[0]
    segs = [x for x in rest.split("/") if x]
    if len(segs) != 2:
        return None
    segs[-1] = re.sub(r"\.git$", "", segs[-1], flags=re.I)
    segs = [x.lower() for x in segs]
    if not re.match(r"^[a-z0-9][a-z0-9.\-]*$", host) or not all(re.match(r"^[a-z0-9._\-]+$", x) and x not in (".", "..") for x in segs):
        return None
    return "/".join([host] + segs)


def resolve_rel(sub, base):
    sub = sub.strip()
    if not re.match(r"^\.\.?/", sub):
        return norm_repo(sub)
    b = norm_repo(base)
    if not b:
        return None
    parts = b.split("/")
    for seg in sub.split("/"):
        if seg in ("", "."):
            continue
        if seg == "..":
            if len(parts) > 1:
                parts.pop()
        else:
            parts.append(seg)
    return norm_repo("/".join(parts))


def find_git_root(d):
    try:
        d = Path(d).resolve()
    except OSError:
        return None
    for p in [d, *d.parents]:
        if (p / ".git").exists():
            return p
    return None


def git_config_file(repo):
    """Path of the repo's own config file (follows the gitdir/commondir links of worktrees), without git's repo discovery."""
    g = repo / ".git"
    try:
        if g.is_file():
            txt = g.read_text(encoding="utf-8").strip()
            if txt.startswith("gitdir:"):
                g = (repo / txt[7:].strip()).resolve()
                cd = g / "commondir"
                if cd.is_file():
                    g = (g / cd.read_text(encoding="utf-8").strip()).resolve()
        return g / "config"
    except OSError:
        return repo / ".git" / "config"


def git_config(args):
    try:
        r = subprocess.run(["git", "config", *args], capture_output=True, text=True, timeout=5)
        return r.stdout if r.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def repo_info(root):
    """{'root', 'url', 'subs'} for a git checkout with an origin, else None."""
    origin = git_config(["-f", str(git_config_file(root)), "--get", "remote.origin.url"]).strip()
    url = norm_repo(origin)
    if not url:
        return None
    subs = []
    gm = root / ".gitmodules"
    if gm.is_file():
        for line in git_config(["-f", str(gm), "--get-regexp", r"^submodule\..*\.url$"]).splitlines():
            parts = line.split(None, 1)
            sub = resolve_rel(parts[1], origin) if len(parts) == 2 else None
            if sub and sub not in subs:
                subs.append(sub)
    return {"root": str(root), "url": url, "subs": subs}


def detect_workspace(hook_in):
    """Repos of this session: the git root of the project dir if it is inside a repo, else every git repo
    exactly one level below it. Returns (repos, git root of the project dir or None)."""
    root = os.environ.get("MEMSYNC_WORKSPACE") or os.environ.get("CLAUDE_PROJECT_DIR") or hook_in.get("cwd") or os.getcwd()
    top = find_git_root(root)
    if top:
        cands = [top]
    else:
        try:
            cands = sorted(c for c in Path(root).iterdir() if c.is_dir() and (c / ".git").exists())
        except OSError:
            cands = []
    repos, seen = [], set()
    for c in cands:
        info = repo_info(c)
        if info and info["url"] not in seen:
            seen.add(info["url"])
            repos.append(info)
    return repos, (str(top) if top else None)


# ---------- layout (how local names map to server paths) ----------
def load_layout():
    d = read_json(LAYOUT, None)
    return d if isinstance(d, dict) and d.get("v") == 3 else None


def pdir(pid):
    return f"projects/{pid}/"


def idx_path(layout, pid=None):
    return INDEX if layout.get("legacy") else pdir(pid or layout["projects"][0]) + INDEX


def pid_of(sp):
    m = re.match(r"^projects/(.+)/[^/]+$", sp)
    return m.group(1) if m else None


def make_layout(hook_in):
    """Workspace -> projects via /v1/resolve. A server without /v1/resolve (v1/v2) gives a legacy layout."""
    repos, project_root = detect_workspace(hook_in)
    layout = {"v": 3, "legacy": False, "projects": [], "repos": {}, "project_pid": None, "files": {}}
    try:
        res = request("POST", "/v1/resolve", {"repos": [{"url": r["url"], "submodules": r["subs"]} for r in repos]})
    except urllib.error.HTTPError as e:
        if e.code in (404, 405):
            layout["legacy"] = True
            return layout
        raise
    m = res.get("map", {})
    for r in repos:
        if r["url"] in m:
            layout["repos"][r["root"]] = m[r["url"]]
    layout["projects"] = list(res.get("projects") or []) or [NOREPO]
    if project_root:
        layout["project_pid"] = layout["repos"].get(project_root)
    return layout


def route_pid(layout, hook_in):
    """Project for a NEW local file. One project: that one. Several: the repo holding the hook's cwd,
    else the repo of CLAUDE_PROJECT_DIR, else the first project. Returns (pid, rule or None)."""
    projects = layout["projects"]
    if len(projects) == 1:
        return projects[0], None
    cwd = hook_in.get("cwd") or ""
    best = None
    for root, pid in layout.get("repos", {}).items():
        if (cwd == root or cwd.startswith(root.rstrip("/") + "/")) and (best is None or len(root) > len(best[0])):
            best = (root, pid)
    if best:
        return best[1], "cwd"
    if layout.get("project_pid") in projects:
        return layout["project_pid"], "project_dir"
    return projects[0], "first"


def route_new(layout, rel, hook_in):
    if layout.get("legacy"):
        return rel, None
    pid, rule = route_pid(layout, hook_in)
    return pdir(pid) + rel, rule


def link_rewrite(line, mapping):
    return re.sub(r"\]\(([^)]+)\)", lambda m: f"]({mapping[m.group(1)]})" if m.group(1) in mapping else m.group(0), line)


def link_rewrite_text(text, mapping):
    return "\n".join(link_rewrite(l, mapping) for l in text.split("\n")) if mapping else text


def renames(layout, pid):
    """server name -> local name, for files of `pid` that were renamed on collision."""
    out = {}
    for local, sp in layout["files"].items():
        if pid_of(sp) == pid and local != sp.rsplit("/", 1)[-1]:
            out[sp.rsplit("/", 1)[-1]] = local
    return out


# ---------- global memory (CLAUDE.md) ----------
def render_global(body):
    body = body.lstrip("\n")
    return HEADER + ("\n" + body if body.strip() else "")


def strip_header(text):
    """The header is an exact block at the top (trailing whitespace tolerated); anything else is body."""
    lines = text.replace("\r\n", "\n").split("\n")
    hl = HEADER.rstrip("\n").split("\n")
    if [l.rstrip() for l in lines[: len(hl)]] == [l.rstrip() for l in hl]:
        return "\n".join(lines[len(hl):]).lstrip("\n")
    return text


def read_global():
    try:
        return strip_header(GLOBAL_FILE.read_text(encoding="utf-8")).lstrip("\n")
    except (OSError, UnicodeDecodeError):
        return None


# ---------- push ----------
def render_index(layout, known):
    parts = []
    for pid in ([None] if layout.get("legacy") else layout["projects"]):
        e = known.get(idx_path(layout, pid))
        if e and e.get("content", "").strip():
            parts.append(link_rewrite_text(e["content"], {} if pid is None else renames(layout, pid)))
    return "".join(p if p.endswith("\n") else p + "\n" for p in parts)


def index_changes(text, layout, known, hook_in, changes):
    """MEMORY.md edits -> per-project changes (a single project sends the file as is)."""
    projects = [None] if layout.get("legacy") else layout["projects"]
    if len(projects) == 1:
        sp = idx_path(layout, projects[0])
        old = known.get(sp)
        if not old or old["sha"] != sha(text):
            added, removed = lines_diff((old or {}).get("content", ""), text)
            changes.append({"path": sp, "content": text, "base_sha": old["sha"] if old else None, "added_lines": added, "removed_lines": removed})
        return
    base_srv, base_loc = {}, {}
    for pid in projects:
        base_srv[pid] = known.get(idx_path(layout, pid), {}).get("content", "").splitlines()
        fwd = renames(layout, pid)
        base_loc[pid] = [link_rewrite(l, fwd) for l in base_srv[pid]]
    all_base = {l for ls in base_loc.values() for l in ls}
    local_lines = text.splitlines()
    local_set = set(local_lines)
    added = {pid: [] for pid in projects}
    removed = {pid: [o for o, loc in zip(base_srv[pid], base_loc[pid]) if loc not in local_set and o.strip()] for pid in projects}
    rule_of = {}
    for l in local_lines:
        if not l.strip() or l in all_base:
            continue
        pid = None
        for target in re.findall(r"\]\(([^)]+)\)", l):  # a link to a known file decides the project
            if target in layout["files"]:
                pid = pid_of(layout["files"][target])
                break
        if pid is None:
            pid, rule_of[l] = route_pid(layout, hook_in)
        rev = {v: k for k, v in renames(layout, pid).items()}
        srv_line = link_rewrite(l, rev)
        if srv_line not in added[pid]:
            added[pid].append(srv_line)
    for pid in projects:
        if not added[pid] and not removed[pid]:
            continue
        drop = set(removed[pid])
        content = "\n".join([l for l in base_srv[pid] if l not in drop] + added[pid]) + "\n"
        sp = idx_path(layout, pid)
        old = known.get(sp)
        if old and old["sha"] == sha(content):
            continue
        c = {"path": sp, "content": content, "base_sha": old["sha"] if old else None, "added_lines": added[pid], "removed_lines": removed[pid]}
        rules = {rule_of.get(l) for l in added[pid]} - {None}
        if rules:
            c["routed_by"] = sorted(rules)[0]
        changes.append(c)


def do_push(session, hook_in=None):
    hook_in = hook_in or {}
    base = load_base()
    layout = load_layout()
    if layout is None:
        # A v1 base (no "v") means files are keyed by their local name: treat as a flat/legacy layout.
        if base is not None and base.get("v") != 3:
            layout = {"v": 3, "legacy": True, "projects": [], "repos": {}, "files": {}}
        else:
            PENDING[0] = len(local_files())  # nothing was ever synced here: every local file is pending if resolve fails
            layout = make_layout(hook_in)
            PENDING[0] = 0
    if base is None:
        base = {"v": 3, "files": {}}
    known = base["files"]
    legacy = layout.get("legacy")
    local = local_files()
    changes, seen = [], set()
    for rel, text in local.items():
        if rel == INDEX:
            continue
        rule = None
        sp = layout["files"].get(rel)
        if sp is None:
            sp, rule = route_new(layout, rel, hook_in)
        seen.add(sp)
        old = known.get(sp)
        if old and old["sha"] == sha(text):
            continue
        c = {"path": sp, "content": text, "base_sha": old["sha"] if old else None}
        if not old:
            c["on_conflict"] = "rename"  # another session may have created the same name meanwhile
            stem = os.path.splitext(rel)[0] + "."
            c["avoid"] = sorted(n for n in local if n != rel and n.startswith(stem))  # a rename must stay free locally
        if rule:
            c["routed_by"] = rule
        changes.append(c)
    if INDEX in local:
        index_changes(local[INDEX], layout, known, hook_in, changes)
    inverse = {sp: rel for rel, sp in layout["files"].items()}
    for sp, old in known.items():
        if sp == GLOBAL:
            continue
        if sp.rsplit("/", 1)[-1] == INDEX:
            if INDEX not in local:
                changes.append({"path": sp, "content": None, "base_sha": old["sha"]})
        elif sp not in seen and (sp in inverse or legacy) and inverse.get(sp, sp) not in local:
            changes.append({"path": sp, "content": None, "base_sha": old["sha"]})
    if not legacy:
        body = read_global()
        if body is not None:
            old = known.get(GLOBAL)
            old_body = (old or {}).get("content", "").lstrip("\n")
            if body != old_body and (old or body.strip()):
                added, removed = lines_diff(old_body, body)
                changes.append({"path": GLOBAL, "content": body, "base_sha": old["sha"] if old else None, "added_lines": added, "removed_lines": removed})
    if not changes:
        return {"changes": 0, "problems": [], "projects": layout["projects"]}
    sent = {c["path"]: c["content"] for c in changes if c["content"] is not None}
    PENDING[0] = len(changes)
    res = request("POST", "/v1/push", {"session": session, "files": changes})
    PENDING[0] = 0
    problems, rerender, moved = [], False, {}
    for r in res.get("results", []):
        sp, status = r.get("path"), r.get("status")
        rel = inverse.get(sp) or (sp if legacy else (sp or "").rsplit("/", 1)[-1])
        if status == "renamed" and r.get("to") and sp in sent:
            rename_local(layout, known, rel, r["to"], sent[sp], moved)
            log(f"push {sp}: renamed to {r['to']}")
            continue
        if status in ("written", "overwrote_remote", "noop") and sp in sent:
            known[sp] = base_entry(sent[sp], sp)
            if not is_merge(sp):
                layout["files"][rel] = sp
        elif status in ("merged", "kept_remote") and r.get("content") is not None:
            known[sp] = base_entry(r["content"], sp)  # another session edited it: take the server text
            if sp == GLOBAL:
                write_text(GLOBAL_FILE, render_global(r["content"]))
            elif is_merge(sp):
                rerender = True
            else:
                write_local(rel, r["content"])
                layout["files"][rel] = sp
        elif status == "deleted" or (status == "noop" and sp not in sent):
            known.pop(sp, None)
            layout["files"].pop(rel, None)
        if status not in ("written", "noop", "deleted"):
            log(f"push {sp}: {status}")
        if status in BAD_STATUSES:
            problems.append((str(sp), status))
    if rerender:
        write_local(INDEX, render_index(layout, known))
    ours = {l for c in changes if c["path"].rsplit("/", 1)[-1] == INDEX for l in c.get("added_lines", [])}
    shared = {l for r in res.get("results", []) for l in (r.get("shared_lines") or []) if isinstance(l, str)}
    relink = relink_index(moved, ours, shared)
    base["v"] = 3
    save_base(base)
    write_json(LAYOUT, layout)
    log(f"push ok: {len(changes)} change(s)" + (f", {len(problems)} problem(s)" if problems else ""))
    if relink:  # send the index lines that now link the renamed files
        again = do_push(session, hook_in)
        return {"changes": len(changes) + again["changes"], "problems": problems + again["problems"], "projects": layout["projects"]}
    return {"changes": len(changes), "problems": problems, "projects": layout["projects"]}


def rename_local(layout, known, rel, to, text, moved):
    """The server stored a new file under `to` because its name was taken. Rename the local copy to
    match (keeping local and server names equal); `moved` collects old -> new local names."""
    new = to.rsplit("/", 1)[-1]
    known[to] = base_entry(text, to)
    layout["files"].pop(rel, None)
    if new == rel or (MEM / new).exists() or new in layout["files"]:
        layout["files"][rel] = to  # keep the local name; layout maps it to the server name
        return
    try:
        (MEM / rel).rename(MEM / new)
    except OSError:
        layout["files"][rel] = to
        return
    layout["files"][new] = to
    moved[rel] = new


def relink_index(moved, ours, shared=()):
    """Point the MEMORY.md lines this push added (`ours`) at renamed files; lines from other sessions
    keep their links. A line in `shared` (another session had added the identical line, so it stands
    for both files) stays, and the relinked line is added after it. True when MEMORY.md changed and
    needs another push."""
    if not moved:
        return False
    try:
        idx = (MEM / INDEX).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return False
    lines, out = idx.split("\n"), []
    for l in lines:
        new = link_rewrite(l, moved) if l in ours else l
        if new != l and l in shared:
            out.append(l)
            if new not in lines:
                out.append(new)
        else:
            out.append(new)
    fixed = "\n".join(out)
    if fixed == idx:
        return False
    write_local(INDEX, fixed)
    return True


# ---------- pull ----------
def do_pull(session, hook_in=None):
    hook_in = hook_in or {}
    had_base = load_base() is not None
    if had_base:
        do_push(session, hook_in)  # same container (resume / compact): don't lose unsent edits
    layout = make_layout(hook_in)
    if layout["legacy"]:  # server without layers: behave like client v1 (flat store, no CLAUDE.md)
        res = request("GET", "/v1/pull")
        server = {f["path"]: f["content"] for f in res.get("files", [])}
        layout["files"] = {rel: rel for rel in server if rel != INDEX}
        wanted = dict(server)
    else:
        res = request("GET", "/v1/pull?projects=" + ",".join(layout["projects"]) + "&global=1")
        server = {f["path"]: f["content"] for f in res.get("files", [])}
        wanted, used, parts = {}, {INDEX}, []
        for pid in layout["projects"]:
            ren = {}
            for name in sorted(sp[len(pdir(pid)):] for sp in server if sp.startswith(pdir(pid))):
                if name == INDEX:
                    continue
                local = name
                if local in used:  # same name in another project of this session
                    stem, ext = os.path.splitext(name)
                    n = 2
                    while f"{stem}.{n}{ext}" in used:
                        n += 1
                    local = f"{stem}.{n}{ext}"
                    ren[name] = local
                used.add(local)
                wanted[local] = server[pdir(pid) + name]
                layout["files"][local] = pdir(pid) + name
            if pdir(pid) + INDEX in server:
                parts.append(link_rewrite_text(server[pdir(pid) + INDEX], ren))
        if parts:
            wanted[INDEX] = "".join(p if p.endswith("\n") else p + "\n" for p in parts)
    MEM.mkdir(parents=True, exist_ok=True)
    if had_base:
        for rel in local_files():
            if rel not in wanted:
                (MEM / rel).unlink(missing_ok=True)
    for rel, text in wanted.items():
        write_local(rel, text)
    if not layout["legacy"]:
        write_text(GLOBAL_FILE, render_global(server.get(GLOBAL, "")))
    save_base({"v": 3, "files": {sp: base_entry(text, sp) for sp, text in server.items()}})
    write_json(LAYOUT, layout)
    log(f"pull ok: {len(server)} file(s), projects {','.join(layout['projects']) or '-'}")
    return {"changes": len(server), "problems": [], "projects": layout["projects"]}


def describe(e):
    """(short code for the status event, human text for the message)"""
    if isinstance(e, urllib.error.HTTPError):
        return f"HTTP {e.code}", f"HTTP {e.code}"
    reason = e.reason if isinstance(e, urllib.error.URLError) else e
    if isinstance(reason, (socket.timeout, TimeoutError)):
        return "TimeoutError", MSG["timeout"].format(name="TimeoutError")
    name = type(reason).__name__
    if isinstance(e, urllib.error.URLError):
        return f"URLError:{name}", MSG["conn_failed"].format(name=name)
    return name, name


def read_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def write_json(path, obj):
    try:
        STATE.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")
        tmp.replace(path)
    except OSError:
        pass


def cli_version(session):
    cache = read_json(CLI_CACHE, {})
    if cache.get("session") == session and cache.get("v") is not None:
        return cache["v"] or None
    ver = ""
    exe = shutil.which("claude") or ("/opt/claude-code/bin/claude" if os.access("/opt/claude-code/bin/claude", os.X_OK) else None)
    if exe:
        try:
            out = subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=5).stdout.split()
            ver = out[0] if out else ""
        except (OSError, subprocess.SubprocessError):
            pass
    write_json(CLI_CACHE, {"session": session, "v": ver})
    return ver or None


AM_CACHE = STATE / "auto_memory.json"


def auto_memory_state(session, hook_in):
    """Is native auto-memory active in the running CLI?

    Claude Code writes the full system prompt into the transcript as an
    `attachment` entry of type `prompt_snapshot`. With auto-memory on, that
    prompt names the memory directory. Observed with Claude Code 2.1.x: the
    snapshot contains MEMSYNC_DIR when memory is on and lacks it when off.
    Returns "true" / "false", or "unknown" before the first snapshot exists
    (e.g. at SessionStart).
    """
    cache = read_json(AM_CACHE, {})
    if cache.get("session") == session and cache.get("v") in ("true", "false"):
        return cache["v"]
    path = hook_in.get("transcript_path")
    if not path or not os.path.isfile(path):
        files = glob.glob(os.path.expanduser("~/.claude/projects/*/*.jsonl"))
        path = max(files, key=os.path.getmtime) if files else None
    state = "unknown"
    if path:
        needle = str(MEM).rstrip("/\\")
        needles = (needle, json.dumps(needle)[1:-1])  # transcripts JSON-escape Windows backslashes
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                for line in f:
                    if '"prompt_snapshot"' not in line:
                        continue
                    try:
                        d = json.loads(line)
                    except ValueError:
                        continue
                    if d.get("type") == "attachment" and (d.get("attachment") or {}).get("type") == "prompt_snapshot":
                        state = "true" if any(n in line for n in needles) else "false"  # the latest snapshot wins
        except OSError:
            pass
    if state != "unknown":
        write_json(AM_CACHE, {"session": session, "v": state})
    return state


def send_status(event, session, hook_in, ok, error, files, reachable, projects=None):
    """POST the status event (flushing queued ones first). Never raises."""
    try:
        ev = {"session": session, "event": event, "ok": bool(ok), "error": error, "files": files,
              "cli_version": cli_version(session),
              "auto_memory": auto_memory_state(session, hook_in),
              "cwd_name": re.split(r"[\\/]", (hook_in.get("cwd") or os.getcwd()).rstrip("\\/"))[-1] or None,
              "projects": projects or None,
              "at": int(time.time() * 1000)}
        queue = read_json(QUEUE, [])
        queue = queue if isinstance(queue, list) else []
        queue.append(ev)
        if reachable:
            while queue:
                try:
                    request("POST", "/v1/status", queue[0], timeout=STATUS_TIMEOUT)
                except Exception as e:  # noqa: BLE001
                    log(f"status post failed: {describe(e)[0]}")
                    break
                queue.pop(0)
        if queue or QUEUE.exists():
            write_json(QUEUE, queue[-QUEUE_MAX:])
    except Exception as e:  # noqa: BLE001
        log(f"status error: {e!r}")


def decide_message(cmd, failed, err_text, res):
    """Return the user-facing message (or None), updating throttle state."""
    st = read_json(NOTIFY, {})
    now = time.time()
    msg = None
    if failed:
        due = (not st.get("failing")) or now - st.get("last_shown", 0) >= THROTTLE_SECS
        if cmd == "pull":
            msg = MSG["pull_failed"].format(err=err_text)
            due = True
        else:
            n = PENDING[0]
            msg = MSG["push_failed"].format(err=err_text, pending=MSG["pending"].format(n=n) if n else "")
        if due:
            st["last_shown"] = now
        else:
            msg = None
        st["failing"] = True
    else:
        if st.get("failing") and cmd == "push":
            msg = MSG["recovered"].format(n=res["changes"])
        st["failing"] = False
        problems = res["problems"]
        if problems and not msg and now - st.get("problem_shown", 0) >= THROTTLE_SECS:
            names = MSG["names_sep"].join(MSG["item"].format(path=p, why=BAD_STATUSES[s]) for p, s in problems[:3])
            more = MSG["more"].format(n=len(problems)) if len(problems) > 3 else ""
            msg = MSG["problems"].format(names=names, more=more)
            st["problem_shown"] = now
    write_json(NOTIFY, st)
    return msg


def emit(cmd, hook_in, msg):
    out = {"systemMessage": msg}
    if cmd == "pull" and (hook_in.get("hook_event_name") or "SessionStart") == "SessionStart":
        out["hookSpecificOutput"] = {"hookEventName": "SessionStart", "additionalContext": msg}
    print(json.dumps(out, ensure_ascii=False))


# ---------- cross-platform lock ----------
LOCK_PATH = None     # default STATE/lock; local mode uses one machine-wide lock file
LOCK_TIMEOUT = None  # seconds to wait; None waits as long as it takes (cloud behaviour)


class LockTimeout(Exception):
    pass


def _try_lock(fd):
    """Non-blocking exclusive lock on an open file descriptor. True when acquired."""
    if fcntl is not None and os.environ.get("MEMSYNC_LOCK_BACKEND") != "excl":
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except OSError:
            return False
    if msvcrt is not None and os.environ.get("MEMSYNC_LOCK_BACKEND") != "excl":
        try:
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            return True
        except OSError:
            return False
    return None  # no OS-level locking available: caller falls back to an O_EXCL lock file


@contextmanager
def file_lock(path, timeout=None):
    """Exclusive inter-process lock held for the with-block: flock (POSIX), msvcrt.locking (Windows),
    or an O_EXCL lock file (stale after 60 s) when neither exists. Raises LockTimeout after `timeout` seconds."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    deadline = None if timeout is None else time.time() + timeout
    fd, excl, owned = None, None, False
    try:
        fd = os.open(str(path), os.O_RDWR | os.O_CREAT, 0o600)
        while True:
            got = _try_lock(fd)
            if got is None:
                os.close(fd)
                fd = None
                excl = Path(str(path) + ".excl")
                while True:
                    try:
                        os.close(os.open(str(excl), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600))
                        owned = True
                        break
                    except FileExistsError:
                        try:
                            if time.time() - excl.stat().st_mtime > 60:
                                excl.unlink()
                                continue
                        except OSError:
                            pass
                        if deadline is not None and time.time() > deadline:
                            raise LockTimeout(str(path))
                        time.sleep(0.05)
                break
            if got:
                break
            if deadline is not None and time.time() > deadline:
                raise LockTimeout(str(path))
            time.sleep(0.05)
        yield
    finally:
        if fd is not None:
            try:
                if fcntl is not None and os.environ.get("MEMSYNC_LOCK_BACKEND") != "excl":
                    fcntl.flock(fd, fcntl.LOCK_UN)
                elif msvcrt is not None:
                    os.lseek(fd, 0, os.SEEK_SET)
                    msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            except OSError:
                pass
            os.close(fd)
        if owned:  # a waiter that timed out must not remove the holder's lock file
            try:
                excl.unlink()
            except OSError:
                pass


# ---------- local mode (Claude Code CLI / desktop on the user's own machine) ----------
# Cloud: one fixed memory dir (MEMSYNC_DIR), one state dir, a proxy injects the token.
# Local: every project has its own native dir (<config>/projects/<slug>/memory), several sessions in
# different projects run at once, the token comes from a file / env var. Same server, same layers:
# only the paths, the lock scope and the first sync differ. See docs/design-local.md.
MODE = os.environ.get("MEMSYNC_MODE") or ("cloud" if (os.environ.get("CLAUDE_CODE_REMOTE") or os.environ.get("MEMSYNC_DIR")) else "local")
LOCAL_COMMANDS = ("install", "uninstall", "migrate", "where")
LOCAL_MARK = "memsync.py"  # hook commands containing this are ours
LOCAL_HOOKS = (("SessionStart", "pull", 30), ("Stop", "push", 30), ("SessionEnd", "push", 15))
LOCAL_LOCK_TIMEOUT = 20
LOCAL_HEADER = HEADER.replace("/root/.claude/CLAUDE.md", "~/.claude/CLAUDE.md")
LOCAL_NO_URL = {
    "en": "Memory sync is not configured: run `python memsync.py install --url <server>` once (or set MEMSYNC_URL).",
    "zh": "记忆同步未配置：请运行一次 `python memsync.py install --url <server>`（或设置 MEMSYNC_URL）。",
}
LOCAL = {"root": None, "state_root": None, "global_base": None, "shared_dir": False}
_ORIG = {"load_base": load_base, "save_base": save_base, "make_layout": make_layout, "detect_workspace": detect_workspace}


def cfg_dir():
    return Path(os.path.expanduser(os.environ.get("CLAUDE_CONFIG_DIR") or "~/.claude"))


def local_state_root():
    return Path(os.path.expanduser(os.environ.get("MEMSYNC_STATE") or str(cfg_dir() / "memsync")))


def java_hash(s):
    """Java/JS String.hashCode over UTF-16 code units, as a signed 32-bit int."""
    h = 0
    data = s.encode("utf-16-le", "surrogatepass")
    for i in range(0, len(data), 2):
        h = (31 * h + int.from_bytes(data[i:i + 2], "little")) & 0xFFFFFFFF
    return h - (1 << 32) if h >= (1 << 31) else h


def base36(n):
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while n:
        n, r = divmod(n, 36)
        out = digits[r] + out
    return out or "0"


def native_slug(path):
    """Claude Code's directory name for a project path: every UTF-16 unit outside [A-Za-z0-9] becomes '-',
    paths over 200 units are cut and get a hash suffix. Same on every OS ('C:\\Users\\u\\p' -> 'C--Users-u-p')."""
    path = str(path)
    units = path.encode("utf-16-le", "surrogatepass")
    s = "".join(chr(u) if (u < 128 and chr(u).isalnum()) else "-" for u in (int.from_bytes(units[i:i + 2], "little") for i in range(0, len(units), 2)))
    if len(s) <= 200:
        return s
    return s[:200] + "-" + base36(abs(java_hash(path)))


def canonical_git_root(top):
    """The root Claude Code keys project memory on: a linked worktree uses the main worktree's root,
    a submodule checkout is its own root."""
    g = top / ".git"
    try:
        if g.is_file():
            txt = g.read_text(encoding="utf-8").strip()
            if txt.startswith("gitdir:"):
                gd = (top / txt[7:].strip()).resolve()
                cd = gd / "commondir"
                if cd.is_file():
                    common = (gd / cd.read_text(encoding="utf-8").strip()).resolve()
                    if common.name == ".git":
                        return common.parent
    except OSError:
        pass
    return top


def user_auto_memory_dir():
    """autoMemoryDirectory from the user's settings.json, if any (then every project shares that dir)."""
    v = read_json(cfg_dir() / "settings.json", {}).get("autoMemoryDirectory")
    return Path(os.path.expanduser(v)) if isinstance(v, str) and v.strip() else None


def local_project_root(hook_in):
    return LOCAL["root"] or os.environ.get("MEMSYNC_WORKSPACE") or os.environ.get("CLAUDE_PROJECT_DIR") or hook_in.get("cwd") or os.getcwd()


def native_memory_dir(root):
    """Where Claude Code keeps auto-memory for a session launched in `root`."""
    top = find_git_root(root)
    base = canonical_git_root(top) if top else Path(root)
    return cfg_dir() / "projects" / native_slug(base) / "memory"


def local_detect_workspace(hook_in):
    """One repo at most: the git root of the project dir. Unlike cloud there is no scan of subdirectories."""
    if LOCAL["shared_dir"]:
        return [], None  # one memory dir for every project (user-level autoMemoryDirectory): no project sync
    root = local_project_root(hook_in)
    top = find_git_root(root)
    info = repo_info(top) if top else None
    return ([info] if info else []), (str(top) if top else None)


def local_make_layout(hook_in):
    layout = _ORIG["make_layout"](hook_in)
    if layout.get("legacy"):
        raise RuntimeError("the server has no layers API (/v1/resolve); upgrade it")
    if not layout["repos"] and layout["projects"] == [NOREPO]:
        layout["projects"] = []  # not a git repo with an origin: global memory only
    return layout


def local_load_base():
    """Per-project base.json plus the machine-wide base of the global file (CLAUDE.md is shared by all projects)."""
    b = _ORIG["load_base"]()
    if b is None:
        return None
    g = read_json(LOCAL["global_base"], None)
    if isinstance(g, dict) and g.get("sha"):
        b.setdefault("files", {})[GLOBAL] = g
    return b


def local_save_base(base):
    files = dict(base.get("files", {}))
    g = files.pop(GLOBAL, None)
    if g is not None:
        write_json(LOCAL["global_base"], g)
    _ORIG["save_base"]({**base, "files": files})


def local_resolve_token(root):
    """Token for this process: MEMSYNC_TOKEN, else MEMSYNC_TOKEN_FILE, else config token_file, else <state>/token."""
    if os.environ.get("MEMSYNC_TOKEN"):
        return
    cfg = read_json(root / "config.json", {})
    for cand in (os.environ.get("MEMSYNC_TOKEN_FILE"), cfg.get("token_file"), str(root / "token")):
        if cand and os.path.isfile(os.path.expanduser(cand)):
            p = os.path.expanduser(cand)
            if os.name == "posix" and os.stat(p).st_mode & 0o077:
                log(f"warning: token file {p} is readable by other users (chmod 600 it)")
            try:
                with open(p, encoding="utf-8") as f:
                    os.environ["MEMSYNC_TOKEN"] = f.read().strip()
            except OSError:
                pass
            return


def local_setup(hook_in, root=None, native=None):
    """Point the module globals at this project's native dir and per-project state. `root`/`native` are for
    migrate (explicit project dir and memory dir); hooks derive both from the session."""
    global URL, MEM, STATE, BASE, LAYOUT, NOTIFY, QUEUE, CLI_CACHE, AM_CACHE, GLOBAL_FILE, HEADER, LOCK_PATH, LOCK_TIMEOUT, LOG
    global load_base, save_base, make_layout, detect_workspace
    LOCAL["root"], LOCAL["shared_dir"] = root, False
    sroot = local_state_root()
    LOCAL["state_root"], LOCAL["global_base"] = sroot, sroot / "global_base.json"
    cfg = read_json(sroot / "config.json", {})
    URL = (os.environ.get("MEMSYNC_URL") or cfg.get("url") or "").strip().rstrip("/")
    MSG["no_url"] = LOCAL_NO_URL[LANG]
    local_resolve_token(sroot)
    GLOBAL_FILE = Path(os.path.expanduser(os.environ.get("MEMSYNC_GLOBAL_FILE") or str(cfg_dir() / "CLAUDE.md")))
    HEADER = LOCAL_HEADER
    load_base, save_base, make_layout, detect_workspace = local_load_base, local_save_base, local_make_layout, local_detect_workspace
    LOCK_PATH, LOCK_TIMEOUT, LOG = sroot / "lock", LOCAL_LOCK_TIMEOUT, sroot / "sync.log"
    repos, _top = local_detect_workspace(hook_in)
    if os.environ.get("MEMSYNC_DIR"):
        MEM = Path(os.path.expanduser(os.environ["MEMSYNC_DIR"]))
    elif native:
        MEM = Path(native)
    elif repos and user_auto_memory_dir():
        # Every project writes into the same user-level dir, while the server keeps memory per project:
        # syncing it would route one repo's files into another's project. Sync only the global file.
        LOCAL["shared_dir"], repos = True, []
        log(f"autoMemoryDirectory is set in user settings ({user_auto_memory_dir()}): project memory is not synced, only CLAUDE.md")
        MEM = sroot / "projects" / "_global" / "memory"
    elif repos:
        MEM = native_memory_dir(local_project_root(hook_in))
    else:
        MEM = sroot / "projects" / "_global" / "memory"  # stays empty: only the global file syncs here
    key = "_global" if not repos else re.sub(r"[^A-Za-z0-9]", "-", MEM.parent.name)[-40:] + "-" + hashlib.sha1(str(MEM).encode("utf-8")).hexdigest()[:8]
    STATE = sroot / "projects" / key
    BASE, LAYOUT = STATE / "base.json", STATE / "layout.json"
    NOTIFY, QUEUE, CLI_CACHE, AM_CACHE = STATE / "notify.json", STATE / "status_queue.json", STATE / "cli_version.json", STATE / "auto_memory.json"
    return MEM


def union_lines(first, second):
    """`first` as is, then the lines of `second` that `first` lacks (blank lines between kept lines survive).
    Nothing of either side is dropped."""
    first, second = first.replace("\r\n", "\n"), second.replace("\r\n", "\n")
    if not first.strip():
        return second if second.endswith("\n") or not second else second + "\n"
    out = first if first.endswith("\n") else first + "\n"
    present = {l.rstrip() for l in first.split("\n")}
    new, pending_blank = [], False
    for l in second.split("\n"):
        if not l.strip():
            pending_blank = bool(new)
        elif l.rstrip() not in present:
            if pending_blank:
                new.append("")
            new.append(l)
            present.add(l.rstrip())
            pending_blank = False
    return out + ("\n".join(new) + "\n" if new else "")


def unique_local_name(name, taken):
    stem, ext = os.path.splitext(name)
    cand, n = f"{stem}.local{ext}", 2
    while cand in taken:
        cand, n = f"{stem}.local{n}{ext}", n + 1
    return cand


def local_backup(rel, text):
    d = STATE / "backup" / time.strftime("%Y%m%d-%H%M%S")
    write_text(d / rel, text)


def local_first_sync(session, hook_in):
    """First sync of a native dir: merge, never delete. Local and server content are unioned on disk first
    (a same-name file with different content keeps the server version at the name and the local one as
    `<stem>.local.md`; MEMORY.md and the global file are line unions), the base is set to the server state, and
    the ordinary push then uploads whatever is local only."""
    layout = make_layout(hook_in)
    projects = layout["projects"]
    res = request("GET", "/v1/pull?projects=" + ",".join(projects) + "&global=1")
    server = {f["path"]: f["content"] for f in res.get("files", [])}
    known = {}
    if projects:
        pd = pdir(projects[0])
        local = local_files()
        srv = {sp[len(pd):]: t for sp, t in server.items() if sp.startswith(pd) and sp != pd + INDEX}
        taken = set(local) | set(srv) | {INDEX}
        rename = {}
        for name, text in sorted(local.items()):
            if name != INDEX and name in srv and srv[name] != text:
                rename[name] = unique_local_name(name, taken)
                taken.add(rename[name])
                local_backup(name, text)
                write_local(rename[name], text)
        for name, text in srv.items():
            dest = MEM / name
            if name not in local and dest.exists():  # unreadable or oversized local file: move it aside, never overwrite
                aside = unique_local_name(name, taken)
                taken.add(aside)
                os.replace(str(dest), str(MEM / aside))
            write_local(name, text)
            known[pd + name] = base_entry(text, pd + name)
            layout["files"][name] = pd + name
        sidx = server.get(pd + INDEX, "")
        merged = union_lines(sidx, link_rewrite_text(local[INDEX], rename)) if INDEX in local else sidx
        if INDEX not in local and merged and (MEM / INDEX).exists():  # unreadable or oversized local index: move it aside
            aside = unique_local_name(INDEX, taken)
            taken.add(aside)
            os.replace(str(MEM / INDEX), str(MEM / aside))
        if merged or INDEX in local:
            write_local(INDEX, merged)
        if pd + INDEX in server:
            known[pd + INDEX] = base_entry(sidx, pd + INDEX)
    gbase = read_json(LOCAL["global_base"], None)
    if isinstance(gbase, dict) and GLOBAL in server:  # global file already synced from another project of this machine
        lb = read_global()
        if lb is not None and lb.lstrip("\n") == gbase.get("content", "").lstrip("\n"):  # no pending local edit: take the server text
            write_text(GLOBAL_FILE, render_global(server[GLOBAL]))
            known[GLOBAL] = base_entry(server[GLOBAL], GLOBAL)
    if not isinstance(gbase, dict):  # first sync of the global file on this machine
        try:
            local_backup("CLAUDE.md", GLOBAL_FILE.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError):
            pass
        body = union_lines(server.get(GLOBAL, ""), read_global() or "")
        write_text(GLOBAL_FILE, render_global(body))
        if GLOBAL in server:
            known[GLOBAL] = base_entry(server[GLOBAL], GLOBAL)
    save_base({"v": 3, "files": known})
    write_json(LAYOUT, layout)
    log(f"first sync: {len(server)} server file(s), projects {','.join(projects) or '-'}")
    res = do_push(session, hook_in)
    res["changes"] = max(res["changes"], 1)
    return res


def dispatch(cmd, session, hook_in):
    if MODE == "local" and load_base() is None:
        return local_first_sync(session, hook_in)
    return do_pull(session, hook_in) if cmd == "pull" else do_push(session, hook_in)


# ----- install / uninstall / migrate / where -----
def hook_command(python, script, sub, windows=None):
    """Hook command line. On Windows, forward slashes in double quotes work in Git Bash and cmd alike."""
    win = (os.name == "nt") if windows is None else windows
    fix = (lambda p: str(p).replace("\\", "/")) if win else str
    return f'"{fix(python)}" "{fix(script)}" {sub}'


def is_ours(hook):
    return isinstance(hook, dict) and LOCAL_MARK in str(hook.get("command", ""))


def strip_hooks(settings):
    """Remove our hook entries from a settings dict (in place); empty containers we leave behind are dropped."""
    hooks = settings.get("hooks")
    if not isinstance(hooks, dict):
        return settings
    for ev in list(hooks):
        groups = hooks[ev]
        if not isinstance(groups, list):
            continue
        kept = []
        for g in groups:
            inner = g.get("hooks") if isinstance(g, dict) else None
            if isinstance(inner, list) and any(is_ours(h) for h in inner):
                rest = [h for h in inner if not is_ours(h)]
                if rest:
                    kept.append({**g, "hooks": rest})
            else:
                kept.append(g)
        if kept:
            hooks[ev] = kept
        else:
            del hooks[ev]
    if not hooks:
        del settings["hooks"]
    return settings


def merge_hooks(settings, command_for):
    """Add our hooks to a settings dict (in place), replacing earlier memsync entries, keeping every other hook."""
    if not isinstance(settings.get("hooks", {}), dict):
        raise ValueError("settings.json: 'hooks' is not an object")
    strip_hooks(settings)
    hooks = settings.setdefault("hooks", {})
    for ev, sub, timeout in LOCAL_HOOKS:
        hooks.setdefault(ev, []).append({"hooks": [{"type": "command", "timeout": timeout, "command": command_for(sub)}]})
    return settings


def load_settings(path):
    if not path.exists():
        return {}
    try:
        d = json.loads(path.read_text(encoding="utf-8-sig"))
    except ValueError as e:
        raise ValueError(f"{path} is not valid JSON ({e}); fix it first, nothing was changed")
    if not isinstance(d, dict):
        raise ValueError(f"{path} is not a JSON object")
    return d


def save_settings(path, settings):
    """Backup (once per change) + atomic write."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        shutil.copy2(str(path), str(path) + ".memsync-bak-" + time.strftime("%Y%m%d-%H%M%S"))
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(settings, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(str(tmp), str(path))


def write_private(path, text):
    """UTF-8 file readable only by the user (0600 on POSIX, icacls on Windows)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    if os.name == "posix":
        os.chmod(str(path), 0o600)
    elif os.name == "nt":
        try:
            subprocess.run(["icacls", str(path), "/inheritance:r", "/grant:r", f"{os.environ.get('USERNAME', '')}:F"], capture_output=True, timeout=10)
        except (OSError, subprocess.SubprocessError):
            pass


def cmd_install(args):
    import argparse
    ap = argparse.ArgumentParser(prog="memsync.py install")
    ap.add_argument("--url")
    ap.add_argument("--token-file", help="existing file holding the token (kept where it is, path recorded)")
    ap.add_argument("--token-stdin", action="store_true", help="read the token from stdin into a private file")
    a = ap.parse_args(args)
    sroot = local_state_root()
    cfg = read_json(sroot / "config.json", {})
    url = (a.url or cfg.get("url") or os.environ.get("MEMSYNC_URL") or "").strip().rstrip("/")
    if not re.match(r"^https?://[^/\s]+", url):
        print("install: --url https://your-memory-host is required", file=sys.stderr)
        return 2
    settings_path = cfg_dir() / "settings.json"
    settings = load_settings(settings_path)  # fails before anything is written
    sroot.mkdir(parents=True, exist_ok=True)
    script = sroot / "memsync.py"
    if os.path.abspath(__file__) != os.path.abspath(str(script)):
        shutil.copy2(__file__, str(script))
    if a.token_stdin:
        token = sys.stdin.read().strip()
        if not token:
            print("install: empty token on stdin", file=sys.stderr)
            return 2
        write_private(sroot / "token", token + "\n")
        cfg.pop("token_file", None)
    elif a.token_file:
        tf = os.path.abspath(os.path.expanduser(a.token_file))
        if not os.path.isfile(tf):
            print(f"install: token file not found: {tf}", file=sys.stderr)
            return 2
        cfg["token_file"] = tf
    cfg["url"] = url
    write_json(sroot / "config.json", cfg)
    merge_hooks(settings, lambda sub: hook_command(sys.executable, script, sub))
    save_settings(settings_path, settings)
    have_token = bool(os.environ.get("MEMSYNC_TOKEN")) or any(os.path.isfile(os.path.expanduser(p)) for p in (cfg.get("token_file"), str(sroot / "token")) if p)
    print(f"memsync installed: hooks in {settings_path}, client and config in {sroot}")
    if not have_token:
        print("no token yet: pipe it in (`... install --token-stdin`), pass --token-file, or export MEMSYNC_TOKEN where Claude Code starts")
    return 0


def cmd_uninstall(args):
    global HEADER
    purge = "--purge" in args
    settings_path = cfg_dir() / "settings.json"
    settings = load_settings(settings_path)
    before = json.dumps(settings, sort_keys=True)
    strip_hooks(settings)
    if json.dumps(settings, sort_keys=True) != before:
        save_settings(settings_path, settings)
    try:  # take our header off the global file; the user's own text stays
        gf = Path(os.path.expanduser(os.environ.get("MEMSYNC_GLOBAL_FILE") or str(cfg_dir() / "CLAUDE.md")))
        text = gf.read_text(encoding="utf-8")
        HEADER = LOCAL_HEADER
        body = strip_header(text)
        if body != text:
            gf.write_text(body, encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        pass
    if purge:
        shutil.rmtree(str(local_state_root()), ignore_errors=True)
    print("memsync hooks removed" + (", state and token deleted" if purge else f" (state kept in {local_state_root()}; --purge deletes it)") + ". Memory files were not touched.")
    return 0


def transcript_cwd(pdir_):
    """cwd recorded in the newest transcripts of a ~/.claude/projects/<slug> dir (the slug itself is lossy)."""
    files = sorted(pdir_.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)[:5]
    for f in files:
        try:
            with f.open(encoding="utf-8", errors="replace") as fh:
                for i, line in enumerate(fh):
                    if i > 80:
                        break
                    if '"cwd"' in line:
                        try:
                            c = json.loads(line).get("cwd")
                        except ValueError:
                            continue
                        if isinstance(c, str) and c:
                            return c
        except OSError:
            continue
    return None


def cmd_migrate(args):
    apply = "--apply" in args
    base = cfg_dir() / "projects"
    rows = []
    for d in sorted(base.iterdir()) if base.is_dir() else []:
        mem = d / "memory"
        n = len([p for p in mem.rglob("*.md")]) if mem.is_dir() else 0
        if not n:
            continue
        cwd = transcript_cwd(d)
        top = find_git_root(cwd) if cwd and os.path.isdir(cwd) else None
        info = repo_info(top) if top else None
        rows.append((d.name, mem, n, cwd, info))
    rc = 0
    for name, mem, n, cwd, info in rows:
        if not info:
            print(f"skip   {name}: {n} file(s), " + ("cwd unknown" if not cwd else "not a git checkout with an origin" if os.path.isdir(cwd) else "cwd no longer exists"))
            continue
        if not apply:
            print(f"would sync {name}: {n} file(s) -> project {info['url']}")
            continue
        if not URL_OK():
            print("migrate: server URL not configured (run install first)", file=sys.stderr)
            return 2
        try:
            local_setup({"cwd": cwd}, root=cwd, native=str(mem))
            with file_lock(LOCK_PATH, LOCAL_LOCK_TIMEOUT):
                r = dispatch("pull", "migrate", {"cwd": cwd})
            print(f"synced {name}: {n} file(s) -> project {info['url']} ({r['changes']} change(s))")
        except Exception as e:  # noqa: BLE001
            rc = 1
            print(f"failed {name}: {describe(e)[1]}", file=sys.stderr)
    if not apply and rows:
        print("dry run; add --apply to sync (merge only, nothing is deleted)")
    return rc


def URL_OK():
    cfg = read_json(local_state_root() / "config.json", {})
    return bool(os.environ.get("MEMSYNC_URL") or cfg.get("url"))


def cmd_where(args):
    root = os.path.abspath(args[0]) if args else os.getcwd()
    local_setup({"cwd": root}, root=root)
    repos, top = local_detect_workspace({"cwd": root})
    print(json.dumps({"project_root": root, "git_root": top, "project": repos[0]["url"] if repos else None,
                      "memory_dir": str(user_auto_memory_dir() if LOCAL["shared_dir"] else MEM), "synced": bool(repos),
                      "shared_dir": LOCAL["shared_dir"], "state_dir": str(STATE)}, indent=2))
    return 0


def local_admin(cmd, args):
    try:
        return {"install": cmd_install, "uninstall": cmd_uninstall, "migrate": cmd_migrate, "where": cmd_where}[cmd](args)
    except ValueError as e:
        print(f"{cmd}: {e}", file=sys.stderr)
        return 1


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd in LOCAL_COMMANDS:
        return local_admin(cmd, sys.argv[2:])
    hook_in = {}
    if not sys.stdin.isatty():
        try:
            j = json.loads(sys.stdin.read() or "{}")
            hook_in = j if isinstance(j, dict) else {}
        except ValueError:
            pass
    session = os.environ.get("CLAUDE_CODE_REMOTE_SESSION_ID") or hook_in.get("session_id") or ""
    if cmd not in ("pull", "push"):
        print("usage: memsync.py pull|push|install|uninstall|migrate|where", file=sys.stderr)
        return 0
    if MODE == "local":
        local_setup(hook_in)
    if not URL:
        # Misconfiguration: say so once per throttle window instead of failing silently.
        st = read_json(NOTIFY, {})
        if time.time() - st.get("config_shown", 0) >= THROTTLE_SECS:
            st["config_shown"] = time.time()
            write_json(NOTIFY, st)
            emit(cmd, hook_in, MSG["no_url"])
        log(f"{cmd}: MEMSYNC_URL is not set")
        return 0
    try:
        STATE.mkdir(parents=True, exist_ok=True)
        with file_lock(LOCK_PATH or STATE / "lock", LOCK_TIMEOUT):
            failed, err_code, err_text, reachable = False, None, "", True
            res = {"changes": 0, "problems": []}
            try:
                res = dispatch(cmd, session, hook_in)
            except Exception as e:  # noqa: BLE001  a hook must never break the session
                detail = e.read().decode("utf-8", "replace")[:200] if isinstance(e, urllib.error.HTTPError) else ""
                log(f"{cmd} failed: {e!r} {detail}")
                failed = True
                err_code, err_text = describe(e)
                reachable = isinstance(e, urllib.error.HTTPError)
            problems = res["problems"]
            st = read_json(NOTIFY, {})
            heartbeat = time.time() - st.get("heartbeat", 0) >= THROTTLE_SECS  # no-op pushes: at most one event / 10 min
            if cmd == "pull" or res["changes"] or failed or heartbeat:
                if not (cmd == "pull" or res["changes"] or failed):
                    st["heartbeat"] = time.time()
                    write_json(NOTIFY, st)
                err = err_code if failed else (",".join(sorted({s for _, s in problems})) or None)
                send_status(cmd, session, hook_in, not failed and not problems, err, res["changes"], reachable, res.get("projects"))
            msg = decide_message(cmd, failed, err_text, res)
            if msg:
                emit(cmd, hook_in, msg)
    except Exception as e:  # noqa: BLE001
        log(f"{cmd} internal error: {e!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
