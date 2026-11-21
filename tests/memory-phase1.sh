#!/usr/bin/env bash
# 驗收:長期記憶階段 1(假資料模式,不會啟動真正的 CLI):任務的專案在交辦當下寫入(git worktree 與主版本庫同一個專案)、
# 驗收按鈕與評論自動退回、記憶庫資料夾的索引(啟動掃描與外部新增/修改/刪除)、總管收到的節點統計與通知頻率。
# 用法:先 npm run build,再在 app 資料夾執行 bash tests/memory-phase1.sh。資料都放在系統暫存區這次專用的新資料夾。
set -u
cd "$(dirname "$0")/.."
W="$(cygpath -u "${TEMP:-/tmp}")/nexus-memory-phase1-$$-$RANDOM"
mkdir -p "$W/repo" "$W/plain" "$W/shots" "$W/profile/memory-vault/knowledge/startup"
echo "--- 測試資料夾:$W"
( cd "$W/repo" && git init -q -b main && printf 'a\n' > a.txt && git add -A \
  && git -c user.name=tester -c user.email=tester@example.com commit -q -m init \
  && git worktree add -q -b feature "$W/wt" )
printf -- '---\n標題: 啟動前放的知識\n狀態: 已確認\n---\n啟動前就在資料夾裡的檔案。\n' > "$W/profile/memory-vault/knowledge/startup/pre.md"

V="$W/profile/memory-vault/preferences/dropped.md"
# 測試腳本截圖「vault-drop」「vault-edit」「vault-delete」時,外層依序新增、修改、刪除記憶庫裡的檔案
(
  for _ in $(seq 1 3000); do [ -f "$W/shots/vault-drop.png" ] && break; sleep 0.1; done
  printf -- '---\n標題: 回報要精簡\n---\n外部放進來的偏好。\n' > "$V"; echo "[wrapper] 已新增記憶檔"
  for _ in $(seq 1 600); do [ -f "$W/shots/vault-edit.png" ] && break; sleep 0.1; done
  printf -- '---\n標題: 回報要詳細\n狀態: 已確認\n---\n外部改過的偏好,內容加長了一些。\n' > "$V"; echo "[wrapper] 已修改記憶檔"
  for _ in $(seq 1 600); do [ -f "$W/shots/vault-delete.png" ] && break; sleep 0.1; done
  rm -f "$V"; echo "[wrapper] 已刪除記憶檔"
) &

for v in $(env | grep -oE '^(CLAUDE|ANTHROPIC)[A-Z_0-9]*'); do unset "$v"; done
export NEXUS_FAKE=1 NEXUS_FAKE_ECHO=1 NEXUS_FAKE_NO_ERRORS=1 NEXUS_NO_SEED=1 NEXUS_CHIEF_STATS_MS=5000 \
  NEXUS_DATA_DIR="$(cygpath -w "$W/profile")" NEXUS_TEST_DIR="$(cygpath -w "$W/shots")" \
  NEXUS_TEST_SCRIPT="$(pwd -W)/tests/memory-phase1.e2e.js" NEXUS_TEST_CWD="$(cygpath -w "$W/repo")"
LOG="$W/run.log"
timeout 300 ./node_modules/electron/dist/electron.exe . > "$LOG" 2>&1
grep -E '^\[test\]|^\[wrapper\]' "$LOG" | cut -c1-700 | tee "$W/result.txt"
wait
BAD=$(grep -cE '不符|等不到' "$W/result.txt")
OK=$(grep -cE '^\[test\] 通過' "$W/result.txt")
if [ "$BAD" = 0 ] && [ "$OK" -gt 0 ] && grep -q '主控台端結束' "$W/result.txt"; then echo "全部通過($OK 項)"; else echo "有 $BAD 項不符"; fi
# 清掉 worktree 登記,避免暫存區的版本庫留下失效的連結
git -C "$W/repo" worktree prune 2>/dev/null
