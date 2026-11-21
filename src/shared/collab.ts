// 協作過程可視化的純邏輯:進行中的連線、任務來源標籤、分派紀錄的整理與保留。
// 主行程與畫面共用;只有型別匯入,不依賴 Electron(單元測試 tests/collab.test.mjs 直接載入)。
import type { DispatchEntry, DispatchStatus, LinkInfo, TaskInfo } from './types';

/** interop 內部的「呼叫請求」需要的欄位。meetingId 有值表示這是會議裡某位參與者的發言回合(不單獨畫成呼叫)。 */
export interface PendingLite { id: string; callerId: string; targetId: string; status: 'running' | 'done' | 'failed'; createdAt: number; meetingId?: string; label?: string }
/** 會議需要的欄位;currentTargetId 是正在發言的參與者。 */
export interface MeetingLite { id: string; callerId: string; participantIds: string[]; status: 'running' | 'done' | 'failed'; createdAt: number; topic?: string; currentTargetId?: string | null }

const cut = (s: string, n: number) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** 由進行中的呼叫與會議組出連線;已結束的不畫,會議裡的發言回合併入會議的連線。 */
export function buildLinks(pending: PendingLite[], meetings: MeetingLite[]): LinkInfo[] {
  const links: LinkInfo[] = [];
  for (const p of pending) {
    if (p.status !== 'running' || p.meetingId) continue;
    links.push({ id: p.id, kind: 'ask', from: p.callerId, to: [p.targetId], ...(p.label ? { label: cut(p.label, 40) } : {}), startedAt: p.createdAt, active: true });
  }
  for (const m of meetings) {
    if (m.status !== 'running' || !m.participantIds.length) continue;
    links.push({
      id: m.id, kind: 'meeting', from: m.callerId, to: [...m.participantIds], ...(m.topic ? { label: cut(m.topic, 40) } : {}), startedAt: m.createdAt, active: true,
      ...(m.currentTargetId && m.participantIds.includes(m.currentTargetId) ? { speaker: m.currentTargetId } : {}),
    });
  }
  return links.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
}

/** 兩份連線清單內容是否相同(沒變就不必推送)。 */
export const sameLinks = (a: LinkInfo[], b: LinkInfo[]): boolean => a.length === b.length && JSON.stringify(a) === JSON.stringify(b);

/** 任務卡上的來源說明;桌面交辦的不顯示(回傳空字串)。chiefId 是目前的總管節點。 */
export function sourceLabel(task: Pick<TaskInfo, 'source' | 'from'>, chiefId: string | null): string {
  const from = task.from;
  switch (task.source) {
    case 'interop':
      if (from?.meeting) return '會議';
      if (from) return chiefId && from.id === chiefId ? '由總管交辦' : `由 ${from.name} 交辦`;
      return '由其他節點交辦';
    case 'remote': return '遠端';
    case 'autopilot': return '模擬自動運作';
    default: return '';
  }
}

/** 分派紀錄保留 30 天、最多 50 筆。 */
export const DISPATCH_KEEP_MS = 30 * 24 * 3600 * 1000;
export const DISPATCH_MAX = 50;

/** 依保留規則整理:丟掉太舊的,新的在前,最多 max 筆。 */
export function trimDispatches(list: DispatchEntry[], now: number, keepMs = DISPATCH_KEEP_MS, max = DISPATCH_MAX): DispatchEntry[] {
  return list.filter(d => now - d.startedAt <= keepMs).sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id)).slice(0, max);
}

/** 指令的簡短標題:壓成一行、去掉前後空白、截斷。 */
export const dispatchTitle = (prompt: string): string => cut(prompt, 60) || '(沒有內容)';

export const DISPATCH_LABEL: Record<DispatchStatus, string> = { running: '進行中', done: '完成', failed: '失敗', timeout: '逾時' };

/** 分派紀錄的一列:狀態文字、耗時(進行中算到 now)。cost 由任務查,查不到是 null。 */
export function dispatchRow(d: DispatchEntry, now: number, tasks: Array<Pick<TaskInfo, 'id' | 'cost'>>): { status: string; durationMs: number; cost: { tokens: number; usd: number } | null } {
  const task = d.taskId ? tasks.find(t => t.id === d.taskId) : undefined;
  const cost = task?.cost && task.cost.tokens > 0 ? { tokens: task.cost.tokens, usd: task.cost.usd } : null;
  return { status: DISPATCH_LABEL[d.status], durationMs: Math.max(0, (d.endedAt ?? now) - d.startedAt), cost };
}

/** 耗時的簡短文字,例如 45 秒、3 分 20 秒、1 小時 5 分。 */
export function durationText(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} 分 ${s % 60} 秒` : `${m} 分`;
  return m % 60 ? `${Math.floor(m / 60)} 小時 ${m % 60} 分` : `${Math.floor(m / 60)} 小時`;
}
