#!/usr/bin/env bash
# 回合中插話的真實觀察(真正的 CLI,會用到一點額度;只動這次建立的測試節點自己的對話檔)。
# 用法:先 npm run build,再在 app 資料夾執行  bash tests/interject-real.sh <claude|codex|antigravity> [模型]
# 主控台資料與測試資料夾放在暫存資料夾,結束時刪掉;測試節點的對話檔先備份到暫存資料夾再刪。
set -u
cd "$(dirname "$0")/.."
BACKEND="${1:?後台}"; MODEL="${2:-}"
T="$(cygpath -u "$TEMP")/nexus-ij-real-$BACKEND-$$-$RANDOM"
mkdir -p "$T/shots" "$T/profile" "$T/work" "$T/backup"
CODE="IJ-$RANDOM-$RANDOM"
PROFILE_W="$(cygpath -w "$T/profile")"
PORT=$((40000 + RANDOM % 9000))
OUT="$(NEXUS_NO_SEED=1 NEXUS_REMOTE_PORT=$PORT NEXUS_HOOKS_PORT=$((PORT + 1)) NEXUS_INTEROP_PORT=$((PORT + 2)) \
  NEXUS_DATA_DIR="$PROFILE_W" NEXUS_TEST_DIR="$(cygpath -w "$T/shots")" NEXUS_TEST_SCRIPT="$(pwd -W)/tests/interject-real.e2e.js" NEXUS_TEST_CWD="$(cygpath -w "$T/work")" \
  NEXUS_TEST_IMAGE="$BACKEND,$MODEL,$CODE" \
  timeout 600 ./node_modules/electron/dist/electron.exe . 2>&1 | grep -E '^\[test\]' | cut -c1-2000)"
echo "$OUT" | grep -v RESULT
SID="$(echo "$OUT" | grep -E '^\[test\] RESULT ' | head -1 | sed 's/^\[test\] RESULT //' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).sessionId??'')}catch{console.log('')}})")"
if [ -n "$SID" ]; then node --no-warnings tests/savepoint-real-files.mjs cleanup "$PROFILE_W" "$BACKEND" "$SID" "$(cygpath -w "$T/backup")" || { echo "[ij] 清理對話檔失敗(暫存資料夾保留)"; exit 1; }; fi
if [ "$BACKEND" = claude ]; then
  for d in "$HOME"/.claude/projects/*nexus-ij-real-$BACKEND-$$-*; do
    [ -d "$d" ] || continue
    if [ -z "$(find "$d" -type f | head -1)" ]; then find "$d" -depth -type d -empty -delete; echo "[ij] 移除 Claude 的空專案資料夾"; else echo "[ij] 注意:Claude 專案資料夾裡還有檔案,沒有刪"; fi
  done
fi
rm -rf "$T/profile" "$T/work" "$T/shots"
echo "[ij] $BACKEND 結束(對話檔備份保留在暫存資料夾)"
