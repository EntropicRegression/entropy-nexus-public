#!/usr/bin/env bash
# 驗收:回憶錄(記憶設計第六輪,假資料模式,不會啟動真正的 CLI):對話視窗的「寫回憶錄」按鈕 → 主控台請節點寫 → 假節點用 memory_draft(kind memoir)提交,
# 缺章節與起日晚於迄日被拒收、合格的寫進 memoirs/ 且未確認、重複提交被擋;刪除節點時多問一次要不要寫回憶錄。
# 跑完後由這支腳本檢查回憶錄檔案本身(檔頭欄位、身分欄位不是節點偽造的、金鑰與本機路徑已遮罩)。
# 用法:先 npm run build,再在 app 資料夾執行 bash tests/memoir.sh。資料都放在系統暫存區這次專用的新資料夾,連接埠隨機。
set -u
cd "$(dirname "$0")/.."
W="$(cygpath -u "${TEMP:-/tmp}")/nexus-memoir-$$-$RANDOM"
mkdir -p "$W/work" "$W/shots" "$W/profile" "$W/claude"
echo "--- 測試資料夾:$W"

PORT=$((40000 + RANDOM % 9000))
for v in $(env | grep -oE '^(CLAUDE|ANTHROPIC)[A-Z_0-9]*'); do unset "$v"; done
export NEXUS_FAKE=1 NEXUS_FAKE_NO_ERRORS=1 NEXUS_NO_SEED=1 NEXUS_FAKE_MEMOIR=1 NEXUS_ARCHIVE_TIMEOUT_MS=20000 \
  NEXUS_REMOTE_PORT=$PORT NEXUS_HOOKS_PORT=$((PORT + 1)) NEXUS_INTEROP_PORT=$((PORT + 2)) \
  NEXUS_DATA_DIR="$(cygpath -w "$W/profile")" NEXUS_TEST_DIR="$(cygpath -w "$W/shots")" \
  NEXUS_CLAUDE_SETTINGS="$(cygpath -w "$W/claude/settings.json")" \
  NEXUS_TEST_SCRIPT="$(pwd -W)/tests/memoir.e2e.js" NEXUS_TEST_CWD="$(cygpath -w "$W/work")"
LOG="$W/run.log"
timeout 300 ./node_modules/electron/dist/electron.exe . > "$LOG" 2>&1
grep -E '^\[test\]' "$LOG" | cut -c1-700 | tee "$W/result.txt"

# ---- 檔案本身的檢查
chk() { if eval "$2"; then echo "[test] 通過 $1" | tee -a "$W/result.txt"; else echo "[test] 不符 $1" | tee -a "$W/result.txt"; fi; }
V="$W/profile/memory-vault"
ORION_ID=$(grep -oE '^\[test\] ID 獵戶 [^ ]+' "$LOG" | head -1 | awk '{print $4}')
M=$(ls "$V"/memoirs/獵戶-*/*.md 2>/dev/null | head -1)
chk "獵戶的回憶錄檔案存在(memoirs/獵戶-<ID 前 8 碼>/<日期>-測試回憶錄.md)" '[ -n "$M" ] && [ -n "$ORION_ID" ] && [ "$(basename "$(dirname "$M")")" = "獵戶-${ORION_ID:0:8}" ] && [[ "$(basename "$M")" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}-測試回憶錄\.md$ ]]'
if [ -n "$M" ]; then
  chk "第一行就是 ---" '[ "$(head -1 "$M")" = "---" ]'
  for key in '種類: "回憶錄"' "節點ID: \"$ORION_ID\"" '節點: "獵戶"' '後台: "Claude Code"' '標題: "測試回憶錄"' '涵蓋期間: "2026-11-16/2026-11-17"' '範圍: "全域"' '更新時間: "' '狀態: "未確認"'; do
    chk "檔頭「$key」" 'grep -qF "$key" "$M"'
  done
  chk "節點偽造的身分欄位沒有寫進去" '! grep -qE "node-forged|冒名者|假後台" "$M"'
  chk "金鑰與本機路徑已遮罩" '! grep -qE "sk-ant-api03|example" "$M" && grep -q "已遮罩" "$M" && grep -q "本機路徑已隱藏" "$M"'
  chk "正文有固定章節" 'grep -q "^## 來源" "$M" && grep -q "^## 不確定之處" "$M"'
fi
chk "獵戶只有一份回憶錄(拒收與重複提交沒有多寫)" '[ "$(ls "$V"/memoirs/獵戶-*/*.md 2>/dev/null | wc -l)" = 1 ]'
chk "刪除前寫的織女回憶錄存在,狀態未確認" 'F=$(ls "$V"/memoirs/織女-*/*.md 2>/dev/null | head -1); [ -n "$F" ] && grep -qF "狀態: \"未確認\"" "$F" && grep -qF "節點: \"織女\"" "$F"'
chk "北河(先按過按鈕再刪除)只有一份回憶錄" '[ "$(ls "$V"/memoirs/北河-*/*.md 2>/dev/null | wc -l)" = 1 ]'
chk "北河的封存:回憶錄寫完後節點自己寫了工作總結" 'F=$(ls "$V"/nodes/封存/北河-*.md 2>/dev/null | head -1); [ -n "$F" ] && grep -q "總結來源: 節點自己" "$F"'
chk "選「不用寫回憶錄」的天琴沒有回憶錄" '[ -z "$(ls "$V"/memoirs/天琴-*/*.md 2>/dev/null)" ]'

wait
BAD=$(grep -cE '不符|等不到' "$W/result.txt")
OK=$(grep -cE '^\[test\] 通過' "$W/result.txt")
if [ "$BAD" = 0 ] && [ "$OK" -gt 0 ] && grep -q '主控台端結束' "$W/result.txt"; then echo "全部通過($OK 項)"; else echo "有 $BAD 項不符"; fi
