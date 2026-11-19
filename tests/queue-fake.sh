#!/usr/bin/env bash
# 指令排隊佇列的驗收(假資料模式):同一個資料夾啟動兩次,第二次檢查重開後的佇列,並從外部用 HTTP 測手機版的排隊與取消。
# 用法:在 app 資料夾執行 bash tests/queue-fake.sh(先 npm run build)。資料放在系統暫存區的新資料夾,不碰真正的設定。
set -u
cd "$(dirname "$0")/.."
D="$(mktemp -d "${TMPDIR:-/tmp}/nexus-queue-XXXXXX")"
mkdir -p "$D/profile" "$D/work"
PORT=$((20000 + RANDOM % 20000))
export NEXUS_FAKE=1 NEXUS_NO_SEED=1 NEXUS_REMOTE_PORT=$PORT
export NEXUS_DATA_DIR="$(cygpath -w "$D/profile")" NEXUS_TEST_DIR="$(cygpath -w "$D")" NEXUS_TEST_SCRIPT="$(pwd -W)/tests/queue-fake.e2e.js" NEXUS_TEST_CWD="$(cygpath -w "$D/work")"
echo "--- 資料夾 $D"
echo "--- 第一次啟動"
timeout 400 ./node_modules/electron/dist/electron.exe . 2>&1 | grep -E "^\[test\]|rror" | cut -c1-400
echo "--- 第二次啟動(重開後,並測手機版)"
LOG="$D/run2.log"
timeout 300 ./node_modules/electron/dist/electron.exe . > "$LOG" 2>&1 &
PID=$!
for _ in $(seq 1 120); do grep -q '^\[test\] CODE' "$LOG" && break; kill -0 $PID 2>/dev/null || break; sleep 1; done
read -r CODE BID < <(grep -m1 '^\[test\] CODE' "$LOG" | awk '{print $3, $4}')
if [ -n "${CODE:-}" ]; then
  U="http://127.0.0.1:$PORT"
  j() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const v=JSON.parse(s);console.log($1)})"; }
  TOKEN=$(printf '{"code":"%s","name":"queue-test"}' "$CODE" | curl -s -X POST "$U/pair" -H 'Content-Type: application/json' --data-binary @- | j 'v.token')
  H="Authorization: Bearer $TOKEN"
  # 內容從標準輸入傳給 curl,中文才不會在 Windows 的命令列參數轉換中變成亂碼
  post() { printf '%s' "$2" | curl -s -o /dev/null -w '%{http_code}' -X POST "$U$1" -H "$H" -H 'Content-Type: application/json' --data-binary @-; }
  state() { curl -s "$U/api/state" -H "$H"; }
  echo "[phone] 頁面含排隊功能:$(curl -s "$U/" | grep -c "api/enqueue")"
  echo "[phone] 未配對排隊:$(curl -s -o /dev/null -w '%{http_code}' -X POST "$U/api/enqueue" -H 'Content-Type: application/json' -d "{\"id\":\"$BID\",\"text\":\"x\"}")"
  echo "[phone] 送出:$(post /api/send "{\"id\":\"$BID\",\"text\":\"請提問\"}")"
  for _ in $(seq 1 40); do [ "$(state | j "v.agents.find(a=>a.id==='$BID').state")" = awaiting ] && break; sleep 0.5; done
  echo "[phone] 忙碌時排隊:$(post /api/enqueue "{\"id\":\"$BID\",\"text\":\"程式碼 手機排隊一\"}") $(post /api/enqueue "{\"id\":\"$BID\",\"text\":\"手機排隊取消\"}") 空內容=$(post /api/enqueue "{\"id\":\"$BID\",\"text\":\" \"}")"
  echo "[phone] 排隊中:$(state | j "JSON.stringify(v.agents.find(a=>a.id==='$BID').queued.map(q=>q.text))")"
  QID=$(state | j "v.agents.find(a=>a.id==='$BID').queued[1].id")
  echo "[phone] 取消:$(post /api/cancelqueued "{\"id\":\"$BID\",\"queuedId\":\"$QID\"}")"
  echo "[phone] 取消後:$(state | j "JSON.stringify(v.agents.find(a=>a.id==='$BID').queued.map(q=>q.text))")"
  RID=$(state | j "v.agents.find(a=>a.id==='$BID').pendingQuestion.requestId")
  echo "[phone] 回答:$(post /api/answer "{\"id\":\"$BID\",\"requestId\":\"$RID\",\"answers\":{\"q1\":[\"藍色\"]}}")"
else
  echo "[phone] 沒有拿到配對碼"
fi
wait $PID
grep -E "^\[test\]|rror" "$LOG" | cut -c1-400
ls "$D"/*.png 2>/dev/null
