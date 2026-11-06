#!/usr/bin/env bash
# Mirror the Windows checkout into the WSL copy the tests actually run in.
# Usage: sync-wsl.sh [test paths...]   — copies sources and tests, normalises CRLF, then runs vitest.
set -euo pipefail
export PATH=$HOME/.local/opt/node-v22.22.0-linux-x64/bin:$PATH
SRC=/mnt/f/dsh/dsh-foreman
DST=$HOME/src/dsh-foreman
mkdir -p "$DST/tests" "$DST/src"
rsync -a --exclude node_modules --exclude lib --exclude .git --exclude .superpowers --exclude '*.log' "$SRC/src/" "$DST/src/"
rsync -a "$SRC/tests/" "$DST/tests/"
for f in package.json tsconfig.json vitest.config.ts tsdown.config.ts; do cp "$SRC/$f" "$DST/$f"; done
find "$DST/src" "$DST/tests" -type f \( -name '*.ts' -o -name '*.tsx' \) -exec sed -i 's/\r$//' {} +
cd "$DST"
if [ $# -eq 0 ]; then
  node node_modules/vitest/vitest.mjs run --testTimeout=60000 --hookTimeout=60000
else
  node node_modules/vitest/vitest.mjs run --testTimeout=60000 --hookTimeout=60000 "$@"
fi
