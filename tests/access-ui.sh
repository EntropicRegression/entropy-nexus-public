#!/usr/bin/env bash
# 權限的畫面驗收:主控台(tests/access-ui.e2e.js)在「手機」面板設定唯讀、只看一個節點的配對權限,
# 再由 tests/access-ui-browser.cjs 以那支裝置連進完整介面與手機版頁面,檢查畫面與伺服器的拒絕。
# 用法:先 npm run build,再在 app 資料夾執行 bash tests/access-ui.sh。不碰正式資料,也不消耗額度。
set -u
cd "$(dirname "$0")/.."
T="$(cygpath -u "$TEMP")/nexus-accessui-$$-$RANDOM"
mkdir -p "$T/shots" "$T/profile"
PORT=$((40000 + RANDOM % 9000))
LOG="$T/run.log"
export NEXUS_FAKE=1 NEXUS_REMOTE_PORT=$PORT NEXUS_HOOKS_PORT=$((PORT + 1)) NEXUS_DATA_DIR="$(cygpath -w "$T/profile")" NEXUS_TEST_DIR="$(cygpath -w "$T/shots")" \
  NEXUS_TEST_SCRIPT="$(pwd -W)/tests/access-ui.e2e.js"
timeout 240 ./node_modules/electron/dist/electron.exe . > "$LOG" 2>&1 &
APP=$!
for _ in $(seq 1 240); do grep -q '\[test\] PAIR' "$LOG" && break; kill -0 $APP 2>/dev/null || break; sleep 0.5; done
set -- $(grep -o '\[test\] PAIR .*' "$LOG" | head -1)
if [ $# -ge 6 ]; then
  env -u NEXUS_TEST_SCRIPT -u NEXUS_DATA_DIR timeout 120 ./node_modules/electron/dist/electron.exe tests/access-ui-browser.cjs "$5" "$3" "$4" "$(cygpath -w "$T/shots")" "$(cygpath -w "$T")" 2>&1 | grep -E '^\[browser\]'
else
  echo "主控台沒有印出配對碼,略過瀏覽器檢查"
fi
wait $APP
grep -E '^\[test\]' "$LOG" | grep -v 'PAIR' | cut -c1-400
echo "截圖位置:$(cygpath -w "$T/shots")"
