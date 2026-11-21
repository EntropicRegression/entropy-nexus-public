#!/usr/bin/env bash
# 語音播報的引擎層驗收(假資料模式,不需要語音服務):角色資料夾 clips/ 的固定語音真的被播放、
# 沒有角色的節點用系統語音、關掉固定語音後改用系統語音、設定會保存。會從喇叭播出一段短音。
# 用法:先 npm run build,再在 app 資料夾執行 bash tests/speech-clips.sh。
set -u
cd "$(dirname "$0")/.."
node --no-warnings tests/speech-clips.test.mjs | tail -1
T="$(cygpath -u "$TEMP")/nexus-clips-$$-$RANDOM"
C="$T/profile/portraits/ClipVoice/clips"
mkdir -p "$T/shots" "$C" "$T/work"
# 產生 0.6 秒的 16-bit 單聲道 WAV(440 Hz 短音)當固定語音
node -e '
const rate = 16000, n = Math.round(rate * 0.6), b = Buffer.alloc(44 + n * 2);
b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8); b.write("fmt ", 12); b.writeUInt32LE(16, 16);
b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
b.write("data", 36); b.writeUInt32LE(n * 2, 40);
for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 6000), 44 + i * 2);
for (const f of process.argv.slice(1)) require("fs").writeFileSync(f, b);
' "$(cygpath -w "$C/done.wav")" "$(cygpath -w "$C/done-2.wav")" "$(cygpath -w "$C/failed.wav")"
PORT=$((40000 + RANDOM % 9000))
LOG="$T/run.log"
export NEXUS_FAKE=1 NEXUS_FAKE_NO_ERRORS=1 NEXUS_NO_SEED=1 NEXUS_REMOTE_PORT=$PORT NEXUS_HOOKS_PORT=$((PORT + 1)) NEXUS_INTEROP_PORT=$((PORT + 2)) \
  NEXUS_DATA_DIR="$(cygpath -w "$T/profile")" NEXUS_TEST_DIR="$(cygpath -w "$T/shots")" NEXUS_TEST_SCRIPT="$(pwd -W)/tests/speech-clips.e2e.js" NEXUS_TEST_CWD="$(cygpath -w "$T/work")"
for v in $(env | grep -oE '^(CLAUDE|ANTHROPIC)[A-Z_0-9]*'); do unset "$v"; done
timeout 180 ./node_modules/electron/dist/electron.exe . > "$LOG" 2>&1
grep -E '^\[test\]' "$LOG" | cut -c1-400 | tee "$T/result.txt"
BAD=$(grep -cE '不符|失敗|等不到' "$T/result.txt")
OK=$(grep -cE '通過' "$T/result.txt")
if [ "$BAD" = 0 ] && [ "$OK" -gt 0 ] && grep -q '主控台端結束' "$T/result.txt"; then echo "全部通過($OK 項)"; else echo "有 $BAD 項不符"; fi
