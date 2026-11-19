#!/usr/bin/env bash
# 階段 7 驗收:建立測試用版本庫,執行 tests/stage7.e2e.js,再從外部檢查版本庫的實際狀態。
# 用法:在 app 資料夾執行 bash tests/stage7.sh(會啟動真正的 Claude Code 與 Antigravity)
set -u
cd "$(dirname "$0")/.."
W="$(cd .. && pwd)/phase0/stage7-test"
rm -rf "$W" && mkdir -p "$W/repo" "$W/plain"
( cd "$W/repo" && git init -q -b main \
  && printf 'function greet(name) {\n  return "hi " + name;\n}\n\nconsole.log(greet("world"));\n\n\n\n\n// end of file\n' > app.js \
  && printf 'line one\nline two\n' > notes.txt && git add -A 2>/dev/null && git -c user.name=tester -c user.email=tester@example.com commit -q -m init \
  && git config user.name tester && git config user.email tester@example.com )
for v in $(env | grep -oE '^(CLAUDE|ANTHROPIC)[A-Z_0-9]*'); do unset "$v"; done
D=.test-data/s7; rm -rf "$D" && mkdir -p "$D"
export NEXUS_NO_SEED=1 NEXUS_DATA_DIR="$(pwd -W)/$D/profile" NEXUS_TEST_DIR="$(pwd -W)/$D" NEXUS_TEST_SCRIPT="$(pwd -W)/tests/stage7.e2e.js" NEXUS_TEST_CWD="$(cygpath -w "$W/repo")"
timeout 560 ./node_modules/electron/dist/electron.exe . 2>&1 | grep -E "^\[test\]|rror" | cut -c1-520
echo "--- 原版本庫的提交紀錄"; git -C "$W/repo" log --oneline --graph | head -8
echo "--- 原版本庫的 app.js"; cat "$W/repo/app.js"
echo "--- 原版本庫的狀態(還原後應該是乾淨的)"; git -C "$W/repo" status --short; ls "$W/repo"
echo "--- notes.txt"; cat "$W/repo/notes.txt"
echo "--- 剩下的工作區與分支"; git -C "$W/repo" worktree list; git -C "$W/repo" branch --list
ls "$D/profile/worktrees" 2>/dev/null | head
