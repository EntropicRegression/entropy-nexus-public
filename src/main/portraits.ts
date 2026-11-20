import { nativeImage, net, protocol } from 'electron';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 可替換的立繪資料夾。
 * 每個角色一個子資料夾,裡面放各表情的圖檔:neutral、thinking、busy、asking、troubled、asleep。
 * 只有 neutral 是必要的,缺少的表情會改用 neutral。沒有任何角色時畫面使用內建的 [REDACTED] 預設圖。
 */
export const MOODS = ['neutral', 'thinking', 'busy', 'asking', 'troubled', 'asleep'] as const;
const EXTS = ['png', 'webp', 'jpg', 'jpeg'];
export const PORTRAIT_SCHEME = 'nexus-portrait';

let root = '';

const README = `立繪資料夾

每個角色建立一個子資料夾,資料夾名稱就是角色名稱。裡面放各表情的圖檔:

  neutral   平常(必要)
  thinking  思考
  busy      忙碌
  asking    詢問
  troubled  困擾
  asleep    休眠

支援 png、webp、jpg。缺少的表情會改用 neutral。建議直式、去背、高度 600 像素以上。

Q 版頭像(選用):在角色資料夾裡放 avatar.png(也接受 chibi_avatar.png,以及 webp、jpg),
主面板上使用這個角色的節點會在六角形裡顯示這張頭像。建議正方形、臉在中間偏上;頂部的「頭像」可以開關。
放好之後重新開啟新增節點面板,就能在「角色」欄位選到。

角色卡:在角色資料夾裡放 persona.md(或 persona.txt,兩者都有時以 .md 為準),
寫下這個角色的身分、說話風格與職責,選用這個角色的節點會帶著這份設定工作。
也可以在新增節點面板或對話視窗的「設定」裡直接編輯。只有角色卡、沒有圖檔的資料夾也能選,畫面會用預設圖。
`;

function find(character: string, mood: string): string | null {
  for (const ext of EXTS) {
    const p = join(root, character, `${mood}.${ext}`);
    if (existsSync(p)) return p;
  }
  return null;
}

export function initPortraits(dir: string): void {
  root = join(dir, 'portraits');
  mkdirSync(root, { recursive: true });
  const readme = join(root, '說明.txt');
  if (!existsSync(readme)) writeFileSync(readme, README);
}

export function portraitsDir(): string {
  return root;
}

/** 資料夾裡有 neutral 圖檔或角色卡的才算一個可用的角色;只有角色卡的,畫面改用預設圖。 */
export function listCharacters(): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(d => d.isDirectory() && (find(d.name, 'neutral') || personaFile(d.name) || existsSync(join(root, d.name, 'voice.wav')) || existsSync(join(root, d.name, 'clips'))))
      .map(d => d.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/** 角色卡的長度上限(字元)。太長會佔掉 agent 的記憶空間,也可能超過命令列參數的長度限制。 */
export const PERSONA_MAX = 8000;
const PERSONA_FILES = ['persona.md', 'persona.txt'];

/** 角色名稱就是立繪資料夾底下的一層資料夾名稱;擋掉 ..、路徑分隔字元等會跳出立繪資料夾的名稱。 */
function checkCharacter(character: string): string {
  const c = typeof character === 'string' ? character.trim() : '';
  if (!c || c.length > 80 || c === '.' || c === '..' || /[\\/:*?"<>|\x00-\x1f]/.test(c) || /[. ]$/.test(c) || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(c)) throw new Error('角色名稱不正確');
  return c;
}

function personaFile(character: string): string | null {
  for (const f of PERSONA_FILES) {
    const p = join(root, character, f);
    if (existsSync(p)) return p;
  }
  return null;
}

/** 讀取角色卡;沒有角色卡時回傳空字串。超過上限的部分截掉,truncated 讓畫面提示使用者。 */
export function readPersona(character: string): { text: string; truncated: boolean } {
  const file = personaFile(checkCharacter(character));
  if (!file) return { text: '', truncated: false };
  const text = readFileSync(file, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n').trim();
  return text.length > PERSONA_MAX ? { text: text.slice(0, PERSONA_MAX), truncated: true } : { text, truncated: false };
}

/** 寫入角色卡。原本是 persona.txt 就寫回 .txt,否則寫 persona.md;角色資料夾不存在時建立(之後就能在角色清單選到)。 */
export function writePersona(character: string, text: string): void {
  const c = checkCharacter(character);
  const body = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (body.length > PERSONA_MAX) throw new Error(`角色卡超過 ${PERSONA_MAX} 字,請精簡後再儲存。`);
  const existing = personaFile(c);
  // 沒有角色卡又存空白時不必建立資料夾與空檔
  if (!existing && !body) return;
  const dir = join(root, c);
  mkdirSync(dir, { recursive: true });
  const file = existing ?? join(dir, 'persona.md');
  // 先寫暫存檔再換名,寫到一半當機也不會留下半份角色卡
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, body ? `${body}\n` : '');
  renameSync(tmp, file);
}

/** 角色某個表情的圖檔路徑(缺少時改用 neutral);角色必須在清單裡,表情必須是已知的名稱。瀏覽器版經 /api/portrait 讀取。 */
export function portraitFile(character: string, mood: string): string | null {
  if (!character || !listCharacters().includes(character) || !(MOODS as readonly string[]).includes(mood)) return null;
  return find(character, mood) ?? find(character, 'neutral');
}

const AVATAR_NAMES = ['avatar', 'chibi_avatar'];
const AVATAR_TYPES: Record<string, string> = { png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg' };
/** 頭像縮到這個邊長以內再交給畫面(節點上只有幾十個像素大)。 */
const AVATAR_SIZE = 192;
const AVATAR_RAW_MAX = 4 * 1024 * 1024;

/**
 * 角色的 Q 版頭像(data URL),畫在主面板節點的六角形裡。檔名是 avatar 或 chibi_avatar;沒有就回傳 null。
 * 角色必須在清單裡,不接受任意路徑。
 */
export function avatarDataUrl(character: string): string | null {
  if (!character || !listCharacters().includes(character)) return null;
  for (const name of AVATAR_NAMES) {
    for (const ext of EXTS) {
      const file = join(root, character, `${name}.${ext}`);
      if (!existsSync(file)) continue;
      try {
        const img = nativeImage.createFromPath(file);
        if (!img.isEmpty()) {
          const { width, height } = img.getSize();
          const k = AVATAR_SIZE / Math.max(width, height);
          return (k < 1 ? img.resize({ width: Math.round(width * k), height: Math.round(height * k), quality: 'best' }) : img).toDataURL();
        }
        // nativeImage 讀不了 WebP,夠小的話直接用原檔
        if (statSync(file).size <= AVATAR_RAW_MAX) return `data:${AVATAR_TYPES[ext]};base64,${readFileSync(file).toString('base64')}`;
      } catch { /* 讀不到就試下一個 */ }
    }
  }
  return null;
}

/** 必須在 app ready 之前呼叫。這個 API 只能呼叫一次,其他自訂協定(例如對話圖片)也從 extra 一起註冊。 */
export function registerPortraitScheme(extra: string[] = []): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: PORTRAIT_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
    ...extra.map(scheme => ({ scheme, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } })),
  ]);
}

/** nexus-portrait://c/<角色>/<表情> → 對應的圖檔。角色必須是資料夾清單裡的名稱,不接受任意路徑。 */
export function handlePortraitRequests(): void {
  protocol.handle(PORTRAIT_SCHEME, request => {
    const parts = new URL(request.url).pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const [character, mood] = parts;
    if (!character || !listCharacters().includes(character) || !(MOODS as readonly string[]).includes(mood)) {
      return new Response('not found', { status: 404 });
    }
    const file = find(character, mood) ?? find(character, 'neutral');
    return file ? net.fetch(pathToFileURL(file).toString()) : new Response('not found', { status: 404 });
  });
}

/**
 * 角色的聲音(語音模式 Phase 3):角色資料夾裡的 voice.wav 是給語音合成模仿的參考錄音(建議 3 到 10 秒、單人、沒有背景音),
 * voice.txt(選用)是這段錄音說的內容,沒有就由語音服務自己辨識;style.txt(選用)是語氣指令,例如「用活潑、甜美的語氣說」。
 * 沒有 voice.wav 時回傳 null,播報改用系統語音。
 */
export function voiceOf(character: string): { wav: string; promptText: string; style: string } | null {
  let c: string;
  try { c = checkCharacter(character); } catch { return null; }
  const wav = join(root, c, 'voice.wav');
  if (!existsSync(wav)) return null;
  const read = (f: string) => { const p = join(root, c, f); try { return existsSync(p) ? readFileSync(p, 'utf8').replace(/^﻿/, '').trim().slice(0, 500) : ''; } catch { return ''; } };
  return { wav, promptText: read('voice.txt'), style: read('style.txt') };
}

const VOICE_MAX = 5 * 1024 * 1024;
const VOICE_MAX_MS = 30000;

/** 檢查參考錄音:要是 PCM 16-bit 的 WAV、單聲道或雙聲道、最長 30 秒。回傳長度(毫秒)。 */
export function wavInfo(buf: Buffer): { ms: number; rate: number; channels: number } {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('不是 WAV 檔');
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  let dataSize = -1;
  for (let o = 12; o + 8 <= buf.length;) {
    const id = buf.toString('ascii', o, o + 4);
    const size = buf.readUInt32LE(o + 4);
    if (id === 'fmt ' && o + 24 <= buf.length) fmt = { format: buf.readUInt16LE(o + 8), channels: buf.readUInt16LE(o + 10), rate: buf.readUInt32LE(o + 12), bits: buf.readUInt16LE(o + 22) };
    if (id === 'data') { dataSize = Math.min(size, buf.length - o - 8); break; }
    o += 8 + size + (size % 2);
  }
  if (!fmt || dataSize < 0) throw new Error('WAV 檔的格式不完整');
  if (fmt.format !== 1 && fmt.format !== 0xfffe) throw new Error('只接受未壓縮的 PCM WAV');
  if (fmt.bits !== 16) throw new Error(`只接受 16-bit 的 WAV(這個檔案是 ${fmt.bits}-bit)`);
  if (fmt.channels < 1 || fmt.channels > 2 || fmt.rate < 8000) throw new Error('WAV 的聲道或取樣率不支援');
  const ms = Math.round((dataSize / (fmt.channels * 2) / fmt.rate) * 1000);
  return { ms, rate: fmt.rate, channels: fmt.channels };
}

/** 角色的聲音設定,給角色卡編輯器顯示。 */
export function voiceProfile(character: string): { hasVoice: boolean; ms: number; promptText: string; style: string } {
  const c = checkCharacter(character);
  const v = voiceOf(c);
  let ms = 0;
  if (v) { try { ms = wavInfo(readFileSync(v.wav)).ms; } catch { /* 檔案壞了就當作長度不明 */ } }
  return { hasVoice: !!v, ms, promptText: v?.promptText ?? '', style: v?.style ?? '' };
}

/** 參考錄音的內容,給畫面播放原音;沒有時回傳 null。 */
export function voiceWav(character: string): Buffer | null {
  const v = voiceOf(checkCharacter(character));
  return v ? readFileSync(v.wav) : null;
}

/**
 * 儲存角色的聲音設定。wav:新的參考錄音(null 表示移除錄音與錄音內容);promptText、style:空字串表示刪掉那個檔案。
 * 沒提供的欄位不動。角色資料夾不存在時建立。
 */
export function saveVoice(character: string, patch: { wav?: Buffer | null; promptText?: string; style?: string }): void {
  const c = checkCharacter(character);
  const dir = join(root, c);
  mkdirSync(dir, { recursive: true });
  const put = (f: string, text: string) => {
    const p = join(dir, f);
    const t = text.replace(/\r\n/g, '\n').trim().slice(0, 500);
    if (t) writeFileSync(p, t, 'utf8'); else if (existsSync(p)) unlinkSync(p);
  };
  if (patch.wav === null) {
    for (const f of ['voice.wav', 'voice.txt']) { const p = join(dir, f); if (existsSync(p)) unlinkSync(p); }
  } else if (patch.wav) {
    if (patch.wav.length > VOICE_MAX) throw new Error('錄音檔太大(上限 5 MB)');
    const info = wavInfo(patch.wav);
    if (info.ms < 2000) throw new Error('錄音太短,至少要 2 秒(建議 3 到 10 秒)');
    if (info.ms > VOICE_MAX_MS) throw new Error('錄音太長,最多 30 秒(建議 3 到 10 秒)');
    const tmp = join(dir, 'voice.wav.tmp');
    writeFileSync(tmp, patch.wav);
    renameSync(tmp, join(dir, 'voice.wav'));
  }
  if (typeof patch.promptText === 'string') put('voice.txt', patch.promptText);
  if (typeof patch.style === 'string') put('style.txt', patch.style);
}
