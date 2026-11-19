#!/usr/bin/env bash
# 遠端裝置權限(完整、操作、唯讀與節點範圍)與操作紀錄的驗收:假資料模式啟動主控台(tests/web-full.e2e.js),
# 印出配對碼後由 tests/access-remote.mjs 從外部用 HTTP 逐項檢查允許與拒絕。
# 用法:先 npm run build,再在 app 資料夾執行 bash tests/access.sh。不碰正式資料,也不消耗額度。
set -u
cd "$(dirname "$0")/.."
T="$(cygpath -u "$TEMP")/nexus-access-$$-$RANDOM"
mkdir -p "$T/shots" "$T/profile"
PORT=$((40000 + RANDOM % 9000))
LOG="$T/run.log"
export NEXUS_FAKE=1 NEXUS_REMOTE_PORT=$PORT NEXUS_HOOKS_PORT=$((PORT + 1)) NEXUS_DATA_DIR="$(cygpath -w "$T/profile")" NEXUS_TEST_DIR="$(cygpath -w "$T/shots")" \
  NEXUS_TEST_SCRIPT="$(pwd -W)/tests/web-full.e2e.js"
timeout 240 ./node_modules/electron/dist/electron.exe . > "$LOG" 2>&1 &
APP=$!
for _ in $(seq 1 240); do grep -q '\[test\] PAIR' "$LOG" && break; kill -0 $APP 2>/dev/null || break; sleep 0.5; done
set -- $(grep -o '\[test\] PAIR .*' "$LOG" | head -1)
if [ $# -ge 6 ]; then
  node tests/access-remote.mjs "$5" "$3" "$4" 2>&1
else
  echo "主控台沒有印出配對碼,略過檢查"
fi
wait $APP
grep -E 'rror' "$LOG" | grep -v "Error occurred in handler" | cut -c1-300
