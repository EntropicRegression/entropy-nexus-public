import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * 記憶庫的寫入(階段 2 起的共用函式):agent 寫記憶、判例、刪除節點時的歸檔都經過這裡,格式與規則只有一份。
 *
 * 規則(見 docs/記憶設計討論.md):
 * - 每筆記憶一個 .md 檔,開頭是 YAML 屬性區塊(用 memory-vault.ts 的 parseFrontMatter 讀得回來的簡單格式)。
 * - 寫入前遮罩看起來像金鑰、權杖、密碼的內容(取代成「[已遮罩]」),不整筆拒絕。
 * - 使用者在記憶庫管理 app 改過的檔案,agent 不覆寫:改成在檔案最後附加一段。判斷方式是記下 agent 上次寫入後的
 *   修改時間與大小(存在記憶庫根目錄的 .nexus-writes.json);檔案現在的修改時間或大小和紀錄不同,就是被別人改過。
 * - 寫入先寫暫存檔再改名,不會留下寫到一半的檔案。
 *
 * 這個檔案只用 node:fs,不依賴 Electron,單元測試可以直接載入。
 */

export type MetaValue = string | number | string[] | null | undefined;

const MASK = '[已遮罩]';

/** 看起來像祕密的字串:各家常見的金鑰格式、Bearer 權杖、JWT、私鑰區塊,以及「password: …」這類鍵值。 */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
];
/** 「password = xxx」「api_key: xxx」「密碼:xxx」:保留鍵名,只遮罩值。 */
const SECRET_KV = /((?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|token|密碼|金鑰|權杖)\s*[:=:]\s*)(["']?)([A-Za-z0-9_\-+/=.~!@#$%^&*]{6,})\2/gi;

/** 遮罩看起來像金鑰、權杖、密碼的內容,回傳遮罩後的文字與遮罩的處數。 */
export function maskSecrets(text: string): { text: string; masked: number } {
  let masked = 0;
  let out = String(text ?? '');
  for (const re of SECRET_PATTERNS) out = out.replace(re, () => { masked++; return MASK; });
  out = out.replace(SECRET_KV, (_m, key: string, q: string) => { masked++; return `${key}${q}${MASK}${q}`; });
  return { text: out, masked };
}

/** 開頭屬性區塊裡的節點ID;沒有屬性區塊或沒有這個欄位是空字串。 */
export function profileNodeId(text: string): string {
  const block = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const line = block && /^(?:節點ID|節點id|node-id|nodeId)\s*[:：]\s*(.*)$/m.exec(block[1]);
  return line ? line[1].trim().replace(/^(['"])(.*)\1$/, '$2').trim() : '';
}

const headOf = (abs: string): string => readFileSync(abs, 'utf8').slice(0, 8192);

/**
 * 節點側寫的路徑(相對記憶庫)。依節點 ID 找 nodes/ 底下(不含子資料夾)的側寫,檔名不一定是現在的名稱(改名後沿用原檔);
 * 同一個 ID 有多份時取最近修改的。找不到時:舊版依名稱存的 nodes/<名稱>.md 沒有節點ID 就沿用;
 * 否則用 nodes/<名稱>-<ID 前 8 碼>.md。同名的不同節點因此各有一份,不會互相覆蓋。
 */
export function nodeProfilePath(vault: string, node: { id: string; name: string }): string {
  const dir = join(vault, 'nodes');
  let best: { rel: string; mtime: number } | null = null;
  let names: string[] = [];
  try { names = readdirSync(dir).filter(n => /\.md$/i.test(n)); } catch { /* 還沒有資料夾 */ }
  for (const n of names) {
    const abs = join(dir, n);
    try {
      const st = statSync(abs);
      if (!st.isFile() || profileNodeId(headOf(abs)) !== node.id) continue;
      if (!best || st.mtimeMs > best.mtime) best = { rel: `nodes/${n}`, mtime: st.mtimeMs };
    } catch { /* 讀不到就略過 */ }
  }
  if (best) return best.rel;
  const legacy = `nodes/${safeName(node.name)}.md`;
  try { if (!profileNodeId(headOf(join(vault, 'nodes', `${safeName(node.name)}.md`)))) return legacy; } catch { /* 沒有舊檔 */ }
  return `nodes/${safeName(node.name)}-${safeName(node.id).slice(0, 8)}.md`;
}

/** 檔名可以用的字:去掉 Windows 不允許的字元與結尾的點、空白,長度上限 60 字。 */
export function safeName(s: string): string {
  const t = String(s ?? '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60).replace(/[. ]+$/, '');
  return t || '未命名';
}

const needsQuote = (v: string) => v === '' || /^[\s[\]"'#]|[:#]\s|\s$/.test(v) || /[\r\n]/.test(v);
/** 雙引號字串:跳脫反斜線與雙引號;換行、單獨的 \r、其他控制字元(Tab 除外)、U+2028/2029 換成空白,YAML 才一定合法。 */
const quote = (v: string) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\x00-\x08\x0a-\x1f\x7f-\x9f\u2028\u2029]/g, ' ')}"`;

/**
 * 把屬性寫成 YAML 區塊(只用到純量與單層清單;null、undefined 的欄位略過)。屬性值也會先遮罩。
 * quoteStrings 為 true 時,所有字串值(含清單內的字串)一律用雙引號、跳脫 \ 與 ",換行單行化;數字不加引號。預設只在必要時加引號。
 */
export function serializeFrontMatter(meta: Record<string, MetaValue>, quoteStrings = false): string {
  const lines = ['---'];
  const one = (x: unknown, inList: boolean): string => {
    const v = maskSecrets(String(x)).text;
    if (quoteStrings && typeof x !== 'number') return quote(v);
    return needsQuote(v) || (inList && /,/.test(v)) ? quote(v) : v;
  };
  for (const [k, raw] of Object.entries(meta)) {
    if (raw === null || raw === undefined) continue;
    if (Array.isArray(raw)) lines.push(`${k}: [${raw.map(x => one(x, true)).join(', ')}]`);
    else lines.push(`${k}: ${one(raw, false)}`);
  }
  lines.push('---');
  return lines.join('\n') + '\n';
}

/** edited:這個檔案曾被使用者改過(主控台改成附加過);之後一律附加,不再整份取代。 */
interface WriteRecord { mtime: number; size: number; edited?: boolean }
const REGISTRY = '.nexus-writes.json';

function readRegistry(vault: string): Record<string, WriteRecord> {
  try { return JSON.parse(readFileSync(join(vault, REGISTRY), 'utf8')); } catch { return {}; }
}
function saveRegistry(vault: string, reg: Record<string, WriteRecord>): void {
  const tmp = join(vault, `${REGISTRY}.tmp`);
  writeFileSync(tmp, JSON.stringify(reg, null, 1));
  renameSync(tmp, join(vault, REGISTRY));
}

/** 這個檔案在 agent 上次寫入之後,有沒有被別人(使用者)改過;agent 沒寫過的既有檔案也算別人的。 */
export function editedByOthers(vault: string, rel: string): boolean {
  const abs = join(vault, rel);
  if (!existsSync(abs)) return false;
  const rec = readRegistry(vault)[rel];
  if (!rec || rec.edited) return true;
  const st = statSync(abs);
  return Math.floor(st.mtimeMs) !== rec.mtime || st.size !== rec.size;
}

export interface WriteResult {
  /** 相對於記憶庫的路徑(用 /)。 */
  path: string;
  /** unchanged:檔案被使用者改過,而新內容和檔案裡每個章節的最新版本都相同,所以沒有附加。 */
  action: 'created' | 'replaced' | 'appended' | 'unchanged';
  /** 遮罩的處數(內文加屬性)。 */
  masked: number;
}

/**
 * 寫入一筆記憶。rel 是相對於記憶庫的路徑(例如 `nodes/Hagemi.md`、`cases/<專案>/2026-0003-案由.md`)。
 * - 檔案不存在:建立。
 * - 檔案存在、而且只有 agent 寫過:mode 為 replace 時整份取代,append 時附加。
 * - 檔案被使用者改過:一律改成附加一段「## 主控台補充(時間)」,不動使用者的內容。
 */
/** 主控台附加段落的標題:## 主控台補充(YYYY-MM-DD HH:mm)。全形、半形括號都認。 */
const APPENDIX_HEADING = /^##\s*主控台補充[（(][^）)]*[）)]\s*$/;
const SECTION_HEADING = /^##\s+(.+?)\s*$/;

/** 去掉開頭的屬性區塊,回傳正文。 */
export function bodyOfText(text: string): string {
  const m = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---[\t ]*(?:\r?\n|$)/.exec(text);
  return m ? text.slice(m[0].length) : text;
}

/**
 * 正文依二級標題(## )切成章節:標題前的文字是 '' 這一節。主控台補充的標題不是章節,只是分隔(它後面的文字、
 * 子標題照樣算在對應的章節)。同一個標題出現好幾次時(使用者版本與之後的補充),以最後一次為準。
 */
export function sectionMap(body: string): Map<string, string> {
  const out = new Map<string, string>();
  let title = '';
  let lines: string[] = [];
  const flush = () => { const text = lines.join('\n').trim(); if (text || title) out.set(title, text); lines = []; };
  for (const line of body.replace(/\r\n?/g, '\n').split('\n')) {
    if (APPENDIX_HEADING.test(line)) { flush(); title = ''; continue; }
    const h = SECTION_HEADING.exec(line);
    if (h) { flush(); title = h[1]; continue; }
    lines.push(line);
  }
  flush();
  return out;
}

/**
 * 附加時只附「和檔案目前內容相比有變動的章節」:新正文的每一節,和檔案裡同標題章節的最新版本(含之前的補充)比較,
 * 不同才附加;內容是空的章節不附加(例如只補上空的標題)。回傳要附加的文字,沒有變動時是空字串。
 */
export function changedSections(currentBody: string, nextBody: string): string {
  const current = sectionMap(currentBody);
  const parts: string[] = [];
  for (const [title, text] of sectionMap(nextBody)) {
    if (!text || (current.get(title) ?? null) === text) continue;
    parts.push(title ? `## ${title}\n\n${text}` : text);
  }
  return parts.join('\n\n');
}

/** 附加前後檔案被別人改過時,最多重讀重算這麼多次;仍一直在變就用最後一次讀到的內容寫入。 */
export const APPEND_RETRIES = 3;

export interface WriteOptions {
  /** 測試用:在比對檔案版本、寫回之前呼叫(模擬寶庫或使用者剛好在這時改了檔案)。 */
  beforeCommit?: (abs: string, attempt: number) => void;
  /** 檔頭的字串值一律用雙引號(會議紀錄用,名稱與主題可能含任何字元)。預設不變。 */
  quoteStrings?: boolean;
}

export function writeMemory(vault: string, rel: string, meta: Record<string, MetaValue>, body: string, mode: 'replace' | 'append' = 'replace', now: Date = new Date(), opts: WriteOptions = {}): WriteResult {
  const relPath = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!relPath.endsWith('.md') || relPath.split('/').some(p => p === '..' || p === '')) throw new Error('記憶的路徑不正確');
  const abs = join(vault, ...relPath.split('/'));
  mkdirSync(dirname(abs), { recursive: true });
  const m = maskSecrets(body);
  let masked = m.masked + Object.values(meta).reduce<number>((n, v) => n + (v === null || v === undefined ? 0 : (Array.isArray(v) ? v : [v]).reduce<number>((k, x) => k + maskSecrets(String(x)).masked, 0)), 0);
  let action: WriteResult['action'];
  let text: string;
  const exists = existsSync(abs);
  if (!exists) {
    action = 'created';
    text = serializeFrontMatter(meta, opts.quoteStrings) + '\n' + m.text.trim() + '\n';
  } else if (mode === 'replace' && !editedByOthers(vault, relPath)) {
    action = 'replaced';
    text = serializeFrontMatter(meta, opts.quoteStrings) + '\n' + m.text.trim() + '\n';
  } else {
    // 附加(檔案被使用者改過,或明確要求附加):依「目前檔案內容」計算要附加的文字。原本要整份取代的寫入,只附有變動的章節;
    // 寫回前再比對一次檔案版本,讀取之後檔案被改過(寶庫或使用者剛好在寫)就重讀重算,不蓋掉別人剛寫的內容
    action = 'appended';
    const stamp = now.toISOString().slice(0, 16).replace('T', ' ');
    const tmp = `${abs}.tmp`;
    for (let attempt = 0; ; attempt++) {
      const before = statSync(abs);
      const current = readFileSync(abs, 'utf8');
      const add = mode === 'append' ? m.text.trim() : changedSections(bodyOfText(current), m.text);
      if (!add) {
        if (!Number.isFinite(masked)) masked = 0;
        return { path: relPath, action: 'unchanged', masked };
      }
      text = current.replace(/\s*$/, '') + `\n\n## 主控台補充(${stamp})\n\n` + add + '\n';
      writeFileSync(tmp, text);
      opts.beforeCommit?.(abs, attempt);
      const after = statSync(abs);
      if ((after.mtimeMs === before.mtimeMs && after.size === before.size) || attempt >= APPEND_RETRIES) break;
      try { unlinkSync(tmp); } catch { /* 下一輪會覆寫 */ }
    }
  }
  const tmp = `${abs}.tmp`;
  if (action !== 'appended') writeFileSync(tmp, text);
  renameSync(tmp, abs);
  const st = statSync(abs);
  const reg = readRegistry(vault);
  // 附加過的檔案記成「使用者改過」:否則下一次寫入會因為版本和登記相同而整份取代,蓋掉使用者的內容
  reg[relPath] = { mtime: Math.floor(st.mtimeMs), size: st.size, ...(action === 'appended' ? { edited: true } : {}) };
  saveRegistry(vault, reg);
  if (!Number.isFinite(masked)) masked = 0;
  return { path: relPath, action, masked };
}
