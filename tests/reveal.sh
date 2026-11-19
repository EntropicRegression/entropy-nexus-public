#!/usr/bin/env bash
# 回覆裡的路徑連結(點一下在檔案總管中顯示)的驗收:假資料模式執行 tests/reveal.e2e.js。
# 用法:先 npm run build,再在 app 資料夾執行 bash tests/reveal.sh。不碰正式資料、不消耗額度,也不會真的打開檔案總管。
set -u
cd "$(dirname "$0")/.."
T="$(cygpath -u "$TEMP")/nexus-reveal-$$-$RANDOM"
mkdir -p "$T/work/app/src" "$T/work/docs" "$T/shots" "$T/profile"
echo 'x' > "$T/work/app/src/main.ts"; echo 'x' > "$T/work/app/src/my file.txt"; echo 'x' > "$T/work/app/notes.md"; echo 'x' > "$T/work/docs/guide.md"
PORT=$((40000 + RANDOM % 9000))
export NEXUS_FAKE=1 NEXUS_NO_SEED=1 NEXUS_REMOTE_PORT=$PORT NEXUS_HOOKS_PORT=$((PORT + 1)) NEXUS_DATA_DIR="$(cygpath -w "$T/profile")" NEXUS_TEST_DIR="$(cygpath -w "$T/shots")" \
  NEXUS_TEST_SCRIPT="$(pwd -W)/tests/reveal.e2e.js" NEXUS_TEST_CWD="$(cygpath -w "$T/work/app")"
timeout 120 ./node_modules/electron/dist/electron.exe . 2>&1 | grep -E '^\[test\]' | cut -c1-400
echo "截圖位置:$(cygpath -w "$T/shots")"
