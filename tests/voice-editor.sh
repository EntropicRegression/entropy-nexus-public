#!/usr/bin/env bash
# 驗收:對話視窗的角色卡與聲音區塊(版面、跟著播報語言)(假資料模式,不會啟動真正的 CLI),由 tests/voice-editor.e2e.js 檢查。
# 用法:先 npm run build,再在 app 資料夾執行 bash tests/voice-editor.sh。資料都放在系統暫存區這次專用的新資料夾,連接埠隨機。
set -u
cd "$(dirname "$0")/.."
W="$(cygpath -u "${TEMP:-/tmp}")/nexus-vedit-$$-$RANDOM"
mkdir -p "$W/shots" "$W/profile" "$W/work"
PORT=$((40000 + RANDOM % 9000))
for v in $(env | grep -oE '^(CLAUDE|ANTHROPIC)[A-Z_0-9]*'); do unset "$v"; done
export NEXUS_FAKE=1 NEXUS_FAKE_NO_ERRORS=1 NEXUS_NO_SEED=1 \
  NEXUS_REMOTE_PORT=$PORT NEXUS_HOOKS_PORT=$((PORT + 1)) NEXUS_INTEROP_PORT=$((PORT + 2)) \
  NEXUS_DATA_DIR="$(cygpath -w "$W/profile")" NEXUS_TEST_DIR="$(cygpath -w "$W/shots")" \
  NEXUS_TEST_SCRIPT="$(pwd -W)/tests/voice-editor.e2e.js" NEXUS_TEST_CWD="$(cygpath -w "$W/work")"
timeout 180 ./node_modules/electron/dist/electron.exe . 2>&1 | grep -E '^\[test\]' | cut -c1-600
cp "$W"/shots/*.png "${VEDIT_SHOTS:-/dev/null}" 2>/dev/null; rm -rf "$W"
