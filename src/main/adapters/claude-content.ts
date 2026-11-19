import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { attachmentKind } from '../../shared/types';
import { withPaths } from './adapter';

type Json = Record<string, any>;

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const MB = 1024 * 1024;
/** API 對單張圖片的上限是 base64 後 5 MB,換算回原始檔約 3.75 MB。 */
export const CLAUDE_IMAGE_MAX = 3.75 * MB;
/** 單一 PDF 的上限;API 整個請求上限 32 MB,base64 會膨脹三分之一,留一些給對話本身。 */
export const CLAUDE_PDF_MAX = 10 * MB;
/** 一則訊息內嵌附件的原始大小總和上限。 */
export const CLAUDE_TOTAL_MAX = 20 * MB;

const mb = (n: number) => `${(n / MB).toFixed(1)} MB`;

/**
 * 把指令文字與附件組成 Claude Code stream-json 的 user 訊息內容。
 * 圖片用 base64 image 區塊、PDF 用 base64 document 區塊內嵌;其他類型、讀不到或超過上限的
 * 改成在文字後附上路徑,並回傳原因讓呼叫端用 note 事件告訴使用者。
 */
export function claudeContent(text: string, paths: string[]): { content: string | Json[]; fallback: Array<{ path: string; reason: string }> } {
  const blocks: Json[] = [];
  const fallback: Array<{ path: string; reason: string }> = [];
  let total = 0;
  for (const path of paths) {
    const kind = attachmentKind(path);
    try {
      if (kind !== 'image' && kind !== 'pdf') throw new Error('Claude Code 只能內嵌圖片與 PDF');
      const size = statSync(path).size;
      const max = kind === 'image' ? CLAUDE_IMAGE_MAX : CLAUDE_PDF_MAX;
      if (size > max) throw new Error(`檔案 ${mb(size)},超過內嵌上限 ${mb(max)}`);
      if (total + size > CLAUDE_TOTAL_MAX) throw new Error(`這則訊息的附件合計超過 ${mb(CLAUDE_TOTAL_MAX)}`);
      const data = readFileSync(path).toString('base64');
      total += size;
      blocks.push(kind === 'image'
        ? { type: 'image', source: { type: 'base64', media_type: IMAGE_TYPES[extname(path).toLowerCase()], data } }
        : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      fallback.push({ path, reason: e.code === 'ENOENT' ? '找不到檔案' : e.code ? `讀取失敗(${e.code})` : e.message });
    }
  }
  const body = withPaths(text, fallback.map(f => f.path));
  return { content: blocks.length ? [...blocks, { type: 'text', text: body }] : body, fallback };
}
