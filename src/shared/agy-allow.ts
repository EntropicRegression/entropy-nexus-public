/**
 * Antigravity 的工具白名單(所有 Antigravity 節點共用)。
 *
 * 主控台用 agy 的無視窗模式(stream-json)啟動 Antigravity 節點,這個模式沒有畫面可以詢問權限:
 * 不在白名單裡、需要審核的動作一律自動拒絕(agy 回報 denied_actions)。使用者在這裡列出要放行的工具,
 * 主控台啟動節點時把它們合併進用 --settings 帶給 agy 的權限檔(permissions.allow)。
 * 規則格式和 agy 的 settings.json 相同,例如 mcp(StitchMCP/*)、mcp(StitchMCP/create_project)、read_file(<目標>)。
 *
 * 這個檔案是純函式,主行程、畫面與單元測試共用。
 */

export const AGY_ALLOW_MAX = 50;
const RULE = /^[A-Za-z_][\w-]*(\([^()\r\n]{1,300}\))?$/;

/** 一條規則是否合乎格式:工具名稱,或「工具名稱(目標)」;不允許換行與巢狀括號。 */
export const isAgyRule = (s: string): boolean => RULE.test(s);

/**
 * 整理使用者輸入的白名單:去掉空白行與重複、最多 AGY_ALLOW_MAX 條。
 * 格式不對的規則回傳在 invalid 裡(不放進清單),讓畫面提示。
 */
export function normalizeAgyAllow(input: unknown): { rules: string[]; invalid: string[] } {
  const raw = Array.isArray(input) ? input.map(String) : typeof input === 'string' ? input.split(/\r?\n/) : [];
  const rules: string[] = [];
  const invalid: string[] = [];
  for (const line of raw) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    if (!isAgyRule(s)) { invalid.push(s); continue; }
    if (!rules.includes(s) && rules.length < AGY_ALLOW_MAX) rules.push(s);
  }
  return { rules, invalid };
}

/** 啟動節點時帶給 agy 的權限設定:主控台自己需要的規則(節點互相呼叫的工具)加上使用者的白名單。 */
export function agySettings(base: string[], extra: string[]): { permissions: { allow: string[] } } {
  return { permissions: { allow: [...new Set([...base, ...extra])] } };
}
