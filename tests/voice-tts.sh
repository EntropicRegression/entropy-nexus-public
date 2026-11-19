#!/usr/bin/env bash
# 語音模式 Phase 3(節點自己的聲音)的驗收:假資料模式啟動主控台(tests/voice-tts.e2e.js),
# 用 CosyVoice 的虛擬環境啟動語音服務,檢查合成語音的播報與退回系統語音。不消耗 CLI 額度;朗讀會真的從喇叭念出來。
# 需要:照 tools/voice-server/README.md 裝好 CosyVoice。
# 用法:先 npm run build,再執行 NEXUS_TTS_ROOT=<放 venv 與 CosyVoice 的資料夾> bash tests/voice-tts.sh
#       (預設 %LOCALAPPDATA%\entropy-nexus-tts)。可用 NEXUS_VOICE_MODEL 指定語音辨識模型(例如 large-v3)。
set -u
cd "$(dirname "$0")/.."
ROOT="${NEXUS_TTS_ROOT:-$(cygpath -u "$LOCALAPPDATA")/entropy-nexus-tts}"
T="$(cygpath -u "$TEMP")/nexus-tts-$$-$RANDOM"
mkdir -p "$T/shots" "$T/profile/portraits/TestVoice" "$T/work"
PORT=$((40000 + RANDOM % 9000))
LOG="$T/run.log"
OUT="$T/result.txt"
# 測試用的參考錄音:Windows 內建語音念一句(授權沒有問題)
REFW="$(cygpath -w "$T/profile/portraits/TestVoice/voice.wav")"
powershell -NoProfile -Command "Add-Type -AssemblyName System.Speech; \$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; \$v = \$s.GetInstalledVoices() | Where-Object { \$_.VoiceInfo.Culture.Name -like 'zh-*' } | Select-Object -First 1; if (\$v) { \$s.SelectVoice(\$v.VoiceInfo.Name) }; \$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono); \$s.SetOutputToWaveFile('$REFW', \$f); \$s.Speak('今天天氣很好,我們一起出去走走吧。'); \$s.Dispose()"
PY="$(cygpath -w "$ROOT/venv/Scripts/python.exe")"
SERVER="$(pwd -W)/tools/voice-server/server.py"
{
  printf 'const VOICE_CMD = %s;\n' "$(node -e 'console.log(JSON.stringify(process.argv[1]))' "\"$PY\" \"$SERVER\"")"
  printf 'const TTS_DIR = %s;\n' "$(node -e 'console.log(JSON.stringify(process.argv[1]))' "$(cygpath -w "$ROOT/CosyVoice")")"
  cat tests/voice-tts.e2e.js
} > "$T/voice-tts.js"
export NEXUS_FAKE=1 NEXUS_FAKE_NO_ERRORS=1 NEXUS_NO_SEED=1 NEXUS_REMOTE_PORT=$PORT NEXUS_HOOKS_PORT=$((PORT + 1)) NEXUS_INTEROP_PORT=$((PORT + 2)) \
  NEXUS_DATA_DIR="$(cygpath -w "$T/profile")" NEXUS_TEST_DIR="$(cygpath -w "$T/shots")" NEXUS_TEST_SCRIPT="$(cygpath -w "$T/voice-tts.js")" NEXUS_TEST_CWD="$(cygpath -w "$T/work")"
timeout 500 ./node_modules/electron/dist/electron.exe . > "$LOG" 2>&1
grep -E '^\[test\]' "$LOG" | cut -c1-400 | tee "$OUT"
BAD=$(grep -cE '不符|失敗' "$OUT")
OK=$(grep -cE '通過' "$OUT")
if [ "$BAD" = 0 ] && [ "$OK" -gt 0 ] && grep -q '主控台端結束' "$OUT"; then echo "全部通過($OK 項)"; else echo "有 $BAD 項不符"; fi
