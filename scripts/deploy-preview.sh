#!/bin/bash
# 把仓库当前构建产物同步到指定 profile 的 dsh-foreman 安装目录（本地预览用）。
# 用法: scripts/deploy-preview.sh [profile]   默认 superagent
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PROFILE=${1:-superagent}
TARGET="$HOME/.dsh/profiles/$PROFILE/node_modules/dsh-foreman"
[ -d "$TARGET" ] || { echo "missing target: $TARGET" >&2; exit 1; }
cd "$ROOT"
pnpm -s build
rsync -a --delete --exclude node_modules --exclude .git --exclude '.artifacts' --exclude '*.tgz' "$ROOT"/ "$TARGET"/
echo "deployed to $TARGET"
