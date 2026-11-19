#!/usr/bin/env bash
# 語音模式(Phase 1)的驗收:用 Windows 內建語音合成產生一段中文 WAV,假資料模式啟動主控台(tests/voice.e2e.js),
# 讓它啟動真正的語音服務(tools/voice-server/server.py)辨識這段語音;主控台結束後檢查語音服務有沒有一起結束。
# 需要:Python 與 faster-whisper。不消耗任何 CLI 額度,但第一次會下載模型(除非用 NEXUS_VOICE_MODEL 指定已有的模型)。
# 用法:先 npm run build,再在 app 資料夾執行 bash tests/voice.sh。可用 NEXUS_VOICE_MODEL 指定模型(例如 large-v3)。
set -u
cd "$(dirname "$0")/.."
T="$(cygpath -u "$TEMP")/nexus-voice-$$-$RANDOM"
mkdir -p "$T/shots" "$T/profile" "$T/work"
PORT=$((40000 + RANDOM % 9000))
LOG="$T/run.log"
WAV="$(cygpath -w "$T/zh.wav")"
powershell -NoProfile -Command "Add-Type -AssemblyName System.Speech; \$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; \$v = \$s.GetInstalledVoices() | Where-Object { \$_.VoiceInfo.Culture.Name -like 'zh-*' } | Select-Object -First 1; if (\$v) { \$s.SelectVoice(\$v.VoiceInfo.Name) }; \$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono); \$s.SetOutputToWaveFile('$WAV', \$f); \$s.Speak('請幫我檢查一下主控台的會議功能,然後把結果告訴我。'); \$s.Dispose()"
SERVER="$(pwd -W)/tools/voice-server/server.py"
{
  printf 'const VOICE_CMD = %s;\n' "$(node -e 'console.log(JSON.stringify(process.argv[1]))' "python -I \"$SERVER\"")"
  printf 'const WAV_B64 = "%s";\n' "$(base64 -w0 "$T/zh.wav")"
  cat tests/voice.e2e.js
} > "$T/voice-test.js"
export NEXUS_FAKE=1 NEXUS_NO_SEED=1 NEXUS_REMOTE_PORT=$PORT NEXUS_HOOKS_PORT=$((PORT + 1)) NEXUS_INTEROP_PORT=$((PORT + 2)) \
  NEXUS_DATA_DIR="$(cygpath -w "$T/profile")" NEXUS_TEST_DIR="$(cygpath -w "$T/shots")" NEXUS_TEST_SCRIPT="$(cygpath -w "$T/voice-test.js")" NEXUS_TEST_CWD="$(cygpath -w "$T/work")"
# 已經在執行的語音服務(例如正在用的主控台開的)不算
voice_pids() { powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { \$_.CommandLine -like '*voice-server*server.py*' -and \$_.Name -like 'python*' } | ForEach-Object { \$_.ProcessId }" | tr -d '\r' | sort; }
BEFORE=$(voice_pids)
timeout 400 ./node_modules/electron/dist/electron.exe . > "$LOG" 2>&1
sleep 2
LEFT=$(comm -13 <(echo "$BEFORE") <(voice_pids) | grep -c .)
OUT="$T/result.txt"
grep -E '^\[test\]' "$LOG" | cut -c1-400 | tee "$OUT"
if [ "$LEFT" = 0 ]; then echo "[test] 通過 主控台結束後語音服務也結束了" | tee -a "$OUT"; else echo "[test] 不符 主控台結束後還有 $LEFT 個語音服務行程" | tee -a "$OUT"; fi
BAD=$(grep -cE '不符|失敗' "$OUT")
OK=$(grep -cE '通過' "$OUT")
if [ "$BAD" = 0 ] && [ "$OK" -gt 0 ] && grep -q '主控台端結束' "$OUT"; then echo "全部通過($OK 項)"; else echo "有 $BAD 項不符"; fi
