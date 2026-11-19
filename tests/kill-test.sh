#!/usr/bin/env bash
# 強制關閉測試:啟動主控台與三家節點,強制結束主控台,檢查殘留的 CLI 子行程。
# 用法:在 app 資料夾執行 bash tests/kill-test.sh
set -u
cd "$(dirname "$0")/.."
D=.test-data/p5kill
rm -rf "$D" && mkdir -p "$D/工作區 ws"
for v in $(env | grep -oE '^(CLAUDE|ANTHROPIC)[A-Z_0-9]*'); do unset "$v"; done
export ANTHROPIC_MODEL=haiku NEXUS_AGY_MODEL=gemini-3.8-flash-low NEXUS_NO_SEED=1
export NEXUS_DATA_DIR="$(pwd -W)/$D/profile" NEXUS_TEST_DIR="$(pwd -W)/$D" NEXUS_TEST_SCRIPT="$(pwd -W)/tests/phase5-kill.e2e.js"
export NEXUS_TEST_CWD="$(cygpath -w "$(pwd)/$D/工作區 ws")"

leftovers() {
  powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='claude.exe' OR Name='codex.exe' OR Name='agy.exe'\" | Where-Object { \$_.CommandLine -match '--permission-prompt-tool stdio --permission-mode|--input-format stream-json --output-format stream-json' -or (\$_.Name -eq 'codex.exe' -and \$_.CommandLine -match 'app-server\$' ) } | ForEach-Object { '{0} pid={1}' -f \$_.Name, \$_.ProcessId }"
}

./node_modules/electron/dist/electron.exe . > "$D/out.log" 2>&1 &
for i in $(seq 1 120); do grep -q "READY\|失敗" "$D/out.log" && break; sleep 1; done
grep "^\[test\]" "$D/out.log"
echo "--- 強制結束前的 CLI 子行程"; leftovers
echo "--- 強制結束主控台(不含子行程)"
taskkill //F //IM electron.exe > /dev/null 2>&1
sleep "${1:-6}"
echo "--- 強制結束 ${1:-6} 秒後仍在的 CLI 子行程"; leftovers
echo "--- 結束"
