#!/bin/bash
# Fill the public URL into setup-script.template.sh and print the result.
# Usage: selfhost/render-setup-script.sh https://memory.example.com > setup-script.rendered.sh
set -euo pipefail
URL="${1:-}"
case "$URL" in
  https://*) ;;
  *) echo "usage: $0 https://your-public-host   (cloud sessions need a public HTTPS URL)" >&2; exit 2 ;;
esac
URL="${URL%/}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# '|' as the sed delimiter; URLs do not contain it.
sed "s|__MEMSYNC_URL__|${URL}|g" "$DIR/setup-script.template.sh"
