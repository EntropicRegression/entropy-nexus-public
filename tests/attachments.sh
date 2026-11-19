#!/usr/bin/env bash
# 缺口 8a 多模態輸入的驗收(假資料模式,不消耗額度):
# 產生測試檔案 → 啟動主控台執行 tests/attachments.e2e.js → 等它回報配對碼後執行 tests/attachments-remote.mjs。
# 資料、截圖與測試檔案都放在系統暫存區裡這次專用的資料夾;遠端用隨機連接埠。
# 用法:在 app 資料夾執行 bash tests/attachments.sh(需要先 npm run build)
set -u
cd "$(dirname "$0")/.."
for v in $(env | grep -oE '^(CLAUDE|ANTHROPIC)[A-Z_0-9]*'); do unset "$v"; done
B="$(cygpath -w "${TEMP:-/tmp}")\\nexus-a8a-$$-$RANDOM"
PORT=$((40000 + RANDOM % 9000))
node tests/attachments-fixtures.mjs "$B\\files" > /dev/null
LOG="$(cygpath -u "$B")/run.log"
echo "資料夾 $B,遠端連接埠 $PORT"
export NEXUS_FAKE=1 NEXUS_DATA_DIR="$B\\profile" NEXUS_TEST_DIR="$B" NEXUS_TEST_SCRIPT="$(pwd -W)/tests/attachments.e2e.js" NEXUS_TEST_CWD="$B\\files" NEXUS_REMOTE_PORT="$PORT"
timeout 240 ./node_modules/electron/dist/electron.exe . > "$LOG" 2>&1 &
PID=$!
CODE=""
for _ in $(seq 1 240); do
  CODE=$(grep -oE '^\[test\] CODE [A-Z0-9]+' "$LOG" | awk '{print $3}' | tail -1)
  [ -n "$CODE" ] && break
  grep -q '^\[test\] 失敗' "$LOG" && break
  sleep 0.5
done
if [ -n "$CODE" ]; then node tests/attachments-remote.mjs "$PORT" "$CODE" "$B\\files" "$B\\profile"; else echo "沒有拿到配對碼"; fi
wait $PID
grep -E "^\[test\]|rror" "$LOG" | cut -c1-700
echo "--- 截圖"; ls "$(cygpath -u "$B")"/*.png
echo "--- 貼上的暫存檔"; ls "$(cygpath -u "$B")/profile/attachments"
echo "--- 手機上傳的檔案"; ls "$(cygpath -u "$B")/profile/uploads"
