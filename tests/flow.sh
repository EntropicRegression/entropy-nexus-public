#!/usr/bin/env bash
# 協作流程(發展規劃 2-2)第一版 M2 的驗收:假資料模式啟動主控台(tests/flow.e2e.js),每個情境用一個獨立的 git 版本庫,
# 假資料節點照主題裡的〔測試流程:…〕腳本寫檔、回報(step_report)、不回報、延後回報、自己 commit,
# 檢查規格「驗收」的情境(一次通過、退回一輪、退回兩輪停機、遲到回報、中途停止、被環境擋住、版本失效、原 session 不在),
# 外加未回報、需裁示、節點自己 commit 被偵測、節點停不下來時不默認已結束(確認逾時縮成 4 秒)。主控台跑完後,這裡再檢查版本庫的提交與 runs/<id>/ 的檔案。
# 用法:先 npm run build,再在 app 資料夾執行 bash tests/flow.sh。不碰正式資料(資料夾、連接埠、Claude 設定檔都是臨時的),也不消耗額度。
set -u
cd "$(dirname "$0")/.."
T="$(cygpath -u "$TEMP")/nexus-flow-$$-$RANDOM"
mkdir -p "$T/shots" "$T/profile/flows" "$T/work" "$T/claude"
PORT=$((40000 + RANDOM % 9000))
LOG="$T/run.log"
OUT="$T/result.txt"

# 測試用的流程範本:和內建範本一樣的步驟,上限縮短(提醒 1.2 秒),核實指令是版本庫裡的 check.js
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

# 每個情境一個版本庫。blocked 的 check.js 第一次跑時以 9009(找不到指令)結束,模擬被環境擋住;計數檔放在版本庫外面
COUNTER="$(cygpath -m "$T/blocked-count")"
for name in pass reject1 reject2 late stop blocked version session unreported ruling commit stuck; do
  R="$T/work/$name"
  mkdir -p "$R/src"
  git -C "$R" init -q -b main
  git -C "$R" config user.name tester
  git -C "$R" config user.email tester@example.com
  git -C "$R" config core.autocrlf false
  printf 'node_modules/\n*.log\n' > "$R/.gitignore"
  printf 'v0\n' > "$R/src/a.txt"
  if [ "$name" = blocked ]; then
    printf "const fs = require('fs');\nconst c = '%s';\nif (!fs.existsSync(c)) { fs.writeFileSync(c, '1'); console.log('模擬:找不到指令'); process.exit(9009); }\n" "$COUNTER" > "$R/check.js"
  else
    : > "$R/check.js"
  fi
  printf "const t = require('fs').readFileSync('src/a.txt', 'utf8');\nif (t.includes('BAD')) { console.log('a.txt 有 BAD'); process.exit(1); }\nconsole.log('ok');\n" >> "$R/check.js"
  git -C "$R" add -A
  git -C "$R" commit -q -m init
done

export NEXUS_FAKE=1 NEXUS_FAKE_NO_ERRORS=1 NEXUS_NO_SEED=1 NEXUS_REMOTE_PORT=$PORT NEXUS_HOOKS_PORT=$((PORT + 1)) NEXUS_INTEROP_PORT=$((PORT + 2)) NEXUS_FLOW_ENSURE_MS=4000 \
  NEXUS_DATA_DIR="$(cygpath -w "$T/profile")" NEXUS_TEST_DIR="$(cygpath -w "$T/shots")" NEXUS_TEST_SCRIPT="$(pwd -W)/tests/flow.e2e.js" NEXUS_TEST_CWD="$(cygpath -w "$T/work")" \
  NEXUS_CLAUDE_SETTINGS="$(cygpath -w "$T/claude/settings.json")"
timeout 400 ./node_modules/electron/dist/electron.exe . > "$LOG" 2>&1
grep -E '^\[test\]' "$LOG" | grep -vE ' (RUN) ' | cut -c1-400 | tee "$OUT"

# ---- 主控台結束後:版本庫與 runs/ 的檔案
ok() { if [ "$1" = 0 ]; then echo "[shell] 通過 $2" | tee -a "$OUT"; else echo "[shell] 不符 $2" | tee -a "$OUT"; fi; }
runid() { grep -E "^\[test\] RUN $1 " "$LOG" | head -1 | awk '{print $4}'; }
RUNS="$T/profile/runs"

# 一次通過:授權後只提交範圍內的 src/a.txt,範圍外的 notes.txt 沒有納入
FILES="$(git -C "$T/work/pass" show --name-only --format= HEAD | tr '\n' ' ')"
[ "$FILES" = "src/a.txt " ]; ok $? "授權卡允許後只提交範圍內的檔案(實際:$FILES)"
[ "$(git -C "$T/work/pass" rev-list --count HEAD)" = 2 ]; ok $? "一次通過的版本庫多了一筆提交"
git -C "$T/work/pass" status --porcelain | grep -q 'notes.txt'; ok $? "範圍外的 notes.txt 仍留在工作區(沒有被提交)"
# 其他情境沒有任何提交(節點不能自己 commit;commit 情境的那一筆是假節點違規做的)
for name in reject1 reject2 late stop blocked version session unreported ruling stuck; do
  [ "$(git -C "$T/work/$name" rev-list --count HEAD)" = 1 ]; ok $? "$name:流程沒有替使用者提交"
done
git -C "$T/work/commit" log -1 --format=%s | grep -q 'fake commit'; ok $? "commit 情境:假節點真的做了 commit(被偵測為違規)"

# runs/<id>/:run.json、回報的 json 與 md、遲到回報寫進 late/、副本用完就刪
P="$(runid pass)"
[ -n "$P" ] && [ -f "$RUNS/$P/run.json" ]; ok $? "run.json 存在($P)"
ls "$RUNS/$P/reports/"*.md >/dev/null 2>&1 && ls "$RUNS/$P/reports/"*.json >/dev/null 2>&1; ok $? "step_report 寫成 json 與 md"
grep -q '## 必修' "$RUNS/$P/reports/"*review*.md 2>/dev/null; ok $? "審查文件由主控台代寫(含必修段落)"
grep -q '"flow"' "$RUNS/$P/run.json" && grep -q '"implement-review"\|"e2e-flow"' "$RUNS/$P/run.json"; ok $? "run.json 保存啟動時解析好的流程定義"
ls "$RUNS/$P/logs/"*/check.log >/dev/null 2>&1; ok $? "核實指令的輸出寫進 logs/"
L="$(runid late)"
ls "$RUNS/$L/late/"*.json >/dev/null 2>&1; ok $? "遲到回報情境:回報寫進 late/"
S="$(runid stop)"
ls "$RUNS/$S/late/"*.json >/dev/null 2>&1; ok $? "停止情境:停止後的回報寫進 late/"
LEFT="$(find "$RUNS" -mindepth 3 -maxdepth 3 -path '*/copies/*' -type d -name '[rv]-*' 2>/dev/null | wc -l)"
[ "$LEFT" = 0 ]; ok $? "審查與核實副本用完都刪掉了(剩 $LEFT 個)"
[ ! -f "$T/claude/settings.json" ] || ! grep -q hooks "$T/claude/settings.json"; ok $? "沒有動到 Claude 設定檔"

echo "暫存資料夾:$T"
BAD=$(grep -cE '不符|失敗|等不到' "$OUT")
OKN=$(grep -cE '通過' "$OUT")
if [ "$BAD" = 0 ] && [ "$OKN" -gt 0 ] && grep -q '主控台端結束' "$OUT"; then echo "全部通過($OKN 項)"; else echo "有 $BAD 項不符"; fi
