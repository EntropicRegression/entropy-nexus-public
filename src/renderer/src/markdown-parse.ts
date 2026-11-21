// 回覆排版的解析:純函式,不依賴 React 與 DOM,可以直接用 node 測試(tests/markdown.test.mjs)。
// 只產生資料結構,由 Markdown.tsx 轉成 React 元素;不產生任何 HTML 字串。

export type Inline =
  | string
  | { t: 'code'; text: string }
  | { t: 'strong' | 'em' | 'strongem' | 'del'; c: Inline[] }
  | { t: 'a'; href: string; c: Inline[] }
  | { t: 'img'; src: string; alt: string }
  | { t: 'br' };

export type Align = 'left' | 'center' | 'right' | null;
export type ListItem = { task?: 'todo' | 'done'; blocks: Block[] };
export type Block =
  | { t: 'code'; lang: string; text: string }
  | { t: 'h'; level: number; text: string }
  | { t: 'hr' }
  | { t: 'quote'; blocks: Block[] }
  | { t: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { t: 'table'; align: Align[]; head: string[]; rows: string[][] }
  | { t: 'p'; text: string };

// ───────────────────────── 行內 ─────────────────────────

const isSpace = (c?: string) => !c || /\s/.test(c);
const isAlnum = (c?: string) => !!c && /[A-Za-z0-9]/.test(c);
const ESCAPABLE = '*_`~|[]';

/** s[i] 是反引號時,回傳對應結尾反引號之後的位置;沒有結尾回傳 -1。 */
function skipCode(s: string, i: number): number {
  let n = 0;
  while (s[i + n] === '`') n++;
  let j = i + n;
  while (j < s.length) {
    if (s[j] !== '`') { j++; continue; }
    let r = 0;
    while (s[j + r] === '`') r++;
    if (r === n) return j + r;
    j += r;
  }
  return -1;
}

/** 找強調的結尾記號:前一個字元不能是空白;`*` 單層時略過成對的 `**`。回傳結尾記號的起點,找不到 -1。 */
function findClose(s: string, from: number, ch: string, len: number): number {
  let p = from;
  while (p < s.length) {
    const c = s[p];
    if (c === '`') { const e = skipCode(s, p); p = e > 0 ? e : p + 1; continue; }
    if (c === '\\') { p += 2; continue; }
    if (c !== ch) { p++; continue; }
    let r = 0;
    while (s[p + r] === ch) r++;
    const q = p + r - len;
    let ok = r >= len && q > from - 1 && q - 1 >= from && !isSpace(s[q - 1]);
    if (ch === '*' && len === 1 && r === 2) ok = false; // 成對的 ** 是粗體的記號
    if (ch === '_') ok = ok && r === len && !isAlnum(s[q + len]);
    if (ch === '~') ok = ok && r === len;
    if (ok) return q;
    p += r;
  }
  return -1;
}

/** 從 `[` 或 `![` 的位置解析 [文字](網址 "標題");網址可用 <...> 包住以容納空白,可含成對括號。 */
function parseLinkAt(s: string, i: number): { end: number; text: string; href: string } | null {
  let p = i + 1, depth = 0;
  for (; p < s.length; p++) {
    const c = s[p];
    if (c === '`') { const e = skipCode(s, p); if (e > 0) p = e - 1; continue; }
    if (c === '\\') { p++; continue; }
    if (c === '[') depth++;
    else if (c === ']') { if (depth === 0) break; depth--; }
  }
  if (p >= s.length || s[p + 1] !== '(') return null;
  const text = s.slice(i + 1, p);
  let q = p + 2;
  while (s[q] === ' ') q++;
  let href: string;
  if (s[q] === '<') {
    const e = s.indexOf('>', q);
    if (e < 0 || s.slice(q, e).includes('\n')) return null;
    href = s.slice(q + 1, e);
    q = e + 1;
  } else {
    const start = q;
    let d = 0;
    for (; q < s.length; q++) {
      const c = s[q];
      if (/\s/.test(c)) break;
      if (c === '(') d++;
      else if (c === ')') { if (d === 0) break; d--; }
    }
    href = s.slice(start, q);
  }
  while (s[q] === ' ') q++;
  if (s[q] === '"' || s[q] === "'") { const e = s.indexOf(s[q], q + 1); if (e < 0) return null; q = e + 1; while (s[q] === ' ') q++; }
  if (s[q] !== ')' || !href.trim()) return null;
  return { end: q + 1, text, href: href.trim() };
}

const BARE_URL = /https?:\/\/[A-Za-z0-9\-._~:/?#@!$&+,;=%()]+/iy;

/**
 * 行內語法:`程式碼`、**粗體**、*斜體*、***粗斜體***、~~刪除線~~、[文字](連結)、![說明](圖片)、<網址>、裸網址、<br>。
 * 強調只看記號內側是不是空白,不套用 CommonMark 的 flanking 規則,所以 **重點**:說明 這類緊貼全形標點的寫法能正常運作。
 */
export function parseInline(src: string, inLink = false): Inline[] {
  const s = inLink ? src : src.replace(/[ \t]+\n/g, '\n').replace(/\\\n/g, '\n');
  const out: Inline[] = [];
  let buf = '';
  const flush = () => { if (buf) { out.push(buf); buf = ''; } };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && ESCAPABLE.includes(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
    if (c === '`') {
      const e = skipCode(s, i);
      if (e > 0) {
        let n = 0;
        while (s[i + n] === '`') n++;
        let code = s.slice(i + n, e - n);
        if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
        if (code) { flush(); out.push({ t: 'code', text: code }); i = e; continue; }
      }
      buf += c; i++; continue;
    }
    if (c === '!' && s[i + 1] === '[') {
      const l = parseLinkAt(s, i + 1);
      if (l && !inLink) { flush(); out.push({ t: 'img', src: l.href, alt: l.text }); i = l.end; continue; }
    }
    if (c === '[' && !inLink) {
      const l = parseLinkAt(s, i);
      if (l) { flush(); out.push({ t: 'a', href: l.href, c: parseInline(l.text, true) }); i = l.end; continue; }
    }
    if (c === '<') {
      const br = /^<br\s*\/?>/i.exec(s.slice(i, i + 8));
      if (br) { flush(); out.push({ t: 'br' }); i += br[0].length; continue; }
      const au = !inLink && /^<(https?:\/\/[^\s<>]+)>/i.exec(s.slice(i, i + 1200));
      if (au) { flush(); out.push({ t: 'a', href: au[1], c: [au[1]] }); i += au[0].length; continue; }
    }
    if ((c === 'h' || c === 'H') && !inLink && !isAlnum(s[i - 1])) {
      BARE_URL.lastIndex = i;
      const m = BARE_URL.exec(s);
      if (m) {
        let url = m[0];
        for (;;) {
          const t = url.replace(/[.,;:!?]+$/, '');
          if (t.endsWith(')') && (t.match(/\)/g)?.length ?? 0) > (t.match(/\(/g)?.length ?? 0)) { url = t.slice(0, -1); continue; }
          url = t;
          break;
        }
        if (url.length > 8) { flush(); out.push({ t: 'a', href: url, c: [url] }); i += url.length; continue; }
      }
    }
    if (c === '*' || c === '~' || c === '_') {
      let r = 0;
      while (s[i + r] === c) r++;
      const tries = c === '*' ? [3, 2, 1].filter(l => l <= r) : c === '~' ? (r >= 2 ? [2] : []) : [r >= 2 ? 2 : 1];
      let done = false;
      if (!(c === '_' && isAlnum(s[i - 1]))) {
        for (const len of tries) {
          if (isSpace(s[i + len])) continue;
          const q = findClose(s, i + len, c, len);
          if (q < 0) continue;
          const inner = parseInline(s.slice(i + len, q), inLink);
          flush();
          out.push({ t: c === '~' ? 'del' : len === 3 ? 'strongem' : len === 2 ? 'strong' : 'em', c: inner });
          i = q + len;
          done = true;
          break;
        }
      }
      if (done) continue;
      buf += c; i++; continue;
    }
    buf += c; i++;
  }
  flush();
  return out;
}

// ───────────────────────── 區塊 ─────────────────────────

const MARK = /^(\s*)([-*+•]|\d{1,9}[.)])(?:(\s+)(.*))?$/;
const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/;

const indentOf = (l: string) => { let w = 0; for (const c of l) { if (c === ' ') w++; else if (c === '\t') w += 4; else break; } return w; };
/** 去掉最多 n 欄的前導空白(Tab 算 4 欄)。 */
const strip = (l: string, n: number) => { let w = 0, k = 0; while (k < l.length && w < n) { const c = l[k]; if (c === ' ') w++; else if (c === '\t') w += 4; else break; k++; } return l.slice(k); };

const isMark = (l: string) => !HR.test(l) && MARK.test(l);

/** 把表格的一列切成儲存格:略過頭尾的豎線;`\|` 不分隔;行內程式碼裡的 | 也不分隔。 */
export function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (c === '`') { const e = skipCode(s, i); if (e > 0) { cur += s.slice(i, e).replace(/\\\|/g, '|'); i = e - 1; continue; } }
    if (c === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  // 結尾的豎線不會多出一個空格;沒有結尾豎線時最後一格才有內容
  if (cur.trim() || !/\|\s*$/.test(line.replace(/\\\|/g, ''))) cells.push(cur.trim());
  return cells;
}

function tableAt(lines: string[], i: number): { block: Block; next: number } | null {
  const head = lines[i], sep = lines[i + 1];
  if (sep === undefined || !head.includes('|') || !sep.includes('|') || !SEP.test(sep)) return null;
  const hc = splitRow(head), sc = splitRow(sep);
  if (!hc.length) return null;
  const rows: string[][] = [];
  let j = i + 2;
  while (j < lines.length && lines[j].trim() && lines[j].includes('|') && !FENCE.test(lines[j])) rows.push(splitRow(lines[j++]));
  const cols = Math.max(hc.length, sc.length, ...rows.map(r => r.length));
  const pad = (r: string[]) => { const x = r.slice(0, cols); while (x.length < cols) x.push(''); return x; };
  const align: Align[] = Array.from({ length: cols }, (_, k) => {
    const c = (sc[k] ?? '').trim();
    return c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null;
  });
  return { block: { t: 'table', align, head: pad(hc), rows: rows.map(pad) }, next: j };
}

function parseLines(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => { if (para.length) { blocks.push({ t: 'p', text: para.join('\n') }); para = []; } };
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    const fm = FENCE.exec(line);
    if (fm && !(fm[2][0] === '`' && fm[3].includes('`'))) {
      flush();
      const indent = indentOf(fm[1]);
      const close = new RegExp(`^\\s*${fm[2][0]}{${fm[2].length},}\\s*$`);
      const body: string[] = [];
      i++;
      // 還在生成中的回覆可能沒有結尾的 ```,就收到最後一行
      while (i < n && !close.test(lines[i])) body.push(strip(lines[i++], indent));
      i++;
      blocks.push({ t: 'code', lang: fm[3].trim().split(/\s+/)[0] ?? '', text: body.join('\n') });
      continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    const tb = tableAt(lines, i);
    if (tb) { flush(); blocks.push(tb.block); i = tb.next; continue; }
    const h = /^\s*(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
    if (h) { flush(); blocks.push({ t: 'h', level: h[1].length, text: h[2] }); i++; continue; }
    if (HR.test(line)) { flush(); blocks.push({ t: 'hr' }); i++; continue; }
    if (/^\s{0,3}>/.test(line)) {
      flush();
      const q: string[] = [];
      while (i < n && /^\s{0,3}>/.test(lines[i])) q.push(lines[i++].replace(/^\s{0,3}> ?/, ''));
      blocks.push({ t: 'quote', blocks: parseLines(q) });
      continue;
    }
    const m = isMark(line) ? MARK.exec(line) : null;
    if (m) {
      flush();
      const ordered = /\d/.test(m[2][0]);
      const items: ListItem[] = [];
      const start = ordered ? parseInt(m[2], 10) : 1;
      while (i < n) {
        const lm = isMark(lines[i]) ? MARK.exec(lines[i]) : null;
        if (!lm || /\d/.test(lm[2][0]) !== ordered) break;
        const base = indentOf(lm[1]);
        const offset = base + lm[2].length + Math.min(Math.max((lm[3] ?? ' ').length, 1), 4);
        let first = lm[4] ?? '';
        let task: ListItem['task'];
        const tm = /^\[([ xX])\](?:\s+(.*))?$/.exec(first);
        if (tm) { task = tm[1] === ' ' ? 'todo' : 'done'; first = tm[2] ?? ''; }
        const sub: string[] = [first];
        let fence: RegExp | null = null;
        const track = (l: string) => {
          if (fence) { if (fence.test(l)) fence = null; return; }
          const f = FENCE.exec(l);
          if (f && !(f[2][0] === '`' && f[3].includes('`'))) fence = new RegExp(`^\\s*${f[2][0]}{${f[2].length},}\\s*$`);
        };
        track(first);
        i++;
        while (i < n) {
          const l = lines[i];
          if (fence) { const t = strip(l, offset); sub.push(t); track(t); i++; continue; }
          if (!l.trim()) {
            let j = i;
            while (j < n && !lines[j].trim()) j++;
            if (j < n && indentOf(lines[j]) > base) { while (i < j) { sub.push(''); i++; } continue; }
            break;
          }
          const ind = indentOf(l);
          if (ind > base) { const t = strip(l, Math.min(ind, offset)); sub.push(t); track(t); i++; continue; }
          // 沒有縮排的接續行(懶惰延續):上一行有內容、而且這行不是新的區塊開頭
          if (isMark(l) || HR.test(l) || FENCE.test(l) || /^\s*#{1,6}\s/.test(l) || /^\s{0,3}>/.test(l) || !sub[sub.length - 1].trim() || tableAt(lines, i)) break;
          sub.push(l.trimStart());
          i++;
        }
        items.push({ task, blocks: parseLines(sub) });
        // 項目之間可以隔空行;下一個非空行還是同種清單項目才繼續
        let j = i;
        while (j < n && !lines[j].trim()) j++;
        const nm = j < n && isMark(lines[j]) ? MARK.exec(lines[j]) : null;
        if (nm && /\d/.test(nm[2][0]) === ordered) i = j;
        else break;
      }
      blocks.push({ t: 'list', ordered, start, items });
      continue;
    }
    para.push(line);
    i++;
  }
  flush();
  return blocks;
}

/** 把回覆文字切成區塊:程式碼、標題、分隔線、引用、清單(可巢狀、核取方塊)、表格、段落。 */
export function parseBlocks(src: string): Block[] {
  return parseLines(src.replace(/\r\n?/g, '\n').split('\n'));
}
