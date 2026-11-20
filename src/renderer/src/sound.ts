import { useSyncExternalStore } from 'react';
import type { SpeechNotice } from '../../shared/types';
import { speechUnits } from '../../shared/speech-summary';

// 提示音:只在節點進入待授權或異常時響一聲,其他狀態保持安靜。
let ctx: AudioContext | null = null;

const KEY = 'nexus.muted';

export const isMuted = (): boolean => localStorage.getItem(KEY) === '1';
export const setMuted = (m: boolean): void => localStorage.setItem(KEY, m ? '1' : '0');

function tone(freq: number, start: number, duration: number, gain: number): void {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  amp.gain.setValueAtTime(0, ctx.currentTime + start);
  amp.gain.linearRampToValueAtTime(gain, ctx.currentTime + start + 0.015);
  amp.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + duration);
  osc.connect(amp).connect(ctx.destination);
  osc.start(ctx.currentTime + start);
  osc.stop(ctx.currentTime + start + duration + 0.02);
}

export function chime(kind: 'ask' | 'fault'): void {
  if (isMuted()) return;
  try {
    ctx ??= new AudioContext();
    // 自我檢查用:記錄提示音實際送進音訊裝置的次數與狀態
    const dbg = window as unknown as { __nexusChimes?: { count: number; state: string } };
    dbg.__nexusChimes = { count: (dbg.__nexusChimes?.count ?? 0) + 1, state: ctx.state };
    if (kind === 'ask') { tone(880, 0, 0.16, 0.07); tone(1175, 0.13, 0.22, 0.07); }
    else { tone(330, 0, 0.2, 0.08); tone(247, 0.16, 0.3, 0.08); }
  } catch { /* 沒有音訊裝置時略過 */ }
}

// 朗讀回覆:回合完成時用系統語音念出 agent 的最後一則回覆。預設關閉,設定記在本機。
const SPEAK_KEY = 'nexus.speak';

export const isSpeakOn = (): boolean => localStorage.getItem(SPEAK_KEY) === '1';
const speakListeners = new Set<() => void>();
export const setSpeakOn = (on: boolean): void => {
  localStorage.setItem(SPEAK_KEY, on ? '1' : '0');
  if (!on) stopSpeaking();
  speakListeners.forEach(f => f());
};
/** 朗讀開關的訂閱:語音面板與其他地方的畫面透過它保持同步。 */
export const subscribeSpeakOn = (f: () => void): (() => void) => { speakListeners.add(f); return () => { speakListeners.delete(f); }; };
export const useSpeakOn = (): boolean => useSyncExternalStore(subscribeSpeakOn, isSpeakOn);

/** 拿掉程式碼區塊與 Markdown 符號,只留適合念出來的文字。 */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, '(程式碼略過)')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|[-*•]|\d+[.)])\s+/gm, '')
    .replace(/\*\*|__/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1500);
}

// ---------- 語音播報佇列(Phase 2a)
// 主行程經 nexus:speech 送來通知,這裡排隊依序念出:授權與提問優先、不過期(播之前確認還在等);
// 完成通知最多 5 則、超過 60 秒就丟掉、同一節點只留最新一則;故障同一節點 60 秒最多一次,
// 最多同時排 2 則不同節點的故障,再多的只在第 2 則尾端補「另有其他節點異常」。
// 每則都有逾時保護(系統語音偶爾不送結束事件),錄音時暫停,被錄音打斷的完成通知直接丟掉。

const MAX_DONE = 5;
const DONE_TTL = 60000;
const FAIL_GAP = 60000;
const MAX_FAILS = 2;

interface Item { n: SpeechNotice; text: string; extra: boolean }

let queue: Item[] = [];
let playing: Item | null = null;
let paused = false;
let token = 0;
let watchdog: number | null = null;
const lastFail = new Map<string, number>();
let pendingCheck: (n: SpeechNotice) => boolean = () => true;
let onSpeaking: (speaking: boolean) => void = () => {};

/** isPending:播之前確認這則還有意義(授權或提問還在等、故障還沒恢復)。onChange:是否正在念,給停止鈕用。 */
export function initSpeech(opts: { isPending: (n: SpeechNotice) => boolean; onChange: (speaking: boolean) => void }): void {
  pendingCheck = opts.isPending;
  onSpeaking = opts.onChange;
}

function phrase(n: SpeechNotice): string {
  switch (n.kind) {
    case 'done': return n.summary ? `${n.agentName}:${n.summary}` : `${n.agentName} 完成了,詳情請看畫面。`;
    case 'approval': return `${n.agentName} 在等你授權,請到畫面確認。`;
    case 'question': return `${n.agentName} 有問題要問你,請到畫面回答。`;
    case 'failed': {
      const paused = n.queuePaused ? ',排隊的指令已暫停' : '';
      if (n.reason === 'quota') return `${n.agentName} 的額度到達上限,排隊的指令已暫停。`;
      return n.reason === 'lost' ? `${n.agentName} 失去連線${paused}。` : `${n.agentName} 出錯了${paused}。`;
    }
  }
}

const urgent = (n: SpeechNotice) => n.kind === 'approval' || n.kind === 'question';

export function enqueueSpeech(n: SpeechNotice): void {
  if (!isSpeakOn()) return;
  const item: Item = { n, text: phrase(n), extra: false };
  if (n.kind === 'approval' || n.kind === 'question') {
    const same = (x: Item) => (x.n.kind === 'approval' || x.n.kind === 'question') && x.n.requestId === n.requestId;
    if (playing && same(playing) || queue.some(same)) return;
    // 插在其他等待中的授權與提問後面、一般通知前面
    const at = queue.findIndex(x => !urgent(x.n));
    if (at < 0) queue.push(item); else queue.splice(at, 0, item);
  } else if (n.kind === 'done') {
    queue = queue.filter(x => !(x.n.kind === 'done' && x.n.agentId === n.agentId));
    queue.push(item);
    const dones = queue.filter(x => x.n.kind === 'done');
    if (dones.length > MAX_DONE) queue = queue.filter(x => x !== dones[0]);
  } else {
    const prev = lastFail.get(n.agentId) ?? 0;
    const queuedSame = queue.findIndex(x => x.n.kind === 'failed' && x.n.agentId === n.agentId);
    if (queuedSame >= 0) { queue[queuedSame] = { ...item, extra: queue[queuedSame].extra }; return; }
    if (n.ts - prev < FAIL_GAP) return;
    lastFail.set(n.agentId, n.ts);
    const fails = queue.filter(x => x.n.kind === 'failed');
    if (fails.length >= MAX_FAILS) {
      const last = fails[fails.length - 1];
      if (!last.extra) { last.extra = true; last.text = `${last.text.replace(/。$/, '')},另有其他節點異常。`; }
      return;
    }
    queue.push(item);
  }
  pump();
}

function clearWatchdog(): void {
  if (watchdog !== null) { clearTimeout(watchdog); watchdog = null; }
}

function pump(): void {
  if (paused || playing) return;
  const now = Date.now();
  queue = queue.filter(x => x.n.kind !== 'done' || now - x.n.ts <= DONE_TTL);
  while (queue.length) {
    const next = queue.shift()!;
    if (!pendingCheck(next.n)) continue;
    play(next);
    return;
  }
  onSpeaking(false);
}

/** 正在播放的合成語音(Phase 3:節點自己的聲音)。 */
let audio: { el: HTMLAudioElement; url: string } | null = null;

function stopAudio(): void {
  if (!audio) return;
  audio.el.onended = null;
  audio.el.onerror = null;
  audio.el.pause();
  URL.revokeObjectURL(audio.url);
  audio = null;
}

/** 先試節點自己的聲音(語音服務的語音合成),沒有啟用、這個角色沒有參考錄音、或失敗時改用系統語音。 */
function play(item: Item): void {
  playing = item;
  const mine = ++token;
  onSpeaking(true);
  clearWatchdog();
  // 合成本身也要有上限,太久就改用系統語音
  const tooSlow = new Promise<null>(r => { watchdog = window.setTimeout(() => r(null), 15000); });
  void Promise.race([window.nexus.voiceTts(item.n.agentId, item.text).catch(() => null), tooSlow]).then(buf => {
    if (mine !== token) return;
    clearWatchdog();
    if (buf) playAudio(item, buf, mine); else playSystem(item, mine);
  });
}

function finisher(mine: number): () => void {
  return () => {
    if (mine !== token) return;
    clearWatchdog();
    stopAudio();
    playing = null;
    pump();
  };
}

function playAudio(item: Item, buf: ArrayBuffer, mine: number): void {
  const finish = finisher(mine);
  const url = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  const el = new Audio(url);
  audio = { el, url };
  el.onended = finish;
  el.onerror = () => { if (mine !== token) return; stopAudio(); playSystem(item, mine); };
  el.onloadedmetadata = () => {
    clearWatchdog();
    if (Number.isFinite(el.duration)) watchdog = window.setTimeout(finish, el.duration * 1000 + 3000);
  };
  watchdog = window.setTimeout(finish, 30000);
  // 自我檢查用:真的開始播放才記成 tts(被安全政策擋下或格式不支援時,會改用系統語音並記成 system)
  const dbg = window as unknown as { __nexusSpokenLog?: string[]; __nexusSpokenVia?: string[] };
  el.onplaying = () => { if (mine !== token) return; (dbg.__nexusSpokenLog ??= []).push(item.text); (dbg.__nexusSpokenVia ??= []).push('tts'); };
  void el.play().catch(() => { if (mine !== token) return; stopAudio(); playSystem(item, mine); });
}

function playSystem(item: Item, mine: number): void {
  const synth = window.speechSynthesis;
  const finish = finisher(mine);
  if (!synth) { finish(); return; }
  const u = utterance(item.text);
  u.onend = finish;
  u.onerror = finish;
  (window as unknown as { __nexusSpokenVia?: string[] }).__nexusSpokenVia ??= [];
  (window as unknown as { __nexusSpokenVia: string[] }).__nexusSpokenVia.push('system');
  // 系統語音偶爾不送結束事件:依長度估一個上限,時間到就停掉這則、換下一則
  clearWatchdog();
  watchdog = window.setTimeout(() => { if (mine === token) { synth.cancel(); finish(); } }, Math.min(25000, 3000 + speechUnits(item.text) * 320));
  synth.speak(u);
}

/** 開始錄音:停掉正在念的;被打斷的完成通知直接丟掉,授權、提問與故障放回佇列開頭(錄完再確認一次)。 */
export function pauseSpeech(): void {
  paused = true;
  if (!playing) return;
  const cur = playing;
  playing = null;
  token++;
  clearWatchdog();
  stopAudio();
  window.speechSynthesis?.cancel();
  if (cur.n.kind !== 'done') queue.unshift(cur);
  onSpeaking(false);
}

export function resumeSpeech(): void {
  paused = false;
  pump();
}

/** 停止朗讀:停掉正在念的,並清空還沒念的。 */
export function stopSpeaking(): void {
  queue = [];
  playing = null;
  token++;
  clearWatchdog();
  stopAudio();
  window.speechSynthesis?.cancel();
  onSpeaking(false);
}

/** 建立一段朗讀;有中文就挑台灣中文的語音,否則用英文。 */
function utterance(text: string): SpeechSynthesisUtterance {
  const synth = window.speechSynthesis;
  const t = speakable(text);
  const u = new SpeechSynthesisUtterance(t);
  const zh = /[一-鿿]/.test(t);
  const voices = synth.getVoices();
  u.voice = voices.find(v => (zh ? /^zh-TW/i : /^en/i).test(v.lang)) ?? voices.find(v => zh && /^zh/i.test(v.lang)) ?? null;
  u.lang = u.voice?.lang ?? (zh ? 'zh-TW' : 'en-US');
  // 自我檢查用:記錄送去朗讀的文字與語音
  const dbg = window as unknown as { __nexusSpoken?: { text: string; voice: string }; __nexusSpokenLog?: string[] };
  dbg.__nexusSpoken = { text: t, voice: u.voice?.name ?? '' };
  (dbg.__nexusSpokenLog ??= []).push(t);
  return u;
}
