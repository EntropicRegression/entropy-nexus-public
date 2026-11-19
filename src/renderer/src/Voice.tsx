import { useEffect, useRef, useState } from 'react';
import type { VoiceStatus } from '../../shared/types';
import { pauseSpeech, resumeSpeech } from './sound';

/**
 * 語音模式(實驗性,Phase 1):按住說話 → 錄成 16 kHz 單聲道 WAV → 主控台的語音服務轉成文字 → 填進輸入框。
 * 不會自動送出,也不能用語音回覆授權。
 */

const clean = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const STATE_TEXT: Record<VoiceStatus['state'], string> = { off: '未啟用', starting: '啟動中', warming: '模型載入中', ready: '可以使用', error: '異常', unsupported: '不提供' };
const MIN_MS = 300;
const MAX_MS = 60000;

export function useVoice(): VoiceStatus | null {
  const [st, setSt] = useState<VoiceStatus | null>(null);
  useEffect(() => {
    let alive = true;
    void window.nexus.voiceStatus().then(s => { if (alive) setSt(s); }).catch(() => {});
    const off = window.nexus.onVoice(s => setSt(s));
    return () => { alive = false; off(); };
  }, []);
  return st;
}

/** 把錄到的 Float32 片段包成 16-bit PCM 的 WAV 檔。 */
function toWav(chunks: Float32Array[], rate: number): ArrayBuffer {
  const n = chunks.reduce((s, c) => s + c.length, 0);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  let o = 44;
  for (const c of chunks) for (let i = 0; i < c.length; i++, o += 2) v.setInt16(o, Math.max(-1, Math.min(1, c[i])) * 0x7fff, true);
  return buf;
}

interface Recording { stop(): Promise<{ wav: ArrayBuffer; ms: number }>; cancel(): void }

async function record(): Promise<Recording> {
  // 先用建議的參數;裝置不接受(找不到符合的裝置或參數過嚴)時退回最寬鬆的 audio: true
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    .catch(e => { if (['NotFoundError', 'OverconstrainedError'].includes((e as DOMException)?.name)) return navigator.mediaDevices.getUserMedia({ audio: true }); throw e; });
  // 直接要 16 kHz 的 AudioContext,由瀏覽器負責重取樣
  const ctx = new AudioContext({ sampleRate: 16000 });
  const src = ctx.createMediaStreamSource(stream);
  // ScriptProcessor 已不建議使用,但不需要額外的 worklet 檔案;Phase 1 先用它
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  proc.onaudioprocess = e => { chunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
  src.connect(proc);
  proc.connect(ctx.destination);
  const t0 = Date.now();
  const end = () => { proc.disconnect(); src.disconnect(); stream.getTracks().forEach(t => t.stop()); void ctx.close(); };
  return {
    stop: async () => { const rate = ctx.sampleRate; end(); return { wav: toWav(chunks, rate), ms: Date.now() - t0 }; },
    cancel: end,
  };
}

/** 錄音失敗的說明;附上錯誤名稱與偵測到的錄音裝置數量,方便判斷是裝置、權限還是程式的問題。 */
async function micError(e: unknown): Promise<string> {
  const err = e as DOMException;
  const mics = await navigator.mediaDevices.enumerateDevices().then(d => d.filter(x => x.kind === 'audioinput').length, () => -1);
  const tech = `(${err?.name ?? 'Error'}${err?.message ? `:${err.message}` : ''};偵測到 ${mics < 0 ? '?' : mics} 個錄音裝置)`;
  if (err?.name === 'NotAllowedError') return `麥克風權限被拒絕。請到 Windows 設定 → 隱私權與安全性 → 麥克風,允許桌面應用程式使用麥克風。${tech}`;
  if (err?.name === 'NotFoundError') return `找不到麥克風。${mics > 0 ? '系統有錄音裝置,但主控台開不了;如果耳機是在主控台開啟之後才接上的,請重新開啟主控台。' : '請確認耳機或麥克風已連接。'}${tech}`;
  if (err?.name === 'NotReadableError') return `麥克風正被其他程式佔用,或無法讀取。${tech}`;
  return `無法錄音:${clean(e)}${tech}`;
}

/** 輸入框旁的「按住說話」按鈕;語音模式沒有啟用時不顯示。 */
export function MicButton({ disabled, onText, onNote }: { disabled: boolean; onText: (text: string) => void; onNote: (note: string) => void }) {
  const st = useVoice();
  const [phase, setPhase] = useState<'idle' | 'recording' | 'working'>('idle');
  const rec = useRef<Recording | null>(null);
  const holding = useRef(false);
  const limit = useRef<number | null>(null);

  useEffect(() => () => { if (rec.current) { rec.current.cancel(); resumeSpeech(); } if (limit.current) clearTimeout(limit.current); }, []);
  if (!st || !st.enabled || st.state === 'unsupported') return null;
  const ready = st.state === 'ready';

  const finish = async () => {
    holding.current = false;
    if (limit.current) { clearTimeout(limit.current); limit.current = null; }
    const r = rec.current;
    rec.current = null;
    if (!r) return;
    const { wav, ms } = await r.stop();
    resumeSpeech();
    if (ms < MIN_MS) { setPhase('idle'); onNote('請按住按鈕說話,說完再放開。'); return; }
    setPhase('working');
    try {
      const out = await window.nexus.voiceTranscribe(wav);
      if (out.text.trim()) onText(out.text.trim());
      else onNote('沒有聽到內容。');
    } catch (e) {
      onNote(clean(e));
    } finally {
      setPhase('idle');
    }
  };

  const begin = async () => {
    if (!ready || disabled || phase !== 'idle') return;
    holding.current = true;
    onNote('');
    try {
      const r = await record();
      // 權限詢問或裝置開啟的期間就放開了:不錄
      if (!holding.current) { r.cancel(); return; }
      // 錄音時暫停語音播報,免得把播報的聲音錄進去
      pauseSpeech();
      rec.current = r;
      setPhase('recording');
      limit.current = window.setTimeout(() => { void finish(); }, MAX_MS);
    } catch (e) {
      holding.current = false;
      onNote(await micError(e));
    }
  };

  const title = !ready ? `語音模式:${STATE_TEXT[st.state]}${st.detail ? `(${st.detail})` : ''}`
    : phase === 'recording' ? '放開就會轉成文字' : phase === 'working' ? '辨識中' : '按住說話,放開後轉成文字填進輸入框(不會自動送出,最長 60 秒)';
  return (
    <button
      className={`ghost mic ${phase}`}
      disabled={disabled || !ready || phase === 'working'}
      onPointerDown={e => { if (e.button !== 0) return; e.currentTarget.setPointerCapture(e.pointerId); void begin(); }}
      onPointerUp={() => { if (holding.current) void finish(); }}
      onPointerCancel={() => { if (holding.current) void finish(); }}
      onContextMenu={e => e.preventDefault()}
      title={title}
      aria-label="按住說話"
    >
      {phase === 'recording' ? '錄音中' : phase === 'working' ? '辨識中' : ready ? '說話' : STATE_TEXT[st.state]}
    </button>
  );
}

/** 頂部「語音」的設定面板。 */
export function VoicePanel({ onClose }: { onClose: () => void }) {
  const st = useVoice();
  const [command, setCommand] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const act = (patch: Parameters<typeof window.nexus.voiceSet>[0]) => {
    setErr(''); setBusy(true);
    void window.nexus.voiceSet(patch).then(() => { setCommand(null); setModel(null); }, e => setErr(clean(e))).finally(() => setBusy(false));
  };
  const dirty = (command !== null && command !== st?.command) || (model !== null && model !== st?.model);

  return (
    <div className="remote voice">
      <div className="remote-head"><b>語音模式(實驗性)</b><span className="spacer" /><button className="ghost" onClick={onClose} aria-label="關閉">✕</button></div>
      {!st ? <div className="empty">讀取中…</div> : <>
        <p className="remote-note">啟用後,對話視窗的輸入框旁會出現「說話」按鈕:按住說話,放開後由本機的語音服務轉成文字填進輸入框,你確認後再自己送出。語音不會上傳到網路,也不能用來回覆授權。需要先在這台電腦準備 Python 與 faster-whisper(見 tools/voice-server/README.md)。</p>
        <label className="toggle">
          <input type="checkbox" checked={st.enabled} disabled={busy} onChange={e => act({ enabled: e.target.checked })} />
          啟用語音模式
        </label>
        <div className={st.state === 'ready' ? 'remote-ok' : st.state === 'error' ? 'remote-warn' : 'remote-note'}>
          狀態:{STATE_TEXT[st.state]}{st.device ? `(${st.device})` : ''}{st.detail ? `:${st.detail}` : ''}
        </div>
        <div className="remote-sub">啟動指令</div>
        <input className="voice-field" value={command ?? st.command} placeholder={st.defaultCommand || 'python "C:\\路徑\\tools\\voice-server\\server.py"'} onChange={e => setCommand(e.target.value)} spellCheck={false} />
        <div className="remote-sub">模型(空白表示 large-v3-turbo)</div>
        <input className="voice-field" value={model ?? st.model} placeholder="large-v3-turbo" onChange={e => setModel(e.target.value)} spellCheck={false} />
        <div className="observe-actions">
          <button className="primary" disabled={busy || !dirty} onClick={() => act({ command: command ?? st.command, model: model ?? st.model })}>儲存</button>
          <button className="ghost" disabled={busy || !st.enabled} onClick={() => act({ restart: true })}>重新啟動服務</button>
        </div>
        {err && <div className="remote-warn">{err}</div>}
        {st.log.length > 0 && <pre className="observe-preview voice-log">{st.log.join('\n')}</pre>}
      </>}
    </div>
  );
}
