import { useEffect, useRef, useState } from 'react';
import { SPEECH_ENGINES, type SpeechClipKind, type SpeechEngineId, type SpeechLang, type VoiceProfile, type VoiceStatus } from '../../shared/types';
import { pauseSpeech, resumeSpeech, setSpeakOn, useSpeakOn } from './sound';

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
  const speakOn = useSpeakOn();
  const [command, setCommand] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [ttsDir, setTtsDir] = useState<string | null>(null);
  const [ttsModel, setTtsModel] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [chars, setChars] = useState<Array<{ character: string; hasVoice: boolean; style: string }>>([]);
  const [preview, setPreview] = useState('');
  const loadChars = () => { void window.nexus.voiceCharacters().then(setChars, () => {}); };
  useEffect(loadChars, []);
  const act = (patch: Parameters<typeof window.nexus.voiceSet>[0]) => {
    setErr(''); setBusy(true);
    void window.nexus.voiceSet(patch).then(() => { setCommand(null); setModel(null); setTtsDir(null); setTtsModel(null); }, e => setErr(clean(e))).finally(() => setBusy(false));
  };
  const val = (draft: string | null, saved: string | undefined) => (draft !== null && draft !== saved);
  const dirty = !!st && (val(command, st.command) || val(model, st.model) || val(ttsDir, st.ttsDir) || val(ttsModel, st.ttsModel));
  const TTS_TEXT = { off: '沒有設定', warming: '載入中', ready: '可以使用', unloaded: '已卸載', error: '異常' } as const;
  // 試聽:用這個角色的聲音念一句
  const listen = async (character: string) => {
    setPreview(character); setErr('');
    try {
      const buf = await window.nexus.voiceTts({ character }, `你好,我是${character}。這是我念播報時的聲音。`);
      if (!buf) { setErr('沒有合成出聲音(語音合成還沒準備好,或這個角色沒有 voice.wav)。'); return; }
      const url = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
      const a = new Audio(url);
      a.onended = () => URL.revokeObjectURL(url);
      await a.play();
    } catch (e) { setErr(clean(e)); } finally { setPreview(''); }
  };

  return (
    <div className="remote voice">
      <div className="remote-head"><b>語音</b><span className="spacer" /><button className="ghost" onClick={onClose} aria-label="關閉">✕</button></div>
      <div className="remote-sub first">語音播報(朗讀)</div>
      <div className="speak-row">
        <button className={`ghost mute speak-switch ${speakOn ? 'on' : ''}`} aria-pressed={speakOn} onClick={() => setSpeakOn(!speakOn)}>{speakOn ? '朗讀 開' : '朗讀 關'}</button>
        <span className="remote-note">預設關閉,設定會記住。不需要啟用下面的語音模式就能用。</span>
      </div>
      <p className="remote-note">打開後,會念出:你從桌面交辦的回合正常完成時的一句重點;節點等你授權、有問題要問你,或你交辦的回合出錯、失聯、排隊的指令被額度上限擋住時的提醒。節點互相呼叫、會議、遠端送來的指令與被中斷的回合不念完成摘要;子代理的回覆不念。朗讀中頂部會出現「停止朗讀」,按下去會停掉目前這則並清空佇列。</p>
      <SpeechEngines />
      <div className="remote-sub">語音模式(實驗性)</div>
      {!st ?<div className="empty">讀取中…</div> : <>
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
          <button className="primary" disabled={busy || !dirty} onClick={() => act({ command: command ?? st.command, model: model ?? st.model, ttsDir: ttsDir ?? st.ttsDir, ttsModel: ttsModel ?? st.ttsModel })}>儲存</button>
          <button className="ghost" disabled={busy || !st.enabled} onClick={() => act({ restart: true })}>重新啟動服務</button>
        </div>
        <div className="remote-sub">節點自己的聲音(語音合成,選用)</div>
        <p className="remote-note">填入 CosyVoice 的資料夾後,語音播報會改用各角色的聲音:把一段 3 到 10 秒、只有一個人說話、沒有背景音的 16-bit WAV 存成角色資料夾裡的 voice.wav。可以另外放 voice.txt(錄音說的內容,沒有就自動辨識)與 style.txt(語氣指令,例如「用活潑、甜美的語氣說」)。沒有 voice.wav 的角色仍用系統語音。請只用自己錄的、或取得本人同意的聲音。</p>
        <div className={st.tts.state === 'ready' ? 'remote-ok' : st.tts.state === 'error' ? 'remote-warn' : 'remote-note'}>
          語音合成:{TTS_TEXT[st.tts.state]}{st.tts.detail ? `:${st.tts.detail}` : ''}{st.tts.vramMB ? `(顯示卡記憶體 ${st.tts.vramMB} MB)` : ''}
          <TtsPower st={st} />
        </div>
        <input className="voice-field" value={ttsDir ?? st.ttsDir} placeholder="CosyVoice 資料夾,例如 C:\Users\你\AppData\Local\entropy-nexus-tts\CosyVoice" onChange={e => setTtsDir(e.target.value)} spellCheck={false} />
        <input className="voice-field" value={ttsModel ?? st.ttsModel} placeholder="模型資料夾(空白表示 <資料夾>\pretrained_models\CosyVoice2-0.5B)" onChange={e => setTtsModel(e.target.value)} spellCheck={false} />
        <div className="observe-actions">
          <button className="primary" disabled={busy || !dirty} onClick={() => act({ command: command ?? st.command, model: model ?? st.model, ttsDir: ttsDir ?? st.ttsDir, ttsModel: ttsModel ?? st.ttsModel })}>儲存</button>
          <button className="ghost" onClick={() => void window.nexus.openPortraitsFolder()} title="voice.wav 放在各角色的資料夾裡">開啟角色資料夾</button>
          <button className="ghost" onClick={loadChars}>重新整理</button>
        </div>
        {chars.length > 0 && <div className="voice-chars">
          {chars.map(c => (
            <div key={c.character} className="voice-char">
              <span>{c.character}</span>
              <em className={c.hasVoice ? 'embed' : 'pathonly'}>{c.hasVoice ? `有聲音${c.style ? ` · ${c.style.slice(0, 16)}` : ''}` : '沒有 voice.wav'}</em>
              <button className="ghost" disabled={!c.hasVoice || st.tts.state !== 'ready' || preview !== ''} onClick={() => void listen(c.character)}>{preview === c.character ? '合成中' : '試聽'}</button>
            </div>
          ))}
        </div>}
        {err && <div className="remote-warn">{err}</div>}
        {st.log.length > 0 && <pre className="observe-preview voice-log">{st.log.join('\n')}</pre>}
      </>}
    </div>
  );
}

const ENGINE_TEXT: Record<SpeechEngineId, { name: string; note: string }> = {
  clips: { name: '固定語音', note: '角色資料夾 clips/ 裡預先錄好的短句(done.wav、approval.wav、question.wav、failed.wav,可另放 lost、quota;同一事件可以放 done-2.wav 等多條隨機播)。不需要語音服務、沒有延遲,但念不出完成的摘要。' },
  local: { name: '本機語音合成', note: '用角色的 voice.wav 即時念出整句,包括完成的摘要;需要啟用下面的語音模式並設定語音合成。' },
};
const CLIP_TEXT: Record<SpeechClipKind, string> = { done: '完成', approval: '授權', question: '提問', failed: '出錯', lost: '失聯', quota: '額度' };
type SpeechInfo = Awaited<ReturnType<typeof window.nexus.speechSettings>>;

/** 播報的聲音來源(語音引擎):勾選、排順序,並列出各角色錄了哪些固定語音(點一下試聽)。 */
function SpeechEngines() {
  const voice = useVoice();
  const [s, setS] = useState<SpeechInfo | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    const load = () => void window.nexus.speechSettings().then(setS, e => setErr(clean(e)));
    load();
    // 語音合成載入完成、資料夾裡新增了錄音,都靠定時重新讀取
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);
  if (!s) return null;
  const on = s.settings.engines;
  const order = [...on, ...SPEECH_ENGINES.filter(id => !on.includes(id))];
  const save = (engines: SpeechEngineId[]) => { setErr(''); void window.nexus.speechSet({ engines }).then(setS, e => setErr(clean(e))); };
  const setLang = (lang: SpeechLang) => { setErr(''); void window.nexus.speechSet({ lang }).then(setS, e => setErr(clean(e))); };
  const toggle = (id: SpeechEngineId) => save(on.includes(id) ? on.filter(x => x !== id) : order.filter(x => x === id || on.includes(x)));
  const up = (id: SpeechEngineId) => { const list = [...on]; const i = list.indexOf(id); if (i > 0) { [list[i - 1], list[i]] = [list[i], list[i - 1]]; save(list); } };
  const listen = async (character: string, kind: SpeechClipKind) => {
    try {
      const r = await window.nexus.speechClip(character, kind);
      if (!r) return;
      const url = URL.createObjectURL(new Blob([r.audio], { type: r.mime }));
      const a = new Audio(url);
      a.onended = () => URL.revokeObjectURL(url);
      await a.play();
    } catch (e) { setErr(clean(e)); }
  };
  return (
    <>
      <div className="remote-sub">播報語言</div>
      <label className="speech-lang">
        <select value={s.settings.lang} onChange={e => setLang(e.target.value as SpeechLang)}>
          <option value="zh">中文</option>
          <option value="en">英文(English)</option>
        </select>
      </label>
      <p className="remote-note">只換播報的語言,介面與節點的回覆不變。英文時:固定語音讀角色資料夾的 clips/en/,語音合成用 voice.en.wav(逐字稿 voice.en.txt、語氣 style.en.txt),節點沒有英文聲音就借總管的,都沒有時用系統的英文語音。英文用節點自己的第一人稱念,開頭先說「I'm 節點名稱.」再接摘要。完成摘要是中文時經本機翻譯;有「不要、不能、未、沒、勿、禁」這類容易被漏翻的否定,譯文帶失敗、錯誤或否定和原文對不上,或沒有翻譯模型、翻譯太慢時,改念「Task complete. Please review the details on screen.」</p>
      <div className="remote-sub">播報的聲音來源</div>
      <p className="remote-note">依序嘗試勾選的來源,第一個有聲音的就用它;都沒有時用系統語音。沒有角色的節點用總管的角色聲音(沒有總管、或總管也沒有角色時用系統語音)。</p>
      {order.map(id => {
        const i = on.indexOf(id);
        const st = s.engines.find(e => e.id === id);
        return (
          <div key={id} className="speech-engine">
            <div className="speech-engine-row">
              <label className="toggle"><input type="checkbox" checked={i >= 0} onChange={() => toggle(id)} />{i >= 0 ? `${i + 1}. ` : ''}{ENGINE_TEXT[id].name}</label>
              <em className={st?.ready ? 'embed' : 'pathonly'}>{st?.ready ? '可以使用' : '尚未就緒'}{st?.detail ? `:${st.detail}` : ''}</em>
              {id === 'local' && voice && <TtsPower st={voice} onError={setErr} />}
              {i > 0 && <button className="ghost" onClick={() => up(id)} title="往前移,先試這個來源" aria-label={`${ENGINE_TEXT[id].name}往前移`}>↑</button>}
            </div>
            <div className="remote-note">{ENGINE_TEXT[id].note}</div>
          </div>
        );
      })}
      {s.clips.length > 0 && <div className="voice-chars">
        {s.clips.map(c => (
          <div key={c.character} className="voice-char">
            <span>{c.character}</span>
            {(Object.keys(CLIP_TEXT) as SpeechClipKind[]).filter(k => c.counts[k]).map(k => (
              <button key={k} className="ghost" onClick={() => void listen(c.character, k)} title={`試聽「${CLIP_TEXT[k]}」的固定語音(共 ${c.counts[k]} 條)`}>{CLIP_TEXT[k]}{(c.counts[k] ?? 0) > 1 ? `×${c.counts[k]}` : ''}</button>
            ))}
          </div>
        ))}
      </div>}
      {err && <div className="remote-warn">{err}</div>}
    </>
  );
}

/** 手動卸載或載入本機語音合成(釋放顯示卡記憶體);只在語音合成已設定、服務在執行時出現。 */
function TtsPower({ st, onError }: { st: VoiceStatus; onError?: (msg: string) => void }) {
  const [busy, setBusy] = useState(false);
  const running = st.state === 'ready' || st.state === 'warming';
  if (!running || st.tts.state === 'off') return null;
  const load = st.tts.state === 'unloaded' || st.tts.state === 'error';
  if (!load && st.tts.state !== 'ready') return null;
  const click = () => {
    setBusy(true);
    void window.nexus.voiceTtsPower(load).catch(e => onError?.(clean(e))).finally(() => setBusy(false));
  };
  return (
    <button className="ghost tts-power" disabled={busy} onClick={click}
      title={load ? '重新載入本機語音合成(會佔用顯示卡記憶體,載入要一點時間)' : '卸載本機語音合成,釋放顯示卡記憶體;語音辨識照常,播報改用下一個聲音來源'}>
      {busy ? (load ? '載入中' : '卸載中') : load ? '載入' : '卸載'}
    </button>
  );
}

/** 錄參考錄音時建議念的句子。 */
const VOICE_SCRIPT = '今天天氣很好,我們一起出去走走吧。我會用這個聲音,幫你念工作的進度。';
const REC_MAX_MS = 15000;

function playWav(buf: ArrayBuffer): Promise<void> {
  const url = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  const a = new Audio(url);
  return new Promise(resolve => {
    const done = () => { URL.revokeObjectURL(url); resolve(); };
    a.onended = done;
    a.onerror = done;
    void a.play().catch(done);
  });
}

/**
 * 角色的聲音(語音模式 Phase 3),放在角色卡編輯器底下:錄一段或選一個 WAV 當參考錄音、
 * 填寫錄音內容(可自動辨識)與語氣指令、播放原音、試聽合成效果、移除。檔案存在角色資料夾(voice.wav、voice.txt、style.txt)。
 */
export function VoiceEditor({ character }: { character: string }) {
  const st = useVoice();
  const [p, setP] = useState<VoiceProfile | null | undefined>(undefined);
  const [promptText, setPromptText] = useState('');
  const [style, setStyle] = useState('');
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ArrayBuffer | null>(null);
  const [recording, setRecording] = useState(false);
  const [sec, setSec] = useState(0);
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const rec = useRef<Recording | null>(null);
  const tick = useRef<number | null>(null);

  const apply = (v: VoiceProfile | null) => { setP(v); setPromptText(v?.promptText ?? ''); setStyle(v?.style ?? ''); };
  useEffect(() => {
    let alive = true;
    setDraft(null); setNote(''); setConfirmRemove(false);
    void window.nexus.voiceProfile(character).then(v => { if (alive) apply(v); }, e => { if (alive) { setP(null); setNote(clean(e)); } });
    return () => { alive = false; };
  }, [character]);
  useEffect(() => () => { if (rec.current) { rec.current.cancel(); resumeSpeech(); } if (tick.current) clearInterval(tick.current); }, []);
  // 瀏覽器版:沒有這個功能
  if (p === null && st?.state === 'unsupported') return null;
  if (p === undefined) return null;

  const sttReady = st?.state === 'ready';
  const ttsReady = st?.tts.state === 'ready';
  const dirty = !!draft || promptText.trim() !== (p?.promptText ?? '') || style.trim() !== (p?.style ?? '');
  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label); setNote('');
    try { await fn(); } catch (e) { setNote(clean(e)); } finally { setBusy(''); }
  };
  const transcribe = async (buf: ArrayBuffer) => {
    const out = await window.nexus.voiceTranscribe(buf);
    if (out.text.trim()) setPromptText(out.text.trim());
    else setNote('沒有聽出內容,請自己填寫錄音說了什麼。');
  };

  const startRec = async () => {
    setNote('');
    try {
      pauseSpeech();
      rec.current = await record();
      setRecording(true); setSec(0);
      const t0 = Date.now();
      tick.current = window.setInterval(() => {
        const ms = Date.now() - t0;
        setSec(Math.floor(ms / 1000));
        if (ms >= REC_MAX_MS) void stopRec();
      }, 250);
    } catch (e) { resumeSpeech(); setNote(await micError(e)); }
  };
  const stopRec = async () => {
    if (tick.current) { clearInterval(tick.current); tick.current = null; }
    const r = rec.current;
    rec.current = null;
    setRecording(false);
    resumeSpeech();
    if (!r) return;
    const { wav, ms } = await r.stop();
    if (ms < 2000) { setNote('錄音太短,至少要 2 秒(建議 3 到 10 秒)。'); return; }
    setDraft(wav);
    // 錄音內容要和錄到的一致,模仿的效果才會好:能辨識就自動辨識,否則先填建議的句子
    if (sttReady) await run('辨識中', () => transcribe(wav));
    else if (!promptText.trim()) setPromptText(VOICE_SCRIPT);
  };
  const save = () => run('儲存中', async () => {
    apply(await window.nexus.voiceProfileSave(character, { ...(draft ? { wav: draft } : {}), promptText, style }));
    setDraft(null);
    setNote('已儲存。這個角色的節點之後的語音播報會用這個聲音。');
  });

  return (
    <div className="persona-edit voice-edit">
      <div className="persona-head">
        <span>聲音 · {character}</span>
        <span className="note">{draft ? '新錄音(還沒儲存)' : p?.hasVoice ? `有參考錄音${p.ms ? `(${(p.ms / 1000).toFixed(1)} 秒)` : ''}${p.style ? ` · ${p.style.slice(0, 12)}` : ''}` : '沒有,播報用系統語音'}</span>
        <span className="spacer" />
        <button className="ghost" onClick={() => setOpen(v => !v)}>{open ? '收起' : p?.hasVoice ? '檢視/編輯' : '設定'}</button>
      </div>
      {open && <>
        <span className="note">參考錄音建議 3 到 10 秒、只有一個人說話、沒有背景音。可以念:「{VOICE_SCRIPT}」。請只用自己的聲音,或取得本人同意的聲音。</span>
        <div className="persona-head voice-actions">
          {recording
            ? <button className="danger" onClick={() => void stopRec()}>停止錄音({sec} 秒)</button>
            : <button className="ghost" disabled={!!busy} onClick={() => void startRec()}>{draft || p?.hasVoice ? '重新錄音' : '錄一段'}</button>}
          <button className="ghost" disabled={recording || !!busy} onClick={() => void run('選檔中', async () => { const v = await window.nexus.voiceProfileImport(character); if (v) { apply(v); setDraft(null); setNote('已匯入參考錄音。'); } })}>選擇 WAV 檔</button>
          <button className="ghost" disabled={recording || !!busy || (!draft && !p?.hasVoice)} onClick={() => void run('播放中', async () => { const b = draft ?? await window.nexus.voiceProfileAudio(character); if (b) await playWav(b); })}>播放原音</button>
          <button className="ghost" disabled={recording || !!busy || !sttReady || (!draft && !p?.hasVoice)} title={sttReady ? '用語音辨識聽出錄音說了什麼' : '要先在「語音」面板啟用語音模式'} onClick={() => void run('辨識中', async () => { const b = draft ?? await window.nexus.voiceProfileAudio(character); if (b) await transcribe(b); })}>自動辨識內容</button>
        </div>
        <label className="voice-label">錄音說的內容(要和錄音一致;留白時播報前會自動辨識)
          <textarea rows={2} value={promptText} maxLength={500} onChange={e => setPromptText(e.target.value)} placeholder={VOICE_SCRIPT} />
        </label>
        <label className="voice-label">語氣指令(選用,例如「用活潑、甜美的語氣說」)
          <input value={style} maxLength={200} onChange={e => setStyle(e.target.value)} placeholder="留白表示照錄音的語氣" />
        </label>
        <div className="persona-head">
          {p?.hasVoice && !draft && (confirmRemove
            ? <button className="danger" disabled={!!busy} onClick={() => void run('移除中', async () => { apply(await window.nexus.voiceProfileSave(character, { wav: null })); setConfirmRemove(false); setNote('已移除參考錄音,播報改用系統語音。'); })}>確定移除</button>
            : <button className="ghost" onClick={() => setConfirmRemove(true)}>移除聲音</button>)}
          <button className="ghost" disabled={recording || !!busy || dirty || !p?.hasVoice || !ttsReady} title={!ttsReady ? '要先在「語音」面板設定語音合成' : dirty ? '先儲存再試聽' : '用這個聲音念一句'}
            onClick={() => void run('合成中', async () => { const b = await window.nexus.voiceTts({ character }, `你好,我是${character}。這是我念播報時的聲音。`); if (b) await playWav(b); else setNote('沒有合成出聲音。'); })}>試聽</button>
          <span className="spacer" />
          {busy && <span className="note">{busy}…</span>}
          <button className="primary" disabled={recording || !!busy || !dirty} onClick={() => void save()}>儲存聲音</button>
        </div>
      </>}
      {note && <span className="note">{note}</span>}
    </div>
  );
}
