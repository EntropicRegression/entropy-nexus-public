import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
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
const quote = (v: string) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`;

/** 把屬性寫成 YAML 區塊(只用到純量與單層清單;null、undefined 的欄位略過)。屬性值也會先遮罩。 */
export function serializeFrontMatter(meta: Record<string, MetaValue>): string {
  const lines = ['---'];
  for (const [k, raw] of Object.entries(meta)) {
    if (raw === null || raw === undefined) continue;
    if (Array.isArray(raw)) {
      const items = raw.map(x => maskSecrets(String(x)).text).map(x => (needsQuote(x) || /,/.test(x) ? quote(x) : x));
      lines.push(`${k}: [${items.join(', ')}]`);
    } else {
      const v = maskSecrets(String(raw)).text;
      lines.push(`${k}: ${needsQuote(v) ? quote(v) : v}`);
    }
  }
  lines.push('---');
  return lines.join('\n') + '\n';
}

interface WriteRecord { mtime: number; size: number }
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
  if (!rec) return true;
  const st = statSync(abs);
  return Math.floor(st.mtimeMs) !== rec.mtime || st.size !== rec.size;
}

export interface WriteResult {
  /** 相對於記憶庫的路徑(用 /)。 */
  path: string;
  action: 'created' | 'replaced' | 'appended';
  /** 遮罩的處數(內文加屬性)。 */
  masked: number;
}

/**
 * 寫入一筆記憶。rel 是相對於記憶庫的路徑(例如 `nodes/Hagemi.md`、`cases/<專案>/2026-0003-案由.md`)。
 * - 檔案不存在:建立。
 * - 檔案存在、而且只有 agent 寫過:mode 為 replace 時整份取代,append 時附加。
 * - 檔案被使用者改過:一律改成附加一段「## 主控台補充(時間)」,不動使用者的內容。
 */
export function writeMemory(vault: string, rel: string, meta: Record<string, MetaValue>, body: string, mode: 'replace' | 'append' = 'replace', now: Date = new Date()): WriteResult {
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
    text = serializeFrontMatter(meta) + '\n' + m.text.trim() + '\n';
  } else if (mode === 'replace' && !editedByOthers(vault, relPath)) {
    action = 'replaced';
    text = serializeFrontMatter(meta) + '\n' + m.text.trim() + '\n';
  } else {
    action = 'appended';
    const stamp = now.toISOString().slice(0, 16).replace('T', ' ');
    text = readFileSync(abs, 'utf8').replace(/\s*$/, '') + `\n\n## 主控台補充(${stamp})\n\n` + m.text.trim() + '\n';
  }
  const tmp = `${abs}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, abs);
  const st = statSync(abs);
  const reg = readRegistry(vault);
  reg[relPath] = { mtime: Math.floor(st.mtimeMs), size: st.size };
  saveRegistry(vault, reg);
  if (!Number.isFinite(masked)) masked = 0;
  return { path: relPath, action, masked };
}
