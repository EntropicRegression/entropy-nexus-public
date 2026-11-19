#!/usr/bin/env bash
# 會議功能的驗收(真正的 CLI,會用到一點額度):主持人召開一場兩輪的會議,參與者輪流發言,最後由主持人整理結論。
# 用法:先 npm run build,再在 app 資料夾執行
#   bash tests/meeting-real.sh <主持人後台[:模型]> <參與者後台[:模型]> [參與者後台[:模型] …]
# 例如 bash tests/meeting-real.sh claude:haiku antigravity codex;後台是 claude、codex 或 antigravity。不碰正式資料。
set -u
cd "$(dirname "$0")/.."
T="$(cygpath -u "$TEMP")/nexus-meetingreal-$$-$RANDOM"
mkdir -p "$T/shots" "$T/profile" "$T/work"
PORT=$((40000 + RANDOM % 9000))
SPEC="$(IFS=,; echo "$*")"
export NEXUS_NO_SEED=1 NEXUS_REMOTE_PORT=$PORT NEXUS_HOOKS_PORT=$((PORT + 1)) NEXUS_INTEROP_PORT=$((PORT + 2)) \
  NEXUS_DATA_DIR="$(cygpath -w "$T/profile")" NEXUS_TEST_DIR="$(cygpath -w "$T/shots")" NEXUS_TEST_SCRIPT="$(pwd -W)/tests/meeting-real.e2e.js" NEXUS_TEST_CWD="$(cygpath -w "$T/work")" \
  NEXUS_TEST_IMAGE="${SPEC:-claude:haiku,claude:haiku,claude:haiku}"
timeout 580 ./node_modules/electron/dist/electron.exe . 2>&1 | grep -E '^\[test\]' | cut -c1-900
