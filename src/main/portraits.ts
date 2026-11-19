import { nativeImage, net, protocol } from 'electron';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
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
      .filter(d => d.isDirectory() && (find(d.name, 'neutral') || personaFile(d.name)))
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
