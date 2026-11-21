import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CandidateInput } from '../shared/case-candidates';
import type { AgentInfo, MemoryEntry, TaskInfo } from '../shared/types';
import type { writeMemory as WriteMemory, safeName as SafeName } from './memory-write';

/**
 * 判例庫(長期記憶階段 3):任務完成時偵測困難任務,請承辦節點把解法寫成判例,由主控台填客觀欄位、寫進記憶庫。
 * 設計見 docs/記憶設計討論.md「解法紀錄:判例庫」。三道保護:客觀欄位由主控台填、新判例一律「未確認」、每天自動撰寫的份數有上限。
 *
 * 這個檔案不依賴 Electron,也不直接 import 其他本機模組的值(單元測試用 node 直接載入 .ts,載不了沒有副檔名的相對路徑):
 * 寫入、檔名清理、候選偵測都由建構時的 deps 傳入(index.ts 接上真的實作)。
 */

/** 判例敘述的章節,順序固定(和記憶設計一致)。 */
/** 摘要的長度上限(判例檔第一行,搜尋結果與總管守則只看得到前面一小段)。 */
const SUMMARY_MAX = 120;
export const CASE_SECTIONS = ['事實經過', '爭點', '處理經過', '結論', '理由', '適用範圍', '參照先例'] as const;
/**
 * case_submit 的參數名稱。工具參數名稱只能用英數字與 _ . -(Anthropic API 的規定,用中文的話 Claude 節點根本拿不到這個工具),
 * 所以參數用英文,寫進判例檔時再對應回中文章節與屬性。
 */
export const CASE_ARGS = { title: '案由', keywords: '關鍵字', facts: '事實經過', issue: '爭點', process: '處理經過', conclusion: '結論', reasoning: '理由', scope: '適用範圍', precedents: '參照先例', summary: '摘要', review: '回顧' } as const;
const SECTION_ARG = Object.fromEntries(Object.entries(CASE_ARGS).map(([arg, label]) => [label, arg])) as Record<string, keyof typeof CASE_ARGS>;
export type CaseSection = (typeof CASE_SECTIONS)[number];
export type CaseSource = '自動偵測' | '使用者標記';

/** 每段敘述最多收多少字、案由與關鍵字的長度上限。 */
const SECTION_MAX = 8000;
const TITLE_MAX = 80;
const KEYWORDS_MAX = 8;
/** 請求送出後超過這麼久節點還沒提交,使用者可以重新請它寫。 */
export const PENDING_RETRY_MS = 30 * 60 * 1000;
const PENDING_KEY = 'case:pending';
const AUTO_KEY = 'case:auto:';
const SEQ_KEY = 'case:seq:';

// ---- 案號 ----

export function formatCaseId(year: number, n: number): string {
  return `${year}-${String(n).padStart(4, '0')}`;
}

export function parseCaseId(s: string): { year: number; n: number } | null {
  const m = /^(\d{4})-(\d{4,})/.exec(s.trim());
  return m ? { year: Number(m[1]), n: Number(m[2]) } : null;
}

/** 下一個案號:取「已用過的案號」與「計數器」兩者較大的流水號加一,跨年從 0001 重新開始。 */
export function nextCaseId(year: number, used: string[], counter = 0): string {
  let max = Math.max(0, counter);
  for (const u of used) { const p = parseCaseId(u); if (p && p.year === year && p.n > max) max = p.n; }
  return formatCaseId(year, max + 1);
}

/** 記憶庫索引裡的判例路徑(cases/<專案>/2026-0003-案由.md)取出案號。 */
export function caseIdFromPath(path: string): string {
  const name = path.split('/').pop() ?? '';
  return /^(\d{4}-\d{4,})/.exec(name)?.[1] ?? '';
}

// ---- 先例 ----

function tokens(s: string): Set<string> {
  const out = new Set<string>();
  const text = s.toLowerCase();
  for (const w of text.match(/[a-z0-9_]{2,}/g) ?? []) out.add(w);
  for (const run of text.match(/[㐀-鿿]+/g) ?? []) {
    if (run.length === 1) out.add(run);
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

/** 依關鍵字比對既有的「已確認」判例(同專案的加分),回傳最相關的幾筆;沒有共同字詞的不列。 */
export function suggestPrecedents(query: string, entries: MemoryEntry[], projectId: string | undefined, limit = 5): Array<{ caseId: string; title: string }> {
  const q = tokens(query);
  return entries
    .filter(e => e.kind === 'case' && e.status === '已確認' && caseIdFromPath(e.path))
    .map(e => {
      const t = tokens(e.title);
      let score = 0;
      for (const w of t) if (q.has(w)) score++;
      return { e, score: score > 0 && projectId && e.projectId === projectId ? score + 1 : score };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || b.e.updatedAt - a.e.updatedAt)
    .slice(0, limit)
    .map(x => ({ caseId: caseIdFromPath(x.e.path), title: x.e.title }));
}

// ---- 請節點撰寫的提示詞 ----

/** 請求的提示詞開頭;假資料轉接器也靠它認出這是判例撰寫請求(見 fake.ts)。 */
export const CASE_PROMPT_LEAD = '(主控台:判例撰寫請求。';

export function formatCasePrompt(input: { taskId: string; title: string; reasons: string[]; source: CaseSource; precedents: Array<{ caseId: string; title: string }> }): string {
  const why = input.source === '使用者標記' ? '使用者要求把它記成判例' : input.reasons.length ? `主控台判斷它是困難任務(${input.reasons.join('、')})` : '主控台判斷它值得記成判例';
  const lines = [
    `${CASE_PROMPT_LEAD}這不是使用者的新指令,請不要再修改任何檔案。)`,
    `你剛完成的任務「${input.title}」(任務編號:${input.taskId}),${why}。請把這次的解法寫成一份判例,讓之後的你或其他節點遇到類似的問題時可以參考。`,
    '請依下面的固定格式,用你自己的話寫出敘述的部分,寫完後呼叫 case_submit 工具(nexus 伺服器)提交一次。耗時、失敗次數、改過的檔案、commit、專案等客觀欄位由主控台自動填,你不必寫。參數:',
    `- task_id:${input.taskId}`,
    '- title(案由):一句話描述問題',
    '- keywords(關鍵字):3 到 6 個關鍵字(字串陣列)',
    '- facts(事實經過):遇到什麼狀況、錯誤訊息或症狀',
    '- issue(爭點):真正要解決的問題是什麼',
    '- process(處理經過):試過哪些方法,哪些沒用、為什麼(走過的彎路)',
    '- conclusion(結論):最後有效的解法:改了哪些檔案、哪些設定、哪些指令',
    '- reasoning(理由):為什麼這樣能解決(根本原因)',
    '- scope(適用範圍):適用條件,什麼情況下不適用',
    '- precedents(參照先例):相關的既有案號,用 [[案號]] 表示;沒有就寫「無」',
    '- summary(摘要):結論的一句話(會放在判例檔最前面,搜尋時最先被看到,所以要寫最重要的一句)',
    '- review(回顧,可省略):2 到 3 句,事後回頭看這次處理有什麼值得記住的;一定要根據上面實際發生的紀錄寫,不要美化',
    '參數名稱一律用括號前的英文;內容用中文寫。',
    '你是這份判例的單一作者:由你一個人整理,並且寫清楚誰說了什麼(例如「使用者指出…」「我發現…」),不要把推測寫成別人的話。',
    '規則:只寫這個任務裡實際發生的事,不要美化成績;不要寫入金鑰、密碼、權杖等機密;每段控制在 800 字內。',
  ];
  if (input.precedents.length) lines.push(`可能相關的既有判例(參照先例可從這裡挑):\n${input.precedents.map(p => `- [[${p.caseId}]] ${p.title}`).join('\n')}`);
  return lines.join('\n');
}

// ---- 提交內容的檢查與判例文件 ----

export interface CaseSubmission { title: string; keywords: string[]; sections: Record<CaseSection, string>; summary: string; review: string }

/** 結論的第一句(摘要沒填時用):取到第一個句號或換行,太長就截斷。 */
export function firstSentence(s: string): string {
  const t = s.replace(/^[\s#>*-]+/, '');
  const m = /^[^。！？!?\n]*[。！？!?]?/.exec(t);
  return (m?.[0] ?? t).replace(/\s+/g, ' ').trim().slice(0, SUMMARY_MAX);
}

const text = (v: unknown): string => (typeof v === 'string' ? v : Array.isArray(v) ? v.map(String).join('\n') : v === undefined || v === null ? '' : String(v)).trim();

/** 檢查節點提交的參數(缺少必要欄位就丟出說明,讓節點照著補)。 */
export function parseSubmission(args: Record<string, unknown>): CaseSubmission {
  // 參數名稱是英文(見 CASE_ARGS);舊的中文名稱也收,避免已經照舊提示寫好的節點白寫
  const arg = (key: keyof typeof CASE_ARGS): unknown => args[key] ?? args[CASE_ARGS[key]];
  const title = text(arg('title')).replace(/\s+/g, ' ').slice(0, TITLE_MAX);
  const kwRaw = arg('keywords');
  const keywords = (Array.isArray(kwRaw) ? kwRaw.map(String) : typeof kwRaw === 'string' ? kwRaw.split(/[,、,;\s]+/) : [])
    .map(s => s.trim().slice(0, 30)).filter(Boolean).slice(0, KEYWORDS_MAX);
  const sections = {} as Record<CaseSection, string>;
  for (const k of CASE_SECTIONS) sections[k] = text(arg(SECTION_ARG[k])).slice(0, SECTION_MAX);
  const missing = [!title && 'title(案由)', !sections['事實經過'] && 'facts(事實經過)', !sections['結論'] && 'conclusion(結論)'].filter(Boolean);
  if (missing.length) throw new Error(`缺少必要的欄位:${missing.join('、')}。請補齊後再呼叫一次 case_submit(參數名稱:task_id、${Object.entries(CASE_ARGS).map(([a, l]) => `${a}(${l})`).join('、')})。`);
  if (!sections['參照先例']) sections['參照先例'] = '無';
  const summary = (text(arg('summary')).replace(/\s+/g, ' ').slice(0, SUMMARY_MAX)) || firstSentence(sections['結論']);
  const review = text(arg('review')).slice(0, SECTION_MAX);
  return { title, keywords, sections, summary, review };
}

/** 敘述裡的 # 標題會破壞章節結構,降成小標題。 */
const flatten = (s: string): string => s.replace(/^#{1,2}(\s)/gm, '###$1');

export function buildCaseBody(caseId: string, sections: Record<CaseSection, string>, summary = '', review = ''): string {
  const parts = [`# 解法第 ${caseId} 號`];
  // 黃金第一行:摘要緊接在標題下面,搜尋結果的摘錄與總管守則都從這裡開始
  if (summary.trim()) parts.push(`摘要:${summary.trim().replace(/\s+/g, ' ')}`);
  for (const k of CASE_SECTIONS) parts.push(`## ${k}\n\n${flatten(sections[k] || '(未填)')}`);
  // 回顧永遠是檔案最後一段
  if (review.trim()) parts.push(`## 回顧\n\n${flatten(review.trim())}`);
  return parts.join('\n\n') + '\n';
}

const pad = (n: number) => String(n).padStart(2, '0');
const localStamp = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// ---- 服務 ----

interface Pending { source: CaseSource; at: number }

export interface CaseDeps {
  vaultDir: string;
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
  entries(): MemoryEntry[];
  /** 寫入檔案後讓索引立刻更新(監看資料夾有延遲)。 */
  rescan(): void;
  task(id: string): TaskInfo | undefined;
  agent(id: string): AgentInfo | undefined;
  /** 任務改過的檔案路徑。 */
  changedFiles(taskId: string): Promise<string[]>;
  /** 任務期間節點說了幾則話、失敗了幾次(用來判斷候選與填「失敗次數」)。 */
  facts(task: TaskInfo): { agentMessages: number; failures: number };
  /** 把請求排進承辦節點的佇列(來源標成 case)。 */
  request(agentId: string, text: string): void;
  patchTask(taskId: string, patch: { caseId?: string; casePending?: boolean }): void;
  detect(input: CandidateInput): string[];
  write: typeof WriteMemory;
  safeName: typeof SafeName;
  /** 後台的顯示名稱(Claude Code、Codex、Antigravity)。 */
  backendLabel(backend: AgentInfo['backend']): string;
  /** 覆寫耗時門檻(分鐘),測試用。 */
  minMinutes?: number;
  dailyCap: number;
  now?: () => Date;
}

export class CaseService {
  private d: CaseDeps;
  constructor(deps: CaseDeps) { this.d = deps; }

  private now(): Date { return this.d.now?.() ?? new Date(); }

  // ---- 每日上限(只計自動撰寫的請求) ----
  autoCountToday(): number { return Number(this.d.getSetting(AUTO_KEY + localDay(this.now()))) || 0; }
  private bumpAuto(): void { this.d.setSetting(AUTO_KEY + localDay(this.now()), String(this.autoCountToday() + 1)); }

  // ---- 待撰寫的請求(重新啟動後仍有效) ----
  private pendingAll(): Record<string, Pending> {
    try { return JSON.parse(this.d.getSetting(PENDING_KEY) ?? '{}') ?? {}; } catch { return {}; }
  }
  private setPending(taskId: string, p: Pending | null): void {
    const all = this.pendingAll();
    if (p) all[taskId] = p; else delete all[taskId];
    this.d.setSetting(PENDING_KEY, JSON.stringify(all));
  }

  /** 節點現在能不能收到請求;不行時回傳原因。 */
  private cannotPrompt(agent: AgentInfo | undefined): string | null {
    if (!agent || agent.parentId) return '承辦的節點已經不在面板上';
    if (agent.terminal) return '承辦的節點在終端機模式';
    if (agent.state === 'sleeping' || agent.state === 'lost') return `承辦的節點${agent.state === 'sleeping' ? '正在休眠' : '失聯'},要先喚醒`;
    return null;
  }

  private request(task: TaskInfo, source: CaseSource, reasons: string[]): void {
    const precedents = suggestPrecedents(`${task.title}`, this.d.entries(), task.project?.id);
    this.d.request(task.agentId, formatCasePrompt({ taskId: task.id, title: task.title, reasons, source, precedents }));
    this.setPending(task.id, { source, at: this.now().getTime() });
    this.d.patchTask(task.id, { casePending: true });
  }

  /**
   * 任務結束時呼叫:是候選、今天自動撰寫的份數還沒到上限、節點收得到,就請它寫判例。
   * 回傳 null 表示沒有請求,字串是原因(測試與紀錄用)。
   */
  onTaskEnded(task: TaskInfo): { requested: true; reasons: string[] } | { requested: false; why: string } {
    try {
      const facts = this.d.facts(task);
      const reasons = this.d.detect({ task, agentMessages: facts.agentMessages, failures: facts.failures, ...(this.d.minMinutes !== undefined ? { minMinutes: this.d.minMinutes } : {}) });
      if (!reasons.length) return { requested: false, why: '不是候選' };
      if (this.autoCountToday() >= this.d.dailyCap) return { requested: false, why: '今天自動撰寫的份數已達上限' };
      const bad = this.cannotPrompt(this.d.agent(task.agentId));
      if (bad) return { requested: false, why: bad };
      this.request(task, '自動偵測', reasons);
      this.bumpAuto();
      return { requested: true, reasons };
    } catch (e) {
      return { requested: false, why: String((e as Error)?.message ?? e) };
    }
  }

  /** 使用者按「記下這個解法」:不受每日上限限制,任何已結束的任務都可以。回傳給使用者看的說明。 */
  mark(taskId: string): string {
    const task = this.d.task(taskId);
    if (!task) throw new Error('找不到這個任務');
    if (task.endedAt === null) throw new Error('任務還沒結束,結束後才能記下解法。');
    if (task.source === 'case') throw new Error('這是撰寫判例的請求本身,不能再記成判例。');
    if (task.caseId) throw new Error(`這個任務已經有判例 ${task.caseId}。`);
    const pending = this.pendingAll()[taskId];
    if (pending && this.now().getTime() - pending.at < PENDING_RETRY_MS) throw new Error('已經請承辦節點撰寫這個任務的判例,等它提交。');
    const bad = this.cannotPrompt(this.d.agent(task.agentId));
    if (bad) throw new Error(`${bad},現在無法請它撰寫判例。`);
    this.request(task, '使用者標記', []);
    return `已請「${task.agentName}」撰寫判例(節點忙碌時會排在佇列),完成後任務卡會出現案號。`;
  }

  /** 記憶庫 cases 資料夾裡已經用過的案號(從檔名取),不依賴索引,避免索引還沒更新時撞號。 */
  private usedIds(): string[] {
    const out: string[] = [];
    const root = join(this.d.vaultDir, 'cases');
    const walk = (dir: string) => {
      let names;
      try { names = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of names) {
        if (e.isDirectory()) walk(join(dir, e.name));
        else { const id = caseIdFromPath(e.name); if (id) out.push(id); }
      }
    };
    if (existsSync(root)) walk(root);
    for (const e of this.d.entries()) { const id = caseIdFromPath(e.path); if (id) out.push(id); }
    return out;
  }

  /** 配發案號:計數器存在資料庫設定裡,同時參考資料夾裡已有的檔案;同一個行程裡是同步的,不會撞號。 */
  allocateCaseId(): string {
    const year = this.now().getFullYear();
    const id = nextCaseId(year, this.usedIds(), Number(this.d.getSetting(SEQ_KEY + year)) || 0);
    this.d.setSetting(SEQ_KEY + year, String(parseCaseId(id)!.n));
    return id;
  }

  /**
   * 承辦節點提交判例(MCP 工具 case_submit)。只有這個任務自己的節點可以提交,而且必須是主控台請它寫的。
   * 客觀欄位由這裡依任務資料填,狀態一律「未確認」。回傳給節點看的說明。
   */
  async submit(callerId: string, args: Record<string, unknown>): Promise<string> {
    const taskId = text(args['task_id'] ?? args['taskId']);
    const task = taskId ? this.d.task(taskId) : undefined;
    if (!task) throw new Error('找不到這個任務(task_id 要用主控台請求裡給的任務編號)。');
    if (task.agentId !== callerId) throw new Error('只有承辦這個任務的節點可以為它提交判例。');
    if (task.caseId) throw new Error(`這個任務已經有判例 ${task.caseId},不能重複提交。`);
    const pending = this.pendingAll()[task.id];
    if (!pending) throw new Error('主控台沒有請你為這個任務撰寫判例,所以不能提交。');
    const sub = parseSubmission(args);
    const files = await this.d.changedFiles(task.id).catch(() => [] as string[]);
    const agent = this.d.agent(task.agentId);
    // 以下到寫入都是同步的:配發案號與寫檔之間不會被另一個提交插隊
    const caseId = this.allocateCaseId();
    const now = this.now();
    const project = task.project?.name || '未分類專案';
    const rel = `cases/${this.d.safeName(project)}/${caseId}-${this.d.safeName(sub.title)}.md`;
    const facts = this.d.facts(task);
    const node = agent ? `${agent.name}(${this.d.backendLabel(agent.backend)}${agent.model ? ` · ${agent.model}` : ''})` : task.agentName;
    const minutes = task.endedAt === null ? 0 : Math.max(0, Math.round((task.endedAt - task.startedAt) / 60000));
    const res = this.d.write(this.d.vaultDir, rel, {
      案號: caseId,
      案由: sub.title,
      種類: 'case',
      範圍: '專案',
      專案ID: task.project?.id,
      專案: project,
      承辦節點: node,
      節點ID: task.agentId,
      任務: task.id,
      來源: pending.source,
      耗時分鐘: minutes,
      失敗次數: facts.failures,
      改過的檔案: files,
      commit: task.changes?.committed,
      狀態: '未確認',
      關鍵字: sub.keywords,
      更新時間: localStamp(now),
    }, buildCaseBody(caseId, sub.sections, sub.summary, sub.review), 'replace', now);
    this.setPending(task.id, null);
    this.d.patchTask(task.id, { caseId, casePending: false });
    this.d.rescan();
    return `已記下判例 ${caseId}(狀態:未確認,使用者在記憶庫確認後才會被總管查到)。路徑:${res.path}${res.masked ? `;有 ${res.masked} 處疑似機密已遮罩` : ''}。`;
  }
}
