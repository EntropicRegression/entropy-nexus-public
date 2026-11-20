// 主面板的版面計算(純函式,不碰 PixiJS;tests/board-layout.test.mjs 直接載入這個檔案驗證)。
//
// 區塊大小依節點數分配:
// - 兩種排法。「格狀」是上下兩列(規劃、執行、總管/待命、待授權、異常);「橫排」是六個區塊排成一列,
//   面板很矮(例如對話視窗打開時)或格狀排不下時使用。
// - 找出「所有節點都排得下」的最大縮放(1 → MIN_ZOOM)。每個區塊先拿到它在這個縮放下需要的寬度,
//   剩下的空間依原本的比例分給其他區塊;全部排得下時就維持原本的比例,畫面不會無故變動。
// - 縮到 MIN_ZOOM 還排不下:區塊最後一格改放「另外 N 個」,其餘節點收起來,不會溢出區塊。
// - 每個區塊最後各自取「排得下的最大縮放」,所以節點少的區塊不會跟著縮小。
import type { Zone } from '../../shared/types';

export interface Rect { x: number; y: number; w: number; h: number }

export const ZONES: Zone[] = ['planning', 'active', 'chief', 'standby', 'auth', 'fault'];
/** 一個節點在縮放 1 時佔的範圍(相對於六角形中心):左右各 56,上 34(光暈),下 64(名字與狀態文字)。 */
export const NODE_TOP = 34;
export const NODE_BOTTOM = 64;
export const CELL_W = 124;
export const CELL_H = NODE_TOP + NODE_BOTTOM;
/** 節點最小縮到 65%,再小名字就讀不出來了。 */
export const MIN_ZOOM = 0.65;
const ZOOM_STEPS = 20;
const MIN_STEP = Math.round(MIN_ZOOM * ZOOM_STEPS);
/** 標題列高度:一般 44,精簡(面板很矮時)32。 */
export const HEADER = 44;
export const HEADER_COMPACT = 32;
/** 標題列到第一列節點的間距、最後一列節點到區塊底邊的間距、節點到區塊左右邊的間距。 */
const TOP_GAP = 4;
const BOTTOM_GAP = 6;
const SIDE = 8;

export interface ZonePlan {
  rect: Rect;
  header: number;
  /** 這個區塊裡節點的縮放。 */
  zoom: number;
  cols: number;
  rows: number;
  /** 顯示幾個節點;其餘 hidden 個收進「另外 N 個」。 */
  shown: number;
  hidden: number;
}

export interface BoardPlan {
  mode: 'grid' | 'strip';
  compact: boolean;
  zones: Record<Zone, ZonePlan>;
}

type Counts = Record<Zone, number>;

/** 總管區塊固定留一個位置(總管節點或「+」六角形)。 */
const slotsOf = (z: Zone, counts: Counts) => (z === 'chief' ? 1 : counts[z]);

const roomOf = (h: number, header: number) => h - header - TOP_GAP - BOTTOM_GAP;

/** 把 n 個節點排進一個區塊:取排得下的最大縮放;到最小縮放還排不下就留一格給「另外 N 個」。 */
export function packZone(rect: Rect, header: number, n: number): ZonePlan {
  const room = roomOf(rect.h, header);
  const fit = (zoom: number) => ({ cols: Math.max(0, Math.floor((rect.w - SIDE * 2) / (CELL_W * zoom))), rows: Math.max(0, Math.floor(room / (CELL_H * zoom))) });
  for (let k = ZOOM_STEPS; k >= MIN_STEP; k--) {
    const zoom = k / ZOOM_STEPS;
    const { cols, rows } = fit(zoom);
    if (cols * rows >= n && (n > 0 || k === ZOOM_STEPS)) return { rect, header, zoom, cols: Math.max(cols, 1), rows: Math.max(rows, 1), shown: n, hidden: 0 };
  }
  // 連一列或一欄都放不下(視窗小到不合理):再縮一點,至少放得下一格
  let zoom = MIN_ZOOM;
  if (fit(zoom).cols * fit(zoom).rows === 0) zoom = Math.max(0.4, Math.min(MIN_ZOOM, room / CELL_H, (rect.w - SIDE * 2) / CELL_W));
  const { cols, rows } = fit(zoom - 1e-9);
  const cap = cols * rows;
  if (cap >= n) return { rect, header, zoom, cols, rows, shown: n, hidden: 0 };
  const shown = Math.max(0, cap - 1);
  return { rect, header, zoom, cols: Math.max(cols, 1), rows: Math.max(rows, 1), shown, hidden: n - shown };
}

/** 第 i 格(節點或「另外 N 個」)的中心位置。total 是這個區塊實際用到幾格,用來把整排置中。 */
export function slotAt(p: ZonePlan, i: number, total: number): { x: number; y: number } {
  const { rect: r, zoom } = p;
  const cw = CELL_W * zoom;
  // 至少排滿一列時,把多出來的寬度平分到左右
  const used = Math.min(p.cols, Math.max(total, 1));
  const left = total >= p.cols ? (r.w - SIDE * 2 - used * cw) / 2 : 0;
  return {
    x: r.x + SIDE + left + cw / 2 + (i % p.cols) * cw,
    y: r.y + p.header + TOP_GAP + NODE_TOP * zoom + Math.floor(i / p.cols) * CELL_H * zoom,
  };
}

/** 區塊正中央(總管節點、「+」六角形、連一格都放不下時的「另外 N 個」)。 */
export function centerOf(p: ZonePlan): { x: number; y: number } {
  const { rect: r, zoom } = p;
  const top = r.y + p.header + TOP_GAP;
  const room = roomOf(r.h, p.header);
  return { x: r.x + r.w / 2, y: top + Math.max(0, (room - CELL_H * zoom) / 2) + NODE_TOP * zoom };
}

interface RowSpec { zones: Zone[]; base: number[]; min: number[] }

/**
 * 分配一列裡各區塊的寬度。avail 是扣掉間距後的總寬度。
 * 排得下(ok):每個區塊至少拿到需要的寬度,其餘依 base 的比例分配(全部都不擠時就等於 base)。
 * 排不下:每個區塊先拿最小寬度,剩下的依「還缺多少」分配。
 */
function allocRow(row: RowSpec, counts: Counts, avail: number, h: number, header: number, zoom: number): { widths: number[]; ok: boolean } {
  const rowsFit = Math.floor(roomOf(h, header) / (CELL_H * zoom));
  const need = row.zones.map((z, i) => {
    const n = slotsOf(z, counts);
    if (n === 0) return row.min[i];
    if (rowsFit <= 0) return Infinity;
    return Math.max(row.min[i], Math.ceil(n / rowsFit) * CELL_W * zoom + SIDE * 2 + 2);
  });
  const total = need.reduce((s, v) => s + v, 0);
  if (total <= avail) {
    const baseSum = row.base.reduce((s, v) => s + v, 0);
    const widths = row.base.map(b => (b / baseSum) * avail);
    const fixed = row.zones.map(() => false);
    for (;;) {
      const left = avail - widths.reduce((s, v, i) => s + (fixed[i] ? v : 0), 0);
      const share = row.base.reduce((s, v, i) => s + (fixed[i] ? 0 : v), 0);
      let changed = false;
      row.zones.forEach((_, i) => { if (!fixed[i]) widths[i] = (row.base[i] / share) * left; });
      row.zones.forEach((_, i) => { if (!fixed[i] && widths[i] < need[i]) { widths[i] = need[i]; fixed[i] = true; changed = true; } });
      if (!changed) break;
    }
    return { widths, ok: true };
  }
  const minSum = row.min.reduce((s, v) => s + v, 0);
  if (minSum >= avail) return { widths: row.min.map(m => (m / minSum) * avail), ok: false };
  // 每個區塊先拿最小寬度,再一欄一欄發給「還有最多節點排不下」的區塊,直到沒有空間;零頭依原本的比例分掉
  const cw = CELL_W * zoom;
  const perCol = Math.max(rowsFit, 1);
  const widths = [...row.min];
  const cols = widths.map(v => Math.max(0, Math.floor((v - SIDE * 2) / cw)));
  let free = avail - minSum;
  for (;;) {
    let pick = -1, worst = 0, cost = 0;
    row.zones.forEach((z, i) => {
      const lack = slotsOf(z, counts) - cols[i] * perCol;
      const c = (cols[i] + 1) * cw + SIDE * 2 + 2 - widths[i];
      if (lack > worst && c <= free) { pick = i; worst = lack; cost = c; }
    });
    if (pick < 0) break;
    widths[pick] += cost;
    cols[pick]++;
    free -= cost;
  }
  const baseSum = row.base.reduce((s, v) => s + v, 0);
  return { widths: widths.map((v, i) => v + (free * row.base[i]) / baseSum), ok: false };
}

/** 把一列的寬度換成取整數後的矩形。 */
function rowRects(widths: number[], x0: number, y: number, h: number, gap: number, right: number): Rect[] {
  const out: Rect[] = [];
  let x = x0;
  widths.forEach((w, i) => {
    const end = i === widths.length - 1 ? right : Math.round(x + w);
    out.push({ x: Math.round(x), y, w: end - Math.round(x), h });
    x += w + gap;
  });
  return out;
}

interface Candidate { plan: BoardPlan; hidden: number; zoom: number }

function build(mode: 'grid' | 'strip', compact: boolean, rows: { spec: RowSpec; rects: Rect[] }[], counts: Counts, header: number, zoom: number): Candidate {
  const zones = {} as Record<Zone, ZonePlan>;
  let hidden = 0;
  for (const { spec, rects } of rows) spec.zones.forEach((z, i) => { zones[z] = packZone(rects[i], header, slotsOf(z, counts)); hidden += zones[z].hidden; });
  return { plan: { mode, compact, zones }, hidden, zoom };
}

/** 橫排:六個區塊排成一列。compact 時標題列與邊距都縮小,把高度留給節點。 */
function planStrip(w: number, h: number, counts: Counts, compact: boolean): Candidate {
  const header = compact ? HEADER_COMPACT : HEADER;
  const padX = 16, padTop = compact ? 10 : 16, padBottom = compact ? 8 : 16, gap = compact ? 8 : 12;
  const zones: Zone[] = ['planning', 'active', 'chief', 'standby', 'auth', 'fault'];
  // 最小寬度:空的區塊放得下標題與數量;有節點的區塊至少放得下一個縮到最小的節點
  const spec: RowSpec = { zones, base: [17, 23, 12, 22, 13, 13], min: zones.map(z => (slotsOf(z, counts) ? Math.ceil(CELL_W * MIN_ZOOM) + SIDE * 2 + 2 : 86)) };
  const avail = w - padX * 2 - gap * 5;
  const zh = Math.max(h - padTop - padBottom, header + 8);
  const rects = (widths: number[]) => rowRects(widths, padX, padTop, zh, gap, w - padX);
  for (let k = ZOOM_STEPS; k >= MIN_STEP; k--) {
    const a = allocRow(spec, counts, avail, zh, header, k / ZOOM_STEPS);
    if (a.ok) return build('strip', compact, [{ spec, rects: rects(a.widths) }], counts, header, k / ZOOM_STEPS);
  }
  return build('strip', compact, [{ spec, rects: rects(allocRow(spec, counts, avail, zh, header, MIN_ZOOM).widths) }], counts, header, MIN_ZOOM);
}

/** a 是否比 b 好:收起來的節點比較少,或一樣多但節點明顯比較大。 */
const better = (a: Candidate, b: Candidate) => a.hidden < b.hidden || (a.hidden === b.hidden && a.zoom >= b.zoom + 0.1);

/** 格狀:上列是規劃、執行、總管,下列是待命、待授權、異常;兩列的高度與各區塊的寬度都依節點數調整。 */
function planGrid(w: number, h: number, counts: Counts): Candidate | null {
  const pad = 16, gap = 14, header = HEADER, minW = 132;
  const innerH = h - pad * 2 - gap;
  const minRow = header + TOP_GAP + BOTTOM_GAP + Math.ceil(CELL_H * MIN_ZOOM);
  if (innerH < minRow * 2) return null;
  // 原本的固定比例:左欄 26%,總管約一個半節點寬,待授權與異常各半
  const inner = w - pad * 2;
  const leftW = Math.round((inner - gap) * 0.26);
  const restW = inner - gap - leftW;
  const chiefW = Math.max(170, Math.round(restW * 0.2));
  const authW = Math.round((restW - gap) * 0.5);
  const top: RowSpec = { zones: ['planning', 'active', 'chief'], base: [leftW, restW - gap - chiefW, chiefW], min: [minW, minW, minW] };
  const bottom: RowSpec = { zones: ['standby', 'auth', 'fault'], base: [leftW, authW, restW - gap - authW], min: [minW, minW, minW] };
  const avail = inner - gap * 2;
  const defTop = Math.round(innerH * 0.48);
  // 上列高度的候選值,從原本的比例往兩邊找
  const tops: number[] = [];
  for (let d = 0; defTop - d >= minRow || defTop + d <= innerH - minRow; d += 4) {
    if (defTop - d >= minRow && defTop - d <= innerH - minRow) tops.push(defTop - d);
    if (d > 0 && defTop + d <= innerH - minRow && defTop + d >= minRow) tops.push(defTop + d);
  }
  if (!tops.length) return null;
  const make = (topH: number, zoom: number, a: number[], b: number[]) => build('grid', false, [
    { spec: top, rects: rowRects(a, pad, pad, topH, gap, w - pad) },
    { spec: bottom, rects: rowRects(b, pad, pad + topH + gap, innerH - topH, gap, w - pad) },
  ], counts, header, zoom);
  for (let k = ZOOM_STEPS; k >= MIN_STEP; k--) {
    const zoom = k / ZOOM_STEPS;
    for (const topH of tops) {
      const a = allocRow(top, counts, avail, topH, header, zoom);
      if (!a.ok) continue;
      const b = allocRow(bottom, counts, avail, innerH - topH, header, zoom);
      if (b.ok) return make(topH, zoom, a.widths, b.widths);
    }
  }
  // 排不下:挑收起來的節點最少的上列高度
  let best: Candidate | null = null;
  for (const topH of tops) {
    const c = make(topH, MIN_ZOOM, allocRow(top, counts, avail, topH, header, MIN_ZOOM).widths, allocRow(bottom, counts, avail, innerH - topH, header, MIN_ZOOM).widths);
    if (!best || c.hidden < best.hidden) best = c;
  }
  return best;
}

/** 依面板大小與各區塊的節點數,算出每個區塊的位置、縮放與要收起來的節點數。 */
export function planBoard(w: number, h: number, counts: Counts): BoardPlan {
  const grid = planGrid(w, h, counts);
  // 格狀排得下而且節點夠大就直接用
  if (grid && grid.hidden === 0 && grid.zoom >= 0.8) return grid.plan;
  // 否則和橫排比(面板夠高時先試一般標題,再試精簡標題),順序在前面的優先
  let best = grid;
  for (const compact of h >= 280 ? [false, true] : [true]) {
    const strip = planStrip(w, h, counts, compact);
    if (!best || better(strip, best)) best = strip;
  }
  return best!.plan;
}
