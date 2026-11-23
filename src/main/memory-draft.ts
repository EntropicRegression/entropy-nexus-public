import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentInfo } from '../shared/types';
import { DRAFT_PROMPT_LEAD, DRAFT_THRESHOLD, draftSegment, shouldOfferDraft, type DraftEvent } from '../shared/memory-draft.ts';
import type { writeMemory as WriteMemory, safeName as SafeName } from './memory-write';
import { MEMOIR_DAILY_CAP, formatMemoirPrompt, isDraftRequest, isMemoirRequest, localDay, parseMemoir, writeMemoir, type PromptOrigin } from './memoir.ts';

/**
 * 對話草稿(長期記憶階段 4.5,點 1):使用者在對話視窗按「儲存這段記憶」,主控台請「那個節點」把上次儲存之後的對話整理成一份草稿,
 * 節點用 memory_draft 提交,主控台寫進記憶庫(preferences/ 或 knowledge/<專案>/),狀態「未確認」,使用者在記憶庫管理 app 確認後才算數。
 * 設計見 docs/記憶設計討論.md「第二輪定案」點 1。
 *
 * 保護:只有被請求的節點可以提交、一次請求只能提交一份(和 cases.ts 同一套做法);草稿的狀態一律「未確認」,
 * 記憶搜尋不會把未確認的內容給任何 agent 看到;不會覆寫已存在的檔案(同名時加上「-草稿」後綴)。
 *
 * 回憶錄(第六輪,見 memoir.ts):使用者按「寫回憶錄」(或刪除節點前選擇寫回憶錄),主控台請那個節點寫一章;節點一樣用 memory_draft 提交,
 * kind 填 memoir(或「回憶錄」)。請求和一般記憶草稿分開記;身分欄位由主控台依提交者填;格式不合格拒收但請求保留(可以補上重寫);
 * 每個節點每天最多 MEMOIR_DAILY_CAP 份(以提交當下的本機日期計)。
 *
 * 請求的有效期(兩種請求相同):只有在那個請求的回合「還在佇列或正在進行」時才收提交(memoirActive / draftActive;
 * 沒有提供時退回用時間判斷 DRAFT_RETRY_MS)。回合結束還沒提交(或提交被拒後回合結束)時清掉請求(turnEnded);
 * 主控台重開時清掉提示已不在佇列的請求(resetOnStartup)。所以節點不能在幾天後被別的節點(ask_node、會議)叫去補交。
 *
 * 不依賴 Electron;一般草稿的寫入與檔名清理由 deps 傳入(測試與 cases.ts 相同的做法),回憶錄用 memoir.ts 的 writeMemoir。
 */

const PENDING_KEY = 'draft:pending';
const SEQ_KEY = 'draft:seq:';
/** 回憶錄請求另外記(和一般記憶草稿分開,兩種請求可以同時存在、互不頂替)。 */
const MEMOIR_PENDING_KEY = 'memoir:pending';
/** 每個節點每天寫了幾份回憶錄:memoir:count:<節點ID>:<YYYY-MM-DD>。 */
const MEMOIR_COUNT_KEY = 'memoir:count:';
/** 請求送出後超過這麼久節點還沒提交,可以重新請它整理。 */
export const DRAFT_RETRY_MS = 30 * 60 * 1000;
const TITLE_MAX = 80;
const CONTENT_MAX = 8000;

export const DRAFT_KINDS = ['preference', 'knowledge'] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];
/** memory_draft 的 kind 寫這些就是回憶錄(走另一套檢查與寫入,見 memoir.ts)。 */
const MEMOIR_KINDS = new Set(['memoir', '回憶錄']);
export const isMemoirKind = (v: unknown): boolean => MEMOIR_KINDS.has(String(v ?? '').trim().toLowerCase());
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
  /** 測試用:每個節點每天的回憶錄上限(預設 MEMOIR_DAILY_CAP)。 */
  memoirDailyCap?: number;
  /**
   * 這個節點的回憶錄請求是不是還在進行(提示還在佇列裡,或節點正在跑回憶錄的回合)。
   * 請求掛著但已經不在進行時(例如上一份不合格後節點就停了),允許重新請求並覆蓋舊請求。沒有提供時退回用時間判斷(DRAFT_RETRY_MS)。
   */
  memoirActive?(agentId: string): boolean;
  /** 這個節點的記憶草稿請求是不是還在進行(草稿提示還在佇列裡,或節點正在跑草稿的回合)。沒有提供時退回用時間判斷(DRAFT_RETRY_MS)。 */
  draftActive?(agentId: string): boolean;
  now?: () => Date;
}

export class DraftService {
  private d: DraftDeps;
  constructor(deps: DraftDeps) { this.d = deps; }

  private now(): Date { return this.d.now?.() ?? new Date(); }
  /** 每個節點最近一次成功提交回憶錄的時間(這次執行期間,不存設定);刪除流程用來分辨「寫好了」和「請求被清掉」。 */
  private memoirSubmitted = new Map<string, number>();

  /** 請求還在不在進行:有提供 active 就看佇列與回合,否則看請求送出多久(DRAFT_RETRY_MS 內算還在)。 */
  private live(active: ((id: string) => boolean) | undefined, agentId: string, at: number, now = this.now()): boolean {
    return active ? active(agentId) : now.getTime() - at < DRAFT_RETRY_MS;
  }

  /**
   * 主控台開啟時呼叫:上次關閉時還掛著的請求,回合一定已經不在了,清掉;只有提示還在佇列裡(重開後才會送出)的保留。
   * 沒有提供 memoirActive / draftActive 時全部清掉。
   */
  resetOnStartup(): void {
    const keep = <T,>(all: Record<string, T>, active?: (id: string) => boolean) => Object.fromEntries(Object.entries(all).filter(([id]) => !!active?.(id)));
    const m = this.memoirPendingAll();
    if (Object.keys(m).length) this.d.setSetting(MEMOIR_PENDING_KEY, JSON.stringify(keep(m, this.d.memoirActive)));
    const p = this.pendingAll();
    if (Object.keys(p).length) this.d.setSetting(PENDING_KEY, JSON.stringify(keep(p, this.d.draftActive)));
  }

  /**
   * 節點的一個回合結束時呼叫(title 是任務標題,也就是送出的提示;origin 是任務的來源):主控台送出的回憶錄或草稿請求的回合
   * 結束了還沒提交,就清掉那份請求,之後要再寫得請使用者重新按按鈕。同一種請求的提示還在佇列裡(下一個回合會處理)時不清。
   * 別的節點(ask_node、會議、流程)送來、只是內容以請求開頭寫成的回合不算。
   */
  turnEnded(agentId: string, title: string, origin: PromptOrigin): void {
    if (isMemoirRequest(title, origin)) {
      if (this.hasPendingMemoir(agentId) && !this.d.memoirActive?.(agentId)) this.setMemoirPending(agentId, null);
    } else if (isDraftRequest(title, origin)) {
      if (this.hasPending(agentId) && !this.d.draftActive?.(agentId)) this.setPending(agentId, null);
    }
  }

  /** 節點被刪除時:兩種請求都清掉,不留在設定裡。 */
  forget(agentId: string): void {
    if (this.hasPending(agentId)) this.setPending(agentId, null);
    this.cancelMemoir(agentId);
    this.memoirSubmitted.delete(agentId);
  }

  /** 這個節點最近一次成功提交回憶錄的時間(毫秒;沒有是 0)。 */
  memoirSubmittedAt(agentId: string): number { return this.memoirSubmitted.get(agentId) ?? 0; }
  private threshold(): number { return this.d.threshold ?? draftThreshold(); }

  private lastSeq(agentId: string): number { return Number(this.d.getSetting(SEQ_KEY + agentId)) || 0; }

  /**
   * 對話視窗用:上次儲存到哪一筆事件、累積多少字才顯示按鈕;memoirBusy 是回憶錄請求還在進行(按鈕停用)。
   * 依主控台的狀態判斷,對話視窗關掉再開也一樣。
   */
  info(agentId: string): { lastSeq: number; threshold: number; memoirBusy: boolean } {
    const m = this.memoirPendingAll()[agentId];
    return { lastSeq: this.lastSeq(agentId), threshold: this.threshold(), memoirBusy: !!m && this.live(this.d.memoirActive, agentId, m.at) };
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

  /** 節點收不收得到主控台的請求;收不到就丟出說明。 */
  private reachable(agentId: string, what: string): AgentInfo {
    const agent = this.d.agent(agentId);
    if (!agent || agent.parentId) throw new Error(`找不到這個節點(子代理不能${what})。`);
    if (agent.terminal) throw new Error('這個節點在終端機模式,請先回到對話模式。');
    if (agent.state === 'sleeping' || agent.state === 'lost') throw new Error(`這個節點${agent.state === 'sleeping' ? '正在休眠' : '失聯'},要先喚醒。`);
    return agent;
  }

  /** 使用者按「儲存這段記憶」:累積夠了、節點收得到,就請它整理;記下這次涵蓋到哪裡,按鈕在下一個門檻前不再出現。 */
  async request(agentId: string): Promise<string> {
    const agent = this.reachable(agentId, '存記憶');
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

  // ---- 回憶錄 ----
  private memoirPendingAll(): Record<string, { at: number }> {
    try { return JSON.parse(this.d.getSetting(MEMOIR_PENDING_KEY) ?? '{}') ?? {}; } catch { return {}; }
  }
  private setMemoirPending(agentId: string, p: { at: number } | null): void {
    const all = this.memoirPendingAll();
    if (p) all[agentId] = p; else delete all[agentId];
    this.d.setSetting(MEMOIR_PENDING_KEY, JSON.stringify(all));
  }
  /** 這個節點現在有沒有一份等著提交的回憶錄請求。 */
  hasPendingMemoir(agentId: string): boolean { return !!this.memoirPendingAll()[agentId]; }
  /** 取消回憶錄請求(刪除節點前等不到時用)。 */
  cancelMemoir(agentId: string): void { if (this.hasPendingMemoir(agentId)) this.setMemoirPending(agentId, null); }
  private memoirCap(): number { return this.d.memoirDailyCap ?? MEMOIR_DAILY_CAP; }
  /** 這個節點在 day(本機日期 YYYY-MM-DD)寫了幾份回憶錄。 */
  private memoirCount(agentId: string, day: string): number { return Number(this.d.getSetting(`${MEMOIR_COUNT_KEY}${agentId}:${day}`)) || 0; }
  /** 這個節點今天已經寫了幾份回憶錄。 */
  memoirCountToday(agentId: string): number { return this.memoirCount(agentId, localDay(this.now())); }

  /**
   * 使用者按「寫回憶錄」(或刪除節點前選擇寫回憶錄):節點收得到、今天還沒寫滿,就請它寫一章。
   * 不看累積字數;子代理與終端機模式不提供。farewell:刪除節點前的最後一章(提示文字不同)。
   * 舊的請求還在進行時拒絕;掛著但已經沒有在進行時重新請求(覆蓋舊請求)。
   */
  async requestMemoir(agentId: string, opts: { farewell?: boolean } = {}): Promise<string> {
    const agent = this.reachable(agentId, '寫回憶錄');
    const pending = this.memoirPendingAll()[agentId];
    const active = pending ? this.live(this.d.memoirActive, agentId, pending.at) : false;
    if (active) throw new Error('已經請這個節點寫回憶錄了,等它提交。');
    if (this.memoirCountToday(agentId) >= this.memoirCap()) {
      // 刪除前的告別請求:節點就要被刪除了,「明天再寫」沒有意義
      throw new Error(opts.farewell
        ? `「${agent.name}」今天已經寫了 ${this.memoirCap()} 份回憶錄,已達每日上限,這次不寫回憶錄。`
        : `「${agent.name}」今天已經寫了 ${this.memoirCap()} 份回憶錄,明天再寫。`);
    }
    const days = this.d.history(agentId).map(e => e.ts).filter((t): t is number => typeof t === 'number' && t > 0);
    const day = (ms: number) => localDay(new Date(ms));
    this.d.request(agentId, formatMemoirPrompt({
      nodeName: agent.name, today: localDay(this.now()), farewell: !!opts.farewell,
      ...(days.length ? { historyFrom: day(Math.min(...days)), historyTo: day(Math.max(...days)) } : {}),
    }));
    this.setMemoirPending(agentId, { at: this.now().getTime() });
    return `已請「${agent.name}」寫一章回憶錄(節點忙碌時會排在佇列);寫好後在記憶庫管理 app 確認,未確認的回憶錄不會被任何 agent 查到。`;
  }

  /**
   * 節點提交回憶錄:只有被請求的節點、在那個請求的回合還在佇列或進行中時能交,一次請求一份;身分欄位由主控台填,
   * 格式不合格就拒收(同一個回合裡可以補上重寫;回合結束後請求就清掉)。
   * 每日上限以提交當下的本機日期計:整個提交只取一次時間,上限檢查、檔名日期、計數都用同一天(請求在 23:59、提交在 00:01 算新的一天)。
   */
  private async submitMemoir(callerId: string, args: Record<string, unknown>): Promise<string> {
    const now = this.now();
    const pending = this.memoirPendingAll()[callerId];
    if (pending && !this.live(this.d.memoirActive, callerId, pending.at, now)) this.setMemoirPending(callerId, null);
    if (!pending || !this.hasPendingMemoir(callerId)) throw new Error('沒有進行中的回憶錄請求,所以不能提交:主控台沒有請你寫回憶錄,或那次請求的回合已經結束。要寫回憶錄,請使用者在對話視窗按「寫回憶錄」(或刪除節點前選擇寫回憶錄),在那個請求的回合裡提交;一次請求只能提交一份。');
    const agent = this.d.agent(callerId);
    if (!agent || agent.parentId) throw new Error('找不到你這個節點(子代理不能寫回憶錄)。');
    const day = localDay(now);
    if (this.memoirCount(callerId, day) >= this.memoirCap()) {
      this.setMemoirPending(callerId, null);
      throw new Error(`你今天已經寫了 ${this.memoirCap()} 份回憶錄,已達每日上限,這份不會寫入。`);
    }
    const sub = parseMemoir(args);
    const res = writeMemoir(this.d.vaultDir, { ...sub, nodeId: callerId, nodeName: agent.name, backendLabel: this.d.backendLabel(agent.backend), now });
    this.setMemoirPending(callerId, null);
    this.d.setSetting(`${MEMOIR_COUNT_KEY}${callerId}:${day}`, String(this.memoirCount(callerId, day) + 1));
    this.memoirSubmitted.set(callerId, now.getTime());
    this.d.rescan();
    const masked = [res.masked ? `${res.masked} 處疑似機密` : '', res.pathsMasked ? `${res.pathsMasked} 處本機路徑` : ''].filter(Boolean).join('、');
    return `已寫入回憶錄「${sub.title}」(狀態:未確認,使用者在記憶庫確認後才會生效)。路徑:${res.path}${masked ? `;${masked}已遮罩` : ''}。`;
  }

  /** 節點提交草稿(MCP 工具 memory_draft)。只有被請求的節點能交,一次請求一份。回傳給節點看的說明。 */
  async submit(callerId: string, args: Record<string, unknown>): Promise<string> {
    if (isMemoirKind(args.kind ?? args.type)) return this.submitMemoir(callerId, args);
    const now = this.now();
    let pending: Pending | undefined = this.pendingAll()[callerId];
    // 請求的回合已經不在佇列也不在進行(沒有提供 draftActive 時:超過 DRAFT_RETRY_MS):請求作廢
    if (pending && !this.live(this.d.draftActive, callerId, pending.at, now)) { this.setPending(callerId, null); pending = undefined; }
    if (!pending) throw new Error(`沒有進行中的記憶草稿請求:主控台沒有請你整理記憶草稿,或那次請求的回合已經結束,所以不能提交。要存記憶,請使用者在對話視窗按「儲存這段記憶」,在那個請求的回合裡提交;一次請求只能提交一份。${this.hasPendingMemoir(callerId) ? '主控台請你寫的是回憶錄,kind 請填 memoir。' : ''}`);
    const sub = parseDraft(args);
    const agent = this.d.agent(callerId);
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

