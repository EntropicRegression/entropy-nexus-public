#!/usr/bin/env bash
# 驗收:長期記憶階段 4(假資料模式,不會啟動真正的 CLI):終止節點時的確認畫面與歸檔(節點自己寫總結、總管代寫、只存統計、沒有總管)、
# 封存檔的內容與區段順序、新增同名節點時接回封存(側寫的「接回自」)。
# 用法:先 npm run build,再在 app 資料夾執行 bash tests/memory-archive.sh。資料都放在系統暫存區這次專用的新資料夾。
set -u
cd "$(dirname "$0")/.."
W="$(cygpath -u "${TEMP:-/tmp}")/nexus-memory-archive-$$-$RANDOM"
V="$W/profile/memory-vault"
mkdir -p "$W/plain" "$W/shots" "$V/nodes"
echo "--- 測試資料夾:$W"
# 節點還活著時的側寫(階段 2 由節點自己寫的);歸檔要把「特長」抄進封存。
# 這個檔案不是主控台寫的,算「使用者改過」:接回時只會附加,不會覆寫
printf -- '---\n種類: node\n節點: AlphaA\n---\n## 特長\n\n擅長重構測試\n\n## 解決問題的流程\n\n舊的流程\n' > "$V/nodes/AlphaA.md"

for v in $(env | grep -oE '^(CLAUDE|ANTHROPIC)[A-Z_0-9]*'); do unset "$v"; done
export NEXUS_FAKE=1 NEXUS_FAKE_NO_ERRORS=1 NEXUS_NO_SEED=1 NEXUS_ARCHIVE_TIMEOUT_MS=20000 \
  NEXUS_DATA_DIR="$(cygpath -w "$W/profile")" NEXUS_TEST_DIR="$(cygpath -w "$W/shots")" \
  NEXUS_TEST_SCRIPT="$(pwd -W)/tests/memory-archive.e2e.js" NEXUS_TEST_CWD="$(cygpath -w "$W/plain")"
LOG="$W/run.log"
timeout 240 ./node_modules/electron/dist/electron.exe . > "$LOG" 2>&1
grep -E '^\[test\]' "$LOG" | cut -c1-700 | tee "$W/result.txt"

# ---- 結束後檢查檔案內容(寫成和腳本相同的「通過/不符」格式)
chk() { # 說明 檔案 模式
  if [ -n "$2" ] && grep -q -- "$3" "$2" 2>/dev/null; then echo "[test] 通過 $1" | tee -a "$W/result.txt"; else echo "[test] 不符 $1 → $2" | tee -a "$W/result.txt"; fi
}
one() { ls "$V"/nodes/封存/"$1"-*.md 2>/dev/null | head -1; }
FA="$(one AlphaA)"; FS="$(one SleepS)"; FD="$(one DirectD)"; FF="$(one FinalF)"
chk "AlphaA 封存:總結來源是節點自己" "$FA" '總結來源: 節點自己'
chk "AlphaA 封存:有節點自己寫的總結" "$FA" '節點自己的總結'
chk "AlphaA 封存:特長抄自原本的側寫" "$FA" '擅長重構測試'
chk "AlphaA 封存:有任務紀錄" "$FA" '## 任務紀錄'
chk "SleepS 封存:總結來源是總管" "$FS" '總結來源: 總管'
chk "SleepS 封存:有總管代寫的總結" "$FS" '總管代寫的總結'
chk "DirectD 封存:總結來源是無" "$FD" '總結來源: 無'
if [ -n "$FD" ] && ! grep -q '## 解決問題的流程' "$FD"; then echo "[test] 通過 DirectD 封存:沒有解決問題的流程" | tee -a "$W/result.txt"; else echo "[test] 不符 DirectD 封存:不該有解決問題的流程" | tee -a "$W/result.txt"; fi
chk "FinalF 封存:沒有總管的原因寫在基本資料" "$FF" '沒有總管可以代寫'
# 區段順序:基本資料 → 特長 → 任務紀錄 → 解決問題的流程
ORDER="$(grep -E '^## ' "$FA" 2>/dev/null | tr '\n' '|')"
if [ "$ORDER" = '## 基本資料|## 特長|## 任務紀錄|## 解決問題的流程|' ]; then echo "[test] 通過 AlphaA 封存的區段順序" | tee -a "$W/result.txt"; else echo "[test] 不符 AlphaA 封存的區段順序 → $ORDER" | tee -a "$W/result.txt"; fi
# 接回:側寫原本的內容保留,後面附加封存的總結與來源
chk "接回:側寫保留原本的內容" "$V/nodes/AlphaA.md" '舊的流程'
chk "接回:側寫附加封存的總結與『接回自』" "$V/nodes/AlphaA.md" '接回自:nodes/封存/AlphaA-'
chk "接回:側寫帶著封存的總結" "$V/nodes/AlphaA.md" '節點自己的總結'

BAD=$(grep -cE '不符|等不到' "$W/result.txt")
OK=$(grep -cE '^\[test\] 通過' "$W/result.txt")
if [ "$BAD" = 0 ] && [ "$OK" -gt 0 ] && grep -q '主控台端結束' "$W/result.txt"; then echo "全部通過($OK 項)"; else echo "有 $BAD 項不符"; fi
