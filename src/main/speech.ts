import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SPEECH_CLIP_KINDS, SPEECH_ENGINES, type SpeechClipKind, type SpeechClipSet, type SpeechEngineId, type SpeechEngineState, type SpeechLang, type SpeechNotice, type SpeechSettings } from '../shared/types';
import { englishSummary, normalizeSpeechLang, speechCharacters } from '../shared/speech-phrases';
import type { Store } from './store';
import { listCharacters, portraitsDir } from './portraits';
import { clipMime, listClips, pickClip } from './speech-clips';
import { localTranslate, localTts, localTtsState } from './voice';

/**
 * 語音播報的引擎層:畫面決定「什麼時候念、念哪一則」(sound.ts 的佇列),這裡決定「用什麼聲音念」。
 * 依使用者排的順序逐一嘗試啟用的引擎,第一個產生出聲音的就用它;全部都沒有時回傳 null,畫面改用系統語音。
 *
 * 新增引擎(例如雲端語音):在 SpeechEngineId 加一個 id、在 ENGINES 實作 state 與 render,畫面的設定會自動列出來。
 * 這組函式只註冊給桌面畫面的 IPC,瀏覽器版的遠端介面呼叫不到。
 */

interface SpeechRequest { character: string; notice: SpeechNotice; text: string; lang: SpeechLang }
interface Rendered { audio: ArrayBuffer; mime: string }
interface Engine {
  state(): { ready: boolean; detail: string };
  render(req: SpeechRequest): Promise<Rendered | null>;
}

const DEFAULTS: SpeechSettings = { engines: ['clips', 'local'], lang: 'zh' };

let store: Store | null = null;
let settings: SpeechSettings = { ...DEFAULTS, engines: [...DEFAULTS.engines] };
/** 節點 id → 節點自己的角色與總管的角色(沒有就是 null)。 */
let rolesOf: (agentId: string) => { own: string | null; chief: string | null } = () => ({ own: null, chief: null });

/** 固定語音的資料夾:中文在 clips/,英文在 clips/en/(不能用 done-en.wav 這種檔名,會被當成中文 done 的另一條)。 */
const clipDir = (character: string, lang: SpeechLang = 'zh') => join(portraitsDir(), character, 'clips', ...(lang === 'en' ? ['en'] : []));
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
    render: async ({ character, notice, lang }) => {
      const file = pickClip(clipDir(character, lang), notice);
      if (!file) return null;
      return { audio: toArrayBuffer(readFileSync(file)), mime: clipMime(file) };
    },
  },
  local: {
    state: localTtsState,
    render: async ({ character, text, lang }) => {
      const audio = await localTts(character, text, lang);
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

export function initSpeechEngines(s: Store, roles: (agentId: string) => { own: string | null; chief: string | null }): void {
  store = s;
  rolesOf = roles;
  try {
    const saved = JSON.parse(s.getSetting('speech') ?? 'null');
    if (saved && typeof saved === 'object') settings = { engines: normalizeEngines(saved.engines), lang: normalizeSpeechLang(saved.lang) };
  } catch { /* 設定壞了就用預設值 */ }
}

export const speechLang = (): SpeechLang => settings.lang;

/**
 * 主行程送出播報通知前的處理:填上播報語言;英文時把完成通知的中文摘要翻成英文(本機翻譯 + 防呆,
 * 不能用就把摘要清成 null,畫面改念固定的英文句)。
 */
export async function prepareNotice(n: SpeechNotice): Promise<SpeechNotice> {
  const lang = settings.lang;
  if (lang !== 'en') return { ...n, lang };
  if (n.kind !== 'done') return { ...n, lang };
  return { ...n, lang, summary: await englishSummary(n.summary, t => localTranslate(t)) };
}

export function speechSettings(): { settings: SpeechSettings; engines: SpeechEngineState[]; clips: SpeechClipSet[] } {
  return {
    settings: { engines: [...settings.engines], lang: settings.lang },
    engines: SPEECH_ENGINES.map(id => ({ id, ...ENGINES[id].state() })),
    clips: clipSets(),
  };
}

export function speechSet(patch: Partial<SpeechSettings>): ReturnType<typeof speechSettings> {
  if (patch && 'engines' in patch) settings = { ...settings, engines: normalizeEngines(patch.engines) };
  if (patch && 'lang' in patch) settings = { ...settings, lang: normalizeSpeechLang(patch.lang) };
  store?.setSetting('speech', JSON.stringify(settings));
  return speechSettings();
}

/** 依引擎順序產生一則播報的聲音;引擎失敗就換下一個。都沒有聲音(或節點沒有角色)時回傳 null。 */
export async function speechRender(notice: SpeechNotice, text: string): Promise<(Rendered & { engine: SpeechEngineId }) | null> {
  if (!notice || typeof notice.agentId !== 'string') return null;
  const lang = normalizeSpeechLang(notice.lang);
  for (const character of speechCharacters(rolesOf(notice.agentId), lang)) {
    const req: SpeechRequest = { character, notice, text: String(text ?? '').slice(0, 500), lang };
    for (const id of settings.engines) {
      try {
        const r = await ENGINES[id].render(req);
        if (r && r.audio.byteLength > 44) return { ...r, engine: id };
      } catch { /* 這個引擎失敗,試下一個 */ }
    }
  }
  return null;
}

/** 試聽:一個角色某個事件的固定語音(有好幾條時挑第一條)。 */
export function speechClip(character: string, kind: SpeechClipKind): Rendered | null {
  if (!listCharacters().includes(character) || !SPEECH_CLIP_KINDS.includes(kind)) return null;
  const file = listClips(clipDir(character))[kind]?.[0];
  return file ? { audio: toArrayBuffer(readFileSync(file)), mime: clipMime(file) } : null;
}
