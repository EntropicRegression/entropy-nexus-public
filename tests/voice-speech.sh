#!/usr/bin/env bash
# 語音播報(Phase 2a)的驗收:假資料模式啟動主控台(tests/voice-speech.e2e.js),
# 另由 tests/voice-speech-client.mjs 扮演節點的 CLI 做節點互相呼叫。不消耗額度;朗讀會真的從喇叭念出來。
# 用法:先 npm run build,再在 app 資料夾執行 bash tests/voice-speech.sh。
set -u
cd "$(dirname "$0")/.."
node tests/voice-summary.test.mjs | tail -1
T="$(cygpath -u "$TEMP")/nexus-speech-$$-$RANDOM"
mkdir -p "$T/shots" "$T/profile" "$T/work"
PORT=$((40000 + RANDOM % 9000))
LOG="$T/run.log"
OUT="$T/result.txt"
export NEXUS_FAKE=1 NEXUS_FAKE_NO_ERRORS=1 NEXUS_NO_SEED=1 NEXUS_REMOTE_PORT=$PORT NEXUS_HOOKS_PORT=$((PORT + 1)) NEXUS_INTEROP_PORT=$((PORT + 2)) NEXUS_INTEROP_WAIT_MS=2500 \
  NEXUS_DATA_DIR="$(cygpath -w "$T/profile")" NEXUS_TEST_DIR="$(cygpath -w "$T/shots")" NEXUS_TEST_SCRIPT="$(pwd -W)/tests/voice-speech.e2e.js" NEXUS_TEST_CWD="$(cygpath -w "$T/work")"
timeout 300 ./node_modules/electron/dist/electron.exe . > "$LOG" 2>&1 &
APP=$!
node tests/voice-speech-client.mjs "$(cygpath -w "$LOG")" "$(cygpath -w "$T/profile")" 2>&1 | cut -c1-400 | tee "$OUT"
wait $APP
grep -E '^\[test\]' "$LOG" | grep -vE ' READY | INTEROP-GO' | cut -c1-400 | tee -a "$OUT"
BAD=$(grep -cE '不符|失敗|等不到' "$OUT")
OK=$(grep -cE '通過' "$OUT")
if [ "$BAD" = 0 ] && [ "$OK" -gt 0 ] && grep -q '主控台端結束' "$OUT"; then echo "全部通過($OK 項)"; else echo "有 $BAD 項不符"; fi
