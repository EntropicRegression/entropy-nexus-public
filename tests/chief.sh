#!/usr/bin/env bash
# 總管節點(主控語音模式)的驗收:假資料模式啟動主控台,執行 tests/chief.e2e.js,截圖存到暫存資料夾。不消耗額度。
# 用法:先 npm run build,再在 app 資料夾執行 bash tests/chief.sh。
set -u
cd "$(dirname "$0")/.."
T="$(cygpath -u "$TEMP")/nexus-chief-$$-$RANDOM"
mkdir -p "$T/shots" "$T/profile" "$T/work"
PORT=$((40000 + RANDOM % 9000))
LOG="$T/run.log"
OUT="$T/result.txt"
export NEXUS_FAKE=1 NEXUS_FAKE_NO_ERRORS=1 NEXUS_FAKE_ECHO=1 NEXUS_NO_SEED=1 NEXUS_REMOTE_PORT=$PORT NEXUS_HOOKS_PORT=$((PORT + 1)) NEXUS_INTEROP_PORT=$((PORT + 2)) \
  NEXUS_DATA_DIR="$(cygpath -w "$T/profile")" NEXUS_TEST_DIR="$(cygpath -w "$T/shots")" NEXUS_TEST_SCRIPT="$(pwd -W)/tests/chief.e2e.js" NEXUS_TEST_CWD="$(cygpath -w "$T/work")"
timeout 200 ./node_modules/electron/dist/electron.exe . > "$LOG" 2>&1
grep -E '^\[test\]' "$LOG" | cut -c1-400 | tee "$OUT"
echo "截圖:$(cygpath -w "$T/shots")"
BAD=$(grep -cE '不符|失敗' "$OUT")
OK=$(grep -cE '通過' "$OUT")
if [ "$BAD" = 0 ] && [ "$OK" -gt 0 ] && grep -q '主控台端結束' "$OUT"; then echo "全部通過($OK 項)"; else echo "有 $BAD 項不符"; fi
