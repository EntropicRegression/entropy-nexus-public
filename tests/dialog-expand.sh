#!/usr/bin/env bash
# 對話視窗展開到滿與輸入框展開的驗收:假資料模式執行 tests/dialog-expand.e2e.js。
# 用法:先 npm run build,再在 app 資料夾執行 bash tests/dialog-expand.sh。不碰正式資料,也不消耗額度。
set -u
cd "$(dirname "$0")/.."
T="$(cygpath -u "$TEMP")/nexus-expand-$$-$RANDOM"
mkdir -p "$T/shots" "$T/profile"
PORT=$((40000 + RANDOM % 9000))
export NEXUS_FAKE=1 NEXUS_REMOTE_PORT=$PORT NEXUS_HOOKS_PORT=$((PORT + 1)) NEXUS_DATA_DIR="$(cygpath -w "$T/profile")" NEXUS_TEST_DIR="$(cygpath -w "$T/shots")" \
  NEXUS_TEST_SCRIPT="$(pwd -W)/tests/dialog-expand.e2e.js"
timeout 120 ./node_modules/electron/dist/electron.exe . 2>&1 | grep -E '^\[test\]' | cut -c1-400
echo "截圖位置:$(cygpath -w "$T/shots")"
