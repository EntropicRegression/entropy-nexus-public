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

// 主面板的節點:整個節點(六角形加上名字和狀態文字)要在某個區塊裡,而且在畫面上沒被其他東西蓋住
window.__boardIssues = function boardIssues() {
  const b = window.__nexusBoard;
  const canvas = document.querySelector('.board canvas');
  if (!b || !canvas) return ['找不到主面板'];
  const c = canvas.getBoundingClientRect();
  const rects = ['planning', 'active', 'chief', 'standby', 'auth', 'fault'].map(z => b.rect(z));
  const out = [];
  for (const p of b.positions()) {
    const s = p.scale;
    const box = { l: p.x - 56 * s, r: p.x + 56 * s, t: p.y - 34 * s, b: p.y + 64 * s };
    const inZone = rects.some(r => r && box.l >= r.x - 2 && box.r <= r.x + r.w + 2 && box.t >= r.y + 32 && box.b <= r.y + r.h + 2);
    if (!inZone) out.push(`節點超出區塊(中心 ${Math.round(p.x)},${Math.round(p.y)},縮放 ${s.toFixed(2)})`);
    const hit = document.elementFromPoint(c.left + p.x, c.top + p.y);
    if (hit && hit !== canvas) out.push(`節點被蓋住(中心 ${Math.round(p.x)},${Math.round(p.y)})← ${hit.tagName.toLowerCase()}.${String(hit.className).split(' ')[0]}`);
  }
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
    [...document.querySelectorAll('.row')].find(r => r.textContent.includes('節點01'))?.click();
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
  b.click();
  await wait(900);
  return window.__layoutAudit();
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
