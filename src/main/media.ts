import { randomBytes } from 'node:crypto';
import { protocol } from 'electron';
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 對話裡的圖片:工具結果帶回來的圖片存成檔案放這裡,並提供受限的讀檔。
 *
 * 讀檔只允許兩個根目錄:節點的工作目錄,以及主控台自己的媒體資料夾。
 * 路徑先在字面上檢查是否落在根目錄內(不在就不碰檔案系統,避免 UNC 路徑觸發對外連線),
 * 再用 realpath 解開符號連結與 junction 重新檢查一次;只回應圖片副檔名,且有大小上限。
 * SVG 可能夾帶指令碼,不支援。
 */
export const FILE_SCHEME = 'nexus-file';

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
};
const EXT_OF: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/bmp': '.bmp' };
/** 讀取時的單檔上限。 */
const MAX_SERVE = 20 * 1024 * 1024;
/** 存檔時的單張上限,以及每個節點最多保留的張數與總量;超過就從最舊的開始清。 */
const MAX_SAVE = 10 * 1024 * 1024;
const MAX_FILES = 60;
const MAX_TOTAL = 100 * 1024 * 1024;
/** 媒體資料夾超過這段時間沒有新圖片就在啟動時清掉。 */
const STALE_MS = 30 * 86400000;

let root = '';

export function initMedia(dataDir: string): void {
  root = join(dataDir, 'media');
  try {
    mkdirSync(root, { recursive: true });
    for (const d of readdirSync(root, { withFileTypes: true })) {
      const p = join(root, d.name);
      if (d.isDirectory() && Date.now() - statSync(p).mtimeMs > STALE_MS) rmSync(p, { recursive: true, force: true });
    }
  } catch { /* 清不掉不影響運作 */ }
}

const safeId = (id: string) => /^[\w-]{1,80}$/.test(id);

/** 節點終止且無法再接回時,把它的圖片一併刪掉。 */
export function removeMedia(agentId: string): void {
  if (!root || !safeId(agentId)) return;
  try { rmSync(join(root, agentId), { recursive: true, force: true }); } catch { /* 略過 */ }
}

/** 每個節點只保留最近的圖片。 */
function prune(dir: string): void {
  const files = readdirSync(dir).map(name => { const p = join(dir, name); const s = statSync(p); return { p, size: s.size, t: s.mtimeMs }; }).sort((a, b) => a.t - b.t);
  let total = files.reduce((n, f) => n + f.size, 0);
  while (files.length && (files.length > MAX_FILES || total > MAX_TOTAL)) {
    const f = files.shift()!;
    total -= f.size;
    try { unlinkSync(f.p); } catch { /* 略過 */ }
  }
}

/** 把工具結果裡的 base64 圖片存成檔案,回傳路徑;格式不支援或太大時回傳 null。 */
export function saveImage(agentId: string, data: string | Buffer, mime: string): string | null {
  const ext = EXT_OF[String(mime).toLowerCase()];
  if (!root || !ext || !safeId(agentId)) return null;
  // base64 換算成位元組約為 3/4,先粗估避免解碼過大的字串
  if (typeof data === 'string' && data.length > MAX_SAVE * 1.4) return null;
  const buf = typeof data === 'string' ? Buffer.from(data, 'base64') : data;
  if (!buf.length || buf.length > MAX_SAVE) return null;
  try {
    const dir = join(root, agentId);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${Date.now()}-${randomBytes(4).toString('hex')}${ext}`);
    writeFileSync(file, buf);
    prune(dir);
    return file;
  } catch {
    return null;
  }
}

/**
 * agent 看過或產生的本機圖片:在工作目錄內就直接引用;在外面就複製一份到媒體資料夾,
 * 讓對話視窗不必開放工作目錄以外的路徑。
 */
export function imageFromFile(agentId: string, cwd: string, file: string): string | null {
  const ok = allowedPath(cwd, file);
  if (ok) return ok;
  const ext = extname(file).toLowerCase();
  if (!MIME[ext] || isUnc(file) || !isAbsolute(file)) return null;
  try {
    const s = statSync(file);
    if (!s.isFile() || s.size > MAX_SAVE) return null;
    return saveImage(agentId, readFileSync(file), MIME[ext]);
  } catch {
    return null;
  }
}

/** \\server\share、//server/share、\\?\ 與 \\.\ 開頭的路徑。 */
const isUnc = (p: string) => /^[\\/]{2}/.test(p);

/** child 是否在 parent 之內(不含 parent 本身);Windows 上不分大小寫。 */
function inside(parent: string, child: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const rel = relative(norm(parent), norm(child));
  return rel !== '' && !isAbsolute(rel) && rel.split(sep)[0] !== '..';
}

function real(p: string): string | null {
  try { return realpathSync.native(p); } catch { return null; }
}

/**
 * 檢查要求的路徑是否可以讀:相對路徑以 cwd 為基準。通過時回傳解析後的實際路徑,否則 null。
 * cwd 為 null 表示節點不存在,只剩媒體資料夾可讀。
 */
export function allowedPath(cwd: string | null, requested: string): string | null {
  if (typeof requested !== 'string' || !requested || requested.length > 4096 || requested.includes('\0')) return null;
  let p = requested.trim();
  if (/^file:/i.test(p)) { try { p = fileURLToPath(p); } catch { return null; } }
  if (isUnc(p)) return null;
  if (!isAbsolute(p) && !cwd) return null;
  const abs = resolve(cwd ?? root, p);
  if (!MIME[extname(abs).toLowerCase()]) return null;
  // 先做字面上的檢查:不在任何允許的根目錄內就不碰檔案系統
  const roots = [cwd, root].filter((r): r is string => !!r && isAbsolute(r));
  if (!roots.some(r => inside(resolve(r), abs))) return null;
  // 再解開符號連結與 junction,確認實際位置仍在允許的根目錄內
  const target = real(abs);
  if (!target || (isUnc(target) && !roots.some(r => isUnc(r)))) return null;
  if (!MIME[extname(target).toLowerCase()]) return null;
  const realRoots = roots.map(real).filter((r): r is string => !!r);
  if (!realRoots.some(r => inside(r, target))) return null;
  try {
    const s = statSync(target);
    if (!s.isFile() || s.size > MAX_SERVE) return null;
  } catch {
    return null;
  }
  return target;
}

/** 讀出允許的圖片;不允許或讀不到時回傳 null。 */
export function readAllowed(cwd: string | null, requested: string): { body: Buffer; mime: string } | null {
  const file = allowedPath(cwd, requested);
  if (!file) return null;
  try {
    return { body: readFileSync(file), mime: MIME[extname(file).toLowerCase()] };
  } catch {
    return null;
  }
}

/** 圖片回應共用的標頭:不讓瀏覽器猜型別,也不執行任何內容。 */
export const IMAGE_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'", 'Cache-Control': 'private, max-age=60' };

/**
 * nexus-file://img/<節點 id>?path=<路徑> → 該節點工作目錄或媒體資料夾裡的圖片。
 * cwdOf 查不到節點時回 404。
 */
export function handleFileRequests(cwdOf: (agentId: string) => string | null): void {
  protocol.handle(FILE_SCHEME, request => {
    const url = new URL(request.url);
    const agentId = decodeURIComponent(url.pathname.split('/').filter(Boolean)[0] ?? '');
    const cwd = url.host === 'img' && agentId ? cwdOf(agentId) : null;
    const hit = cwd ? readAllowed(cwd, url.searchParams.get('path') ?? '') : null;
    if (!hit) return new Response('not found', { status: 404, headers: { 'Access-Control-Allow-Origin': '*' } });
    // 畫面本身是 file:// 或開發伺服器的來源,允許跨來源讀取才能用 fetch 檢查;內容只有圖片
    return new Response(new Uint8Array(hit.body), { status: 200, headers: { ...IMAGE_HEADERS, 'Content-Type': hit.mime, 'Access-Control-Allow-Origin': '*' } });
  });
}
