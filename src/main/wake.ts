/**
 * 跨 app 喚醒網址:entropy-nexus://wake?node=<節點ID>(記憶庫管理 app 用)。純函式、不依賴 Electron,單元測試可以直接載入。
 * 網址只帶節點 ID;是否接回由主控台一定先跳確認、使用者同意後才做。不開任何本機 HTTP 端點。
 */
export const WAKE_PROTOCOL = 'entropy-nexus';

export type WakeParse = { ok: true; node: string } | { ok: false; reason: string };

/** 節點 id 只接受英數字、底線、連字號(主控台自己產生的 id 都符合),長度 1 到 64。 */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 解析並驗證一個喚醒網址。 */
export function parseWakeUrl(raw: string): WakeParse {
  let u: URL;
  try { u = new URL(String(raw ?? '').trim()); } catch { return { ok: false, reason: '網址格式不正確' }; }
  if (u.protocol !== `${WAKE_PROTOCOL}:`) return { ok: false, reason: '不是主控台的網址' };
  // entropy-nexus://wake?... 的 host 是 wake;容許結尾斜線
  if (u.hostname.toLowerCase() !== 'wake' || !/^\/*$/.test(u.pathname)) return { ok: false, reason: '不支援這個動作' };
  const nodes = u.searchParams.getAll('node');
  if (nodes.length !== 1 || !ID_RE.test(nodes[0])) return { ok: false, reason: '節點 ID 不正確' };
  return { ok: true, node: nodes[0] };
}

/** 從命令列參數(Windows 第二個執行個體)找出喚醒網址;沒有就是 null。 */
export function findWakeUrl(argv: string[]): string | null {
  return argv.find(a => typeof a === 'string' && a.toLowerCase().startsWith(`${WAKE_PROTOCOL}://`)) ?? null;
}
