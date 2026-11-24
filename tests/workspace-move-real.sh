#!/usr/bin/env bash
# 工作區轉移的真實驗證(W4;真正的 CLI,會用到一點額度,會動真實的工具資料夾,但只動這次建立的測試節點自己的對話檔)。
# 用法:先 npm run build,再在 app 資料夾執行  bash tests/workspace-move-real.sh <move|rebuild> <後台> [模型]
#   move 只支援 claude、codex(Antigravity 換資料夾後 shell 仍綁舊資料夾,不支援);rebuild 三家都可以。
#   主控台資料(資料庫、記憶庫、存點、獨立工作區)與測試資料夾、測試用 git 版本庫都放在暫存資料夾,結束時整個刪掉。
set -u
cd "$(dirname "$0")/.."
MODE="${1:?模式 move 或 rebuild}"; BACKEND="${2:?後台}"; MODEL="${3:-}"
T="$(cygpath -u "$TEMP")/nexus-wm-real-$MODE-$BACKEND-$$-$RANDOM"
mkdir -p "$T/shots" "$T/profile" "$T/work" "$T/dest" "$T/repo" "$T/backup"
CODE="WM-$RANDOM-$RANDOM"
PROFILE_W="$(cygpath -w "$T/profile")"
stop() { echo "[w4] 停下:$1(暫存資料夾保留)"; exit 1; }
if [ "$MODE" = rebuild ]; then
  git -C "$T/repo" init -q -b main && echo hi > "$T/repo/README.md" && git -C "$T/repo" add -A && git -C "$T/repo" -c user.name=t -c user.email=t@t commit -qm init || stop "建立測試版本庫失敗"
  CWD="$T/repo"
else
  CWD="$T/work"
fi
PORT=$((40000 + RANDOM % 9000))
OUT="$(NEXUS_NO_SEED=1 NEXUS_REMOTE_PORT=$PORT NEXUS_HOOKS_PORT=$((PORT + 1)) NEXUS_INTEROP_PORT=$((PORT + 2)) \
  NEXUS_DATA_DIR="$PROFILE_W" NEXUS_TEST_DIR="$(cygpath -w "$T/shots")" NEXUS_TEST_SCRIPT="$(pwd -W)/tests/workspace-move-real.e2e.js" NEXUS_TEST_CWD="$(cygpath -w "$CWD")" \
  NEXUS_TEST_IMAGE="$MODE,$BACKEND,$MODEL,$CODE,$(cygpath -w "$T/dest")" \
  timeout 900 ./node_modules/electron/dist/electron.exe . 2>&1 | grep -E '^\[test\]' | cut -c1-600)"
echo "$OUT" | grep -v RESULT
field() { echo "$OUT" | grep -E '^\[test\] RESULT ' | head -1 | sed 's/^\[test\] RESULT //' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s)['$1']??'')}catch{console.log('')}})"; }
SID="$(field sessionId)"
PASS=1; echo "$OUT" | grep -q '全部通過' || PASS=0

# 檔案實際落在哪裡(由這裡檢查,畫面腳本讀不到磁碟)
if [ "$MODE" = move ]; then
  if [ -f "$T/dest/moved.txt" ] && grep -q "$CODE" "$T/dest/moved.txt" && [ ! -e "$T/work/moved.txt" ]; then echo "[w4] 通過:moved.txt 寫在新資料夾,舊資料夾沒有"; else echo "[w4] 不符:moved.txt 位置不對(新:$( [ -f "$T/dest/moved.txt" ] && echo 有 || echo 沒有),舊:$( [ -e "$T/work/moved.txt" ] && echo 有 || echo 沒有))"; PASS=0; fi
elif [ "$BACKEND" != antigravity ]; then
  WT="$(field worktree)"
  if [ -n "$WT" ] && [ -f "$(cygpath -u "$WT")/rebuilt.txt" ] && grep -q "$CODE" "$(cygpath -u "$WT")/rebuilt.txt"; then echo "[w4] 通過:rebuilt.txt 寫在重建的工作區"; else echo "[w4] 不符:重建的工作區裡沒有 rebuilt.txt"; PASS=0; fi
fi

# 清理:先備份再刪測試節點的對話檔;Claude 在測試資料夾對應的 projects/ 資料夾只剩空資料夾時一併移除
if [ -n "$SID" ]; then node --no-warnings tests/savepoint-real-files.mjs cleanup "$PROFILE_W" "$BACKEND" "$SID" "$(cygpath -w "$T/backup")" || stop "清理對話檔失敗"; fi
if [ "$BACKEND" = claude ]; then
  for d in "$HOME"/.claude/projects/*nexus-wm-real-$MODE-$BACKEND-$$-*; do
    [ -d "$d" ] || continue
    if [ -z "$(find "$d" -type f | head -1)" ]; then find "$d" -depth -type d -empty -delete; echo "[w4] 移除 Claude 的空專案資料夾:$(basename "$d" | sed 's/.*nexus-wm-real/…nexus-wm-real/')"; else echo "[w4] 注意:Claude 專案資料夾裡還有檔案,沒有刪:$(basename "$d" | sed 's/.*nexus-wm-real/…nexus-wm-real/')"; fi
  done
fi
[ "$PASS" = 1 ] || stop "有項目不符"
rm -rf "$T/profile" "$T/work" "$T/dest" "$T/repo" "$T/shots"
echo "[w4] $MODE $BACKEND 完成(對話檔備份保留在暫存資料夾)"
