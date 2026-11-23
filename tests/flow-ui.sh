#!/usr/bin/env bash
# 協作流程(發展規劃 2-2)第一版 M4「介面」的驗收:假資料模式啟動主控台(tests/flow-ui.e2e.js),在畫面裡用 DOM 操作:
#   ui        任務面板「套用流程」對話框:選範本與專案、角色依專案設定預填、錯誤訊息、允許桌面核實寫回、開始;
#             步驟條燈號隨進度變化、step_report 卡片、核實結果、範圍外檔案;授權卡勾選範圍外檔案後允許(只提交勾選的)
#   gate      交辦前的授權卡只有允許/拒絕,拒絕後停機,顯示停機卡
#   ruling    需裁示:填入裁示並繼續           unreported 未回報:手動補報表單
#   stuck     停止後節點停不下來:強制視為結束(要先勾選了解警語)
#   blocked   核實被環境擋住的燈號與重跑      timeout   核實逾時的燈號與中止
#   reject2   退回兩輪停機:失敗燈號與停機卡  reassign  原節點不在了:待決卡改派節點,紀錄標示新 session
#   pause     暫停 / 繼續                      viol      違規列表(禁止動作已擋下、打包產出改動)
#   expire    正本改變後按允許:授權卡失效,顯示原因、沒有允許鈕
#   protected 寫入流程定義資料夾的違規(共用資料夾,最後單獨跑)
# 另外驗證:停機、中止、交辦前拒絕都要再按一次確認;已用時間和主行程一致;補報表單在畫面先檢查;操作失敗顯示錯誤且狀態不變;
# 有未送出內容時 Esc 不關閉詳情;關閉後焦點還給原本的按鈕。
# 用法:先 npm run build,再在 app 資料夾執行 bash tests/flow-ui.sh。不碰正式資料(資料夾、連接埠、Claude 設定檔都是臨時的),也不消耗額度。
# 截圖存在暫存資料夾的 shots/(檢查版面用,不要提交)。
set -u
cd "$(dirname "$0")/.."
T="$(cygpath -u "$TEMP")/nexus-flow-ui-$$-$RANDOM"
mkdir -p "$T/shots" "$T/profile/flows" "$T/work" "$T/claude"
PORT=$((40000 + RANDOM % 9000))
LOG="$T/run.log"
OUT="$T/result.txt"

# 和 flow.sh 相同的一般範本
cat > "$T/profile/flows/e2e-flow.yaml" <<'YAML'
id: e2e-flow
name: 測試流程
version: 1
description: 假資料驗收用
roles:
  implementer: { mode: write, description: 實作 }
  reviewer: { mode: review, description: 審查 }
limits: { max_rejections: 2, max_minutes: 30, step_minutes: 5, reminder_minutes: 0.02, max_dispatches: 12 }
scope: { allowed_paths: [src/] }
verify:
  commands:
    - { id: check, run: node check.js, timeout: 60 }
steps:
  - { id: implement, label: 實作, role: implementer, mode: write, verify: true, on_reject: fix }
  - { id: review, label: 隔離審查, role: reviewer, mode: review, on_reject: fix, next: done }
  - { id: fix, label: 修正, role: implementer, mode: write, continue_session: true, verify: true, on_reject: fix, next: review }
finish: { offer: [commit] }
YAML

# 交辦前跳卡(requires_approval)
cat > "$T/profile/flows/e2e-gate.yaml" <<'YAML'
id: e2e-gate
name: 授權測試流程
version: 1
description: 交辦前跳卡
roles:
  implementer: { mode: write, description: 實作 }
  reviewer: { mode: review, description: 審查 }
limits: { max_rejections: 2, max_minutes: 30, step_minutes: 5, reminder_minutes: 0.02, max_dispatches: 12 }
scope: { allowed_paths: [src/] }
verify:
  commands:
    - { id: check, run: node check.js, timeout: 60 }
steps:
  - { id: implement, label: 實作並推送, role: implementer, mode: write, verify: true, on_reject: halt, requires_approval: [push] }
  - { id: review, label: 隔離審查, role: reviewer, mode: review, on_reject: halt, next: done }
finish: { offer: [commit] }
YAML

# 核實逾時(check.js 睡 20 秒,逾時 2 秒)
cat > "$T/profile/flows/e2e-timeout.yaml" <<'YAML'
id: e2e-timeout
name: 逾時測試流程
version: 1
description: 核實逾時
roles:
  implementer: { mode: write, description: 實作 }
  reviewer: { mode: review, description: 審查 }
limits: { max_rejections: 2, max_minutes: 30, step_minutes: 5, reminder_minutes: 0.02, max_dispatches: 12 }
scope: { allowed_paths: [src/] }
verify:
  commands:
    - { id: slow, run: node check.js, timeout: 2 }
steps:
  - { id: implement, label: 實作, role: implementer, mode: write, verify: true, on_reject: halt }
  - { id: review, label: 隔離審查, role: reviewer, mode: review, on_reject: halt, next: done }
finish: { offer: [commit] }
YAML

COUNTER="$(cygpath -m "$T/blocked-count")"
for name in ui gate ruling unreported stuck blocked timeout reject2 reassign pause viol protected expire; do
  R="$T/work/$name"
  mkdir -p "$R/src"
  git -C "$R" init -q -b main
  git -C "$R" config user.name tester
  git -C "$R" config user.email tester@example.com
  git -C "$R" config core.autocrlf false
  printf 'node_modules/\n*.log\ndist/\nrelease/\n' > "$R/.gitignore"
  printf 'v0\n' > "$R/src/a.txt"
  if [ "$name" = blocked ]; then
    printf "const fs = require('fs');\nconst c = '%s';\nif (!fs.existsSync(c)) { fs.writeFileSync(c, '1'); console.log('模擬:找不到指令'); process.exit(9009); }\nconsole.log('ok');\n" "$COUNTER" > "$R/check.js"
  elif [ "$name" = timeout ]; then
    printf "console.log('跑很久的核實');\nsetTimeout(() => console.log('ok'), 20000);\n" > "$R/check.js"
  else
    printf "console.log('ok');\n" > "$R/check.js"
  fi
  git -C "$R" add -A
  git -C "$R" commit -q -m init
done
# 另一個專案的資料夾(放「工作目錄不在專案裡」的節點,測試錯誤訊息)
mkdir -p "$T/work/other"

export NEXUS_FAKE=1 NEXUS_FAKE_NO_ERRORS=1 NEXUS_NO_SEED=1 NEXUS_REMOTE_PORT=$PORT NEXUS_HOOKS_PORT=$((PORT + 1)) NEXUS_INTEROP_PORT=$((PORT + 2)) NEXUS_FLOW_ENSURE_MS=4000 \
  NEXUS_DATA_DIR="$(cygpath -w "$T/profile")" NEXUS_TEST_DIR="$(cygpath -w "$T/shots")" NEXUS_TEST_SCRIPT="$(pwd -W)/tests/flow-ui.e2e.js" NEXUS_TEST_CWD="$(cygpath -w "$T/work")" \
  NEXUS_CLAUDE_SETTINGS="$(cygpath -w "$T/claude/settings.json")"
timeout 480 ./node_modules/electron/dist/electron.exe . > "$LOG" 2>&1
grep -E '^\[test\]' "$LOG" | grep -vE ' (RUN) ' | cut -c1-400 | tee "$OUT"

# ---- 主控台結束後:版本庫
ok() { if [ "$1" = 0 ]; then echo "[shell] 通過 $2" | tee -a "$OUT"; else echo "[shell] 不符 $2" | tee -a "$OUT"; fi; }
files() { git -C "$T/work/$1" show --name-only --format= HEAD | sort | tr '\n' ' '; }
[ "$(files ui)" = "notes.txt src/a.txt " ]; ok $? "授權卡勾選範圍外的 notes.txt 後允許:只提交勾選的(實際:$(files ui))"
git -C "$T/work/ui" status --porcelain | grep -q 'extra.txt'; ok $? "沒勾選的 extra.txt 留在工作區"
git -C "$T/work/ui" log -1 --format=%s | grep -q '介面測試提交'; ok $? "授權卡的提交訊息照填的寫入"
for name in gate ruling unreported stuck blocked timeout reject2 reassign pause viol protected expire; do
  [ "$(git -C "$T/work/$name" rev-list --count HEAD)" = 1 ]; ok $? "$name:沒有任何提交"
done
grep -q 'allow_desktop_verify: true' "$T/profile/flows/projects.yaml" 2>/dev/null; ok $? "允許桌面核實的勾選寫回 projects.yaml"
[ -f "$T/shots/flow-ui-detail.png" ] && [ -f "$T/shots/flow-ui-apply.png" ]; ok $? "截圖存好了(shots/)"
[ ! -f "$T/claude/settings.json" ] || ! grep -q hooks "$T/claude/settings.json"; ok $? "沒有動到 Claude 設定檔"

echo "暫存資料夾:$T"
BAD=$(grep -cE '不符|失敗|等不到' "$OUT")
OKN=$(grep -cE '通過' "$OUT")
if [ "$BAD" = 0 ] && [ "$OKN" -gt 0 ] && grep -q '主控台端結束' "$OUT"; then echo "全部通過($OKN 項)"; else echo "有 $BAD 項不符"; fi
