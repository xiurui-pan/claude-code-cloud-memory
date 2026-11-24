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

Error visibility: failures are reported to the user as a hook JSON `systemMessage` (stdout is
either empty or exactly one JSON object), and a small status event is POSTed to /v1/status
(queued locally in STATE/status_queue.json when the server can't be reached).
"""
import fcntl
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
from pathlib import Path

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
    relink = relink_index(moved, ours)
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


def relink_index(moved, ours):
    """Point the MEMORY.md lines this push added (`ours`) at renamed files; lines from other sessions
    keep their links. True when MEMORY.md changed and needs another push."""
    if not moved:
        return False
    try:
        idx = (MEM / INDEX).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return False
    fixed = "\n".join(link_rewrite(l, moved) if l in ours else l for l in idx.split("\n"))
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
        needle = str(MEM).rstrip("/")
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
                        state = "true" if needle in line else "false"  # the latest snapshot wins
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
              "cwd_name": os.path.basename((hook_in.get("cwd") or os.getcwd()).rstrip("/")) or None,
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


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    hook_in = {}
    if not sys.stdin.isatty():
        try:
            j = json.loads(sys.stdin.read() or "{}")
            hook_in = j if isinstance(j, dict) else {}
        except ValueError:
            pass
    session = os.environ.get("CLAUDE_CODE_REMOTE_SESSION_ID") or hook_in.get("session_id") or ""
    if cmd not in ("pull", "push"):
        print("usage: memsync.py pull|push", file=sys.stderr)
        return 0
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
        with (STATE / "lock").open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            failed, err_code, err_text, reachable = False, None, "", True
            res = {"changes": 0, "problems": []}
            try:
                res = do_pull(session, hook_in) if cmd == "pull" else do_push(session, hook_in)
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
