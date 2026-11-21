#!/usr/bin/env bash
# 重拍 README 的截圖(docs/screenshot-board.png、docs/screenshot-dialog.png),假資料模式,不消耗額度。
# 用法:先 npm run build,再在 app 資料夾執行 bash tests/readme-shots.sh;截圖先存到暫存資料夾,確認後加 --apply 覆蓋 docs 裡的檔案。
set -u
cd "$(dirname "$0")/.."
T="$(cygpath -u "$TEMP")/nexus-readme-$$-$RANDOM"
mkdir -p "$T/shots" "$T/profile" "$T/nexus-demo/webapp"
PORT=$((40000 + RANDOM % 9000))
export NEXUS_FAKE=1 NEXUS_FAKE_NO_ERRORS=1 NEXUS_NO_SEED=1 NEXUS_REMOTE_PORT=$PORT NEXUS_HOOKS_PORT=$((PORT + 1)) NEXUS_INTEROP_PORT=$((PORT + 2)) \
  NEXUS_DATA_DIR="$(cygpath -w "$T/profile")" NEXUS_TEST_DIR="$(cygpath -w "$T/shots")" NEXUS_TEST_SCRIPT="$(pwd -W)/tests/readme-shots.e2e.js" NEXUS_TEST_CWD="$(cygpath -w "$T/nexus-demo/webapp")"
for v in $(env | grep -oE '^(CLAUDE|ANTHROPIC)[A-Z_0-9]*'); do unset "$v"; done
timeout 240 ./node_modules/electron/dist/electron.exe . 2>&1 | grep -E '^\[test\]'
echo "截圖:$(cygpath -w "$T/shots")"
if [ "${1:-}" = "--apply" ]; then
  cp "$T/shots/board.png" docs/screenshot-board.png && cp "$T/shots/dialog.png" docs/screenshot-dialog.png && echo "已覆蓋 docs/screenshot-board.png、docs/screenshot-dialog.png"
fi
