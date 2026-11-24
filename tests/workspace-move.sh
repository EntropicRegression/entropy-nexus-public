#!/usr/bin/env bash
# 驗收:轉移工作區(假資料模式,不會啟動真正的 CLI)。建一個資料夾、一個指向它的 junction(模擬資料夾改名後留下的舊路徑)、
# 以及另一個資料夾,由 tests/workspace-move.e2e.js 檢查各後台能不能轉移。
# 用法:先 npm run build,再在 app 資料夾執行 bash tests/workspace-move.sh。資料都放在系統暫存區這次專用的新資料夾,連接埠隨機。
set -u
cd "$(dirname "$0")/.."
W="$(cygpath -u "${TEMP:-/tmp}")/nexus-wsmove-$$-$RANDOM"
mkdir -p "$W/shots" "$W/profile" "$W/real lobby" "$W/other"
cmd //c mklink //J "$(cygpath -w "$W/alias")" "$(cygpath -w "$W/real lobby")" > /dev/null || { echo "[test] 不符 建立 junction 失敗"; exit 1; }
PORT=$((40000 + RANDOM % 9000))
for v in $(env | grep -oE '^(CLAUDE|ANTHROPIC)[A-Z_0-9]*'); do unset "$v"; done
export NEXUS_FAKE=1 NEXUS_FAKE_NO_ERRORS=1 NEXUS_NO_SEED=1 \
  NEXUS_REMOTE_PORT=$PORT NEXUS_HOOKS_PORT=$((PORT + 1)) NEXUS_INTEROP_PORT=$((PORT + 2)) \
  NEXUS_DATA_DIR="$(cygpath -w "$W/profile")" NEXUS_TEST_DIR="$(cygpath -w "$W/shots")" \
  NEXUS_TEST_SCRIPT="$(pwd -W)/tests/workspace-move.e2e.js" NEXUS_TEST_CWD="$(cygpath -w "$W/real lobby")" \
  NEXUS_TEST_IMAGE="$(cygpath -w "$W/real lobby")|$(cygpath -w "$W/alias")|$(cygpath -w "$W/other")"
timeout 180 ./node_modules/electron/dist/electron.exe . 2>&1 | grep -E '^\[test\]' | cut -c1-600
# 先移除 junction 本身,不會刪到它指向的資料夾
cmd //c rmdir "$(cygpath -w "$W/alias")" 2> /dev/null
rm -rf "$W"
