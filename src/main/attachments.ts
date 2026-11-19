import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative, resolve, isAbsolute } from 'node:path';
import { nativeImage } from 'electron';
import { attachmentKind } from '../shared/types';

/**
 * 桌面版附件的輔助功能:剪貼簿貼上的圖片存成暫存檔,以及送出前的縮圖。
 * 縮圖只讀這次執行期間由使用者選取、貼上或拖放登記過的路徑,畫面不能拿它讀任意檔案。
 */
let dir = '';
const allowed = new Set<string>();
const PASTE_MAX = 10 * 1024 * 1024;
const PREVIEW_RAW_MAX = 4 * 1024 * 1024;
const PASTE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const key = (p: string) => resolve(p).toLowerCase();

/** 啟動時建立暫存資料夾,並清掉七天前貼上的檔案。 */
export function initAttachments(dataDir: string): void {
  dir = join(dataDir, 'attachments');
  try {
    mkdirSync(dir, { recursive: true });
    for (const f of readdirSync(dir)) { const p = join(dir, f); if (Date.now() - statSync(p).mtimeMs > 7 * 86400000) unlinkSync(p); }
  } catch { /* 清不掉不影響運作 */ }
}

/** 主控台自己存放附件的資料夾:桌面貼上的(attachments)與遠端裝置上傳的(uploads)。 */
export function attachmentDirs(): string[] {
  return dir ? [dir, join(dir, '..', 'uploads')] : [];
}

const within = (parent: string, child: string): boolean => { const rel = relative(resolve(parent).toLowerCase(), resolve(child).toLowerCase()); return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel); };
const STAGE_MAX = 50 * 1024 * 1024;

/**
 * 給只能讀工作區內檔案的後台(Antigravity)用:附件不在節點的工作目錄、也不在主控台的附件資料夾時,
 * 複製一份到附件資料夾並回傳新路徑(那個資料夾會在啟動 CLI 時加進工作區)。已經讀得到的原樣回傳;
 * 太大或複製失敗時回傳 null,由呼叫端告訴使用者。複製的檔案和貼上的圖片一樣七天後清掉。
 */
export function stageAttachment(path: string, cwd: string): string | null {
  if (within(cwd, path) || attachmentDirs().some(d => within(d, path))) return path;
  if (!dir) return null;
  try {
    const s = statSync(path);
    if (!s.isFile() || s.size > STAGE_MAX) return null;
    const stem = basename(path, extname(path)).replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 60);
    const file = join(dir, `file-${Date.now()}-${randomBytes(3).toString('hex')}${stem ? `-${stem}` : ''}${extname(path).toLowerCase()}`);
    copyFileSync(path, file);
    allowed.add(key(file));
    return file;
  } catch {
    return null;
  }
}

/** 登記使用者選取或拖放的檔案,之後才能讀縮圖。 */
export function allowAttachments(paths: unknown[]): void {
  for (const p of paths) if (typeof p === 'string' && p) allowed.add(key(p));
}

/** 把貼上的圖片存成 attachments/paste-<時間戳>-<亂數>.<副檔名>,回傳路徑。 */
export function savePastedImage(mime: string, data: ArrayBuffer): string {
  const ext = PASTE_TYPES[String(mime).toLowerCase()];
  if (!ext) throw new Error('只能貼上 PNG、JPEG、GIF 或 WebP 圖片');
  if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) throw new Error('貼上的內容不是圖片');
  const buf = Buffer.from(data as ArrayBuffer);
  if (buf.length > PASTE_MAX) throw new Error(`貼上的圖片超過 ${PASTE_MAX / 1024 / 1024} MB`);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const file = join(dir, `paste-${stamp}-${randomBytes(3).toString('hex')}.${ext}`);
  writeFileSync(file, buf);
  allowed.add(key(file));
  return file;
}

/** 附件的縮圖(data URL)。不是圖片、沒有登記過或讀不到時回傳 null。 */
export function attachmentPreview(path: string): string | null {
  if (typeof path !== 'string' || !allowed.has(key(path)) || attachmentKind(path) !== 'image') return null;
  try {
    const img = nativeImage.createFromPath(path);
    if (!img.isEmpty()) {
      const { width } = img.getSize();
      return (width > 240 ? img.resize({ width: 240, quality: 'good' }) : img).toDataURL();
    }
    // nativeImage 讀不了 GIF、WebP,夠小的話直接用原檔
    const mime = path.toLowerCase().endsWith('.gif') ? 'image/gif' : path.toLowerCase().endsWith('.webp') ? 'image/webp' : '';
    if (!mime || statSync(path).size > PREVIEW_RAW_MAX) return null;
    return `data:${mime};base64,${readFileSync(path).toString('base64')}`;
  } catch {
    return null;
  }
}
