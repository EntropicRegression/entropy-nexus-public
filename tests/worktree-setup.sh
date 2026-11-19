#!/usr/bin/env bash
# 缺口 1 驗收(假資料模式,不消耗額度):獨立工作區的環境初始化與移除。
# 用法:先 npm run build,再在 app 資料夾執行 bash tests/worktree-setup.sh
# 測試版本庫與主控台資料都放在系統暫存區的新資料夾,不碰 %APPDATA%\entropy-nexus。
set -u
cd "$(dirname "$0")/.."
T="$(mktemp -d "${TMPDIR:-/tmp}/nexus-wtsetup-e2e-XXXXXX")"
fails=0
check() { if eval "$2"; then echo "[sh] 通過 $1"; else echo "[sh] 失敗 $1"; fails=$((fails + 1)); fi; }
islink() { [ -n "$(cmd //c dir /AL "$(cygpath -w "$(dirname "$1")")" 2>/dev/null | grep -F " $(basename "$1") ")" ] || [ -L "$1" ]; }
mkrepo() { # 名稱 .gitignore 內容
  local r="$T/$1"; mkdir -p "$r/app"
  ( cd "$r" && git init -q -b main && git config user.name tester && git config user.email tester@example.com \
    && printf '%b' "$2" > .gitignore && echo hi > README.md && echo 'console.log(1)' > app/index.js \
    && git add -A 2>/dev/null && git commit -q -m init )
}
# 情境 A:沒有 .worktreeinclude,.env、.env.local 被忽略,node_modules 也被忽略
mkrepo repo-a 'node_modules/\n.env*\n'
echo A=1 > "$T/repo-a/.env"; echo B=2 > "$T/repo-a/.env.local"; echo C=3 > "$T/repo-a/app/.env.development"; echo x > "$T/repo-a/notes.txt"
mkdir -p "$T/repo-a/node_modules/pkg" "$T/repo-a/app/node_modules/dep"
echo 'module.exports = 1' > "$T/repo-a/node_modules/pkg/index.js"; echo keep > "$T/repo-a/app/node_modules/dep/keep.txt"
# 情境 B:有 .worktreeinclude(未追蹤),node_modules 沒有被忽略
mkrepo repo-b '.env*\n'
printf '# 只複製這些\n.env\nconfig/*.json\n' > "$T/repo-b/.worktreeinclude"
echo X=1 > "$T/repo-b/.env"; echo Y=2 > "$T/repo-b/.env.local"; mkdir -p "$T/repo-b/config" "$T/repo-b/node_modules/pkg"
echo '{}' > "$T/repo-b/config/a.json"; echo 'module.exports = 2' > "$T/repo-b/node_modules/pkg/index.js"

for v in $(env | grep -oE '^(CLAUDE|ANTHROPIC)[A-Z_0-9]*'); do unset "$v"; done
D="$T/data"; mkdir -p "$D"
export NEXUS_FAKE=1 NEXUS_NO_SEED=1 NEXUS_DATA_DIR="$(cygpath -w "$D/profile")" NEXUS_TEST_DIR="$(cygpath -w "$D")" NEXUS_TEST_SCRIPT="$(pwd -W)/tests/worktree-setup.e2e.js" NEXUS_TEST_CWD="$(cygpath -w "$T")"
run() { timeout 120 ./node_modules/electron/dist/electron.exe . 2>&1 | grep -E "^\[test\]|rror" | cut -c1-600; }

echo "=== 第一次啟動:建立節點"; run
WA="$(ls -d "$D/profile/worktrees/"repo-a-* 2>/dev/null | head -1)"; WB="$(ls -d "$D/profile/worktrees/"repo-b-* 2>/dev/null | head -1)"
echo "工作區 A=$WA"; echo "工作區 B=$WB"
check 'A 複製 .env' '[ "$(cat "$WA/.env" 2>/dev/null)" = A=1 ]'
check 'A 複製 .env.local' '[ -f "$WA/.env.local" ]'
check 'A 複製 app/.env.development' '[ -f "$WA/app/.env.development" ]'
check 'A 不複製 notes.txt' '[ ! -e "$WA/notes.txt" ]'
check 'A node_modules 是 junction 且看得到內容' 'islink "$WA/node_modules" && [ -f "$WA/node_modules/pkg/index.js" ]'
check 'A app/node_modules 是 junction' 'islink "$WA/app/node_modules" && [ -f "$WA/app/node_modules/dep/keep.txt" ]'
check 'A git status 乾淨' '[ -z "$(git -C "$WA" status --porcelain)" ]'
check 'B 依規則複製 .env 與 config/a.json' '[ -f "$WB/.env" ] && [ -f "$WB/config/a.json" ]'
check 'B 不複製規則外的 .env.local' '[ ! -e "$WB/.env.local" ]'
check 'B node_modules 是 junction' 'islink "$WB/node_modules"'
check 'B git status 乾淨(連結已寫進 info/exclude)' '[ -z "$(git -C "$WB" status --porcelain)" ]'
echo "--- B 的 info/exclude"; grep '^/' "$(git -C "$WB" rev-parse --path-format=absolute --git-path info/exclude)"

echo "=== 第二次啟動:終止節點、移除工作區"; run
check 'A 工作區已移除' '[ ! -e "$WA" ]'
check 'B 工作區已移除' '[ ! -e "$WB" ]'
check 'A 原版本庫 node_modules/pkg/index.js 仍在' '[ -f "$T/repo-a/node_modules/pkg/index.js" ]'
check 'A 原版本庫 app/node_modules/dep/keep.txt 仍在' '[ -f "$T/repo-a/app/node_modules/dep/keep.txt" ]'
check 'B 原版本庫 node_modules/pkg/index.js 仍在' '[ -f "$T/repo-b/node_modules/pkg/index.js" ]'
check 'A 原版本庫 .env 仍在' '[ -f "$T/repo-a/.env" ]'
echo "--- 剩下的工作區"; git -C "$T/repo-a" worktree list; git -C "$T/repo-b" worktree list
echo "[sh] 共 $fails 項失敗"
# 工作區都已移除、沒有殘留連結時才清掉暫存資料夾
if [ "$fails" = 0 ]; then rm -rf "$T"; else echo "保留 $T 供檢查"; fi
exit "$fails"
