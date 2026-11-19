#!/usr/bin/env bash
# 角色卡的驗收(假資料模式):執行 tests/persona-fake.e2e.js,並從外部用 HTTP 測試手機端的角色卡路由。
# 另外檢查長文字、含換行與引號的身分設定當成命令列參數傳給子行程時不會變形(Claude Code 的 --append-system-prompt 走這條路)。
# 用法:在 app 資料夾執行 bash tests/persona-fake.sh(先 npm run build)。資料全放在系統暫存區的新資料夾,不碰使用者的資料。
set -u
cd "$(dirname "$0")/.."
T="$(mktemp -d "${TMPDIR:-/tmp}/nexus-persona-XXXXXX")"
mkdir -p "$T/profile" "$T/cwd"
PORT=$((40000 + RANDOM % 20000))
LOG="$T/run.log"
echo "--- 暫存資料夾 $T,遠端連接埠 $PORT"

echo "--- 命令列參數跳脫"
node -e '
const { spawnSync } = require("node:child_process");
const persona = "你是「甲」。\n第二行 \"雙引號\" \x27單引號\x27 `反引號` \\反斜線\\ 結尾反斜線\\ $HOME %PATH% & | > < ^\n" + "長".repeat(8000) + " 結尾\\";
const r = spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "--", "--append-system-prompt", persona], { encoding: "utf8", windowsHide: true });
if (r.status !== 0) console.log("[test] FAIL 子行程沒有正常結束", r.stderr.slice(0, 300));
const got = JSON.parse(r.stdout || "[]");
console.log("[test]", got[1] === persona ? "PASS" : "FAIL", "子行程收到的參數與原文相同", "長度", persona.length, got[1]?.length);
'

export NEXUS_FAKE=1 NEXUS_FAKE_ECHO=1 NEXUS_NO_SEED=1 NEXUS_REMOTE_PORT=$PORT
export NEXUS_DATA_DIR="$(cygpath -w "$T/profile")" NEXUS_TEST_DIR="$(cygpath -w "$T")" NEXUS_TEST_SCRIPT="$(pwd -W)/tests/persona-fake.e2e.js" NEXUS_TEST_CWD="$(cygpath -w "$T/cwd")"
timeout 300 ./node_modules/electron/dist/electron.exe . > "$LOG" 2>&1 &
EP=$!

# 等主控台回報配對碼
CODE=""
for _ in $(seq 1 240); do
  CODE=$(grep -oE '^\[test\] CODE [A-Z0-9]+' "$LOG" | awk '{print $3}' | tail -1)
  [ -n "$CODE" ] && break
  kill -0 $EP 2>/dev/null || break
  sleep 0.5
done
if [ -n "$CODE" ]; then node tests/persona-remote.js "http://127.0.0.1:$PORT" "$CODE"; else echo "[remote] 沒有拿到配對碼"; fi
wait $EP
grep -E '^\[test\]|rror' "$LOG" | cut -c1-400
echo "--- 立繪資料夾"; ls -R "$T/profile/portraits" | head -20
echo "--- 立繪資料夾外不應出現 evil"; find "$T" -iname '*evil*' | head
ls "$T"/*.png 2>/dev/null
