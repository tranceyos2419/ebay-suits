#!/bin/bash
# Installs npm dependencies (pdf-lib, pdfjs-dist, ...) so scripts such as
# src/shipping/stamp_airpacket.ts work as soon as a session starts.
set -euo pipefail

cd "${CLAUDE_PROJECT_DIR:-.}"

# Run npm install only if package.json / package-lock.json / this script changed
hashes=node_modules/.session-start.sha256
if ! sha256sum --check --status "$hashes" 2>/dev/null; then
  rm -f "$hashes"
  npm install --no-audit --no-fund >&2
  sha256sum .claude/hooks/session-start.sh package.json package-lock.json 2>/dev/null > "$hashes" || rm -f "$hashes"
fi
