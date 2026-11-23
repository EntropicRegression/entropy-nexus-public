#!/usr/bin/env bash
# 協作流程(發展規劃 2-2)第一版 M3「範圍合約與授權完整版」的驗收:假資料模式啟動主控台(tests/flow-scope.e2e.js),
# 每個情境一個獨立的 git 版本庫,假資料節點照主題裡的〔測試流程:…〕腳本行動。情境:
#   askpush    節點要求執行 git push(先送工具啟動、再詢問授權)→ 自動拒絕、留說明、記違規,流程繼續
#   toolcommit 節點直接執行 git commit(工具啟動事件)→ 中斷交辦、記違規、停機
#   harmless   只是提到 Program Files、.msi 的一般指令不攔
#   flowswrite 節點寫入流程定義資料夾 flows/ → 事後比對偵測、記違規、停機
#   outno/outyes 範圍外檔案:授權卡列出說明與沒寫原因的檔案;沒勾選不提交、勾選才提交
#   gatedeny/gateallow requires_approval 的步驟交辦前跳卡:拒絕就不交辦;允許才交辦,而且這一步可以做被授權的動作
#   quit       核實進行中關閉主控台:核實子程序被終止、核實副本與 nexus-flow-data-* 臨時資料夾清掉
# 用法:先 npm run build,再在 app 資料夾執行 bash tests/flow-scope.sh。不碰正式資料(資料夾、連接埠、Claude 設定檔都是臨時的),也不消耗額度。
# 主控台的 TEMP 指到暫存資料夾裡的 tmp/,才能確認核實的臨時資料夾有清掉(也順便驗證 8.3 短路徑:外層 TEMP 是短名稱時,路徑一路保持短名稱)。
set -u
cd "$(dirname "$0")/.."
T="$(cygpath -u "$TEMP")/nexus-flow-scope-$$-$RANDOM"
mkdir -p "$T/shots" "$T/profile/flows" "$T/work" "$T/claude" "$T/tmp"
PORT=$((40000 + RANDOM % 9000))
LOG="$T/run.log"
OUT="$T/result.txt"

# 一般情境的範本(和 flow.sh 相同的步驟,核實指令是版本庫裡的 check.js)
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
    - { id: check, run: node check.js, timeout: 90 }
steps:
  - { id: implement, label: 實作, role: implementer, mode: write, verify: true, on_reject: fix }
  - { id: review, label: 隔離審查, role: reviewer, mode: review, on_reject: fix, next: done }
  - { id: fix, label: 修正, role: implementer, mode: write, continue_session: true, verify: true, on_reject: fix, next: review }
finish: { offer: [commit] }
YAML

# requires_approval 的範本:實作步驟要先授權 push
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

# quit 的 check.js:記下自己的 pid(版本庫外面),然後睡 80 秒(核實逾時是 90 秒),讓主控台在核實進行中關閉
PIDFILE="$(cygpath -m "$T/quit-check.pid")"
for name in askpush toolcommit harmless flowswrite outno outyes gatedeny gateallow quit; do
  R="$T/work/$name"
  mkdir -p "$R/src"
  git -C "$R" init -q -b main
  git -C "$R" config user.name tester
  git -C "$R" config user.email tester@example.com
  git -C "$R" config core.autocrlf false
  printf 'node_modules/\n*.log\ndist/\nrelease/\n' > "$R/.gitignore"
  printf 'v0\n' > "$R/src/a.txt"
  if [ "$name" = quit ]; then
    printf "require('fs').writeFileSync('%s', String(process.pid));\nsetTimeout(() => console.log('ok'), 80000);\n" "$PIDFILE" > "$R/check.js"
  else
    printf "console.log('ok');\n" > "$R/check.js"
  fi
  git -C "$R" add -A
  git -C "$R" commit -q -m init
done

export NEXUS_FAKE=1 NEXUS_FAKE_NO_ERRORS=1 NEXUS_NO_SEED=1 NEXUS_REMOTE_PORT=$PORT NEXUS_HOOKS_PORT=$((PORT + 1)) NEXUS_INTEROP_PORT=$((PORT + 2)) NEXUS_FLOW_ENSURE_MS=4000 \
  NEXUS_DATA_DIR="$(cygpath -w "$T/profile")" NEXUS_TEST_DIR="$(cygpath -w "$T/shots")" NEXUS_TEST_SCRIPT="$(pwd -W)/tests/flow-scope.e2e.js" NEXUS_TEST_CWD="$(cygpath -w "$T/work")" \
  NEXUS_CLAUDE_SETTINGS="$(cygpath -w "$T/claude/settings.json")"
TEMP="$(cygpath -w "$T/tmp")" TMP="$(cygpath -w "$T/tmp")" timeout 400 ./node_modules/electron/dist/electron.exe . > "$LOG" 2>&1
grep -E '^\[test\]' "$LOG" | grep -vE ' (RUN) ' | cut -c1-400 | tee "$OUT"

# ---- 主控台結束後:版本庫、runs/ 與臨時資料夾
ok() { if [ "$1" = 0 ]; then echo "[shell] 通過 $2" | tee -a "$OUT"; else echo "[shell] 不符 $2" | tee -a "$OUT"; fi; }
runid() { grep -E "^\[test\] RUN $1 " "$LOG" | head -1 | awk '{print $4}'; }
RUNS="$T/profile/runs"
files() { git -C "$T/work/$1" show --name-only --format= HEAD | sort | tr '\n' ' '; }

[ "$(files outno)" = "src/a.txt " ]; ok $? "範圍外檔案沒勾選:只提交範圍內的檔案(實際:$(files outno))"
git -C "$T/work/outno" status --porcelain | grep -q 'notes.txt'; ok $? "範圍外檔案沒勾選:notes.txt 留在工作區"
[ "$(files outyes)" = "notes.txt src/a.txt " ]; ok $? "範圍外檔案勾選後:notes.txt 一起提交,沒勾選的 extra.txt 沒有(實際:$(files outyes))"
git -C "$T/work/outyes" status --porcelain | grep -q 'extra.txt'; ok $? "範圍外檔案勾選後:沒勾選的 extra.txt 留在工作區"
for name in askpush toolcommit harmless flowswrite gatedeny gateallow quit; do
  [ "$(git -C "$T/work/$name" rev-list --count HEAD)" = 1 ]; ok $? "$name:沒有任何提交(節點沒有真的 commit,流程也沒有替使用者提交)"
done

# 關閉時終止核實:check.js 的程序已經不在,核實副本與臨時資料夾都清掉
if [ -f "$T/quit-check.pid" ]; then
  QPID="$(cat "$T/quit-check.pid")"
  tasklist //FI "PID eq $QPID" 2>/dev/null | grep -q "$QPID"; [ $? != 0 ]; ok $? "關閉主控台:核實子程序($QPID)已被終止"
else
  ok 1 "關閉主控台:核實有開始跑(找不到 pid 檔)"
fi
LEFT="$(find "$T/tmp" -maxdepth 1 -name 'nexus-flow-data-*' 2>/dev/null | wc -l)"
[ "$LEFT" = 0 ]; ok $? "關閉主控台:nexus-flow-data-* 臨時資料夾清掉了(剩 $LEFT 個)"
Q="$(runid quit)"
CL="$(find "$RUNS/$Q/copies" -mindepth 1 -maxdepth 1 -name 'v-*' 2>/dev/null | wc -l)"
[ -n "$Q" ] && [ "$CL" = 0 ]; ok $? "關閉主控台:核實副本清掉了(剩 $CL 個)"
[ -n "$Q" ] && grep -q '"phase": *"verifying"' "$RUNS/$Q/run.json"; ok $? "關閉主控台:狀態有寫回(停在核實階段,重開後改成暫停再重新核實)"
[ ! -f "$T/claude/settings.json" ] || ! grep -q hooks "$T/claude/settings.json"; ok $? "沒有動到 Claude 設定檔"

echo "暫存資料夾:$T"
BAD=$(grep -cE '不符|失敗|等不到' "$OUT")
OKN=$(grep -cE '通過' "$OUT")
if [ "$BAD" = 0 ] && [ "$OKN" -gt 0 ] && grep -q '主控台端結束' "$OUT"; then echo "全部通過($OKN 項)"; else echo "有 $BAD 項不符"; fi
