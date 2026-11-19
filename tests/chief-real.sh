#!/usr/bin/env bash
# 總管候選模型的比較測試:用真正的 CLI(會用到額度)在獨立的測試主控台裡跑 tests/chief-real.e2e.js,
# 結果整理成 Markdown 報告(暫存資料夾)。不碰正式資料。
# 用法:先 npm run build,再在 app 資料夾執行 bash tests/chief-real.sh。約需 30 到 60 分鐘。
set -u
cd "$(dirname "$0")/.."
T="$(cygpath -u "$TEMP")/nexus-chief-real-$$-$RANDOM"
mkdir -p "$T/shots" "$T/profile" "$T/work"
PORT=$((40000 + RANDOM % 9000))
LOG="$T/run.log"
export NEXUS_NO_SEED=1 NEXUS_REMOTE_PORT=$PORT NEXUS_HOOKS_PORT=$((PORT + 1)) NEXUS_INTEROP_PORT=$((PORT + 2)) \
  NEXUS_DATA_DIR="$(cygpath -w "$T/profile")" NEXUS_TEST_DIR="$(cygpath -w "$T/shots")" NEXUS_TEST_SCRIPT="$(pwd -W)/tests/chief-real.e2e.js" NEXUS_TEST_CWD="$(cygpath -w "$T/work")"
timeout 4500 ./node_modules/electron/dist/electron.exe . > "$LOG" 2>&1
grep -E '^\[test\]' "$LOG" | cut -c1-300
node -e '
const fs = require("fs");
const rows = fs.readFileSync(process.argv[1], "utf8").split(/\r?\n/).filter(l => l.startsWith("[test] [result] ")).map(l => JSON.parse(l.slice(16)));
const out = ["# 總管候選模型比較", ""];
for (const r of rows) {
  if (r.error) { out.push(`## ${r.candidate}`, "", `**錯誤**:${r.error}`, ""); continue; }
  out.push(`## ${r.candidate} · ${r.prompt}`, "", `- 指令:${r.text}`, `- 期望:${r.expect}`, `- 結束狀態:${r.state},耗時 ${Math.round(r.ms / 1000)} 秒,第一則回覆 ${r.firstReplyMs ? Math.round(r.firstReplyMs / 1000) + " 秒" : "無"}`,
    `- 工具:${r.tools.join(" / ") || "(無)"}`, `- 授權:${r.approvals.join(" / ") || "(無)"}`,
    `- 交給:${r.dispatched.map(d => d.to).join("、") || "(沒有分派)"}`, "", ...r.dispatched.map(d => `> 交辦給 ${d.to}:${d.prompt.replace(/\n/g, " ")}`), "", "回覆:", "", "```text", r.reply, "```", "");
}
fs.writeFileSync(process.argv[2], out.join("\n"));
console.log(`報告:${process.argv[2]}(${rows.length} 筆)`);
' "$LOG" "$(cygpath -w "$T/report.md")"
