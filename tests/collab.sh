#!/usr/bin/env bash
# 協作過程可視化的驗收:假資料模式啟動主控台(tests/collab.e2e.js),再由 tests/collab-client.mjs 扮演各節點的 CLI,
# 用 MCP 連到主控台的工具服務(呼叫、會議),檢查面板上的連線與端點、任務卡的來源標籤、總覽的分派紀錄。
# 另外先跑一遍單元測試(tests/collab.test.mjs)。
# 用法:先 npm run build,再在 app 資料夾執行 bash tests/collab.sh。不碰正式資料,也不消耗額度。
set -u
cd "$(dirname "$0")/.."
node --no-warnings tests/collab.test.mjs | tail -1
T="$(cygpath -u "$TEMP")/nexus-collab-$$-$RANDOM"
mkdir -p "$T/shots" "$T/profile" "$T/work"
PORT=$((40000 + RANDOM % 9000))
LOG="$T/run.log"
OUT="$T/result.txt"
export NEXUS_FAKE=1 NEXUS_FAKE_NO_ERRORS=1 NEXUS_NO_SEED=1 NEXUS_REMOTE_PORT=$PORT NEXUS_HOOKS_PORT=$((PORT + 1)) NEXUS_INTEROP_PORT=$((PORT + 2)) NEXUS_INTEROP_WAIT_MS=2500 \
  NEXUS_DATA_DIR="$(cygpath -w "$T/profile")" NEXUS_TEST_DIR="$(cygpath -w "$T/shots")" NEXUS_TEST_SCRIPT="$(pwd -W)/tests/collab.e2e.js" NEXUS_TEST_CWD="$(cygpath -w "$T/work")"
timeout 300 ./node_modules/electron/dist/electron.exe . > "$LOG" 2>&1 &
APP=$!
node tests/collab-client.mjs "$(cygpath -w "$LOG")" "$(cygpath -w "$T/profile")" 2>&1 | cut -c1-500 | tee "$OUT"
wait $APP
grep -E '^\[test\]' "$LOG" | grep -v ' READY ' | cut -c1-400 | tee -a "$OUT"
BAD=$(grep -cE '不符|失敗|等不到' "$OUT")
OK=$(grep -cE '通過' "$OUT")
if [ "$BAD" = 0 ] && [ "$OK" -gt 0 ] && grep -q '主控台端結束' "$OUT"; then echo "全部通過($OK 項)"; else echo "有 $BAD 項不符"; fi
