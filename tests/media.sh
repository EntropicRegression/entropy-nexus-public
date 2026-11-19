#!/usr/bin/env bash
# 缺口 8b 驗收(多模態輸出):在暫存區建立工作目錄、外部資料夾、junction 與符號連結,
# 用假資料模式執行 tests/media-fake.e2e.js,主控台印出配對碼後再啟動 tests/media-phone.cjs 當成手機檢查。
# 用法:先 npm run build,再在 app 資料夾執行 bash tests/media.sh。不碰正式資料,也不消耗額度。
set -u
cd "$(dirname "$0")/.."
T="$(cygpath -u "$TEMP")/nexus8b-media-$$-$RANDOM"
mkdir -p "$T/work/pics" "$T/outside" "$T/shots" "$T/profile"
cp build/icon.png "$T/work/pics/sample.png"
cp build/icon.png "$T/work/pics/two.png"
cp build/icon.png "$T/outside/secret.png"
echo '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' > "$T/work/pics/logo.svg"
echo 'not an image' > "$T/work/notes.txt"
W="$(cygpath -w "$T/work")"; O="$(cygpath -w "$T/outside")"
# junction 不需要系統管理員權限;檔案符號連結需要開發人員模式或系統管理員,建立失敗時該項仍會檢查(檔案不存在一樣要被拒絕)
powershell -NoProfile -Command "New-Item -ItemType Junction -Path '$W\\jlink' -Target '$O' | Out-Null"
powershell -NoProfile -Command "try { New-Item -ItemType SymbolicLink -Path '$W\\link.png' -Target '$O\\secret.png' -ErrorAction Stop | Out-Null; 'symlink: 已建立' } catch { 'symlink: 無法建立(' + \$_.Exception.Message + ')' }"
ls -la "$T/work" | sed 's/^/  /'
PORT=$((40000 + RANDOM % 9000))
LOG="$T/run.log"
export NEXUS_FAKE=1 NEXUS_NO_SEED=1 NEXUS_REMOTE_PORT=$PORT NEXUS_DATA_DIR="$(cygpath -w "$T/profile")" NEXUS_TEST_DIR="$(cygpath -w "$T/shots")" \
  NEXUS_TEST_SCRIPT="$(pwd -W)/tests/media-fake.e2e.js" NEXUS_TEST_CWD="$W" NEXUS_TEST_IMAGE="$O"
echo "暫存資料夾:$(cygpath -w "$T"),遠端連接埠 $PORT"
timeout 240 ./node_modules/electron/dist/electron.exe . > "$LOG" 2>&1 &
APP=$!
for _ in $(seq 1 240); do grep -q '\[test\] PAIR' "$LOG" && break; kill -0 $APP 2>/dev/null || break; sleep 0.5; done
set -- $(grep -o '\[test\] PAIR .*' "$LOG" | head -1)
if [ $# -ge 6 ]; then
  timeout 90 ./node_modules/electron/dist/electron.exe tests/media-phone.cjs "$5" "$3" "$4" "$6" "$W" "$O" "$(cygpath -w "$T/shots")" "$(cygpath -w "$T")" 2>&1 | grep -E '^\[phone\]'
else
  echo "主控台沒有印出配對碼,略過手機檢查"
fi
wait $APP
grep -E '^\[test\]|rror' "$LOG" | grep -v 'PAIR' | cut -c1-600
echo "--- 媒體資料夾"; ls -R "$T/profile/media" 2>/dev/null | head
echo "--- 截圖"; ls "$T/shots"
echo "截圖位置:$(cygpath -w "$T/shots")"
