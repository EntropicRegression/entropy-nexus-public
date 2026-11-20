// 驗收:主面板的版面計算(純函式):區塊依節點數分配大小、節點不會超出區塊、排不下時收進「另外 N 個」。
// 用法:在 app 資料夾執行 node tests/board-layout.test.mjs(Node 22.18 以上可直接載入 .ts)
import assert from 'node:assert/strict';
import { planBoard, slotAt, centerOf, ZONES, MIN_ZOOM, NODE_TOP, NODE_BOTTOM } from '../src/renderer/src/board-layout.ts';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('[ok]', name); };
const counts = (o = {}) => ({ planning: 0, active: 0, chief: 0, standby: 0, auth: 0, fault: 0, ...o });

/** 檢查一份版面:區塊在面板內、互不重疊;每一格(節點與「另外 N 個」)都在自己的區塊裡、標題列下方,而且彼此不重疊。 */
function check(w, h, c, label) {
  const plan = planBoard(w, h, c);
  const zs = ZONES.map(z => [z, plan.zones[z]]);
  for (const [z, p] of zs) {
    const r = p.rect;
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= w + 0.5 && r.y + r.h <= h + 0.5, `${label}:${z} 區塊超出面板 ${JSON.stringify(r)}`);
    assert.ok(r.w >= (w < 700 ? 52 : 85) && r.h >= p.header + 8, `${label}:${z} 區塊太小 ${JSON.stringify(r)}`);
    for (const [z2, p2] of zs) {
      if (z2 === z) continue;
      const q = p2.rect;
      assert.ok(r.x + r.w <= q.x || q.x + q.w <= r.x || r.y + r.h <= q.y || q.y + q.h <= r.y, `${label}:${z} 和 ${z2} 重疊`);
    }
    const n = z === 'chief' ? 1 : c[z];
    assert.equal(p.shown + p.hidden, n, `${label}:${z} 顯示加收起來的數量不等於節點數`);
    if (z === 'chief' && w >= 460) assert.equal(p.hidden, 0, `${label}:總管不能被收起來`);
    assert.ok(p.zoom >= MIN_ZOOM - 1e-9, `${label}:${z} 縮放 ${p.zoom} 低於下限`);
    if (p.collapsed) { assert.equal(p.shown, 0, `${label}:${z} 收合時不該畫節點`); continue; }
    const total = p.shown + (p.hidden ? 1 : 0);
    const cells = [];
    for (let i = 0; i < total; i++) cells.push(z === 'chief' || p.shown === 0 ? centerOf(p) : slotAt(p, i, total));
    cells.forEach((s, i) => {
      const box = { l: s.x - 56 * p.zoom, r: s.x + 56 * p.zoom, t: s.y - NODE_TOP * p.zoom, b: s.y + NODE_BOTTOM * p.zoom };
      assert.ok(box.l >= r.x - 0.01 && box.r <= r.x + r.w + 0.01 && box.t >= r.y + p.header - 0.01 && box.b <= r.y + r.h + 0.01, `${label}:${z} 第 ${i} 格超出區塊 ${JSON.stringify({ box, r, zoom: p.zoom })}`);
      cells.slice(0, i).forEach(o => assert.ok(Math.abs(o.x - s.x) >= 112 * p.zoom - 0.01 || Math.abs(o.y - s.y) >= (NODE_TOP + NODE_BOTTOM) * p.zoom - 0.01, `${label}:${z} 第 ${i} 格和別格重疊`));
    });
  }
  return plan;
}
const hiddenOf = plan => ZONES.reduce((s, z) => s + plan.zones[z].hidden, 0);

// 主面板的實際大小:視窗扣掉頂部列 44、事件紀錄 112、右側欄 280;對話視窗打開時只剩上方一條
const SIZES = [[1160, 744], [820, 544], [1000, 494], [810, 384], [680, 404], [1160, 311], [820, 208], [1000, 158], [810, 144], [680, 144]];

test('沒有節點:格狀,維持原本的比例(左欄 26%、上列 48%)', () => {
  const p = check(1160, 744, counts(), '空');
  assert.equal(p.mode, 'grid');
  assert.deepEqual(p.zones.planning.rect, { x: 16, y: 16, w: 290, h: 335 });
  assert.equal(p.zones.standby.rect.w, 290);
  assert.equal(p.zones.chief.rect.w, 170);
});

test('13 個待命節點在大螢幕:全部顯示、不縮小,待命區變寬', () => {
  const p = check(1160, 744, counts({ standby: 13 }), '13 待命');
  assert.equal(hiddenOf(p), 0);
  assert.equal(p.zones.standby.zoom, 1);
  assert.ok(p.zones.standby.rect.w > 500, JSON.stringify(p.zones.standby.rect));
  assert.ok(p.zones.auth.rect.w >= 132 && p.zones.fault.rect.w >= 132);
});

test('13 個待命節點:各種視窗大小下都不超出區塊,縮放不低於下限', () => {
  for (const [w, h] of SIZES) {
    const p = check(w, h, counts({ standby: 13 }), `${w}×${h}`);
    // 夠大的面板不應該收起任何節點
    if (h >= 380 && w >= 800) assert.equal(hiddenOf(p), 0, `${w}×${h} 不該有節點被收起來 ${JSON.stringify(p.zones.standby)}`);
  }
});

test('面板很矮(對話視窗打開):改成橫排、精簡標題,排不下的收進「另外 N 個」', () => {
  const p = check(810, 144, counts({ standby: 13 }), '810×144');
  assert.equal(p.mode, 'strip');
  assert.equal(p.compact, true);
  assert.ok(p.zones.standby.hidden > 0 && p.zones.standby.shown >= 1, JSON.stringify(p.zones.standby));
  assert.ok(p.zones.standby.rect.w > p.zones.auth.rect.w * 2, '擠的區塊要比空的區塊寬');
});

test('30 個節點分散在各區塊:不超出、數量對得上;小視窗出現「另外 N 個」', () => {
  const c = counts({ standby: 14, active: 7, planning: 3, auth: 3, fault: 2 });
  for (const [w, h] of SIZES) check(w, h, c, `分散 ${w}×${h}`);
  assert.equal(hiddenOf(planBoard(1160, 744, c)), 0);
  assert.ok(hiddenOf(planBoard(810, 384, c)) > 0);
});

test('隨機的節點數與面板大小:版面永遠合法', () => {
  let seed = 12345;
  const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let i = 0; i < 4000; i++) {
    const w = 440 + rnd(1640), h = 130 + rnd(900);
    const c = counts({ standby: rnd(40), active: rnd(4) ? rnd(8) : rnd(40), planning: rnd(6), auth: rnd(3) ? 0 : rnd(12), fault: rnd(3) ? 0 : rnd(12) });
    check(w, h, c, `隨機 ${w}×${h} ${JSON.stringify(c)}`);
  }
});

test('節點變多時縮放只會變小或不變', () => {
  let last = 1;
  for (let n = 0; n <= 60; n++) {
    const p = check(1160, 744, counts({ standby: n }), `待命 ${n}`);
    assert.ok(p.zones.standby.zoom <= last + 1e-9, `待命 ${n} 個時縮放反而變大`);
    last = p.zones.standby.zoom;
  }
});

test('很窄的面板(瀏覽器 760 寬):主畫面仍然畫得出節點;對話視窗打開時區塊收合成窄條,總管仍然看得到', () => {
  const c = counts({ standby: 13 });
  const main = check(480, 404, c, '480×404');
  assert.ok(main.zones.standby.shown >= 2 && main.zones.standby.zoom >= MIN_ZOOM, JSON.stringify(main.zones.standby));
  const dlg = check(480, 144, c, '480×144');
  assert.equal(dlg.mode, 'strip');
  assert.equal(dlg.zones.chief.hidden, 0);
  assert.ok(dlg.zones.chief.zoom >= MIN_ZOOM);
  for (const z of ZONES) assert.ok(dlg.zones[z].rect.w >= 52, `${z} 寬度 ${dlg.zones[z].rect.w}`);
  assert.equal(dlg.zones.standby.shown + dlg.zones.standby.hidden, 13);
});

console.log(`通過:${passed} 項`);
