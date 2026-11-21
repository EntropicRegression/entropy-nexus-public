import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SPEECH_CLIP_KINDS, SPEECH_ENGINES, type SpeechClipKind, type SpeechClipSet, type SpeechEngineId, type SpeechEngineState, type SpeechNotice, type SpeechSettings } from '../shared/types';
import type { Store } from './store';
import { listCharacters, portraitsDir } from './portraits';
import { clipMime, listClips, pickClip } from './speech-clips';
import { localTts, localTtsState } from './voice';

/**
 * 語音播報的引擎層:畫面決定「什麼時候念、念哪一則」(sound.ts 的佇列),這裡決定「用什麼聲音念」。
 * 依使用者排的順序逐一嘗試啟用的引擎,第一個產生出聲音的就用它;全部都沒有時回傳 null,畫面改用系統語音。
 *
 * 新增引擎(例如雲端語音):在 SpeechEngineId 加一個 id、在 ENGINES 實作 state 與 render,畫面的設定會自動列出來。
 * 這組函式只註冊給桌面畫面的 IPC,瀏覽器版的遠端介面呼叫不到。
 */

interface SpeechRequest { character: string; notice: SpeechNotice; text: string }
interface Rendered { audio: ArrayBuffer; mime: string }
interface Engine {
  state(): { ready: boolean; detail: string };
  render(req: SpeechRequest): Promise<Rendered | null>;
}

const DEFAULTS: SpeechSettings = { engines: ['clips', 'local'] };

let store: Store | null = null;
let settings: SpeechSettings = { engines: [...DEFAULTS.engines] };
let characterOf: (agentId: string) => string | null = () => null;

const clipDir = (character: string) => join(portraitsDir(), character, 'clips');
const toArrayBuffer = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

function clipSets(): SpeechClipSet[] {
  const out: SpeechClipSet[] = [];
  for (const character of listCharacters()) {
    const all = listClips(clipDir(character));
    const counts: SpeechClipSet['counts'] = {};
    for (const k of SPEECH_CLIP_KINDS) if (all[k]?.length) counts[k] = all[k]!.length;
    if (Object.keys(counts).length) out.push({ character, counts });
  }
  return out;
}

const ENGINES: Record<SpeechEngineId, Engine> = {
  clips: {
    state: () => {
      const n = clipSets().length;
      return n ? { ready: true, detail: `${n} 個角色有固定語音` } : { ready: false, detail: '還沒有角色錄固定語音(角色資料夾的 clips/)' };
    },
    render: async ({ character, notice }) => {
      const file = pickClip(clipDir(character), notice);
      if (!file) return null;
      return { audio: toArrayBuffer(readFileSync(file)), mime: clipMime(file) };
    },
  },
  local: {
    state: localTtsState,
    render: async ({ character, text }) => {
      const audio = await localTts(character, text);
      return audio ? { audio, mime: 'audio/wav' } : null;
    },
  },
};

/** 只留認得的引擎、去掉重複,保持使用者排的順序。 */
export function normalizeEngines(list: unknown): SpeechEngineId[] {
  if (!Array.isArray(list)) return [...DEFAULTS.engines];
  const out: SpeechEngineId[] = [];
  for (const id of list) if (SPEECH_ENGINES.includes(id) && !out.includes(id)) out.push(id);
  return out;
}

export function initSpeechEngines(s: Store, character: (agentId: string) => string | null): void {
  store = s;
  characterOf = character;
  try {
    const saved = JSON.parse(s.getSetting('speech') ?? 'null');
    if (saved && typeof saved === 'object') settings = { engines: normalizeEngines(saved.engines) };
  } catch { /* 設定壞了就用預設值 */ }
}

export function speechSettings(): { settings: SpeechSettings; engines: SpeechEngineState[]; clips: SpeechClipSet[] } {
  return {
    settings: { engines: [...settings.engines] },
    engines: SPEECH_ENGINES.map(id => ({ id, ...ENGINES[id].state() })),
    clips: clipSets(),
  };
}

export function speechSet(patch: Partial<SpeechSettings>): ReturnType<typeof speechSettings> {
  if (patch && 'engines' in patch) settings = { engines: normalizeEngines(patch.engines) };
  store?.setSetting('speech', JSON.stringify(settings));
  return speechSettings();
}

/** 依引擎順序產生一則播報的聲音;引擎失敗就換下一個。都沒有聲音(或節點沒有角色)時回傳 null。 */
export async function speechRender(notice: SpeechNotice, text: string): Promise<(Rendered & { engine: SpeechEngineId }) | null> {
  const character = notice && typeof notice.agentId === 'string' ? characterOf(notice.agentId) : null;
  if (!character) return null;
  const req: SpeechRequest = { character, notice, text: String(text ?? '').slice(0, 500) };
  for (const id of settings.engines) {
    try {
      const r = await ENGINES[id].render(req);
      if (r && r.audio.byteLength > 44) return { ...r, engine: id };
    } catch { /* 這個引擎失敗,試下一個 */ }
  }
  return null;
}

/** 試聽:一個角色某個事件的固定語音(有好幾條時挑第一條)。 */
export function speechClip(character: string, kind: SpeechClipKind): Rendered | null {
  if (!listCharacters().includes(character) || !SPEECH_CLIP_KINDS.includes(kind)) return null;
  const file = listClips(clipDir(character))[kind]?.[0];
  return file ? { audio: toArrayBuffer(readFileSync(file)), mime: clipMime(file) } : null;
}
