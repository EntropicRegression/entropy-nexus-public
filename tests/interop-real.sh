#!/usr/bin/env bash
# 節點互相呼叫的驗收(真正的 CLI,會用到一點額度):一個節點用主控台的工具呼叫另一個節點並取回答覆。
# 用法:先 npm run build,再在 app 資料夾執行
#   bash tests/interop-real.sh <呼叫方後台> <被呼叫方後台> [呼叫方模型] [被呼叫方模型] [ask]
# 例如 bash tests/interop-real.sh claude claude haiku haiku;後台是 claude、codex 或 antigravity。不碰正式資料。
set -u
cd "$(dirname "$0")/.."
T="$(cygpath -u "$TEMP")/nexus-interopreal-$$-$RANDOM"
mkdir -p "$T/shots" "$T/profile" "$T/work"
# 第五個參數是 ask 時,呼叫方用「每次詢問」模式,檢查主控台的授權(允許一次、拒絕一次)
SCRIPT=interop-real.e2e.js; [ "${5:-}" = "ask" ] && SCRIPT=interop-real-ask.e2e.js
PORT=$((40000 + RANDOM % 9000))
export NEXUS_NO_SEED=1 NEXUS_REMOTE_PORT=$PORT NEXUS_HOOKS_PORT=$((PORT + 1)) NEXUS_INTEROP_PORT=$((PORT + 2)) \
  NEXUS_DATA_DIR="$(cygpath -w "$T/profile")" NEXUS_TEST_DIR="$(cygpath -w "$T/shots")" NEXUS_TEST_SCRIPT="$(pwd -W)/tests/$SCRIPT" NEXUS_TEST_CWD="$(cygpath -w "$T/work")" \
  NEXUS_TEST_IMAGE="${1:-claude},${2:-claude},${3:-},${4:-}"
timeout 560 ./node_modules/electron/dist/electron.exe . 2>&1 | grep -E '^\[test\]' | cut -c1-700
