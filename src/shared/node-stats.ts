import type { Spent, TaskInfo } from './types';

/**
 * 每個節點的自動統計(純計算,不依賴 Electron)。資料來自任務紀錄,不需要 agent 自己寫。
 * 兩個比率刻意分開:
 * - 完成率 = 完成 / (完成 + 失敗 + 中斷):只代表回合有沒有正常結束。進行中的任務不算。
 * - 驗收率 = 已驗收 / (已驗收 + 已退回):使用者的判斷,沒有人驗收過就是 null(畫面顯示「尚無驗收」)。
 */
export interface ProjectCount { id: string; name: string; tasks: number; lastAt: number }

export interface NodeStats {
  agentId: string;
  tasks: number;
  done: number;
  failed: number;
  interrupted: number;
  running: number;
  completionRate: number | null;
  accepted: number;
  rejected: number;
  acceptanceRate: number | null;
  /** 已完成任務的平均耗時(毫秒);沒有完成的任務時是 null。 */
  avgDoneMs: number | null;
  cost: Spent;
  /** 最近一個任務的交辦時間;沒有任務時是 null。 */
  lastActive: number | null;
  /** 做過的專案,最近做的排前面;舊任務沒有專案欄位就不列入。 */
  projects: ProjectCount[];
}

const rate = (n: number, d: number): number | null => (d > 0 ? n / d : null);

export function emptyStats(agentId: string): NodeStats {
  return { agentId, tasks: 0, done: 0, failed: 0, interrupted: 0, running: 0, completionRate: null, accepted: 0, rejected: 0, acceptanceRate: null, avgDoneMs: null, cost: { tokens: 0, usd: 0 }, lastActive: null, projects: [] };
}

/** 依節點彙總任務;沒有任務的節點不會出現在結果裡(用 emptyStats 補)。 */
export function computeNodeStats(tasks: TaskInfo[], filter?: (t: TaskInfo) => boolean): Map<string, NodeStats> {
  const out = new Map<string, NodeStats>();
  const doneMs = new Map<string, { sum: number; n: number }>();
  const projects = new Map<string, Map<string, ProjectCount>>();
  for (const t of tasks) {
    if (filter && !filter(t)) continue;
    let s = out.get(t.agentId);
    if (!s) { s = emptyStats(t.agentId); out.set(t.agentId, s); }
    s.tasks++;
    if (t.status === 'done') s.done++;
    else if (t.status === 'failed') s.failed++;
    else if (t.status === 'interrupted') s.interrupted++;
    else s.running++;
    if (t.verdict === 'accepted') s.accepted++;
    else if (t.verdict === 'rejected') s.rejected++;
    if (t.status === 'done' && t.endedAt !== null) {
      const d = doneMs.get(t.agentId) ?? { sum: 0, n: 0 };
      d.sum += Math.max(0, t.endedAt - t.startedAt);
      d.n++;
      doneMs.set(t.agentId, d);
    }
    if (t.cost) { s.cost.tokens += t.cost.tokens || 0; s.cost.usd += t.cost.usd || 0; }
    if (s.lastActive === null || t.startedAt > s.lastActive) s.lastActive = t.startedAt;
    if (t.project) {
      const m = projects.get(t.agentId) ?? new Map<string, ProjectCount>();
      const p = m.get(t.project.id) ?? { id: t.project.id, name: t.project.name, tasks: 0, lastAt: 0 };
      p.tasks++;
      if (t.startedAt >= p.lastAt) { p.lastAt = t.startedAt; p.name = t.project.name; }
      m.set(t.project.id, p);
      projects.set(t.agentId, m);
    }
  }
  for (const s of out.values()) {
    s.completionRate = rate(s.done, s.done + s.failed + s.interrupted);
    s.acceptanceRate = rate(s.accepted, s.accepted + s.rejected);
    const d = doneMs.get(s.agentId);
    s.avgDoneMs = d ? d.sum / d.n : null;
    s.projects = [...(projects.get(s.agentId)?.values() ?? [])].sort((a, b) => b.lastAt - a.lastAt);
  }
  return out;
}

/** 依專案彙總(每個專案一份統計,agentId 欄位放專案 id);給之後的記憶與畫面用。 */
export function computeProjectStats(tasks: TaskInfo[]): Map<string, NodeStats> {
  const byProject = new Map<string, TaskInfo[]>();
  for (const t of tasks) if (t.project) byProject.set(t.project.id, [...(byProject.get(t.project.id) ?? []), { ...t, agentId: t.project.id }]);
  const out = new Map<string, NodeStats>();
  for (const [id, list] of byProject) out.set(id, computeNodeStats(list).get(id) ?? emptyStats(id));
  return out;
}

const pct = (r: number | null, n: number, d: number) => (r === null ? null : `${Math.round(r * 100)}%(${n}/${d})`);

/** 耗時的簡短寫法:45 秒、3 分 20 秒、1 小時 5 分。 */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} 分 ${s % 60} 秒` : `${m} 分`;
  return m % 60 ? `${Math.floor(m / 60)} 小時 ${m % 60} 分` : `${Math.floor(m / 60)} 小時`;
}

export interface StatsNode { id: string; name: string; backendLabel: string; model: string }

/** 一個節點在總管守則裡的一行。 */
export function statsLine(n: StatsNode, s: NodeStats | undefined): string {
  const who = `${n.name}(${n.backendLabel}${n.model ? ` · ${n.model}` : ''})`;
  if (!s || !s.tasks) return `- ${who}:尚無任務紀錄`;
  const finished = s.done + s.failed + s.interrupted;
  const parts = [
    `完成率 ${pct(s.completionRate, s.done, finished) ?? '無已結束的任務'}`,
    `驗收率 ${pct(s.acceptanceRate, s.accepted, s.accepted + s.rejected) ?? '尚無驗收'}`,
  ];
  if (s.avgDoneMs !== null) parts.push(`平均耗時 ${formatDuration(s.avgDoneMs)}`);
  const proj = s.projects.slice(0, 3).map(p => p.name).join('、');
  if (proj) parts.push(`近期專案 ${proj}`);
  return `- ${who}:${parts.join(',')}`;
}

export const RECENT_DAYS = 30;
export const STATS_BUDGET = 1500;

/**
 * 總管守則的「各節點近況」段落。規則:
 * 1. 最近 30 天有任務的節點排前面(最近交辦的在前),其餘的接在後面;
 * 2. 字數超過 budget 時從後面開始捨去(所以先捨去沒有近期任務的節點),最後一行寫「另有 N 個節點,可用 list_nodes 查看」;
 * 3. 沒有任何節點時回傳空字串。
 */
export function chiefStatsSection(nodes: StatsNode[], stats: Map<string, NodeStats>, now: number, budget = STATS_BUDGET): string {
  if (!nodes.length) return '';
  const cutoff = now - RECENT_DAYS * 24 * 3600 * 1000;
  const recent = (n: StatsNode) => (stats.get(n.id)?.lastActive ?? 0) >= cutoff;
  const last = (n: StatsNode) => stats.get(n.id)?.lastActive ?? 0;
  const sorted = [...nodes].sort((a, b) => Number(recent(b)) - Number(recent(a)) || last(b) - last(a) || a.name.localeCompare(b.name));
  const head = '各節點的近況(主控台統計;完成率只代表回合正常結束,驗收率是使用者按「驗收/退回」的結果,兩者分開看):';
  const footer = (n: number) => `另有 ${n} 個節點,可用 list_nodes 查看`;
  const lines = sorted.map(n => statsLine(n, stats.get(n.id)));
  let used = head.length;
  let kept = 0;
  for (let i = 0; i < lines.length; i++) {
    const rest = lines.length - (i + 1);
    const need = used + 1 + lines[i].length + (rest > 0 ? 1 + footer(rest).length : 0);
    if (need > budget) break;
    used += 1 + lines[i].length;
    kept++;
  }
  // 連一行都放不下時至少留一行,避免整段消失
  if (kept === 0) kept = 1;
  const out = [head, ...lines.slice(0, kept)];
  if (kept < lines.length) out.push(footer(lines.length - kept));
  return out.join('\n');
}

