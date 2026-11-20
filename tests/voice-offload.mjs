// 驗收:手動卸載與重新載入本機語音合成(tools/voice-server/server.py 的 /tts/unload、/tts/load)。
// 直接啟動語音服務(不經過主控台),檢查的是效果:卸載後 PyTorch 佔用的顯示卡記憶體真的下降、合成被拒絕、
// 語音辨識照常;重新載入後又能合成出聲音。
// 需要:照 tools/voice-server/README.md 裝好 CosyVoice。
// 用法:node tests/voice-offload.mjs [放 venv 與 CosyVoice 的資料夾,預設 %LOCALAPPDATA%\entropy-nexus-tts]
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = process.argv[2] || join(process.env.LOCALAPPDATA ?? '', 'entropy-nexus-tts');
const PY = join(ROOT, 'venv', 'Scripts', 'python.exe');
const SERVER = resolve(import.meta.dirname, '..', 'tools', 'voice-server', 'server.py');
const LOAD_MS = 10 * 60000;

let bad = 0;
const ok = (cond, what, extra = '') => { if (!cond) bad++; console.log(`[test] ${cond ? '通過' : '不符'} ${what}${extra === '' ? '' : ` → ${extra}`}`); };
const wait = ms => new Promise(r => setTimeout(r, ms));
const port = await new Promise(r => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const token = randomBytes(16).toString('hex');
const H = { Authorization: `Bearer ${token}` };
const url = p => `http://127.0.0.1:${port}${p}`;
const health = async () => (await fetch(url('/health'), { headers: H, signal: AbortSignal.timeout(5000) })).json();
const until = async (what, fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = await fn(); if (v) return v; } catch { /* 服務還沒開始聆聽 */ } await wait(1000); } throw new Error(`等不到:${what}`); };

// 參考錄音:Windows 內建語音念一句
const dir = mkdtempSync(join(tmpdir(), 'nexus-offload-'));
const ref = join(dir, 'voice.wav');
spawnSync('powershell', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'zh-*' } | Select-Object -First 1; if ($v) { $s.SelectVoice($v.VoiceInfo.Name) }; $f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono); $s.SetOutputToWaveFile('${ref}', $f); $s.Speak('今天天氣很好,我們一起出去走走吧。'); $s.Dispose()`]);

const child = spawn(PY, [SERVER], {
  env: { ...process.env, NEXUS_VOICE_PORT: String(port), NEXUS_VOICE_TOKEN: token, NEXUS_VOICE_PARENT_PID: String(process.pid), NEXUS_VOICE_TTS_DIR: join(ROOT, 'CosyVoice'), PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
  windowsHide: true,
});
const logs = [];
child.stdout.on('data', d => logs.push(String(d)));
child.stderr.on('data', d => logs.push(String(d)));

const synth = () => fetch(url('/tts'), { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '測試完成了。', wav: ref, promptText: '今天天氣很好,我們一起出去走走吧。' }), signal: AbortSignal.timeout(120000) });

try {
  const h0 = await until('語音辨識與語音合成都載入', async () => { const h = await health(); return h.status === 'ready' && h.tts?.status === 'ready' ? h : h.tts?.status === 'error' ? Promise.reject(new Error(h.tts.error)) : null; }, LOAD_MS);
  const before = h0.tts.vramMB;
  console.log(`[test] 載入後顯示卡記憶體 ${before} MB`);
  let r = await synth();
  const wav1 = r.ok ? (await r.arrayBuffer()).byteLength : 0;
  ok(wav1 > 44, '卸載前可以合成', `${r.status} ${wav1} bytes`);

  r = await fetch(url('/tts/unload'), { method: 'POST', headers: H, signal: AbortSignal.timeout(60000) });
  const un = (await r.json()).tts;
  ok(un.status === 'unloaded', '卸載後狀態是 unloaded', JSON.stringify(un));
  ok(before > 500 && un.vramMB < before / 4, '卸載後顯示卡記憶體真的釋放', `${before} MB → ${un.vramMB} MB`);
  r = await synth();
  ok(r.status === 503 && /卸載/.test((await r.json()).error ?? ''), '卸載後合成被拒絕(503,說明已卸載)', r.status);
  ok((await health()).status === 'ready', '卸載語音合成不影響語音辨識');
  r = await fetch(url('/tts/unload'), { method: 'POST', headers: H });
  ok(r.ok && (await r.json()).tts.status === 'unloaded', '重複卸載不會出錯');

  r = await fetch(url('/tts/load'), { method: 'POST', headers: H });
  ok(r.ok && (await r.json()).tts.status === 'warming_up', '重新載入:狀態變成載入中');
  const h2 = await until('重新載入完成', async () => { const h = await health(); return h.tts?.status === 'ready' ? h : null; }, LOAD_MS);
  ok(h2.tts.vramMB > before / 2, '重新載入後顯示卡記憶體回來了', `${h2.tts.vramMB} MB`);
  r = await synth();
  const wav2 = r.ok ? (await r.arrayBuffer()).byteLength : 0;
  ok(wav2 > 44, '重新載入後又能合成', `${r.status} ${wav2} bytes`);
} catch (err) {
  bad++;
  console.log('[test] 失敗', err.message);
  console.log(logs.join('').split(/\r?\n/).slice(-15).join('\n'));
} finally {
  if (child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
}
console.log(bad ? `有 ${bad} 項不符` : '全部通過');
process.exit(bad ? 1 : 0);
