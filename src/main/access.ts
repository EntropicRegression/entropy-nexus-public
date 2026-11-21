import type { RemoteAccess, RemoteRole, Snapshot, Update } from '../shared/types';
import type { DashboardData } from '../shared/dashboard';

/**
 * 遠端裝置的權限。每支配對的裝置有一個角色與節點範圍:
 * - full(完整):和坐在電腦前相同,不限節點。
 * - operator(操作):對範圍內的節點下指令、排隊、中斷、回應授權、回答提問、休眠與喚醒。
 * - viewer(唯讀):只能看範圍內節點的狀態與對話。
 * 非完整的角色不能新增或終止節點、改設定、編輯角色卡、看或產生配對碼、用終端機模式、瀏覽電腦的資料夾。
 *
 * 規則集中在這個檔案:每個功能需要的等級、要檢查哪個節點、要不要寫進操作紀錄。
 * 沒列出的功能一律當成只有完整角色能用(預設拒絕),新增功能時忘了登記也不會意外開放。
 * 這個檔案不依賴 Electron 或核心服務,可以單獨測試(tests/access.test.js)。
 */
export type Level = 'read' | 'operate' | 'admin';

export interface Rule {
  level: Level;
  /** 要檢查節點範圍時,節點從哪裡來:agent 是節點 id,task 是任務 id(再查它屬於哪個節點)。 */
  scope?: 'agent' | 'task';
  /** 成功時是否寫進操作紀錄;被拒絕的一律會記。 */
  log: boolean;
}

const RANK: Record<RemoteRole, number> = { viewer: 0, operator: 1, full: 2 };
const NEED: Record<Level, number> = { read: 0, operate: 1, admin: 2 };

export const FULL: RemoteAccess = { role: 'full', agents: null };

/** 把存檔或畫面送來的權限整理成合法的值;完整角色不限節點,看不懂的角色當成唯讀。 */
export function normalizeAccess(role: unknown, agents: unknown): RemoteAccess {
  const r: RemoteRole = role === 'full' || role === 'operator' || role === 'viewer' ? role : 'viewer';
  if (r === 'full') return FULL;
  const list = Array.isArray(agents) ? [...new Set(agents.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 80))].slice(0, 200) : null;
  return { role: r, agents: list };
}

export const roleAllows = (access: RemoteAccess, level: Level): boolean => RANK[access.role] >= NEED[level];

/** root 是節點所屬的最上層節點(子代理跟著呼叫它的節點);節點不存在時是 null。 */
export const visible = (access: RemoteAccess, root: string | null): boolean => access.agents === null || (root !== null && access.agents.includes(root));

const read = (scope?: Rule['scope']): Rule => ({ level: 'read', scope, log: false });
const operate = (scope?: Rule['scope'], log = true): Rule => ({ level: 'operate', scope, log });
const ADMIN: Rule = { level: 'admin', log: true };
const ADMIN_QUIET: Rule = { level: 'admin', log: false };

/**
 * 完整介面經 /api/rpc 呼叫的方法(名稱和主行程的方法表相同);第一個參數是節點或任務 id。
 * 語音模式(voiceStatus、voiceSet、voiceTranscribe)刻意不在方法表裡,只註冊給桌面畫面的 IPC,
 * 所以任何角色的遠端裝置都呼叫不到(/api/rpc 回「沒有這個功能」);要開放給遠端時再在這裡加規則。
 */
const RPC: Record<string, Rule> = {
  snapshot: read(),
  history: read('agent'),
  worktreeStatus: read('agent'),
  taskChanges: read('task'),
  // 驗收:操作以上的角色、只限看得到的節點(依任務 id 找節點)
  taskVerdict: operate('task'),
  send: operate('agent'),
  enqueue: operate('agent'),
  cancelQueued: operate('agent'),
  editQueued: operate('agent'),
  resumeQueue: operate('agent'),
  approval: operate('agent'),
  answer: operate('agent'),
  interrupt: operate('agent'),
  sleep: operate('agent'),
  wake: operate('agent'),
  attachmentPreview: operate(undefined, false),
  // 角色的 Q 版頭像:只是畫面上的圖,看得到節點的角色就能讀
  getAvatar: read(),
  // 只有完整角色能用,而且只是讀取或太頻繁,不寫紀錄
  remoteStatus: ADMIN_QUIET, remoteAudit: ADMIN_QUIET, observeStatus: ADMIN_QUIET, getPersona: ADMIN_QUIET, oldSessions: ADMIN_QUIET,
  findMemoryArchive: ADMIN_QUIET,
  inspectDir: ADMIN_QUIET, termAttach: ADMIN_QUIET, termWrite: ADMIN_QUIET, termResize: ADMIN_QUIET,
};

/** 手機版頁面與 App 用的端點;鍵是「方法 路徑」。POST 的節點 id 在 body.id,GET 的在查詢參數 id 或 task。 */
const HTTP: Record<string, Rule> = {
  'GET /api/state': read(),
  'GET /api/meta': read(),
  'GET /api/stream': read(),
  'GET /api/portrait': read(),
  'GET /api/history': read('agent'),
  'GET /api/file': read('agent'),
  'GET /api/worktree': read('agent'),
  'GET /api/changes': read('task'),
  'GET /api/dirs': ADMIN_QUIET,
  'GET /api/inspect': ADMIN_QUIET,
  'GET /api/oldsessions': ADMIN_QUIET,
  'GET /api/persona': ADMIN_QUIET,
  'POST /api/upload': operate(undefined, false),
  'POST /api/send': operate('agent'),
  'POST /api/enqueue': operate('agent'),
  'POST /api/cancelqueued': operate('agent'),
  'POST /api/editqueued': operate('agent'),
  'POST /api/resumequeue': operate('agent'),
  'POST /api/approve': operate('agent'),
  'POST /api/answer': operate('agent'),
  'POST /api/interrupt': operate('agent'),
  'POST /api/sleep': operate('agent'),
  'POST /api/wake': operate('agent'),
};

export const rpcRule = (method: string): Rule => (Object.hasOwn(RPC, method) ? RPC[method] : ADMIN);
export const httpRule = (method: string, path: string): Rule => { const k = `${method} ${path}`; return Object.hasOwn(HTTP, k) ? HTTP[k] : ADMIN; };

/** 操作紀錄裡的動作名稱:手機版端點對應到和完整介面相同的名稱。 */
const ACTION: Record<string, string> = {
  '/api/approve': 'approval', '/api/cancelqueued': 'cancelQueued', '/api/editqueued': 'editQueued', '/api/resumequeue': 'resumeQueue',
  '/api/opensession': 'openOldSession', '/api/persona': 'setPersona', '/api/revert': 'revertTask', '/api/commit': 'commitTask',
  '/api/merge': 'mergeWorktree', '/api/settings': 'settings', '/api/update': 'updateAgent', '/api/attach': 'attach',
};
export const actionOf = (path: string): string => ACTION[path] ?? path.replace(/^\/api\//, '');

/** 權限不足時給使用者看的說明。 */
export function denial(access: RemoteAccess, rule: Rule, inScope: boolean): string {
  if (!roleAllows(access, rule.level)) return access.role === 'viewer' ? '這支裝置是唯讀權限,不能執行這個操作。' : '這支裝置的權限不能執行這個操作。';
  return inScope ? '' : '這支裝置沒有這個節點的權限。';
}

/**
 * 儀表資料裡依節點分開的部分(花費、今天的任務統計)只留這支裝置看得到的節點;
 * 各後台的額度與每日預算是帳號層級的資料,和額度(usage)一樣所有角色都看得到。
 * 這裡不匯入 shared/dashboard 的函式(只用型別),這個檔案才能被 node 直接載入做單元測試。
 */
function limitDashboard(d: DashboardData, see: (id: string) => boolean): DashboardData {
  return { ...d, spend: d.spend.filter(r => see(r.agentId)), tasks: d.tasks.filter(r => see(r.agentId)) };
}

/** 狀態快照只留這支裝置看得到的節點;非完整角色不提供外部觀察節點與立繪資料夾的位置。 */
export function filterSnapshot<T extends Pick<Snapshot, 'agents' | 'tasks'> & Partial<Pick<Snapshot, 'events' | 'observed' | 'portraitsDir' | 'dashboard'>>>(s: T, access: RemoteAccess, rootOf: (id: string) => string | null): T {
  if (access.role === 'full') return s;
  const see = (id: string) => visible(access, rootOf(id));
  const out = { ...s, agents: s.agents.filter(a => see(a.id)), tasks: s.tasks.filter(t => see(t.agentId)) };
  if (s.events) out.events = s.events.filter(e => see(e.agentId));
  if (s.dashboard) out.dashboard = limitDashboard(s.dashboard, see);
  if ('observed' in s) out.observed = [];
  if ('portraitsDir' in s) out.portraitsDir = '';
  return out;
}

/**
 * 即時更新只留這支裝置看得到的部分;整筆都看不到時回傳 null。
 * 終端機輸出與外部觀察節點只給完整角色。
 */
export function filterUpdate(u: Update, access: RemoteAccess, rootOf: (id: string) => string | null): Update | null {
  if (access.role === 'full') return u;
  const see = (id: string) => visible(access, rootOf(id));
  const out: Update = {};
  if (u.agent && visible(access, u.agent.parentId ? rootOf(u.agent.id) : u.agent.id)) out.agent = u.agent;
  if (u.event && see(u.event.agentId)) out.event = u.event;
  if (u.delta && see(u.delta.agentId)) out.delta = u.delta;
  if (u.task && see(u.task.agentId)) out.task = u.task;
  if (u.tasks) out.tasks = u.tasks.filter(t => see(t.agentId));
  // 節點已經不在了,查不到它屬於誰;移除的通知只有 id,照送讓畫面清掉
  if (u.removedId !== undefined) out.removedId = u.removedId;
  if (u.usage) out.usage = u.usage;
  if (u.dashboard) out.dashboard = limitDashboard(u.dashboard, see);
  if (u.maxActive !== undefined) out.maxActive = u.maxActive;
  if (u.quotaStop !== undefined) out.quotaStop = u.quotaStop;
  if (u.autopilot !== undefined) out.autopilot = u.autopilot;
  return Object.keys(out).length ? out : null;
}

/** 操作紀錄的內容摘要:指令文字、授權的決定之類,截短後存。 */
export function auditDetail(action: string, input: Record<string, any>): string {
  const cut = (s: unknown, n = 160) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  switch (action) {
    case 'send': case 'enqueue': case 'editQueued': return cut(input.text);
    case 'approval': return input.decision === 'allow' ? '允許' : input.decision === 'allow_session' ? '本次都允許' : input.decision === 'deny' ? '拒絕' : cut(input.decision, 20);
    case 'answer': return input.answers ? cut(Object.values(input.answers).flat().join('、')) : '略過';
    case 'create': return cut(`${input.backend ?? ''} ${input.name ?? ''} ${input.cwd ?? ''}${input.permissionMode === 'auto' ? '(自動)' : ''}`);
    case 'updateAgent': return cut([input.name && `名稱 ${input.name}`, input.model !== undefined && `模型 ${input.model || '預設'}`, input.character !== undefined && `角色 ${input.character || '無'}`].filter(Boolean).join(','));
    case 'setPersona': return cut(input.character);
    case 'settings': return cut([Number.isInteger(input.maxActive) && `同時上限 ${input.maxActive}`, Number.isInteger(input.quotaStop) && `額度上限 ${input.quotaStop}%`].filter(Boolean).join(','));
    case 'commitTask': return cut(input.message);
    case 'taskVerdict': return input.verdict === 'accepted' ? '驗收' : input.verdict === 'rejected' ? '退回' : '清除驗收';
    case 'setDailyBudget': return cut(`${input.backend ?? ''} 每日預算 ${input.percent === null || input.percent === undefined ? '預設' : `${input.percent}%`}`);
    default: return '';
  }
}
