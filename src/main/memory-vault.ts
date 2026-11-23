import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { MemoryEntry } from '../shared/types';

/**
 * 記憶庫:<資料目錄>\memory-vault\ 資料夾,每筆記憶一個 .md 檔,開頭是 YAML 屬性(front matter)。
 * 這個模組只負責讀取與索引(不依賴 Electron):掃描資料夾、解析屬性、把摘要寫進資料庫的索引表,檔案被外部改動後重新讀取。
 * 階段 1 沒有 agent 寫入;使用者(或之後的記憶庫管理 app)放進來的檔案也能被索引。
 */
export const VAULT_DIRS = ['nodes', 'cases', 'knowledge', 'preferences', 'meetings', 'memoirs'] as const;
const KIND: Record<(typeof VAULT_DIRS)[number], MemoryEntry['kind']> = { nodes: 'node', cases: 'case', knowledge: 'knowledge', preferences: 'preference', meetings: 'meeting', memoirs: 'memoir' };
/** 只讀檔案開頭這麼多位元組來找屬性;一筆記憶不該大到哪裡去。 */
const READ_MAX = 256 * 1024;

const README_V2 = `記憶庫資料夾

這裡存放主控台的長期記憶,每筆記憶是一個 .md 檔,開頭用 YAML 屬性記下種類、範圍、專案、節點、狀態等欄位:

  ---
  種類: 專案知識
  範圍: 專案
  專案ID: c:/projects/example
  標題: 改 UI 要先跑版面檢查
  狀態: 已確認
  更新時間: 2026-11-21
  ---
  內文用一般的 Markdown 寫。

子資料夾:
  nodes        節點側寫(工作履歷)與刪除節點時的歸檔
  cases        解法紀錄(判例庫),每個專案一個子資料夾
  knowledge    專案知識,每個專案一個子資料夾
  preferences  使用者偏好

以底線 _ 開頭的資料夾(例如 nodes/封存/_圖像/)是附屬資料(圖像快照等),不是記憶:不會被索引,記憶庫管理 app 也應忽略。
記憶庫根目錄的 .nexus-stats.json 是主控台定期寫出的節點統計(給管理 app 讀),.tmp 結尾的是寫入中的暫存檔,請忽略。

主控台只負責讀取與建立索引;檔案在外面被修改、新增、刪除後會自動重新讀取。
目前 agent 還不會寫入這裡(之後的版本才會),但放進來的檔案已經會被索引。
這個資料夾可以用任何文字編輯器開啟;請保留檔案開頭的 --- 屬性區塊。
`;
/** 第一版說明檔(還沒有附屬資料的兩行)。 */
const README_V1 = README_V2.replace('以底線 _ 開頭的資料夾(例如 nodes/封存/_圖像/)是附屬資料(圖像快照等),不是記憶:不會被索引,記憶庫管理 app 也應忽略。\n記憶庫根目錄的 .nexus-stats.json 是主控台定期寫出的節點統計(給管理 app 讀),.tmp 結尾的是寫入中的暫存檔,請忽略。\n\n', '');
/** 第三版說明檔:補上熱度檔與管理 App 專屬的 .vault-awards.json,agent 已經會寫入(還沒有 meetings 資料夾)。 */
const README_V3 = README_V2
  .replace('記憶庫根目錄的 .nexus-stats.json 是主控台定期寫出的節點統計(給管理 app 讀),.tmp 結尾的是寫入中的暫存檔,請忽略。\n',
    '記憶庫根目錄的 .nexus-stats.json(節點統計)與 .nexus-heat.json(召回熱度)是主控台寫出的附屬檔(給管理 app 讀),.tmp 結尾的是寫入中的暫存檔,請忽略。\n'
    + '.vault-awards.json 是記憶寶庫管理 App 專屬檔,用來記錄手動頒發的光暈;主控台不讀不寫,請勿手動刪除。\n')
  .replace('主控台只負責讀取與建立索引;檔案在外面被修改、新增、刪除後會自動重新讀取。\n目前 agent 還不會寫入這裡(之後的版本才會),但放進來的檔案已經會被索引。\n',
    '主控台負責建立索引;檔案在外面被修改、新增、刪除後會自動重新讀取。\n'
    + '節點會透過記憶工具寫入(草稿與判例先標成「未確認」,在管理 app 確認後 agent 才查得到);你自己放進來的檔案也會被索引。\n');
/** 第四版說明檔:子資料夾清單補上 meetings(會議紀錄)。 */
const README_V4 = README_V3.replace('  preferences  使用者偏好\n', '  preferences  使用者偏好\n  meetings     會議紀錄(每場會議結束後自動寫入,每個專案一個子資料夾;狀態是「未確認」,使用者確認後節點才查得到)\n');
/** 目前的說明檔:子資料夾清單再補上 memoirs(回憶錄)。 */
export const README = README_V4.replace('\n\n以底線 _ 開頭的資料夾', '\n  memoirs      回憶錄(節點用第一人稱寫的經歷回顧,每個節點一個子資料夾;狀態是「未確認」,使用者確認後節點才查得到)\n\n以底線 _ 開頭的資料夾');
/** 主控台寫過的舊版說明檔;內容和其中一版完全相同(使用者沒改過)才換成新版。 */
const OLD_READMES = [README_V1, README_V2, README_V3, README_V4];

/** 說明檔要寫成什麼:沒有檔案就寫新版;內容是主控台寫過的舊版(使用者沒改過)就換成新版;改過或已是新版回傳 null(不動)。 */
export function readmeUpdate(existing: string | null): string | null {
  if (existing === null) return README;
  const t = existing.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  return t !== README && OLD_READMES.includes(t) ? README : null;
}

export type FrontValue = string | string[];
export interface FrontMatter { meta: Map<string, FrontValue>; body: string; hasBlock: boolean }

/** 雙引號字串內的跳脫:只還原 \" 與 \\,其他反斜線原樣保留(使用者手寫的 "C:\x" 不受影響)。 */
const unescapeDouble = (s: string): string => s.replace(/\\(["\\])/g, '$1');

const unquote = (v: string): string => {
  const t = v.trim();
  if (t.length >= 2 && t[0] === '"' && t.at(-1) === '"') return unescapeDouble(t.slice(1, -1));
  if (t.length >= 2 && t[0] === "'" && t.at(-1) === "'") return t.slice(1, -1);
  return t;
};

/** 「[a, b, "c, d"]」拆成清單:引號只在項目開頭才算(O'Brien 的 ' 不是引號);雙引號內的逗號、#、單引號都保留,\" 與 \\ 會還原。 */
function parseInlineList(v: string): string[] {
  const inner = v.trim().slice(1, -1);
  const out: Array<{ v: string; quoted: boolean }> = [];
  let cur = '', quote = '', quoted = false;
  const push = () => { out.push({ v: quoted ? cur : cur.trim(), quoted }); cur = ''; quoted = false; };
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      if (quote === '"' && ch === '\\' && (inner[i + 1] === '"' || inner[i + 1] === '\\')) { cur += inner[++i]; continue; }
      if (ch === quote) { quote = ''; continue; }
      cur += ch;
      continue;
    }
    if ((ch === '"' || ch === "'") && cur.trim() === '' && !quoted) { quote = ch; quoted = true; cur = ''; continue; }
    if (quoted && /\s/.test(ch)) continue;
    if (ch === ',' || ch === '，') { push(); continue; }
    cur += ch;
  }
  push();
  // 引號內的空字串項目保留(長度才對得上);未加引號的空白項目略過
  return out.filter(x => x.quoted || x.v).map(x => x.v);
}

/**
 * 解析檔案開頭的屬性區塊。只支援我們用得到的簡單格式:
 *   鍵: 值        單行文字(可用引號包住)
 *   鍵: [a, b]    清單
 *   鍵:           後面接 "- 項目" 的清單
 * 其餘寫法(巢狀、多行文字、錨點)一律略過那一行,不會丟出錯誤、也不會執行任何東西。沒有屬性區塊時 hasBlock 是 false。
 */
export function parseFrontMatter(text: string): FrontMatter {
  const src = text.replace(/^\uFEFF/, '');
  const lines = src.split(/\r?\n/);
  const meta = new Map<string, FrontValue>();
  if (lines[0]?.trim() !== '---') return { meta, body: src, hasBlock: false };
  let end = -1;
  for (let i = 1; i < lines.length; i++) if (lines[i].trim() === '---') { end = i; break; }
  if (end < 0) return { meta, body: src, hasBlock: false };
  let listKey: string | null = null;
  for (const line of lines.slice(1, end)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const item = /^\s+-\s+(.*)$/.exec(line) ?? /^-\s+(.*)$/.exec(line);
    if (item && listKey) { const cur = meta.get(listKey); if (Array.isArray(cur)) cur.push(unquote(item[1])); continue; }
    if (/^\s/.test(line)) continue;
    const m = /^([^:：]+)[:：]\s*(.*)$/.exec(line);
    if (!m) { listKey = null; continue; }
    const key = m[1].trim();
    const value = m[2].trim();
    listKey = null;
    if (!key) continue;
    if (value === '') { meta.set(key, []); listKey = key; }
    else if (value.startsWith('[') && value.endsWith(']')) meta.set(key, parseInlineList(value));
    else meta.set(key, unquote(value));
  }
  return { meta, body: lines.slice(end + 1).join('\n'), hasBlock: true };
}

const pick = (meta: Map<string, FrontValue>, keys: string[]): string => {
  for (const k of keys) { const v = meta.get(k); const s = Array.isArray(v) ? v.join('、') : v; if (s) return s; }
  return '';
};

const KIND_WORDS: Record<string, MemoryEntry['kind']> = {
  node: 'node', 節點側寫: 'node', 節點: 'node', case: 'case', 判例: 'case', 解法紀錄: 'case', 解法: 'case',
  knowledge: 'knowledge', 專案知識: 'knowledge', 知識: 'knowledge', preference: 'preference', 偏好: 'preference', 使用者偏好: 'preference',
  meeting: 'meeting', 會議: 'meeting', 會議紀錄: 'meeting', memoir: 'memoir', 回憶錄: 'memoir',
};

/** 子類只特別處理 decision / bookmark 英文寫法(轉成 決策 / 書籤);其他寫法原樣保留(去頭尾空白),使用者自己的分類不會被吃掉。 */
export function normalizeSubtype(v: string): string {
  const t = v.trim();
  return /^decision$/i.test(t) ? '決策' : /^bookmark$/i.test(t) ? '書籤' : t;
}

/** 「2026-11-21」「2026-11-21T10:00:00」之類轉成毫秒;看不懂回傳 0。 */
function parseTime(v: string): number {
  if (!v) return 0;
  const t = Date.parse(v.replace(' ', 'T'));
  return Number.isFinite(t) ? t : 0;
}

/**
 * 一個檔案的索引資料。rel 是相對於記憶庫的路徑(用 /)。
 * 種類:屬性「種類」寫的優先,否則看所在的子資料夾。範圍:屬性優先;沒寫時節點側寫與偏好是全域,有專案的是專案,其餘全域。
 * 專案:屬性「專案ID」→「專案」→ 路徑 cases|knowledge|meetings/<專案>/ 的資料夾名稱。標題:屬性 → 內文第一個 # 標題 → 檔名。
 */
export function entryFromFile(rel: string, text: string, mtime: number, size: number): MemoryEntry {
  const { meta, body } = parseFrontMatter(text);
  const parts = rel.split('/');
  const dirKind = KIND[parts[0] as keyof typeof KIND] ?? 'knowledge';
  const kind = KIND_WORDS[pick(meta, ['種類', 'kind', 'type']).toLowerCase()] ?? dirKind;
  const folderProject = (parts[0] === 'cases' || parts[0] === 'knowledge' || parts[0] === 'meetings') && parts.length > 2 ? parts[1] : '';
  const projectId = pick(meta, ['專案ID', '專案id', 'project-id', 'projectId', '專案', 'project']) || folderProject;
  const scopeText = pick(meta, ['範圍', 'scope']);
  const scope: MemoryEntry['scope'] = /專案|project/i.test(scopeText) ? '專案' : /全域|global/i.test(scopeText) ? '全域'
    : kind === 'node' || kind === 'preference' ? '全域' : projectId ? '專案' : '全域';
  const heading = /^#\s+(.+)$/m.exec(body)?.[1].trim() ?? '';
  const title = pick(meta, ['標題', '案由', '主題', 'title', 'name']) || heading || parts[parts.length - 1].replace(/\.md$/i, '');
  return {
    path: rel, kind, scope, projectId: scope === '專案' ? projectId : '', nodeId: pick(meta, ['節點ID', '節點id', 'node-id', 'nodeId', '節點', '承辦節點', 'node']),
    title, updatedAt: parseTime(pick(meta, ['更新時間', 'updated', 'updatedAt'])) || mtime, mtime, size, status: pick(meta, ['狀態', 'status']),
    subtype: normalizeSubtype(pick(meta, ['子類', 'subtype'])),
    supersedes: pick(meta, ['取代', 'supersedes']).replace(/[\[\]]/g, '').trim(),
  };
}

/** 索引表的存取(由 Store 實作;測試可以用一個假的)。 */
export interface MemoryIndexStore {
  memoryAll(): MemoryEntry[];
  memoryPut(e: MemoryEntry): void;
  memoryDelete(path: string): void;
}

export class MemoryVault {
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private onChange: (() => void) | null = null;

  readonly dir: string;
  private index: MemoryIndexStore;

  constructor(dir: string, index: MemoryIndexStore) {
    this.dir = dir;
    this.index = index;
  }

  /** 建立資料夾與說明檔,並完整掃描一次。 */
  init(): void {
    mkdirSync(this.dir, { recursive: true });
    for (const d of VAULT_DIRS) mkdirSync(join(this.dir, d), { recursive: true });
    const readme = join(this.dir, '說明.md');
    let cur: string | null = null;
    try { cur = existsSync(readme) ? readFileSync(readme, 'utf8') : null; } catch { cur = ''; }
    const next = readmeUpdate(cur);
    if (next !== null) { try { writeFileSync(readme, next); } catch { /* 寫不進去不影響索引 */ } }
    this.rescan();
  }

  /** 目前資料夾裡的 .md 檔(只看 VAULT_DIRS 的子資料夾,深度不限),回傳相對路徑。 */
  private files(): string[] {
    const out: string[] = [];
    const walk = (abs: string, rel: string) => {
      let names;
      try { names = readdirSync(abs, { withFileTypes: true }); } catch { return; }
      for (const e of names) {
        const r = `${rel}/${e.name}`;
        if (e.isDirectory()) { if (!e.name.startsWith('_')) walk(join(abs, e.name), r); }
        else if (e.isFile() && /\.md$/i.test(e.name)) out.push(r);
      }
    };
    for (const d of VAULT_DIRS) walk(join(this.dir, d), d);
    return out;
  }

  /** 掃描整個資料夾:新增或修改過的重新解析,不見的從索引刪除,沒變的(修改時間與大小相同)不重讀。回傳有變動的筆數。 */
  rescan(): { added: number; updated: number; removed: number } {
    const known = new Map(this.index.memoryAll().map(e => [e.path, e]));
    let added = 0, updated = 0;
    for (const rel of this.files()) {
      let st;
      try { st = statSync(join(this.dir, rel)); } catch { continue; }
      const old = known.get(rel);
      known.delete(rel);
      if (old && old.mtime === Math.floor(st.mtimeMs) && old.size === st.size) continue;
      let text = '';
      try { text = readFileSync(join(this.dir, rel), 'utf8').slice(0, READ_MAX); } catch { continue; }
      this.index.memoryPut(entryFromFile(rel, text, Math.floor(st.mtimeMs), st.size));
      if (old) updated++; else added++;
    }
    for (const path of known.keys()) this.index.memoryDelete(path);
    return { added, updated, removed: known.size };
  }

  list(): MemoryEntry[] {
    return this.index.memoryAll();
  }

  /**
   * 監看資料夾:有檔案變動就等一下(去抖動,編輯器存檔常連續觸發好幾次)再重新掃描。
   * 監看失敗(例如網路磁碟不支援)不影響使用,只是外部修改要等下次啟動才會讀到。
   */
  watch(onChange?: () => void, debounceMs = 300): void {
    this.onChange = onChange ?? null;
    if (this.watcher) return;
    try {
      this.watcher = watch(this.dir, { recursive: true }, () => {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          this.timer = null;
          const r = this.rescan();
          if (r.added || r.updated || r.removed) this.onChange?.();
        }, debounceMs);
      });
      this.watcher.on('error', () => this.unwatch());
    } catch { this.watcher = null; }
  }

  unwatch(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.watcher?.close();
    this.watcher = null;
  }
}
