#!/usr/bin/env bash
# 節點六角形裡的 Q 版頭像的驗收:假資料模式執行 tests/avatar.e2e.js。
# 測試用的立繪資料夾放三個角色:alpha(avatar.png)、beta(chibi_avatar.png)、gamma(沒有頭像)。
# 頭像圖檔用第一個參數指定(預設用 build/icon.png);不碰正式資料,也不消耗額度。
# 用法:先 npm run build,再在 app 資料夾執行 bash tests/avatar.sh [頭像1] [頭像2]
set -u
cd "$(dirname "$0")/.."
T="$(cygpath -u "$TEMP")/nexus-avatar-$$-$RANDOM"
P="$T/profile/portraits"
mkdir -p "$T/shots" "$T/work" "$P/alpha" "$P/beta" "$P/gamma"
A1="${1:-build/icon.png}"; A2="${2:-build/icon.png}"
cp "$A1" "$P/alpha/avatar.png"; cp "$A2" "$P/beta/chibi_avatar.png"
for c in alpha beta gamma; do echo "測試角色" > "$P/$c/persona.md"; done
# 第三個參數是 sleep 時改跑 tests/avatar-sleep.e2e.js:節點休眠、喚醒、增減與開關對話視窗時逐步截圖(沒有自動判斷,要看截圖)
SCRIPT=avatar.e2e.js; [ "${3:-}" = "sleep" ] && SCRIPT=avatar-sleep.e2e.js
PORT=$((40000 + RANDOM % 9000))
export NEXUS_FAKE=1 NEXUS_FAKE_NO_ERRORS=1 NEXUS_NO_SEED=1 NEXUS_REMOTE_PORT=$PORT NEXUS_HOOKS_PORT=$((PORT + 1)) NEXUS_DATA_DIR="$(cygpath -w "$T/profile")" NEXUS_TEST_DIR="$(cygpath -w "$T/shots")" \
  NEXUS_TEST_SCRIPT="$(pwd -W)/tests/$SCRIPT" NEXUS_TEST_CWD="$(cygpath -w "$T/work")"
timeout 120 ./node_modules/electron/dist/electron.exe . 2>&1 | grep -E '^\[test\]' | cut -c1-400
echo "截圖位置:$(cygpath -w "$T/shots")"
