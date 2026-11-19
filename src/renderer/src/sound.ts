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
export const setSpeakOn = (on: boolean): void => { localStorage.setItem(SPEAK_KEY, on ? '1' : '0'); if (!on) stopSpeaking(); };

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

/** 念出一段回覆;前一段還沒念完會先停掉。onChange 回報是否正在朗讀,給停止鈕用。 */
export function speak(text: string, onChange?: (speaking: boolean) => void): void {
  const synth = window.speechSynthesis;
  const t = speakable(text);
  if (!synth || !t) return;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(t);
  // 有中文就挑台灣中文的語音,否則用英文
  const zh = /[一-鿿]/.test(t);
  const voices = synth.getVoices();
  u.voice = voices.find(v => (zh ? /^zh-TW/i : /^en/i).test(v.lang)) ?? voices.find(v => zh && /^zh/i.test(v.lang)) ?? null;
  u.lang = u.voice?.lang ?? (zh ? 'zh-TW' : 'en-US');
  u.onstart = () => onChange?.(true);
  u.onend = () => onChange?.(false);
  u.onerror = () => onChange?.(false);
  // 自我檢查用:記錄最後一次送去朗讀的文字與語音
  (window as unknown as { __nexusSpoken?: { text: string; voice: string } }).__nexusSpoken = { text: t, voice: u.voice?.name ?? '' };
  synth.speak(u);
}

export function stopSpeaking(): void {
  window.speechSynthesis?.cancel();
}
