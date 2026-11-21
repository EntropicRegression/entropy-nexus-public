#!/usr/bin/env bash
# 驗收:長期記憶階段 2(假資料模式,不啟動真正的 CLI):由 tests/memory-phase2-client.mjs 扮演總管與一般節點,
# 用 MCP 呼叫 memory_search / memory_write(權限、節點特長、專案知識上限通知、判例可見度、遮罩)。
# 用法:先 npm run build,再在 app 資料夾執行 bash tests/memory-phase2.sh。不碰正式資料,也不消耗額度。
set -u
cd "$(dirname "$0")/.."
T="$(cygpath -u "${TEMP:-/tmp}")/nexus-memory-phase2-$$-$RANDOM"
mkdir -p "$T/shots" "$T/profile" "$T/work"
PORT=$((40000 + RANDOM % 9000))
LOG="$T/run.log"
for v in $(env | grep -oE '^(CLAUDE|ANTHROPIC)[A-Z_0-9]*'); do unset "$v"; done
export NEXUS_FAKE=1 NEXUS_FAKE_ECHO=1 NEXUS_FAKE_NO_ERRORS=1 NEXUS_NO_SEED=1 NEXUS_KNOWLEDGE_CAP=3 \
  NEXUS_REMOTE_PORT=$PORT NEXUS_HOOKS_PORT=$((PORT + 1)) NEXUS_INTEROP_PORT=$((PORT + 2)) NEXUS_INTEROP_WAIT_MS=2500 \
  NEXUS_DATA_DIR="$(cygpath -w "$T/profile")" NEXUS_TEST_DIR="$(cygpath -w "$T/shots")" NEXUS_TEST_SCRIPT="$(pwd -W)/tests/memory-phase2.e2e.js" NEXUS_TEST_CWD="$(cygpath -w "$T/work")"
timeout 280 ./node_modules/electron/dist/electron.exe . > "$LOG" 2>&1 &
APP=$!
node tests/memory-phase2-client.mjs "$(cygpath -w "$LOG")" "$(cygpath -w "$T/profile")" 2>&1 | cut -c1-500
wait $APP
grep -E '^\[test\]' "$LOG" | grep -v ' READY ' | cut -c1-500
