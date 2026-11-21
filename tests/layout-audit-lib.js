// 版面檢查的共用函式(桌面版與瀏覽器版的版面驗收都會先載入這個檔案)。
// window.__layoutAudit() 找出畫面上「點不到」的操作元件,回傳問題清單(字串陣列):
// - 超出畫面而且沒有捲動區可以捲到它
// - 所在的捲動區本身超出畫面(捲動區的下半段點不到)
// - 被不能捲動的容器裁掉一部分
// - 在畫面內但被其他元素蓋住(中心點點下去會點到別的東西)
// 另外檢查整頁是否出現水平或垂直捲動(本程式的版面設計上不應該捲動整頁)。
// 浮動面板(頂部的語音、遠端、顯示、快捷鍵、說明)本來就會蓋住底下的東西,被它們蓋住不算問題
const FLOATING = '.remote, .topbar-pop, .keys, .limit-help';
window.__layoutAudit = function layoutAudit() {
  const W = window.innerWidth, H = window.innerHeight;
  const issues = [];
  const desc = el => {
    if (!el) return '(無)';
    const text = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || el.getAttribute('placeholder') || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 24);
    const cls = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    return `${el.tagName.toLowerCase()}${cls}${text ? `「${text}」` : ''}`;
  };
  const scrollable = p => {
    const cs = getComputedStyle(p);
    const y = /(auto|scroll)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 1;
    const x = /(auto|scroll)/.test(cs.overflowX) && p.scrollWidth > p.clientWidth + 1;
    return y || x;
  };
  const visible = el => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    for (let p = el; p; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    }
    return true;
  };
  const els = [...document.querySelectorAll('button, input:not([type=hidden]), select, textarea, [role=tab], a[href]')]
    .filter(el => el.id !== 'test-files' && visible(el));
  for (const el of els) {
    const r = el.getBoundingClientRect();
    const name = desc(el);
    // 最近的可捲動祖先;捲動區內被捲走的元件不算問題,只要捲動區本身在畫面內
    let sc = null;
    for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) if (scrollable(p)) { sc = p; break; }
    const box = sc ? sc.getBoundingClientRect() : { top: 0, left: 0, bottom: H, right: W };
    if (sc && (box.bottom > H + 1 || box.right > W + 1 || box.top < -1 || box.left < -1)) {
      issues.push(`捲動區超出畫面:${name}(捲動區 ${desc(sc)} 底邊 ${Math.round(box.bottom)} / 畫面 ${H})`);
      continue;
    }
    const outOfScreen = r.bottom > H + 1 || r.right > W + 1 || r.top < -1 || r.left < -1;
    if (outOfScreen && !sc) { issues.push(`超出畫面、無法捲動:${name}(${Math.round(r.left)},${Math.round(r.top)}–${Math.round(r.right)},${Math.round(r.bottom)} / 畫面 ${W}×${H})`); continue; }
    // 在捲動區的可見範圍外:捲得到,略過
    if (sc && (r.bottom <= box.top || r.top >= box.bottom || r.right <= box.left || r.left >= box.right)) continue;
    // 被不能捲動、但會裁切內容的容器切掉
    let clipped = false;
    for (let p = el.parentElement; p && p !== sc && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      const pr = p.getBoundingClientRect();
      if (r.bottom > pr.bottom + 2 || r.top < pr.top - 2 || r.right > pr.right + 2 || r.left < pr.left - 2) { issues.push(`被容器裁掉:${name}(容器 ${desc(p)})`); clipped = true; }
      break;
    }
    if (clipped) continue;
    // 被蓋住:取元件在可見範圍內的中心點
    const cx = (Math.max(r.left, box.left, 0) + Math.min(r.right, box.right, W)) / 2;
    const cy = (Math.max(r.top, box.top, 0) + Math.min(r.bottom, box.bottom, H)) / 2;
    const top = document.elementFromPoint(cx, cy);
    if (top && !el.contains(top) && !top.contains(el) && !(el.labels && [...el.labels].some(l => l.contains(top))) && !(top.closest(FLOATING) && !el.closest(FLOATING))) issues.push(`被蓋住:${name} ← ${desc(top)}`);
  }
  const de = document.documentElement;
  if (de.scrollWidth > W + 1) issues.push(`整頁出現水平捲動(${de.scrollWidth} > ${W})`);
  return [...new Set(issues)];
};

// 主面板的節點:整個節點(六角形加上名字和狀態文字)要在某個區塊裡,而且在畫面上沒被其他東西蓋住。
// 區塊本身要在面板裡、互不重疊;排不下時的「另外 N 個」標記也要在自己的區塊裡、點得到,
// 而且「畫出來的節點 + 收起來的節點」要等於全部節點(沒有節點憑空消失)。
window.__boardIssues = function boardIssues() {
  const b = window.__nexusBoard;
  const canvas = document.querySelector('.board canvas');
  if (!b || !canvas) return ['找不到主面板'];
  const c = canvas.getBoundingClientRect();
  const zones = ['planning', 'active', 'chief', 'standby', 'auth', 'fault'];
  const rects = zones.map(z => b.rect(z));
  const out = [];
  const size = b.size();
  if (Math.abs(size.w - c.width) > 1 || Math.abs(size.h - c.height) > 1) out.push(`面板回報的大小 ${size.w}×${size.h} 和畫布 ${Math.round(c.width)}×${Math.round(c.height)} 不一致`);
  rects.forEach((r, i) => {
    if (!r) { out.push(`沒有 ${zones[i]} 區塊`); return; }
    if (r.x < 0 || r.y < 0 || r.x + r.w > size.w + 1 || r.y + r.h > size.h + 1) out.push(`區塊 ${zones[i]} 超出面板(${r.x},${r.y} ${r.w}×${r.h} / ${size.w}×${size.h})`);
    if (r.w < 50 || r.h < 60) out.push(`區塊 ${zones[i]} 太小(${r.w}×${r.h})`);
    rects.slice(0, i).forEach((q, j) => { if (q && r.x < q.x + q.w && q.x < r.x + r.w && r.y < q.y + q.h && q.y < r.y + r.h) out.push(`區塊 ${zones[i]} 和 ${zones[j]} 重疊`); });
  });
  if (b.more) {
    for (const m of b.more()) {
      const r = b.rect(m.zone), s = m.scale;
      if (!(m.x - 56 * s >= r.x - 2 && m.x + 56 * s <= r.x + r.w + 2 && m.y - 34 * s >= r.y + 32 && m.y + 64 * s <= r.y + r.h + 2)) out.push(`「另外 ${m.count} 個」超出區塊 ${m.zone}(中心 ${Math.round(m.x)},${Math.round(m.y)},縮放 ${s.toFixed(2)})`);
      const hit = document.elementFromPoint(c.left + m.x, c.top + m.y);
      if (hit && hit !== canvas && !hit.closest('.board-more')) out.push(`「另外 ${m.count} 個」被蓋住 ← ${hit.tagName.toLowerCase()}.${String(hit.className).split(' ')[0]}`);
    }
    const hidden = b.hidden();
    const gone = hidden.reduce((n, h) => n + h.count, 0);
    if (b.positions().length + gone !== b.total()) out.push(`節點數對不上:畫出來 ${b.positions().length} + 收起來 ${gone} ≠ 全部 ${b.total()}`);
    for (const h of hidden) if (!b.more().some(m => m.zone === h.zone && m.count === h.count)) out.push(`區塊 ${h.zone} 收起 ${h.count} 個節點,卻沒有「另外 N 個」標記`);
  }
  for (const p of b.positions()) {
    const s = p.scale;
    const box = { l: p.x - 56 * s, r: p.x + 56 * s, t: p.y - 34 * s, b: p.y + 64 * s };
    const inZone = rects.some(r => r && box.l >= r.x - 2 && box.r <= r.x + r.w + 2 && box.t >= r.y + 32 && box.b <= r.y + r.h + 2);
    if (!inZone) out.push(`節點超出區塊(中心 ${Math.round(p.x)},${Math.round(p.y)},縮放 ${s.toFixed(2)})`);
    const hit = document.elementFromPoint(c.left + p.x, c.top + p.y);
    if (hit && hit !== canvas && !hit.closest('.board-more')) out.push(`節點被蓋住(中心 ${Math.round(p.x)},${Math.round(p.y)})← ${hit.tagName.toLowerCase()}.${String(hit.className).split(' ')[0]}`);
  }
  // 節點之間不能互相重疊(六角形與文字的範圍)
  const ps = b.positions();
  let overlaps = 0;
  ps.forEach((p, i) => ps.slice(0, i).forEach(q => { const s = Math.min(p.scale, q.scale); if (Math.abs(p.x - q.x) < 100 * s && Math.abs(p.y - q.y) < 90 * s) overlaps++; }));
  if (overlaps) out.push(`有 ${overlaps} 組節點互相重疊`);
  const tiny = b.positions().filter(p => p.scale < 0.6).length;
  if (tiny) out.push(`有 ${tiny} 個節點縮到 60% 以下(字太小)`);
  return out;
};

// 情境:打開某個畫面並檢查,回傳問題清單;畫面保持打開(截圖後呼叫 __layoutClose)
window.__layoutScene = async function layoutScene(name) {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const btn = (text, root = document) => root && [...root.querySelectorAll('button')].find(b => b.textContent.trim() === text);
  if (name === 'board') { await wait(1200); return [...window.__layoutAudit(), ...window.__boardIssues()]; }
  if (name === 'dialog') {
    window.__nexusSelect('節點01');
    await wait(1500);
    return [...window.__layoutAudit(), ...window.__boardIssues()];
  }
  if (name === 'addnode') {
    document.querySelector('button.add')?.click();
    await wait(600);
    const sel = document.querySelector('.addform select');
    if (sel && [...sel.options].some(o => o.value === 'Layout')) {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, 'Layout');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await wait(900);
    }
    return window.__layoutAudit();
  }
  if (name === 'help') { document.querySelector('.topbar button.help')?.click(); await wait(600); return window.__layoutAudit(); }
  const b = btn(name, document.querySelector('.topbar'));
  if (!b) return [`頂部找不到「${name}」按鈕(可能被擠出畫面或被隱藏)`];
  // 視窗窄的時候「快捷鍵、顯示」收在「更多」選單裡:先打開選單,確認選單裡的按鈕點得到,再點它
  const pre = [];
  if (b.offsetParent === null) {
    const more = document.querySelector('.topbar button.more-btn');
    if (!more || more.offsetParent === null) return [`頂部的「${name}」按鈕被隱藏,也沒有「更多」選單`];
    more.click();
    await wait(300);
    const r = b.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (b.offsetParent === null || r.right > innerWidth + 1 || r.bottom > innerHeight + 1 || r.left < -1 || !hit || !b.contains(hit)) pre.push(`「更多」選單裡的「${name}」點不到`);
  }
  b.click();
  await wait(900);
  if (document.querySelector('.topbar-more.open')) pre.push('點了選單項目後「更多」選單沒有收起來');
  return [...pre, ...window.__layoutAudit()];
};

window.__layoutClose = async function layoutClose() {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 4; i++) {
    const x = document.querySelector('.dialog button[aria-label="關閉"], .remote button[aria-label="關閉"], .topbar-pop button[aria-label="關閉"]');
    if (!x) break;
    x.click();
    await wait(250);
  }
  const cancel = [...(document.querySelector('.addform')?.querySelectorAll('button') ?? [])].find(b => b.textContent.trim() === '取消');
  if (cancel) { cancel.click(); await wait(250); }
  const keys = [...document.querySelectorAll('.topbar button.on')].find(b => b.textContent.trim() === '快捷鍵');
  if (keys) { keys.click(); await wait(200); }
  const help = document.querySelector('.topbar button.help.on');
  if (help) { help.click(); await wait(200); }
};

window.__LAYOUT_SCENES = [['board', '主畫面(14 個節點,13 個在待命區)'], ['dialog', '對話視窗'], ['addnode', '新增節點(選了角色)'], ['語音', '頂部「語音」'], ['遠端', '頂部「遠端」'], ['顯示', '頂部「顯示」'], ['快捷鍵', '頂部「快捷鍵」'], ['help', '頂部「?」說明']];
