// 手機端角色卡路由的外部測試(由 tests/persona-fake.sh 呼叫):配對、未配對被拒、跳脫被拒、讀寫。
// 用法:node tests/persona-remote.js <http://127.0.0.1:埠> <配對碼>
const [base, code] = process.argv.slice(2);
const call = async (path, body, token) => {
  const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return [r.status, (await r.text()).slice(0, 140)];
};
const q = c => `/api/persona?character=${encodeURIComponent(c)}`;
(async () => {
  const [st, pr] = await call('/pair', { code, name: 'persona-test' });
  if (st !== 200) { console.log('[remote] 配對失敗', st, pr); return; }
  const token = JSON.parse(pr).token;
  console.log('[remote] 未配對讀取', ...(await call(q('審查員'))));
  console.log('[remote] 未配對寫入', ...(await call('/api/persona', { character: '審查員', text: 'x' })));
  console.log('[remote] 讀取', ...(await call(q('審查員'), null, token)));
  console.log('[remote] 跳脫讀取 ..', ...(await call(q('..'), null, token)));
  console.log('[remote] 跳脫讀取 ..\\x', ...(await call(q('..\\x'), null, token)));
  console.log('[remote] 跳脫寫入 ../evil', ...(await call('/api/persona', { character: '../evil', text: 'pwned' }, token)));
  console.log('[remote] 缺少內容', ...(await call('/api/persona', { character: '審查員' }, token)));
  console.log('[remote] 寫入', ...(await call('/api/persona', { character: '審查員', text: 'REMOTE 手機改的角色卡\n第二行 "引號"' }, token)));
  console.log('[remote] 寫入後讀取', ...(await call(q('審查員'), null, token)));
})().catch(e => console.log('[remote] 失敗', e.message));
