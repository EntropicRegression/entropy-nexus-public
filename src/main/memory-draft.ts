import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentInfo } from '../shared/types';
import { DRAFT_PROMPT_LEAD, DRAFT_THRESHOLD, draftSegment, shouldOfferDraft, type DraftEvent } from '../shared/memory-draft.ts';
import type { writeMemory as WriteMemory, safeName as SafeName } from './memory-write';

/**
 * 對話草稿(長期記憶階段 4.5,點 1):使用者在對話視窗按「儲存這段記憶」,主控台請「那個節點」把上次儲存之後的對話整理成一份草稿,
 * 節點用 memory_draft 提交,主控台寫進記憶庫(preferences/ 或 knowledge/<專案>/),狀態「未確認」,使用者在記憶庫管理 app 確認後才算數。
 * 設計見 docs/記憶設計討論.md「第二輪定案」點 1。
 *
 * 保護:只有被請求的節點可以提交、一次請求只能提交一份(和 cases.ts 同一套做法);草稿的狀態一律「未確認」,
 * 記憶搜尋不會把未確認的內容給任何 agent 看到;不會覆寫已存在的檔案(同名時加上「-草稿」後綴)。
 *
 * 不依賴 Electron;寫入與檔名清理由 deps 傳入(測試與 cases.ts 相同的做法)。
 */

const PENDING_KEY = 'draft:pending';
const SEQ_KEY = 'draft:seq:';
/** 請求送出後超過這麼久節點還沒提交,可以重新請它整理。 */
export const DRAFT_RETRY_MS = 30 * 60 * 1000;
const TITLE_MAX = 80;
const CONTENT_MAX = 8000;

export const DRAFT_KINDS = ['preference', 'knowledge'] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];
const KIND_ALIAS: Record<string, DraftKind> = { preference: 'preference', 偏好: 'preference', 使用者偏好: 'preference', knowledge: 'knowledge', 知識: 'knowledge', 專案知識: 'knowledge' };
const SUBTYPE_ALIAS: Record<string, '決策' | '書籤'> = { decision: '決策', 決策: '決策', bookmark: '書籤', 書籤: '書籤' };

/** 門檻:環境變數 NEXUS_DRAFT_THRESHOLD(測試與調整用)優先,否則 3000 字。 */
export function draftThreshold(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.NEXUS_DRAFT_THRESHOLD);
  return Number.isFinite(n) && n > 0 ? n : DRAFT_THRESHOLD;
}

export function formatDraftPrompt(input: { nodeName: string; segment: string; project: string }): string {
  return [
    `${DRAFT_PROMPT_LEAD}這不是使用者的新指令,請不要修改任何檔案。)`,
    `使用者想把你們剛才這段對話裡值得長期保留的內容存進記憶庫。請你(單一作者)整理成一份草稿,寫完後呼叫 memory_draft 工具(nexus 伺服器)提交一次。參數:`,
    '- kind:preference(使用者跨專案適用的偏好、習慣、說話方式)或 knowledge(這個專案的知識、決策、踩過的坑、待辦書籤);只能二選一',
    '- title:一句話標題(會變成檔名)',
    '- content:內容(Markdown)。第一行寫最重要的一句話;之後寫來龍去脈。誰說的要寫清楚:「使用者要求…」「我(節點)建議…」,不要把我的推測寫成使用者的決定',
    '- subtype(只有 knowledge 可填,可省略):決策(做了什麼決定、為什麼)或 書籤(還沒做完、之後要回來處理的事,寫清楚做到哪)',
    '- supersedes(可省略):如果這則記憶取代某個舊的記憶,填舊檔的路徑(用 memory_search 查到的路徑)',
    '參數名稱一律用英文;內容用中文寫。',
    '規則:只寫這段對話裡實際出現的事,不要美化、不要補充沒說過的內容;不要寫入金鑰、密碼、權杖等機密;控制在 800 字內;只提交一份,挑最值得保存的主題。如果這段對話沒有值得保存的內容,就不要呼叫工具,直接回覆「沒有值得保存的內容」。',
    `節點:${input.nodeName};專案:${input.project || '(未知)'}。`,
    '',
    '以下是要整理的對話片段(依時間順序):',
    input.segment,
  ].join('\n');
}

export interface DraftSubmission { kind: DraftKind; title: string; content: string; subtype: '決策' | '書籤' | ''; supersedes: string }

const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v)).trim();

/** 檢查節點提交的參數;缺欄位或格式不對就丟出說明讓節點照著補。 */
export function parseDraft(args: Record<string, unknown>): DraftSubmission {
  const kind = KIND_ALIAS[str(args.kind ?? args.type).toLowerCase()];
  const title = str(args.title ?? args.name).replace(/\s+/g, ' ').slice(0, TITLE_MAX);
  const content = str(args.content ?? args.text ?? args.body).slice(0, CONTENT_MAX);
  if (!kind || !title || !content) throw new Error(`memory_draft 需要 kind(preference 或 knowledge)、title、content 三個字串參數。這次收到的 kind:${JSON.stringify(args.kind ?? null)}。`);
  const rawSub = str(args.subtype);
  const subtype = rawSub ? SUBTYPE_ALIAS[rawSub.toLowerCase()] : undefined;
  if (rawSub && !subtype) throw new Error('subtype 只能是 決策(decision)或 書籤(bookmark),不需要時請省略。');
  if (subtype && kind !== 'knowledge') throw new Error('subtype 只有 kind 為 knowledge 時可以填。');
  const supersedes = str(args.supersedes).replace(/[\[\]]/g, '').trim();
  return { kind, title, content, subtype: subtype ?? '', supersedes };
}

const pad = (n: number) => String(n).padStart(2, '0');
const localStamp = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

interface Pending { at: number; project: string; projectId: string }

export interface DraftDeps {
  vaultDir: string;
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
  /** 節點的對話事件(新的在後面)。 */
  history(agentId: string): DraftEvent[];
  agent(id: string): AgentInfo | undefined;
  /** 節點所在的專案(用工作目錄判斷)。 */
  project(agentId: string): Promise<{ id: string; name: string }>;
  /** 把請求排進節點的佇列(來源標成 draft)。 */
  request(agentId: string, text: string): void;
  rescan(): void;
  write: typeof WriteMemory;
  safeName: typeof SafeName;
  backendLabel(backend: AgentInfo['backend']): string;
  threshold?: number;
  now?: () => Date;
}

export class DraftService {
  private d: DraftDeps;
  constructor(deps: DraftDeps) { this.d = deps; }

  private now(): Date { return this.d.now?.() ?? new Date(); }
  private threshold(): number { return this.d.threshold ?? draftThreshold(); }

  private lastSeq(agentId: string): number { return Number(this.d.getSetting(SEQ_KEY + agentId)) || 0; }

  /** 對話視窗用:上次儲存到哪一筆事件、累積多少字才顯示按鈕。 */
  info(agentId: string): { lastSeq: number; threshold: number } {
    return { lastSeq: this.lastSeq(agentId), threshold: this.threshold() };
  }

  private pendingAll(): Record<string, Pending> {
    try { return JSON.parse(this.d.getSetting(PENDING_KEY) ?? '{}') ?? {}; } catch { return {}; }
  }
  private setPending(agentId: string, p: Pending | null): void {
    const all = this.pendingAll();
    if (p) all[agentId] = p; else delete all[agentId];
    this.d.setSetting(PENDING_KEY, JSON.stringify(all));
  }
  /** 這個節點現在有沒有一份等著提交的請求(測試用)。 */
  hasPending(agentId: string): boolean { return !!this.pendingAll()[agentId]; }

  /** 使用者按「儲存這段記憶」:累積夠了、節點收得到,就請它整理;記下這次涵蓋到哪裡,按鈕在下一個門檻前不再出現。 */
  async request(agentId: string): Promise<string> {
    const agent = this.d.agent(agentId);
    if (!agent || agent.parentId) throw new Error('找不到這個節點(子代理不能存記憶)。');
    if (agent.terminal) throw new Error('這個節點在終端機模式,請先回到對話模式。');
    if (agent.state === 'sleeping' || agent.state === 'lost') throw new Error(`這個節點${agent.state === 'sleeping' ? '正在休眠' : '失聯'},要先喚醒。`);
    const pending = this.pendingAll()[agentId];
    if (pending && this.now().getTime() - pending.at < DRAFT_RETRY_MS) throw new Error('已經請這個節點整理記憶草稿了,等它提交。');
    const last = this.lastSeq(agentId);
    const seg = draftSegment(this.d.history(agentId), last);
    if (!shouldOfferDraft(seg.chars, this.threshold())) throw new Error(`上次儲存之後的對話只有 ${seg.chars} 字,累積到 ${this.threshold()} 字才能儲存。`);
    const proj = await this.d.project(agentId).catch(() => ({ id: '', name: '' }));
    this.d.request(agentId, formatDraftPrompt({ nodeName: agent.name, segment: seg.text, project: proj.name }));
    this.setPending(agentId, { at: this.now().getTime(), project: proj.name, projectId: proj.id });
    this.d.setSetting(SEQ_KEY + agentId, String(seg.lastSeq));
    return `已請「${agent.name}」整理這段對話的記憶草稿(節點忙碌時會排在佇列);完成後在記憶庫管理 app 確認,未確認的草稿不會被任何 agent 查到。`;
  }

  /** 不覆寫既有的檔案:同名時加「-草稿」、「-草稿2」…。 */
  private freePath(dir: string, title: string): string {
    const base = this.d.safeName(title);
    let rel = `${dir}/${base}.md`;
    for (let k = 1; existsSync(join(this.d.vaultDir, ...rel.split('/'))); k++) rel = `${dir}/${base}-草稿${k > 1 ? k : ''}.md`;
    return rel;
  }

  /** 節點提交草稿(MCP 工具 memory_draft)。只有被請求的節點能交,一次請求一份。回傳給節點看的說明。 */
  async submit(callerId: string, args: Record<string, unknown>): Promise<string> {
    const pending = this.pendingAll()[callerId];
    if (!pending) throw new Error('主控台沒有請你整理記憶草稿,所以不能提交(只有使用者按下「儲存這段記憶」後,被請求的節點才能提交,而且一次請求只能提交一份)。');
    const sub = parseDraft(args);
    const agent = this.d.agent(callerId);
    const now = this.now();
    const node = agent ? `${agent.name}(${this.d.backendLabel(agent.backend)}${agent.model ? ` · ${agent.model}` : ''})` : callerId;
    const project = pending.project || '未分類專案';
    const rel = sub.kind === 'preference' ? this.freePath('preferences', sub.title) : this.freePath(`knowledge/${this.d.safeName(project)}`, sub.title);
    const res = this.d.write(this.d.vaultDir, rel, {
      種類: sub.kind,
      範圍: sub.kind === 'preference' ? '全域' : '專案',
      專案ID: sub.kind === 'knowledge' ? pending.projectId || undefined : undefined,
      專案: project,
      標題: sub.title,
      子類: sub.subtype || undefined,
      取代: sub.supersedes ? `[[${sub.supersedes}]]` : undefined,
      狀態: '未確認',
      來源: '對話草稿',
      來源節點: node,
      節點ID: callerId,
      更新時間: localStamp(now),
    }, sub.content, 'replace', now);
    this.setPending(callerId, null);
    this.d.rescan();
    return `已寫入草稿「${sub.title}」(狀態:未確認,使用者在記憶庫確認後才會生效)。路徑:${res.path}${res.masked ? `;有 ${res.masked} 處疑似機密已遮罩` : ''}。`;
  }
}

