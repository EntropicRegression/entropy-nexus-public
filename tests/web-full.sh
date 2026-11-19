#!/usr/bin/env bash
# 瀏覽器版完整介面的驗收:假資料模式啟動主控台(tests/web-full.e2e.js),印出配對碼後再啟動
# tests/web-full-browser.cjs 當成另一台電腦的瀏覽器連進來檢查,並截圖和桌面畫面對照。
# 用法:先 npm run build,再在 app 資料夾執行 bash tests/web-full.sh。不碰正式資料,也不消耗額度。
set -u
cd "$(dirname "$0")/.."
T="$(cygpath -u "$TEMP")/nexus-webfull-$$-$RANDOM"
mkdir -p "$T/shots" "$T/profile"
PORT=$((40000 + RANDOM % 9000))
LOG="$T/run.log"
export NEXUS_FAKE=1 NEXUS_REMOTE_PORT=$PORT NEXUS_HOOKS_PORT=$((PORT + 1)) NEXUS_DATA_DIR="$(cygpath -w "$T/profile")" NEXUS_TEST_DIR="$(cygpath -w "$T/shots")" \
  NEXUS_TEST_SCRIPT="$(pwd -W)/tests/web-full.e2e.js"
echo "暫存資料夾:$(cygpath -w "$T"),遠端連接埠 $PORT"
timeout 240 ./node_modules/electron/dist/electron.exe . > "$LOG" 2>&1 &
APP=$!
for _ in $(seq 1 240); do grep -q '\[test\] PAIR' "$LOG" && break; kill -0 $APP 2>/dev/null || break; sleep 0.5; done
set -- $(grep -o '\[test\] PAIR .*' "$LOG" | head -1)
if [ $# -ge 6 ]; then
  env -u NEXUS_TEST_SCRIPT -u NEXUS_DATA_DIR timeout 120 ./node_modules/electron/dist/electron.exe tests/web-full-browser.cjs "$5" "$3" "$4" "$6" "$(cygpath -w "$T/shots")" "$(cygpath -w "$T")" 2>&1 | grep -E '^\[browser\]'
else
  echo "主控台沒有印出配對碼,略過瀏覽器檢查"
fi
wait $APP
grep -E '^\[test\]|rror' "$LOG" | grep -v 'PAIR' | cut -c1-400
echo "--- 截圖"; ls "$T/shots"
echo "截圖位置:$(cygpath -w "$T/shots")"
