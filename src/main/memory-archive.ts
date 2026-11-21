import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryEntry, TaskInfo } from '../shared/types';
import { formatDuration, type NodeStats } from '../shared/node-stats.ts';
import { snapshotImages, type CharacterImages } from './vault-images.ts';
import { nodeProfilePath, safeName, writeMemory, type MetaValue, type WriteResult } from './memory-write.ts';

/**
 * 長期記憶階段 4:刪除節點時把它的工作履歷歸檔進記憶庫,之後同名(或同角色)的新節點可以接回。
 * 這個檔案只用 node:fs,不依賴 Electron,單元測試可以直接載入。檔案一律經過 writeMemory 寫入(遮罩金鑰、不覆寫使用者改過的檔案)。
 *
 * 封存檔:nodes/封存/<節點名稱>-<YYYY-MM-DD>.md(同一天再封存同名節點,加 -2、-3)。
 * 本檔的內文區段順序固定:基本資料、特長、任務紀錄、解決問題的流程、判例(沒有內容的區段整段省略,任務紀錄與基本資料一定有)。
 */
export const ARCHIVE_DIR = 'nodes/封存';
export type SummarySource = '節點自己' | '總管' | '無';
export type SummaryPlan = 'self' | 'chief' | 'none';

const STATUS_LABEL: Record<string, string> = { done: '完成', failed: '失敗', interrupted: '中斷', running: '進行中', awaiting: '等待回應' };
const VERDICT_LABEL: Record<string, string> = { accepted: '已驗收', rejected: '已退回' };
export const RECENT_TASKS = 20;

/** 該由誰寫工作總結:選了直接刪除 → 無;節點自己能回覆 → 自己;不行(休眠、失聯、終端機、已經試過沒成功)就請總管;都不行 → 無。 */
export function decideSummarizer(i: { mode: 'summary' | 'stats'; selfAvailable: boolean; selfFailed: boolean; chiefAvailable: boolean }): SummaryPlan {
  if (i.mode === 'stats') return 'none';
  if (i.selfAvailable && !i.selfFailed) return 'self';
  return i.chiefAvailable ? 'chief' : 'none';
}

const pad = (n: number) => String(n).padStart(2, '0');
export const dateOf = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeOf = (ms: number): string => { const d = new Date(ms); return `${dateOf(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const pct = (r: number | null, n: number, d: number) => (r === null ? '尚無' : `${Math.round(r * 100)}%(${n}/${d})`);

export interface ArchiveNode { id: string; name: string; backend: string; backendLabel: string; model: string; character: string; createdAt: number; sessionId?: string | null; cwd?: string }
export interface ArchiveInput {
  node: ArchiveNode;
  stats: NodeStats | undefined;
  /** 這個節點的任務(任意順序)。 */
  tasks: TaskInfo[];
  /** 節點目前的側寫裡「特長」一段的內容;沒有側寫就是空字串。 */
  traits: string;
  /** 工作總結(解決問題的流程);沒有就是空字串。 */
  summary: string;
  summarySource: SummarySource;
  /** 沒有總結的原因(寫在基本資料裡)。 */
  noSummaryReason: string;
  /** 判例編號(索引裡節點ID相同的判例)。 */
  cases: string[];
  /** 回顧(2 到 3 句,根據實際紀錄);沒有就是空字串或省略。放在檔案最後一段。 */
  review?: string;
  now: Date;
  /** 角色的頭像與立繪原檔(絕對路徑);封存時複製進 nodes/封存/_圖像/<節點ID>/。沒有就不寫 頭像、立繪 屬性。 */
  images?: CharacterImages;
}

/** 組出封存檔的屬性與內文。 */
export function buildArchive(i: ArchiveInput): { meta: Record<string, MetaValue>; body: string } {
  const { node: n, stats: s } = i;
  const stamp = timeOf(i.now.getTime());
  const meta: Record<string, MetaValue> = {
    種類: 'node', 狀態: '封存', 節點ID: n.id, 節點: n.name, 後台: n.backendLabel, 模型: n.model || '(預設)', 角色: n.character || '(無)',
    封存時間: stamp, 總結來源: i.summarySource,
    // 給記憶庫管理 app 讀的數字與接回用的資訊(後台 是顯示名稱,後台ID 是後台代號)
    後台ID: n.backend, sessionId: n.sessionId || undefined, 工作目錄: n.cwd || undefined,
    任務數: s?.tasks ?? 0, 完成數: s?.done ?? 0, 完成率: s?.completionRate == null ? undefined : Math.round(s.completionRate * 100) / 100,
    驗收數: s?.accepted ?? 0, 退回數: s?.rejected ?? 0, 判例數: i.cases.length,
  };
  const sections: string[] = [];
  const projects = (s?.projects ?? []).map(p => `${p.name}(${p.tasks} 個任務)`).join('、');
  sections.push(['## 基本資料', '',
    `- 名稱:${n.name}`, `- 後台:${n.backendLabel}`, `- 模型:${n.model || '(預設)'}`, `- 角色:${n.character || '(無)'}`,
    `- 建立時間:${timeOf(n.createdAt)}`, `- 做過的專案:${projects || '(無紀錄)'}`,
    `- 工作總結:${i.summarySource === '無' ? `沒有(${i.noSummaryReason || '未寫'})` : `由${i.summarySource}撰寫`}`].join('\n'));
  if (i.traits.trim()) sections.push(`## 特長\n\n${i.traits.trim()}`);
  const task: string[] = ['## 任務紀錄', ''];
  if (!s || !s.tasks) task.push('尚無任務紀錄。');
  else {
    task.push(`- 任務 ${s.tasks} 件:完成 ${s.done}、失敗 ${s.failed}、中斷 ${s.interrupted}${s.running ? `、進行中 ${s.running}` : ''}`);
    task.push(`- 完成率 ${pct(s.completionRate, s.done, s.done + s.failed + s.interrupted)};驗收率 ${pct(s.acceptanceRate, s.accepted, s.accepted + s.rejected)}`);
    if (s.avgDoneMs !== null) task.push(`- 平均耗時 ${formatDuration(s.avgDoneMs)}`);
    if (s.cost.tokens || s.cost.usd) task.push(`- 累計花費 ${s.cost.tokens} tokens${s.cost.usd ? ` / $${s.cost.usd.toFixed(2)}` : ''}`);
    task.push('', `最近 ${Math.min(RECENT_TASKS, i.tasks.length)} 個任務:`);
    for (const t of [...i.tasks].sort((a, b) => b.startedAt - a.startedAt).slice(0, RECENT_TASKS)) {
      const parts = [STATUS_LABEL[t.status] ?? t.status];
      if (t.endedAt !== null) parts.push(formatDuration(Math.max(0, t.endedAt - t.startedAt)));
      if (t.verdict && VERDICT_LABEL[t.verdict]) parts.push(VERDICT_LABEL[t.verdict]);
      task.push(`- ${timeOf(t.startedAt)} 「${t.title.replace(/\s+/g, ' ').slice(0, 80)}」${parts.join(' · ')}`);
    }
  }
  sections.push(task.join('\n'));
  if (i.summary.trim()) sections.push(`## 解決問題的流程\n\n${i.summary.trim()}`);
  if (i.cases.length) sections.push(`## 判例\n\n${i.cases.map(c => `- ${c}`).join('\n')}`);
  // 回顧永遠是檔案最後一段
  if (i.review?.trim()) sections.push(`## 回顧\n\n${i.review.trim()}`);
  return { meta, body: sections.join('\n\n') };
}

/** 第一個沒被用掉的封存檔路徑:<名稱>-<日期>.md,已存在就加 -2、-3。 */
export function archivePath(vault: string, name: string, now: Date): string {
  const base = `${ARCHIVE_DIR}/${safeName(name)}-${dateOf(now)}`;
  let rel = `${base}.md`;
  for (let k = 2; existsSync(join(vault, ...rel.split('/'))); k++) rel = `${base}-${k}.md`;
  return rel;
}

/** 寫入封存檔,回傳寫入結果(路徑相對於記憶庫)。 */
export function writeArchive(vault: string, input: ArchiveInput): WriteResult {
  const { meta, body } = buildArchive(input);
  if (input.images && (input.images.avatar || input.images.portrait)) {
    // 圖像快照:屬性裡的路徑相對於封存檔(封存檔在 nodes/封存/,圖像在 nodes/封存/_圖像/)
    const snap = snapshotImages(vault, input.node.id, input.images);
    const rel = (p: string | null) => (p ? p.slice(`${ARCHIVE_DIR}/`.length) : undefined);
    meta.頭像 = rel(snap.avatar);
    meta.立繪 = rel(snap.portrait);
  }
  return writeMemory(vault, archivePath(vault, input.node.name, input.now), meta, body, 'replace', input.now);
}

/** 取出 Markdown 裡「## 標題」到下一個「## 」之間的內容(不含標題);沒有就是空字串。 */
export function extractSection(text: string, heading: string): string {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const start = lines.findIndex(l => l.trim() === `## ${heading}`);
  if (start < 0) return '';
  let end = lines.length;
  for (let k = start + 1; k < lines.length; k++) if (/^##\s/.test(lines[k])) { end = k; break; }
  return lines.slice(start + 1, end).join('\n').trim();
}

/** 去掉屬性區塊,只留內文。 */
const bodyOf = (text: string): string => text.replace(/^﻿/, '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');

const ARCHIVE_RE = /^nodes\/封存\/(.+)-(\d{4}-\d{2}-\d{2})(?:-(\d+))?\.md$/;

export interface ArchiveMatch { path: string; date: string; name: string }

/**
 * 找某個名稱的封存:路徑符合 nodes/封存/<名稱>-<日期>[-n].md、狀態是「封存」。多筆時取最新的(日期、再比序號)。
 * names 依序比對(先節點名稱、再角色),第一個有封存的名稱勝出。
 */
export function findArchive(entries: MemoryEntry[], names: string[]): ArchiveMatch | null {
  for (const raw of names) {
    const name = String(raw ?? '').trim();
    if (!name) continue;
    const want = safeName(name);
    const hits: Array<ArchiveMatch & { seq: number }> = [];
    for (const e of entries) {
      if (e.kind !== 'node' || e.status !== '封存') continue;
      const m = ARCHIVE_RE.exec(e.path);
      if (m && m[1] === want) hits.push({ path: e.path, date: m[2], name, seq: Number(m[3] ?? 1) });
    }
    hits.sort((a, b) => b.date.localeCompare(a.date) || b.seq - a.seq);
    if (hits[0]) return { path: hits[0].path, date: hits[0].date, name };
  }
  return null;
}

/**
 * 把封存檔的「特長」與「解決問題的流程」接回新節點的側寫 nodes/<名稱>.md,並加上屬性「接回自」。
 * 檔案不存在就建立;已存在而且被使用者改過,writeMemory 會改成附加一段。封存裡兩段都沒有內容時回傳 null(不寫檔)。
 */
export function attachArchive(vault: string, archiveRel: string, node: { id: string; name: string; backendLabel: string; model: string }, now: Date = new Date()): WriteResult | null {
  const rel = archiveRel.replace(/\\/g, '/');
  if (!ARCHIVE_RE.test(rel)) throw new Error('封存檔的路徑不正確');
  const abs = join(vault, ...rel.split('/'));
  if (!existsSync(abs)) throw new Error('找不到這份封存');
  const text = readFileSync(abs, 'utf8');
  const traits = extractSection(bodyOf(text), '特長');
  const flow = extractSection(bodyOf(text), '解決問題的流程');
  if (!traits && !flow) return null;
  // 側寫被使用者改過時只會附加內文、屬性區塊不會更新,所以來源也寫在內文裡
  const body = [`接回自:${rel}`, traits &&`## 特長\n\n${traits}`, flow && `## 解決問題的流程\n\n${flow}`].filter(Boolean).join('\n\n');
  const meta: Record<string, MetaValue> = {
    種類: 'node', 節點ID: node.id, 節點: node.name, 後台: node.backendLabel, 模型: node.model || '(預設)',
    更新時間: timeOf(now.getTime()), 接回自: rel,
  };
  return writeMemory(vault, nodeProfilePath(vault, node), meta, body, 'replace', now);
}

/** 判例檔名開頭的編號(例如 2026-0003);沒有就用整個檔名。 */
export function caseNumber(e: MemoryEntry): string {
  const file = e.path.split('/').pop() ?? e.path;
  return /^(\d{4}-\d{3,})/.exec(file)?.[1] ?? file.replace(/\.md$/i, '');
}

export const SELF_SUMMARY_PROMPT = `〔歸檔總結〕這個節點即將從主控台移除。請用 400 字以內,簡要整理你平常是怎麼工作的,分成四點:
1. 習慣的做法
2. 常用工具與步驟
3. 成功的模式
4. 常見的失誤
最後另起一行寫「## 回顧」,接著用 2 到 3 句話回顧:根據你實際做過的任務與對話紀錄,這段時間有哪些值得後人記住的事。你是單一作者,由你一個人總結,並寫清楚誰說了什麼(例如「使用者多次要求…」「我曾經…」);只寫紀錄裡有的,不要美化、不要編造。
只回覆總結本身;不要改動任何檔案,也不要執行指令。`;

/** 從節點或總管的回覆裡分出「## 回顧」:回傳去掉回顧的總結,與回顧本身(沒有就是空字串)。接受「## 回顧」「回顧:」「**回顧**」等寫法。 */
export function splitReview(reply: string): { summary: string; review: string } {
  const lines = reply.split(/\r?\n/);
  const at = lines.findIndex(l => REVIEW_HEAD.test(l));
  if (at < 0) return { summary: reply.trim(), review: '' };
  const head = lines[at].replace(REVIEW_HEAD, '').trim();
  const review = [head, ...lines.slice(at + 1)].join('\n').trim();
  return { summary: lines.slice(0, at).join('\n').trim(), review };
}
const REVIEW_HEAD = /^\s*(?:#{1,6}\s*)?(?:\*\*)?回顧(?:\*\*)?\s*[:：]?\s*(?:\*\*)?/;

/** 請總管代寫:附上節點的任務標題與最近的回覆。 */
export function chiefSummaryPrompt(nodeName: string, titles: string[], replies: string[]): string {
  return `〔歸檔總結:總管代寫〕節點「${nodeName}」即將從主控台移除,但它現在無法自己寫工作總結。請根據下面的資料,用 400 字以內整理它平常是怎麼工作的:習慣的做法、常用工具與步驟、成功的模式、常見的失誤。資料不足的地方不要編造,直接略過。最後另起一行寫「## 回顧」,接著用 2 到 3 句話回顧,內容要根據下面實際的紀錄;你是單一作者,由你一個人總結,並寫清楚誰說了什麼(例如「使用者要求…」「節點回報…」)。只回覆總結本身;不要改動任何檔案,也不要執行指令。

它做過的任務(新到舊):
${titles.length ? titles.map(t => `- ${t}`).join('\n') : '(沒有紀錄)'}

它最近的回覆:
${replies.length ? replies.map((r, k) => `(${k + 1}) ${r}`).join('\n\n') : '(沒有紀錄)'}`;
}
