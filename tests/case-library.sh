#!/usr/bin/env bash
# 驗收:長期記憶階段 3 判例庫(假資料模式,不會啟動真正的 CLI):候選偵測(失敗後成功、耗時、快速任務不算)、請承辦節點撰寫並用 case_submit 提交、
# 每天自動撰寫 3 份的上限、手動「記下這個解法」、重複提交被擋、任務卡上的案號標籤;跑完後由這支腳本檢查判例檔案本身(屬性欄位、章節順序、機密遮罩、未確認)。
# 用法:先 npm run build,再在 app 資料夾執行 bash tests/case-library.sh。資料都放在系統暫存區這次專用的新資料夾。
set -u
cd "$(dirname "$0")/.."
W="$(cygpath -u "${TEMP:-/tmp}")/nexus-case-library-$$-$RANDOM"
Y=$(date +%Y)
mkdir -p "$W/work" "$W/shots" "$W/profile/memory-vault/cases/work"
echo "--- 測試資料夾:$W"
# 啟動前就在記憶庫裡的「已確認」判例:新判例的案號要接在它後面,請求裡要列為可能的先例
printf -- '---\n案號: %s-0001\n案由: 登入逾時的處理\n種類: case\n範圍: 專案\n專案: work\n狀態: 已確認\n---\n# 解法第 %s-0001 號\n\n## 事實經過\n\n先前的判例。\n' "$Y" "$Y" > "$W/profile/memory-vault/cases/work/$Y-0001-登入逾時的處理.md"

PORT=$((40000 + RANDOM % 9000))
for v in $(env | grep -oE '^(CLAUDE|ANTHROPIC)[A-Z_0-9]*'); do unset "$v"; done
export NEXUS_FAKE=1 NEXUS_FAKE_ECHO=1 NEXUS_FAKE_NO_ERRORS=1 NEXUS_NO_SEED=1 NEXUS_FAKE_CASE=1 NEXUS_CASE_MIN_MINUTES=0.03 \
  NEXUS_REMOTE_PORT=$PORT NEXUS_HOOKS_PORT=$((PORT + 1)) NEXUS_INTEROP_PORT=$((PORT + 2)) \
  NEXUS_DATA_DIR="$(cygpath -w "$W/profile")" NEXUS_TEST_DIR="$(cygpath -w "$W/shots")" \
  NEXUS_TEST_SCRIPT="$(pwd -W)/tests/case-library.e2e.js" NEXUS_TEST_CWD="$(cygpath -w "$W/work")"
LOG="$W/run.log"
timeout 300 ./node_modules/electron/dist/electron.exe . > "$LOG" 2>&1
grep -E '^\[test\]' "$LOG" | cut -c1-700 | tee "$W/result.txt"

# ---- 檔案本身的檢查
chk() { if eval "$2"; then echo "[test] 通過 $1" | tee -a "$W/result.txt"; else echo "[test] 不符 $1" | tee -a "$W/result.txt"; fi; }
D="$W/profile/memory-vault/cases/work"
F2=$(ls "$D"/$Y-0002-*.md 2>/dev/null | head -1)
F5=$(ls "$D"/$Y-0005-*.md 2>/dev/null | head -1)
chk "案號 0002 的判例檔案存在,0001 沒被動到" '[ -n "$F2" ] && grep -q "先前的判例" "$D"/$Y-0001-*.md'
chk "共有 6 份判例(1 份預先放的加 5 份新的)" '[ "$(ls "$D" | grep -c "\.md$")" = 6 ]'
if [ -n "$F2" ]; then
  for key in "案號: $Y-0002" '種類: case' '範圍: 專案' '專案: work' '承辦節點: 甲號(Claude Code' '來源: 自動偵測' '耗時分鐘: ' '失敗次數: 1' '狀態: 未確認' '關鍵字: \[測試, 判例\]' '更新時間: '; do
    chk "判例屬性「$key」" 'grep -q "^$key" "$F2"'
  done
  chk "屬性有專案ID、節點ID、任務、改過的檔案、commit 之外的客觀欄位" 'grep -q "^專案ID: " "$F2" && grep -q "^節點ID: " "$F2" && grep -q "^任務: " "$F2" && grep -q "^改過的檔案: " "$F2"'
  ORDER=$(grep -E '^(# |## )' "$F2" | tr '\n' '|')
  chk "章節順序固定" '[ "$ORDER" = "# 解法第 $Y-0002 號|## 事實經過|## 爭點|## 處理經過|## 結論|## 理由|## 適用範圍|## 參照先例|" ]'
  chk "機密已遮罩" '! grep -q "sk-ant-api03" "$F2" && grep -q "已遮罩" "$F2"'
  chk "參照先例帶 [[案號]] 連結" 'grep -q "\[\[$Y-0001\]\]" "$F2"'
fi
[ -n "$F5" ] && chk "手動標記的判例來源是使用者標記" 'grep -q "^來源: 使用者標記" "$F5"' || chk "手動標記的判例(0005)存在" 'false'

wait
BAD=$(grep -cE '不符|等不到' "$W/result.txt")
OK=$(grep -cE '^\[test\] 通過' "$W/result.txt")
if [ "$BAD" = 0 ] && [ "$OK" -gt 0 ] && grep -q '主控台端結束' "$W/result.txt"; then echo "全部通過($OK 項)"; else echo "有 $BAD 項不符"; fi
