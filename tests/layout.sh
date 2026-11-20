#!/usr/bin/env bash
# 版面檢查(假資料模式):幾種視窗大小下,找出點不到的按鈕和超出區塊的節點,並截圖。
#   bash tests/layout.sh          桌面版
#   LAYOUT_WEB=1 bash tests/layout.sh   瀏覽器版完整介面與手機版(另開一個 Electron 視窗當瀏覽器連進來)
# 先 npm run build。不碰正式資料,也不消耗額度。
set -u
cd "$(dirname "$0")/.."
T="$(cygpath -u "$TEMP")/nexus-layout-$$-$RANDOM"
mkdir -p "$T/shots" "$T/profile/portraits/Layout" "$T/work"
# 有角色卡的角色:新增節點時選它,角色卡編輯區會展開(表單最長的情況)
printf '# 角色卡\n\n版面測試用的角色。\n' > "$T/profile/portraits/Layout/persona.md"
PORT=$((40000 + RANDOM % 9000))
LOG="$T/run.log"
{ [ "${LAYOUT_WEB:-}" = 1 ] && echo 'window.__LAYOUT_WEB__ = true;'; cat tests/layout-audit-lib.js tests/layout.e2e.js; } > "$T/layout.js"
export NEXUS_FAKE=1 NEXUS_FAKE_NO_ERRORS=1 NEXUS_NO_SEED=1 NEXUS_REMOTE_PORT=$PORT NEXUS_HOOKS_PORT=$((PORT + 1)) NEXUS_INTEROP_PORT=$((PORT + 2)) \
  NEXUS_DATA_DIR="$(cygpath -w "$T/profile")" NEXUS_TEST_DIR="$(cygpath -w "$T/shots")" NEXUS_TEST_SCRIPT="$(cygpath -w "$T/layout.js")" NEXUS_TEST_CWD="$(cygpath -w "$T/work")"
for v in $(env | grep -oE '^(CLAUDE|ANTHROPIC)[A-Z_0-9]*'); do unset "$v"; done
timeout 360 ./node_modules/electron/dist/electron.exe . > "$LOG" 2>&1 &
APP=$!
if [ "${LAYOUT_WEB:-}" = 1 ]; then
  for _ in $(seq 1 240); do grep -q '\[test\] PAIR' "$LOG" && break; kill -0 $APP 2>/dev/null || break; sleep 0.5; done
  set -- $(grep -o '\[test\] PAIR .*' "$LOG" | head -1)
  if [ $# -ge 5 ]; then
    env -u NEXUS_TEST_SCRIPT -u NEXUS_DATA_DIR timeout 300 ./node_modules/electron/dist/electron.exe tests/layout-browser.cjs "$5" "$3" "$4" "$(cygpath -w "$T/shots")" "$(cygpath -w "$T")" "$(pwd -W)/tests/layout-audit-lib.js" 2>&1 | grep -E '^\[browser\]' | cut -c1-300 | tee "$T/result.txt"
  else
    echo "主控台沒有印出配對碼" | tee "$T/result.txt"
  fi
  wait $APP
else
  wait $APP
  grep -E '^\[test\]' "$LOG" | cut -c1-300 | tee "$T/result.txt"
fi
echo "截圖位置:$(cygpath -w "$T/shots")"
if grep -q '全部通過' "$T/result.txt"; then echo "全部通過"; else echo "有 $(grep -c '不符' "$T/result.txt") 個畫面不符"; fi
