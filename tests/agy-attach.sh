#!/usr/bin/env bash
# Antigravity 附件的驗收(真正的 agy,會用到一點額度):貼上的圖片與工作目錄以外的檔案都讀得到。
# 資料資料夾放在家目錄底下的暫時資料夾(agy 對暫存區的檔案不會拒絕,放暫存區測不出問題),結束後刪除。
# 用法:先 npm run build,再在 app 資料夾執行 bash tests/agy-attach.sh。不碰正式資料。
set -u
cd "$(dirname "$0")/.."
H="$(cygpath -u "$USERPROFILE")/.nexus-agy-test-$$"
T="$(cygpath -u "$TEMP")/nexus-agyattach-$$-$RANDOM"
mkdir -p "$H/profile" "$H/outside" "$T/work" "$T/shots"
echo "代號是 KP-5521" > "$H/outside/code.txt"
PORT=$((40000 + RANDOM % 9000))
export NEXUS_NO_SEED=1 NEXUS_REMOTE_PORT=$PORT NEXUS_HOOKS_PORT=$((PORT + 1)) NEXUS_DATA_DIR="$(cygpath -w "$H/profile")" NEXUS_TEST_DIR="$(cygpath -w "$T/shots")" \
  NEXUS_TEST_SCRIPT="$(pwd -W)/tests/agy-attach.e2e.js" NEXUS_TEST_CWD="$(cygpath -w "$T/work")" NEXUS_TEST_IMAGE="$(cygpath -w "$H/outside/code.txt")"
timeout 300 ./node_modules/electron/dist/electron.exe . 2>&1 | grep -E '^\[test\]' | cut -c1-500
echo "--- 附件資料夾"; ls "$H/profile/attachments" 2>/dev/null
rm -rf "$H"
