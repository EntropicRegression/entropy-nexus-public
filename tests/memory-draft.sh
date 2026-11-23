#!/usr/bin/env bash
# 驗收:長期記憶階段 4.5 對話草稿(假資料模式,不會啟動真正的 CLI):累積字數門檻、「儲存這段記憶」按鈕、請節點用 memory_draft 提交、
# 重複提交被擋、草稿狀態未確認;跑完後由這支腳本檢查草稿檔案本身(屬性欄位、機密遮罩、子類)。
# 用法:先 npm run build,再在 app 資料夾執行 bash tests/memory-draft.sh。資料都放在系統暫存區這次專用的新資料夾。
set -u
cd "$(dirname "$0")/.."
W="$(cygpath -u "${TEMP:-/tmp}")/nexus-memory-draft-$$-$RANDOM"
mkdir -p "$W/work" "$W/shots" "$W/profile"
echo "--- 測試資料夾:$W"

PORT=$((40000 + RANDOM % 9000))
for v in $(env | grep -oE '^(CLAUDE|ANTHROPIC)[A-Z_0-9]*'); do unset "$v"; done
export NEXUS_FAKE=1 NEXUS_FAKE_ECHO=1 NEXUS_FAKE_NO_ERRORS=1 NEXUS_NO_SEED=1 NEXUS_FAKE_DRAFT=1 NEXUS_DRAFT_THRESHOLD=300 \
  NEXUS_REMOTE_PORT=$PORT NEXUS_HOOKS_PORT=$((PORT + 1)) NEXUS_INTEROP_PORT=$((PORT + 2)) \
  NEXUS_DATA_DIR="$(cygpath -w "$W/profile")" NEXUS_TEST_DIR="$(cygpath -w "$W/shots")" \
  NEXUS_TEST_SCRIPT="$(pwd -W)/tests/memory-draft.e2e.js" NEXUS_TEST_CWD="$(cygpath -w "$W/work")"
LOG="$W/run.log"
timeout 300 ./node_modules/electron/dist/electron.exe . > "$LOG" 2>&1
grep -E '^\[test\]' "$LOG" | cut -c1-700 | tee "$W/result.txt"

# ---- 檔案本身的檢查
chk() { if eval "$2"; then echo "[test] 通過 $1" | tee -a "$W/result.txt"; else echo "[test] 不符 $1" | tee -a "$W/result.txt"; fi; }
V="$W/profile/memory-vault"
K=$(ls "$V"/knowledge/*/測試草稿知識.md 2>/dev/null | head -1)
P="$V/preferences/測試草稿偏好.md"
chk "專案知識草稿檔案存在" '[ -n "$K" ]'
if [ -n "$K" ]; then
  for key in '種類: knowledge' '範圍: 專案' '子類: 決策' '狀態: 未確認' '來源: 對話草稿' '來源節點: 甲號(Claude Code' '節點ID: ' '標題: 測試草稿知識' '更新時間: '; do
    chk "草稿屬性「$key」" 'grep -q "^$key" "$K"'
  done
  chk "機密已遮罩" '! grep -q "sk-ant-api03" "$K" && grep -q "已遮罩" "$K"'
fi
chk "使用者偏好草稿檔案存在,狀態未確認" '[ -f "$P" ] && grep -q "^狀態: 未確認" "$P" && grep -q "^範圍: 全域" "$P"'
chk "只有這兩份草稿(重複提交沒有多寫)" '[ "$(find "$V/knowledge" "$V/preferences" -name "*.md" | wc -l)" = 2 ]'

wait
BAD=$(grep -cE '不符|等不到' "$W/result.txt")
OK=$(grep -cE '^\[test\] 通過' "$W/result.txt")
if [ "$BAD" = 0 ] && [ "$OK" -gt 0 ] && grep -q '主控台端結束' "$W/result.txt"; then echo "全部通過($OK 項)"; else echo "有 $BAD 項不符"; fi
