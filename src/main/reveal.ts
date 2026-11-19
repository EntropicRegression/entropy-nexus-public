import { shell } from 'electron';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 回覆裡以行內程式碼寫出的檔案或資料夾路徑,點一下在檔案總管中顯示。
 *
 * 只做「顯示」:資料夾直接打開,檔案則打開它所在的資料夾並選取,絕不執行或用預設程式開啟檔案。
 * 相對路徑依序以節點的工作目錄、工作目錄往上幾層(agent 常從版本庫根目錄寫路徑)、使用者的家目錄為基準,
 * 第一個實際存在的才算數;都不存在就不是連結。網路路徑不處理,避免點一下就對外連線。
 */
const UP_LEVELS = 4;

function exists(p: string): 'dir' | 'file' | null {
  try { const s = statSync(p); return s.isDirectory() ? 'dir' : s.isFile() ? 'file' : null; } catch { return null; }
}

/** 把文字解析成實際存在的路徑;不像路徑或找不到時回傳 null。 */
export function resolveLocal(cwd: string | null, text: unknown): { path: string; kind: 'dir' | 'file' } | null {
  if (typeof text !== 'string') return null;
  let p = text.trim();
  if (!p || p.length > 1000) return null;
  // Markdown 連結的目標可能是百分比編碼的相對路徑(docs/my%20file.md#L3):原樣找不到時再用解碼後的試一次
  const direct = resolveOne(cwd, p);
  if (direct || /^file:/i.test(p) || !/%[0-9a-f]{2}|#/i.test(p)) return direct;
  try { return resolveOne(cwd, decodeURIComponent(p.replace(/#.*$/, ''))); } catch { return null; }
}

function resolveOne(cwd: string | null, text: string): { path: string; kind: 'dir' | 'file' } | null {
  let p = text;
  if (/[\n\0<>"|*]/.test(p) || (!/^file:/i.test(p) && p.includes('?'))) return null;
  // file 網址:去掉 #L12 這類片段與查詢字串再轉成路徑(百分比編碼由 fileURLToPath 還原)
  if (/^file:/i.test(p)) { try { p = fileURLToPath(p.replace(/[#?].*$/, '')); } catch { return null; } }
  else if (/^[a-z][\w+.-]*:\/\//i.test(p)) return null;
  if (/^[\\/]{2}/.test(p)) return null;
  // src/foo.ts:12 或 src/foo.ts:12:5 這種帶行號的寫法
  p = p.replace(/:\d+(:\d+)?$/, '');
  if (/^~(?=$|[\\/])/.test(p)) p = join(homedir(), p.slice(1));
  // 磁碟機代號後面的冒號以外不該再有冒號
  if (/:/.test(p.replace(/^[a-zA-Z]:/, ''))) return null;
  const hit = (abs: string) => { const kind = exists(abs); return kind ? { path: abs, kind } : null; };
  if (isAbsolute(p)) return /^[\\/]/.test(p) && process.platform === 'win32' ? null : hit(resolve(p));
  const bases: string[] = [];
  if (cwd && isAbsolute(cwd)) {
    let dir = resolve(cwd);
    for (let i = 0; i <= UP_LEVELS; i++) { bases.push(dir); const up = dirname(dir); if (up === dir) break; dir = up; }
  }
  // 沒有分隔符號的單一名稱只在工作目錄裡找,避免把一般的單字對到上層或家目錄的資料夾
  const bare = !/[\\/]/.test(p);
  if (!bare) bases.push(homedir());
  for (const base of bare ? bases.slice(0, 1) : bases) { const r = hit(resolve(base, p)); if (r) return r; }
  return null;
}

/** 在檔案總管中顯示;找不到時丟出錯誤讓畫面提示。 */
export async function revealLocal(cwd: string | null, text: unknown): Promise<void> {
  const r = resolveLocal(cwd, text);
  if (!r) throw new Error('找不到這個檔案或資料夾');
  if (r.kind === 'dir') { const err = await shell.openPath(r.path); if (err) throw new Error(err); }
  else shell.showItemInFolder(r.path);
}
