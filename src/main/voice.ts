import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { app } from 'electron';
import type { VoiceStatus, VoiceTranscript } from '../shared/types';
import type { Store } from './store';
import { listCharacters, voiceOf } from './portraits';

/**
 * 語音模式(實驗性,Phase 1):主控台啟動並看管本機的語音服務(tools/voice-server/server.py),
 * 畫面錄好的 WAV 經這裡轉給它辨識。
 *
 * 安全:
 * - 服務只聽 127.0.0.1;每次啟動換一個空的連接埠與一組亂數權杖,用環境變數交給服務,請求一律帶 Bearer 權杖。
 * - 這組函式只註冊給桌面畫面的 IPC,不在遠端的方法表裡,手機與瀏覽器版都呼叫不到。
 * - 服務收到 NEXUS_VOICE_PARENT_PID,主控台不在了(包括被強制關閉)就自己結束,不會留著佔用顯示卡記憶體。
 *   主控台正常結束時用 taskkill /T 把啟動指令開出的整個行程樹一起結束。
 */
interface Settings { enabled: boolean; command: string; model: string; ttsDir: string; ttsModel: string }

const LOG_LINES = 40;
const MAX_WAV = 4 * 1024 * 1024;

let store: Store;
let onStatus: (s: VoiceStatus) => void = () => {};
let hint: () => string = () => '';
let settings: Settings = { enabled: false, command: '', model: '', ttsDir: '', ttsModel: '' };
let tts: VoiceStatus['tts'] = { state: 'off', detail: '' };
/** 節點 id → 這個節點的角色(查參考錄音用)。 */
let characterOf: (agentId: string) => string | null = () => null;
let child: ChildProcess | null = null;
let port = 0;
let token = '';
let state: VoiceStatus['state'] = 'off';
let detail = '';
let device = '';
let log: string[] = [];
let timer: NodeJS.Timeout | null = null;
/** 每次啟動加一;舊行程的事件與輪詢結果一律略過。 */
let generation = 0;

/** 開發模式在專案的 tools/voice-server;打包版由 electron-builder 的 extraResources 放在 resources/voice-server。 */
function defaultCommand(): string {
  const candidates = [join(app.getAppPath(), 'tools', 'voice-server', 'server.py'), join(process.resourcesPath ?? '', 'voice-server', 'server.py')];
  const script = candidates.find(p => existsSync(p));
  return script ? `python "${script}"` : '';
}

export function voiceStatus(): VoiceStatus {
  return { ...settings, defaultCommand: defaultCommand(), state, detail, device, log: [...log], tts: { ...tts } };
}

function update(next: Partial<{ state: VoiceStatus['state']; detail: string; device: string }>): void {
  if (next.state !== undefined) state = next.state;
  if (next.detail !== undefined) detail = next.detail;
  if (next.device !== undefined) device = next.device;
  onStatus(voiceStatus());
}

function addLog(chunk: string): void {
  for (const line of chunk.split(/\r?\n/)) if (line.trim()) log.push(line.slice(0, 500));
  if (log.length > LOG_LINES) log = log.slice(-LOG_LINES);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

/** prompt:辨識時附上的提示詞(節點名稱),幫助辨識專有名詞。 */
export function initVoice(s: Store, status: (st: VoiceStatus) => void, prompt: () => string, character: (agentId: string) => string | null = () => null): void {
  store = s;
  onStatus = status;
  hint = prompt;
  characterOf = character;
  try {
    const saved = JSON.parse(s.getSetting('voice') ?? '{}');
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    settings = { enabled: saved.enabled === true, command: str(saved.command), model: str(saved.model), ttsDir: str(saved.ttsDir), ttsModel: str(saved.ttsModel) };
  } catch { /* 設定壞了就用預設值 */ }
  if (settings.enabled) void start();
}

async function start(): Promise<void> {
  if (child) return;
  const gen = ++generation;
  const cmd = settings.command.trim() || defaultCommand();
  log = [];
  device = '';
  tts = { state: settings.ttsDir.trim() ? 'warming' : 'off', detail: '' };
  if (!cmd) { update({ state: 'error', detail: '找不到語音服務。請在設定裡填入啟動指令,例如 python "C:\\路徑\\tools\\voice-server\\server.py"。' }); return; }
  update({ state: 'starting', detail: '' });
  try { port = await freePort(); } catch (err) { update({ state: 'error', detail: `找不到可用的連接埠:${(err as Error).message}` }); return; }
  if (gen !== generation) return;
  token = randomBytes(32).toString('hex');
  addLog(`> ${cmd}`);
  const proc = spawn(cmd, {
    shell: true,
    windowsHide: true,
    env: {
      ...process.env,
      NEXUS_VOICE_PORT: String(port),
      NEXUS_VOICE_TOKEN: token,
      NEXUS_VOICE_PARENT_PID: String(process.pid),
      ...(settings.model.trim() ? { NEXUS_VOICE_MODEL: settings.model.trim() } : {}),
      ...(settings.ttsDir.trim() ? { NEXUS_VOICE_TTS_DIR: settings.ttsDir.trim() } : {}),
      ...(settings.ttsModel.trim() ? { NEXUS_VOICE_TTS_MODEL: settings.ttsModel.trim() } : {}),
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
    },
  });
  child = proc;
  proc.stdout?.setEncoding('utf8');
  proc.stderr?.setEncoding('utf8');
  proc.stdout?.on('data', (d: string) => { if (gen === generation) { addLog(d); onStatus(voiceStatus()); } });
  proc.stderr?.on('data', (d: string) => { if (gen === generation) { addLog(d); onStatus(voiceStatus()); } });
  proc.on('error', err => { if (gen === generation) update({ state: 'error', detail: `無法啟動語音服務:${err.message}` }); });
  proc.on('exit', code => {
    if (child === proc) child = null;
    if (gen !== generation) return;
    stopPolling();
    const last = [...log].reverse().find(l => !l.startsWith('>')) ?? '';
    update({ state: 'error', detail: `語音服務已結束(代碼 ${code ?? '?'})${last ? `:${last}` : ''}` });
  });
  poll(gen);
}

function stopPolling(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}

/** 模型載入中每秒查一次,可以用之後每 15 秒確認一次。 */
function poll(gen: number): void {
  stopPolling();
  timer = setTimeout(async () => {
    if (gen !== generation || !child) return;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) });
      const h = await r.json() as { status?: string; error?: string; device?: string; tts?: { status?: string; error?: string } };
      if (gen !== generation) return;
      const t: VoiceStatus['tts'] = !h.tts || h.tts.status === 'off' ? { state: 'off', detail: '' } : h.tts.status === 'ready' ? { state: 'ready', detail: '' } : h.tts.status === 'error' ? { state: 'error', detail: h.tts.error ?? '' } : { state: 'warming', detail: '載入中' };
      if (t.state !== tts.state || t.detail !== tts.detail) { tts = t; onStatus(voiceStatus()); }
      if (h.status === 'ready') { if (state !== 'ready') update({ state: 'ready', detail: '', device: h.device ?? '' }); }
      else if (h.status === 'error') { update({ state: 'error', detail: h.error || '模型載入失敗' }); return; }
      else if (state !== 'warming') update({ state: 'warming', detail: '模型載入中' });
    } catch {
      // 服務還沒開始聆聽;已經可以用的服務查不到才算異常
      if (gen === generation && state === 'ready') update({ state: 'error', detail: '語音服務沒有回應' });
    }
    if (gen === generation && child) poll(gen);
  }, state === 'ready' && tts.state !== 'warming' ? 15000 : 1000);
}

/** 結束語音服務(連同啟動指令開出的整個行程樹)。 */
export function stopVoice(): Promise<void> {
  generation++;
  stopPolling();
  const proc = child;
  child = null;
  if (!proc || proc.exitCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    const done = setTimeout(resolve, 3000);
    proc.once('exit', () => { clearTimeout(done); resolve(); });
    if (process.platform === 'win32' && proc.pid) execFile('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
    else proc.kill();
  });
}

export async function voiceSet(patch: { enabled?: boolean; command?: string; model?: string; ttsDir?: string; ttsModel?: string; restart?: boolean }): Promise<VoiceStatus> {
  const before = { ...settings };
  if (typeof patch.enabled === 'boolean') settings.enabled = patch.enabled;
  if (typeof patch.command === 'string') settings.command = patch.command.slice(0, 2000);
  if (typeof patch.model === 'string') settings.model = patch.model.slice(0, 300);
  if (typeof patch.ttsDir === 'string') settings.ttsDir = patch.ttsDir.slice(0, 1000);
  if (typeof patch.ttsModel === 'string') settings.ttsModel = patch.ttsModel.slice(0, 1000);
  store.setSetting('voice', JSON.stringify(settings));
  const changed = before.command !== settings.command || before.model !== settings.model || before.ttsDir !== settings.ttsDir || before.ttsModel !== settings.ttsModel;
  if (!settings.enabled) {
    await stopVoice();
    log = [];
    tts = { state: 'off', detail: '' };
    update({ state: 'off', detail: '', device: '' });
  } else if (!before.enabled || changed || patch.restart || !child) {
    await stopVoice();
    await start();
  } else onStatus(voiceStatus());
  return voiceStatus();
}

export async function voiceTranscribe(wav: ArrayBuffer): Promise<VoiceTranscript> {
  if (state !== 'ready' || !child) throw new Error(state === 'warming' ? '模型還在載入,請稍候' : '語音服務沒有在執行');
  if (!(wav instanceof ArrayBuffer) || wav.byteLength <= 44) throw new Error('錄音太短');
  if (wav.byteLength > MAX_WAV) throw new Error('錄音太長');
  const r = await fetch(`http://127.0.0.1:${port}/transcribe`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'audio/wav', 'X-Voice-Prompt': encodeURIComponent(hint().slice(0, 300)) },
    body: Buffer.from(wav),
    signal: AbortSignal.timeout(60000),
  });
  const body = await r.json().catch(() => ({})) as { text?: string; audioMs?: number; durationMs?: number; error?: string };
  if (!r.ok) throw new Error(body.error || `語音服務回應錯誤(${r.status})`);
  return { text: String(body.text ?? ''), audioMs: Number(body.audioMs ?? 0), durationMs: Number(body.durationMs ?? 0) };
}

/** 用角色的參考錄音合成一段話;沒有啟用語音合成、或角色沒有 voice.wav 時回傳 null(呼叫端改用系統語音)。 */
export async function voiceTts(target: string | { character: string }, text: string): Promise<ArrayBuffer | null> {
  if (state !== 'ready' || tts.state !== 'ready' || !child) return null;
  const character = typeof target === 'string' ? characterOf(target) : typeof target?.character === 'string' ? target.character : null;
  const voice = character ? voiceOf(character) : null;
  const say = String(text ?? '').trim().slice(0, 500);
  if (!voice || !say) return null;
  const r = await fetch(`http://127.0.0.1:${port}/tts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: say, wav: voice.wav, promptText: voice.promptText, style: voice.style }),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error || `語音合成失敗(${r.status})`);
  }
  const buf = await r.arrayBuffer();
  return buf.byteLength > 44 ? buf : null;
}

/** 各角色有沒有參考錄音。 */
export function voiceCharacters(): Array<{ character: string; hasVoice: boolean; style: string }> {
  return listCharacters().map(c => { const v = voiceOf(c); return { character: c, hasVoice: !!v, style: v?.style ?? '' }; });
}
