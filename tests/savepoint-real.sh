#!/usr/bin/env bash
# session 存點的真實驗證(里程碑 S4;真正的 CLI,會用到一點額度,會動真實的工具資料夾,但只動這次建立的測試節點自己的對話檔)。
# 用法:先 npm run build,再在 app 資料夾執行  bash tests/savepoint-real.sh <後台> [模型]
#   後台是 claude、codex 或 antigravity。主控台資料(資料庫、記憶庫、存點、封存檔)全部放在暫存資料夾,結束時整個刪掉,不碰正式資料。
# 流程:A 建立測試節點、記住暗號、終止並建立存點 → 備份並刪掉它的原始對話檔 → B 從存點還原、續接、問暗號 → 備份並清掉它的對話檔。
# 任何一步失敗就停下(保留備份與暫存資料夾,不繼續刪)。
set -u
cd "$(dirname "$0")/.."
BACKEND="${1:?後台}"; MODEL="${2:-}"
T="$(cygpath -u "$TEMP")/nexus-sp-real-$BACKEND-$$-$RANDOM"
mkdir -p "$T/shots" "$T/profile" "$T/work" "$T/backup-deleted" "$T/backup-cleanup"
CODE="SP-$RANDOM-$RANDOM"
PROFILE_W="$(cygpath -w "$T/profile")"
run() {
  local PORT=$((40000 + RANDOM % 9000))
  NEXUS_NO_SEED=1 NEXUS_REMOTE_PORT=$PORT NEXUS_HOOKS_PORT=$((PORT + 1)) NEXUS_INTEROP_PORT=$((PORT + 2)) \
  NEXUS_DATA_DIR="$PROFILE_W" NEXUS_TEST_DIR="$(cygpath -w "$T/shots")" NEXUS_TEST_SCRIPT="$(pwd -W)/tests/savepoint-real.e2e.js" NEXUS_TEST_CWD="$(cygpath -w "$T/work")" \
  NEXUS_TEST_IMAGE="$1,$BACKEND,$MODEL,$CODE" \
  timeout 600 ./node_modules/electron/dist/electron.exe . 2>&1 | grep -E '^\[test\]' | cut -c1-600
}
field() { grep -E '^\[test\] RESULT ' | head -1 | sed 's/^\[test\] RESULT //' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s)['$1']??'')}catch{console.log('')}})"; }
stop() { echo "[s4] 停下:$1(暫存資料夾保留,備份在其中)"; exit 1; }

echo "[s4] ===== $BACKEND:階段 A(建立、記住暗號、終止並建立存點)====="
A="$(run A)"; echo "$A" | grep -v RESULT
echo "$A" | grep -q '全部通過' || stop "階段 A 沒有全部通過"
NODE="$(echo "$A" | field nodeId)"; SID_A="$(echo "$A" | field sessionId)"
[ -n "$NODE" ] && [ -n "$SID_A" ] || stop "取不到節點或 sessionId"

echo "[s4] ===== $BACKEND:備份並刪掉測試節點的原始對話檔 ====="
node --no-warnings tests/savepoint-real-files.mjs delete "$PROFILE_W" "$NODE" "$(cygpath -w "$T/backup-deleted")" || stop "刪檔步驟失敗"

echo "[s4] ===== $BACKEND:階段 B(先問再還原、續接、問暗號)====="
B="$(run B)"; echo "$B" | grep -v RESULT
SID_B="$(echo "$B" | field sessionId)"
echo "$B" | grep -q '全部通過' || stop "階段 B 沒有全部通過"

echo "[s4] ===== $BACKEND:清理(備份後刪掉測試節點的對話檔;測試用的主控台資料整個刪掉)====="
for SID in $(printf '%s\n' "$SID_A" "$SID_B" | sort -u); do
  node --no-warnings tests/savepoint-real-files.mjs cleanup "$PROFILE_W" "$BACKEND" "$SID" "$(cygpath -w "$T/backup-cleanup")" || stop "清理失敗"
done
rm -rf "$T/profile" "$T/work" "$T/shots"
echo "[s4] $BACKEND 完成(備份保留在暫存資料夾,確認沒問題後可刪)"
