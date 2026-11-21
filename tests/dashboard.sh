#!/usr/bin/env bash
# 總覽儀表的驗收(假資料模式):額度條、狀態數字與點下去選到的節點、花費、任務統計、每日預算的提醒、
# 週額度重置、外部觀察節點(tests/dashboard.e2e.js),以及遠端裝置依權限看到的資料(tests/dashboard-remote.mjs)。
# 用法:先 npm run build,再在 app 資料夾執行 bash tests/dashboard.sh。不碰正式資料與 ~/.claude,也不消耗額度。
# 開了朗讀的那一段會用系統語音念一句「超過每日預算」。
set -u
cd "$(dirname "$0")/.."
node --no-warnings tests/dashboard.test.mjs | tail -1
T="$(cygpath -u "$TEMP")/nexus-dash-$$-$RANDOM"
mkdir -p "$T/shots" "$T/profile" "$T/work" "$T/claude"
echo '{}' > "$T/claude/settings.json"
PORT=$((40000 + RANDOM % 9000))
LOG="$T/run.log"
export NEXUS_FAKE=1 NEXUS_FAKE_NO_ERRORS=1 NEXUS_NO_SEED=1 NEXUS_FAULT_WARN_MS=3000 NEXUS_REMOTE_PORT=$PORT NEXUS_HOOKS_PORT=$((PORT + 1)) NEXUS_INTEROP_PORT=$((PORT + 2)) \
  NEXUS_CLAUDE_SETTINGS="$(cygpath -w "$T/claude/settings.json")" \
  NEXUS_DATA_DIR="$(cygpath -w "$T/profile")" NEXUS_TEST_DIR="$(cygpath -w "$T/shots")" NEXUS_TEST_SCRIPT="$(pwd -W)/tests/dashboard.e2e.js" NEXUS_TEST_CWD="$(cygpath -w "$T/work")"
for v in $(env | grep -oE '^(CLAUDE|ANTHROPIC)[A-Z_0-9]*'); do unset "$v"; done
timeout 300 ./node_modules/electron/dist/electron.exe . > "$LOG" 2>&1 &
APP=$!
for _ in $(seq 1 400); do grep -q '\[test\] PAIR' "$LOG" && break; kill -0 $APP 2>/dev/null || break; sleep 0.5; done
set -- $(grep -o '\[test\] PAIR .*' "$LOG" | head -1)
if [ $# -ge 6 ]; then
  node --no-warnings tests/dashboard-remote.mjs "$5" "$3" "$4" "$6" "$((PORT + 1))" "$(cygpath -w "$T/claude/settings.json")" "$(cygpath -w "$T/work")" 2>&1 | cut -c1-400 | tee "$T/remote.txt"
else
  echo "[remote] 不符 主控台沒有印出配對碼" | tee "$T/remote.txt"
fi
wait $APP
grep -E '^\[test\]' "$LOG" | grep -v 'PAIR' | cut -c1-400 | tee "$T/result.txt"
cat "$T/remote.txt" >> "$T/result.txt"
echo "截圖位置:$(cygpath -w "$T/shots")"
BAD=$(grep -cE '不符|失敗|等不到' "$T/result.txt")
OK=$(grep -cE '通過' "$T/result.txt")
if [ "$BAD" = 0 ] && [ "$OK" -gt 0 ] && grep -q '主控台端結束' "$T/result.txt" && grep -q '遠端檢查全部通過' "$T/result.txt"; then echo "全部通過($OK 項)"; else echo "有 $BAD 項不符"; fi
