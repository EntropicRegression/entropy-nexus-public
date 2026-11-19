#!/usr/bin/env bash
# 節點互相呼叫的驗收:假資料模式啟動主控台(tests/interop.e2e.js),再由 tests/interop-client.mjs 扮演各節點的 CLI,
# 用 MCP 連到主控台的工具服務,檢查列出節點、呼叫、授權、忙碌、迴圈與逾時後接著等。
# 用法:先 npm run build,再在 app 資料夾執行 bash tests/interop.sh。不碰正式資料,也不消耗額度。
set -u
cd "$(dirname "$0")/.."
T="$(cygpath -u "$TEMP")/nexus-interop-$$-$RANDOM"
mkdir -p "$T/shots" "$T/profile" "$T/work"
PORT=$((40000 + RANDOM % 9000))
LOG="$T/run.log"
export NEXUS_FAKE=1 NEXUS_FAKE_NO_ERRORS=1 NEXUS_NO_SEED=1 NEXUS_REMOTE_PORT=$PORT NEXUS_HOOKS_PORT=$((PORT + 1)) NEXUS_INTEROP_PORT=$((PORT + 2)) NEXUS_INTEROP_WAIT_MS=2500 \
  NEXUS_DATA_DIR="$(cygpath -w "$T/profile")" NEXUS_TEST_DIR="$(cygpath -w "$T/shots")" NEXUS_TEST_SCRIPT="$(pwd -W)/tests/interop.e2e.js" NEXUS_TEST_CWD="$(cygpath -w "$T/work")"
timeout 280 ./node_modules/electron/dist/electron.exe . > "$LOG" 2>&1 &
APP=$!
node tests/interop-client.mjs "$(cygpath -w "$LOG")" "$(cygpath -w "$T/profile")" 2>&1 | cut -c1-500
wait $APP
grep -E '^\[test\]' "$LOG" | grep -v ' READY ' | cut -c1-400
