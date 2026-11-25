/**
 * 對話裡的網址能不能交給預設瀏覽器開啟:只接受 http 與 https,而且不能帶帳號密碼
 * (https://正常網站@別的主機 這種寫法會讓人誤判實際要去的主機)。可以開就回傳正規化後的網址,不行回傳 null。
 */
export function externalUrl(href: string): string | null {
  if (typeof href !== 'string' || href.length > 4000) return null;
  let u: URL;
  try { u = new URL(href.trim()); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password || !u.hostname) return null;
  return u.href;
}
