#!/usr/bin/env bash
# 會議功能(start_meeting)的驗收:假資料模式啟動主控台(tests/meeting.e2e.js),再由 tests/meeting-client.mjs 扮演各節點的 CLI,
# 用 MCP 連到主控台的工具服務,檢查參數、輪流發言、參與者收到的指令、授權、提前結束、重複開會、反向呼叫、散會與忙碌略過。
# 用法:先 npm run build,再在 app 資料夾執行 bash tests/meeting.sh。不碰正式資料,也不消耗額度。
set -u
cd "$(dirname "$0")/.."
T="$(cygpath -u "$TEMP")/nexus-meeting-$$-$RANDOM"
mkdir -p "$T/shots" "$T/profile" "$T/work"
PORT=$((40000 + RANDOM % 9000))
LOG="$T/run.log"
OUT="$T/result.txt"
export NEXUS_FAKE=1 NEXUS_FAKE_NO_ERRORS=1 NEXUS_NO_SEED=1 NEXUS_REMOTE_PORT=$PORT NEXUS_HOOKS_PORT=$((PORT + 1)) NEXUS_INTEROP_PORT=$((PORT + 2)) NEXUS_INTEROP_WAIT_MS=2500 \
  NEXUS_DATA_DIR="$(cygpath -w "$T/profile")" NEXUS_TEST_DIR="$(cygpath -w "$T/shots")" NEXUS_TEST_SCRIPT="$(pwd -W)/tests/meeting.e2e.js" NEXUS_TEST_CWD="$(cygpath -w "$T/work")"
timeout 400 ./node_modules/electron/dist/electron.exe . > "$LOG" 2>&1 &
APP=$!
node tests/meeting-client.mjs "$(cygpath -w "$LOG")" "$(cygpath -w "$T/profile")" 2>&1 | cut -c1-500 | tee "$OUT"
wait $APP
grep -E '^\[test\]' "$LOG" | grep -v ' READY ' | cut -c1-400 | tee -a "$OUT"
BAD=$(grep -cE '不符|失敗|等不到' "$OUT")
OK=$(grep -cE '通過' "$OUT")
if [ "$BAD" = 0 ] && [ "$OK" -gt 0 ] && grep -q '主控台端結束' "$OUT"; then echo "全部通過($OK 項)"; else echo "有 $BAD 項不符"; fi
