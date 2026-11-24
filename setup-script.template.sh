#!/bin/bash
# claude-code-cloud-memory client v3. Bump this line to invalidate the cached environment snapshot.
# Project memory lives in /root/memory, global memory in /root/.claude/CLAUDE.md; both sync to __MEMSYNC_URL__
# (token: network secret, never in this script).
MEMSYNC_LANG=en   # set to zh for Chinese hook messages
mkdir -p /root/.claude/memsync /root/memory
curl -fsS --max-time 30 __MEMSYNC_URL__/client/memsync.py \
  -o /root/.claude/memsync/memsync.py || echo "memsync: client download failed"
cat > /root/.claude/settings.json <<EOF_SETTINGS
{
  "env": {
    "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "0",
    "MEMSYNC_URL": "__MEMSYNC_URL__",
    "MEMSYNC_DIR": "/root/memory",
    "MEMSYNC_LANG": "${MEMSYNC_LANG}"
  },
  "autoMemoryDirectory": "/root/memory",
  "hooks": {
    "SessionStart": [{"hooks": [{"type": "command", "timeout": 30,
      "command": "python3 /root/.claude/memsync/memsync.py pull"}]}],
    "Stop": [{"hooks": [{"type": "command", "timeout": 30,
      "command": "python3 /root/.claude/memsync/memsync.py push"}]}],
    "SessionEnd": [{"hooks": [{"type": "command", "timeout": 15,
      "command": "python3 /root/.claude/memsync/memsync.py push"}]}]
  }
}
EOF_SETTINGS
echo "memsync: setup done"
