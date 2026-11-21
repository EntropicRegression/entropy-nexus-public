import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryEntry } from '../shared/types';
import { parseFrontMatter } from './memory-vault';
import { safeName, writeMemory, type MetaValue } from './memory-write';

/**
 * 記憶的 MCP 工具(階段 2):memory_search、memory_write 的邏輯。不依賴 Electron,單元測試可以直接載入;
 * 呼叫者是誰、專案怎麼判斷、git 怎麼查、怎麼通知總管,都由 deps 傳進來(測試用假的,主控台用 Core.memoryDeps())。
 *
 * - memory_search:所有節點都能用。範圍是全域加上呼叫者目前的專案(或指定的專案);判例只有「已確認」的看得到。
 *   呼叫者自己的側寫與判例排最前面,其餘依關鍵字分數與更新時間。
 * - memory_write:只有總管能寫(節點的特長、專案知識、使用者偏好)。判例走 case_submit,不在這裡寫。
 */

export interface MemoryCaller { id: string; name: string; cwd: string; isChief: boolean }
export interface MemoryProject { id: string; name: string; root: string }
export interface MemoryNodeInfo { id: string; name: string; backendLabel: string; model: string }

export interface MemoryToolsDeps {
  vaultDir: string;
  list(): MemoryEntry[];
  rescan(): void;
  /** 面板上的最上層節點(寫節點側寫時用來找到那個節點)。 */
  nodes(): MemoryNodeInfo[];
  project(cwd: string): Promise<MemoryProject>;
  /** 專案目前 HEAD 的短 sha;不是 git 或失敗回傳 null。 */
  head(root: string): Promise<string | null>;
  /** 從 commit 到 HEAD 之間有幾個 commit;失敗回傳 null。 */
  commitsAhead(root: string, commit: string): Promise<number | null>;
  /** 下一則給總管的指令前面加一則「主控台通知」。 */
  noteChief(text: string): void;
  now(): number;
}

/** 每個專案最多這麼多則專案知識,超過仍會寫入,但會通知總管整理。 */
export const KNOWLEDGE_CAP = Number(process.env.NEXUS_KNOWLEDGE_CAP) || 50;
/** 更新時間超過這麼多天就標「可能過時」。 */
export const STALE_DAYS = 60;
/** 專案知識的 commit 落後 HEAD 超過這麼多個就標「可能過時」。 */
export const STALE_COMMITS = 200;
const READ_MAX = 256 * 1024;
const MAX_RESULTS = 8;
const MAX_OUTPUT = 6000;
const EXCERPT = 160;

// ---------- git ----------

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise(res => {
    execFile('git', ['-c', 'core.quotepath=false', ...args], { cwd, windowsHide: true, timeout: 15000 }, (err, stdout) => res(err ? null : String(stdout).trim()));
  });
}
export const gitHead = (root: string) => git(root, ['rev-parse', '--short', 'HEAD']).then(s => s || null);

const aheadCache = new Map<string, { at: number; n: number | null }>();
const AHEAD_TTL = 5 * 60 * 1000;
/** 快取的 `git rev-list --count <commit>..HEAD`;錯誤(不是 git、commit 不存在)回傳 null,不影響搜尋。 */
export async function gitCommitsAhead(root: string, commit: string): Promise<number | null> {
  if (!/^[0-9a-f]{4,40}$/i.test(commit)) return null;
  const key = `${root}\0${commit}`;
  const hit = aheadCache.get(key);
  if (hit && Date.now() - hit.at < AHEAD_TTL) return hit.n;
  const out = await git(root, ['rev-list', '--count', `${commit}..HEAD`]);
  const n = out !== null && /^\d+$/.test(out) ? Number(out) : null;
  aheadCache.set(key, { at: Date.now(), n });
  return n;
}

// ---------- 過時 ----------

/** 可能過時的理由(沒有理由回傳空字串)。 */
export function staleReason(updatedAt: number, now: number, commitsAhead: number | null): string {
  const days = (now - updatedAt) / (24 * 3600 * 1000);
  if (updatedAt > 0 && days > STALE_DAYS) return `已 ${Math.floor(days)} 天沒更新`;
  if (commitsAhead !== null && commitsAhead > STALE_COMMITS) return `專案已前進 ${commitsAhead} 個 commit`;
  return '';
}

// ---------- 章節 ----------

/** 取出 `## 標題` 章節的內文(不含標題行);沒有這個章節回傳 null。 */
export function getSection(body: string, heading: string): string | null {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex(l => l.trim() === `## ${heading}`);
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^##\s/.test(lines[i])) { end = i; break; }
  return lines.slice(start + 1, end).join('\n').trim();
}

/** 取代 `## 標題` 章節的內文,其他章節與前言原樣保留;沒有這個章節就加在最前面(標題之後的順序不動)。 */
export function setSection(body: string, heading: string, text: string): string {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex(l => l.trim() === `## ${heading}`);
  const block = [`## ${heading}`, '', text.trim(), ''];
  if (start < 0) return `${block.join('\n')}\n${body.trim()}`.trim() + '\n';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^##\s/.test(lines[i])) { end = i; break; }
  return [...lines.slice(0, start), ...block, ...lines.slice(end)].join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/** 節點側寫檔的路徑。 */
export const nodeProfilePath = (name: string) => `nodes/${safeName(name)}.md`;

/** 讀節點側寫的「特長」(給總管守則用);沒有側寫或沒有特長回傳空字串。 */
export function readNodeStrengths(vaultDir: string, name: string): string {
  try {
    const { body } = parseFrontMatter(readFileSync(join(vaultDir, ...nodeProfilePath(name).split('/')), 'utf8').slice(0, READ_MAX));
    return getSection(body, '特長') ?? '';
  } catch { return ''; }
}

// ---------- 搜尋 ----------

const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const isCjk = (s: string) => /[㐀-鿿]/.test(s);

/** 關鍵字分數:標題命中權重高、內文依次數(最多 5 次);中文詞整段找不到時退一步用相鄰兩字。 */
export function scoreText(query: string, title: string, body: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const t = title.toLowerCase(), b = body.toLowerCase();
  const count = (hay: string, needle: string) => { let n = 0, i = 0; while (n < 5 && (i = hay.indexOf(needle, i)) >= 0) { n++; i += needle.length; } return n; };
  let score = 0;
  if (q.includes(' ') && (t.includes(q) || b.includes(q))) score += 6;
  for (const tok of q.split(/\s+/).filter(Boolean)) {
    const inT = t.includes(tok), inB = count(b, tok);
    if (inT || inB) { score += (inT ? 5 : 0) + inB; continue; }
    if (isCjk(tok) && tok.length >= 3) {
      for (let i = 0; i + 2 <= tok.length; i++) {
        const bi = tok.slice(i, i + 2);
        if (t.includes(bi)) score += 1;
        if (b.includes(bi)) score += 0.5;
      }
    }
  }
  return score;
}

function excerptOf(body: string, query: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  const b = flat.toLowerCase();
  let at = -1;
  for (const tok of query.toLowerCase().split(/\s+/).filter(Boolean)) { at = b.indexOf(tok); if (at >= 0) break; }
  const from = Math.max(0, at < 0 ? 0 : at - 30);
  const s = flat.slice(from, from + EXCERPT);
  return `${from > 0 ? '…' : ''}${s}${from + EXCERPT < flat.length ? '…' : ''}`;
}

export interface SearchArgs { query?: string; kind?: string; node?: string; project?: string }
const KINDS = ['node', 'case', 'knowledge', 'preference'] as const;
const KIND_ALIAS: Record<string, MemoryEntry['kind']> = { node: 'node', 節點: 'node', 節點側寫: 'node', case: 'case', 判例: 'case', knowledge: 'knowledge', 知識: 'knowledge', 專案知識: 'knowledge', preference: 'preference', 偏好: 'preference' };
const KIND_LABEL: Record<MemoryEntry['kind'], string> = { node: '節點側寫', case: '判例', knowledge: '專案知識', preference: '使用者偏好' };
/** 只有這些狀態的判例 agent 才看得到。 */
export const CASE_VISIBLE = '已確認';

export interface SearchHit {
  entry: MemoryEntry;
  score: number;
  own: boolean;
  excerpt: string;
  stale: string;
}

/** 搜尋的核心(回傳結構化結果,方便測試);memorySearch 再把它排成文字。 */
export async function searchMemory(deps: MemoryToolsDeps, caller: MemoryCaller, args: SearchArgs): Promise<SearchHit[]> {
  const query = String(args.query ?? '').trim();
  const kindWanted = args.kind ? KIND_ALIAS[String(args.kind).trim().toLowerCase()] : undefined;
  if (args.kind && !kindWanted) throw new Error(`kind 只能是 ${KINDS.join('、')} 其中之一。`);
  const proj = await deps.project(caller.cwd).catch(() => null);
  const wantProject = String(args.project ?? '').trim().toLowerCase();
  const nodeWanted = String(args.node ?? '').trim().toLowerCase();
  const folderOf = (e: MemoryEntry) => ((e.path.startsWith('cases/') || e.path.startsWith('knowledge/')) ? e.path.split('/')[1] ?? '' : '');
  const inScope = (e: MemoryEntry): boolean => {
    if (e.scope !== '專案') return true;
    if (wantProject) return e.projectId.toLowerCase().includes(wantProject) || folderOf(e).toLowerCase().includes(wantProject);
    if (!proj) return false;
    return sameId(e.projectId, proj.id) || sameId(e.projectId, proj.name) || sameId(folderOf(e), safeName(proj.name));
  };
  const isOwn = (e: MemoryEntry) => (e.kind === 'node' || e.kind === 'case') && !!e.nodeId && (sameId(e.nodeId, caller.id) || sameId(e.nodeId, caller.name) || (e.kind === 'node' && sameId(e.title, caller.name)));
  const hits: SearchHit[] = [];
  for (const e of deps.list()) {
    if (kindWanted && e.kind !== kindWanted) continue;
    if (e.kind === 'case' && e.status !== CASE_VISIBLE) continue;
    if (!inScope(e)) continue;
    if (nodeWanted && !(sameId(e.nodeId, nodeWanted) || e.nodeId.toLowerCase().includes(nodeWanted) || (e.kind === 'node' && e.title.toLowerCase().includes(nodeWanted)))) continue;
    let text = '';
    try { text = readFileSync(join(deps.vaultDir, ...e.path.split('/')), 'utf8').slice(0, READ_MAX); } catch { continue; }
    const { meta, body } = parseFrontMatter(text);
    const score = scoreText(query, e.title, body);
    const own = isOwn(e);
    if (query && score <= 0 && !(own && e.kind === 'node')) continue;
    const commit = String(Array.isArray(meta.get('commit')) ? '' : meta.get('commit') ?? '').trim();
    let ahead: number | null = null;
    if (commit && e.scope === '專案' && (proj || e.projectId)) ahead = await deps.commitsAhead(proj && sameId(e.projectId, proj.id) ? proj.root : e.projectId, commit).catch(() => null);
    hits.push({ entry: e, score, own, excerpt: excerptOf(body, query), stale: staleReason(e.updatedAt, deps.now(), ahead) });
  }
  hits.sort((a, b) => Number(b.own) - Number(a.own) || b.score - a.score || b.entry.updatedAt - a.entry.updatedAt);
  return hits;
}

const dateOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export async function memorySearch(deps: MemoryToolsDeps, caller: MemoryCaller, args: SearchArgs): Promise<string> {
  const hits = await searchMemory(deps, caller, args);
  if (!hits.length) return '記憶庫裡沒有符合的內容。(搜尋範圍是全域加上你目前的專案;判例只有使用者確認過的看得到。)可以換個關鍵字,或拿掉 kind、node 的限制再試。';
  const out: string[] = [];
  let used = 0, shown = 0;
  for (const h of hits.slice(0, MAX_RESULTS)) {
    const e = h.entry;
    const line = `${shown + 1}. [${KIND_LABEL[e.kind]}] ${e.title}${h.own ? '(你自己的)' : ''}\n   路徑:${e.path} | 更新:${dateOf(e.updatedAt)}${e.status ? ` | 狀態:${e.status}` : ''}${e.scope === '專案' ? ` | 專案:${e.projectId}` : ''}${h.stale ? ` | 可能過時(${h.stale})` : ''}\n   ${h.excerpt}`;
    if (used + line.length > MAX_OUTPUT && shown > 0) break;
    out.push(line);
    used += line.length + 1;
    shown++;
  }
  const more = hits.length - shown;
  return `找到 ${hits.length} 筆${more > 0 ? `,以下列出前 ${shown} 筆(換更精確的關鍵字或加 kind、node、project 縮小範圍)` : ''}:\n${out.join('\n')}${hits.some(h => h.stale) ? '\n標「可能過時」的內容請先對照現況再採用。' : ''}`;
}

// ---------- 寫入 ----------

export interface WriteArgs { kind?: string; title?: string; content?: string; project?: string }

function isoNow(deps: MemoryToolsDeps): string { return new Date(deps.now()).toISOString(); }

const knowledgeDir = (name: string) => `knowledge/${safeName(name)}`;
function countKnowledge(vaultDir: string, name: string): number {
  try { return readdirSync(join(vaultDir, 'knowledge', safeName(name))).filter(f => /\.md$/i.test(f)).length; } catch { return 0; }
}

const notedCap = new Set<string>();

export async function memoryWrite(deps: MemoryToolsDeps, caller: MemoryCaller, args: WriteArgs): Promise<string> {
  if (!caller.isChief) throw new Error('只有總管節點可以寫入記憶(節點特長、專案知識、使用者偏好);你不是總管。請把想記下來的重點回報給總管或使用者。要寫判例請用 case_submit。');
  const kind = KIND_ALIAS[String(args.kind ?? '').trim().toLowerCase()];
  const title = String(args.title ?? '').trim();
  const content = String(args.content ?? '').trim();
  if (kind === 'case') throw new Error('判例不能用 memory_write 寫,請用 case_submit 送交,經使用者確認後才會生效。');
  if (!kind || !title || !content) throw new Error(`memory_write 需要 kind(node、knowledge、preference 其中之一)、title、content 三個字串參數。這次收到的 kind:${JSON.stringify(args.kind ?? null)}。`);
  const proj = await deps.project(caller.cwd);
  const now = isoNow(deps);

  if (kind === 'node') {
    const key = title.toLowerCase();
    const matches = deps.nodes().filter(n => n.id === title || n.name.toLowerCase() === key);
    if (matches.length !== 1) throw new Error(matches.length ? `有 ${matches.length} 個節點都叫「${title}」,請改用節點 id 當 title。` : `找不到節點「${title}」。kind 為 node 時 title 要填節點的名稱(用 list_nodes 查)。`);
    const node = matches[0];
    const rel = nodeProfilePath(node.name);
    const abs = join(deps.vaultDir, ...rel.split('/'));
    let meta = new Map<string, MetaValue>();
    let body = '';
    if (existsSync(abs)) {
      const fm = parseFrontMatter(readFileSync(abs, 'utf8'));
      meta = new Map(fm.meta);
      body = fm.body;
    }
    // 節點自己的專案(用它的工作目錄)沒辦法在這裡確定,commit 取總管所在專案的 HEAD 作為寫入時的參考
    const head = await deps.head(proj.root);
    const full: Record<string, MetaValue> = { ...Object.fromEntries(meta), 種類: 'node', 節點ID: node.id, 節點: node.name, 後台: node.backendLabel, 模型: node.model, 更新時間: now, commit: head ?? undefined };
    if (!head) delete full.commit;
    let next = setSection(body, '特長', content);
    if (getSection(next, '解決問題的流程') === null) next = `${next.trim()}\n\n## 解決問題的流程\n`;
    const r = writeMemory(deps.vaultDir, rel, full, next);
    deps.rescan();
    return `已更新節點「${node.name}」的特長(${r.action === 'appended' ? '側寫檔被使用者改過,改為附加一段' : r.action === 'created' ? '建立新的側寫檔' : '取代特長章節,其他章節保留'})。路徑:${r.path}${r.masked ? `;有 ${r.masked} 處疑似金鑰或密碼已遮罩` : ''}`;
  }

  if (kind === 'preference') {
    const rel = `preferences/${safeName(title)}.md`;
    const r = writeMemory(deps.vaultDir, rel, { 種類: 'preference', 範圍: '全域', 標題: title, 更新時間: now }, content);
    deps.rescan();
    return `已寫入使用者偏好「${title}」(${actionText(r.action)})。路徑:${r.path}${maskText(r.masked)}`;
  }

  // knowledge
  const target = proj;
  const requested = String(args.project ?? '').trim();
  const p: MemoryProject = requested && !sameId(requested, proj.id) && !sameId(requested, proj.name) ? { id: requested, name: requested, root: requested } : target;
  const rel = `${knowledgeDir(p.name)}/${safeName(title)}.md`;
  const existed = existsSync(join(deps.vaultDir, ...rel.split('/')));
  const head = p === target ? await deps.head(p.root) : null;
  const r = writeMemory(deps.vaultDir, rel, { 種類: 'knowledge', 範圍: '專案', 專案ID: p.id, 專案: p.name, 標題: title, 更新時間: now, commit: head ?? undefined }, content);
  deps.rescan();
  const n = countKnowledge(deps.vaultDir, p.name);
  let tail = '';
  if (n > KNOWLEDGE_CAP && !existed) {
    tail = `\n注意:專案「${p.name}」的專案知識已有 ${n} 則,超過 ${KNOWLEDGE_CAP} 則的上限,已通知總管整理。`;
    const key = `${p.id}\0${Math.floor(n / 10)}`;
    if (!notedCap.has(key)) {
      notedCap.add(key);
      deps.noteChief(`(主控台通知:專案「${p.name}」的專案知識已有 ${n} 則,超過上限 ${KNOWLEDGE_CAP} 則。請在方便的時候重新整理:用 memory_search 找出重複或相近的知識,合併成較少、較精煉的幾則(用 memory_write 以同一個 title 寫入會取代內容),並告知使用者哪些舊檔可以刪除。使用者改過的檔案不會被覆寫,只會附加一段。)`);
    }
  }
  return `已寫入專案「${p.name}」的專案知識「${title}」(${actionText(r.action)})。路徑:${r.path}${maskText(r.masked)}${tail}`;
}

const actionText = (a: string) => (a === 'created' ? '新增' : a === 'replaced' ? '取代同標題的內容' : '檔案被使用者改過,改為附加一段');
const maskText = (n: number) => (n ? `;有 ${n} 處疑似金鑰或密碼已遮罩` : '');
