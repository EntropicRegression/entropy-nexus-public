#!/usr/bin/env bash
# 背景子代理顯示在面板上的驗收:Claude Code 轉接器接到假的 CLI(tests/claude-fake-cli.js),執行 tests/bg-subagent.e2e.js。
# 用法:先 npm run build,再在 app 資料夾執行 bash tests/bg-subagent.sh。不碰正式資料,也不消耗額度。
set -u
cd "$(dirname "$0")/.."
T="$(cygpath -u "$TEMP")/nexus-bgsub-$$-$RANDOM"
mkdir -p "$T/work" "$T/shots" "$T/profile"
PORT=$((40000 + RANDOM % 9000))
export NEXUS_NO_SEED=1 NEXUS_SUB_LINGER_MS=2000 NEXUS_CLAUDE_BIN="$(pwd -W)/tests/claude-fake-cli.js" NEXUS_REMOTE_PORT=$PORT NEXUS_HOOKS_PORT=$((PORT + 1)) \
  NEXUS_DATA_DIR="$(cygpath -w "$T/profile")" NEXUS_TEST_DIR="$(cygpath -w "$T/shots")" NEXUS_TEST_SCRIPT="$(pwd -W)/tests/bg-subagent.e2e.js" NEXUS_TEST_CWD="$(cygpath -w "$T/work")"
timeout 120 ./node_modules/electron/dist/electron.exe . 2>&1 | grep -E '^\[test\]' | cut -c1-500
echo "截圖位置:$(cygpath -w "$T/shots")"
