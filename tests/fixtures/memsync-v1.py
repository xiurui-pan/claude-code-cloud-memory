#!/usr/bin/env python3
"""Claude Code cloud-session memory sync client.

Runs as a hook:
  memsync.py pull   (SessionStart)  push pending local changes, then mirror the server into MEMSYNC_DIR
  memsync.py push   (Stop / SessionEnd)  send files that changed since the last sync

The bearer token is injected by the cloud environment's network proxy (a network secret
for the memory host), so this script never holds it. MEMSYNC_TOKEN is honoured only
for local testing.

Environment: MEMSYNC_URL (required), MEMSYNC_DIR (default /root/memory),
MEMSYNC_STATE (default ~/.claude/memsync), MEMSYNC_LANG (en|zh, default en). A hook must never break the session: every failure exits 0.

Error visibility: failures are reported to the user as a hook JSON `systemMessage` (stdout is
either empty or exactly one JSON object), and a small status event is POSTed to /v1/status
(queued locally in STATE/status_queue.json when the server can't be reached).
"""
import fcntl
import glob
import hashlib
import json
import os
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
BASE = STATE / "base.json"
LOG = STATE / "sync.log"
INDEX = "MEMORY.md"
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
    req.add_header("user-agent", "memsync/1")
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
        try:
            text = p.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        if len(text.encode("utf-8")) <= MAX_FILE_BYTES:
            out[rel] = text
    return out


def write_local(rel, text):
    p = MEM / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")


def base_entry(text, rel):
    e = {"sha": sha(text)}
    if rel == INDEX:
        e["content"] = text  # kept so the next push can send a line diff
    return e


def do_push(session):
    base = load_base()
    if base is None:
        base = {"files": {}}
    known = base["files"]
    local = local_files()
    changes = []
    for rel, text in local.items():
        old = known.get(rel)
        if old and old["sha"] == sha(text):
            continue
        c = {"path": rel, "content": text, "base_sha": old["sha"] if old else None}
        if rel == INDEX:
            before = (old or {}).get("content", "").splitlines()
            after = text.splitlines()
            c["added_lines"] = [l for l in after if l not in set(before)]
            c["removed_lines"] = [l for l in before if l not in set(after)]
        changes.append(c)
    for rel, old in known.items():
        if rel not in local:
            changes.append({"path": rel, "content": None, "base_sha": old["sha"]})
    if not changes:
        return {"changes": 0, "problems": []}
    PENDING[0] = len(changes)
    res = request("POST", "/v1/push", {"session": session, "files": changes})
    PENDING[0] = 0
    problems = []
    for r in res.get("results", []):
        rel, status = r.get("path"), r.get("status")
        if status in ("written", "overwrote_remote", "noop") and rel in local:
            known[rel] = base_entry(local[rel], rel)
        elif status == "merged" and r.get("content") is not None:
            write_local(rel, r["content"])
            known[rel] = base_entry(r["content"], rel)
        elif status == "kept_remote" and r.get("content") is not None:
            write_local(rel, r["content"])  # another session edited it; our delete loses
            known[rel] = base_entry(r["content"], rel)
        elif status == "deleted" or (status == "noop" and rel not in local):
            known.pop(rel, None)
        if status not in ("written", "noop", "deleted"):
            log(f"push {rel}: {status}")
        if status in BAD_STATUSES:
            problems.append((str(rel), status))
    save_base(base)
    log(f"push ok: {len(changes)} change(s)" + (f", {len(problems)} problem(s)" if problems else ""))
    return {"changes": len(changes), "problems": problems}


def do_pull(session):
    if load_base() is not None:
        do_push(session)  # same container (resume / compact): don't lose unsent edits
    res = request("GET", "/v1/pull")
    server = {f["path"]: f["content"] for f in res.get("files", [])}
    MEM.mkdir(parents=True, exist_ok=True)
    for rel in local_files():
        if rel not in server:
            (MEM / rel).unlink(missing_ok=True)
    for rel, text in server.items():
        write_local(rel, text)
    save_base({"files": {rel: base_entry(text, rel) for rel, text in server.items()}})
    log(f"pull ok: {len(server)} file(s)")
    return {"changes": len(server), "problems": []}


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


def send_status(event, session, hook_in, ok, error, files, reachable):
    """POST the status event (flushing queued ones first). Never raises."""
    try:
        ev = {"session": session, "event": event, "ok": bool(ok), "error": error, "files": files,
              "cli_version": cli_version(session),
              "auto_memory": auto_memory_state(session, hook_in),
              "cwd_name": os.path.basename((hook_in.get("cwd") or os.getcwd()).rstrip("/")) or None,
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
                res = do_pull(session) if cmd == "pull" else do_push(session)
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
                send_status(cmd, session, hook_in, not failed and not problems, err, res["changes"], reachable)
            msg = decide_message(cmd, failed, err_text, res)
            if msg:
                emit(cmd, hook_in, msg)
    except Exception as e:  # noqa: BLE001
        log(f"{cmd} internal error: {e!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
