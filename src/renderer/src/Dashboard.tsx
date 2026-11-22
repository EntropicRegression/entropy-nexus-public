import { useEffect, useMemo, useRef, useState } from 'react';
import { BACKEND_LABEL, STATE_LABEL, type AgentInfo, type Backend, type BackendUsage, type Capability, type DispatchEntry, type ObservedSession, type TaskInfo, type UsageWindow } from '../../shared/types';
import {
  dashWarnings, defaultDailyBudget, formatTokens, formatUsd, percentText, quotaWarnPercent, statusGroups, sumSpend, totalTasks, warningText,
  type BudgetStatus, type Cost, type DashboardData, type DashWarning,
} from '../../shared/dashboard';
import { dispatchRow, durationText } from '../../shared/collab';
import { ago, when } from './Hover';
import { ObservedRows } from './Observe';
import { BACKEND_COLOR, STATE_COLOR, hex } from './theme';

const BACKENDS: Backend[] = ['claude', 'codex', 'antigravity'];
/** 瀏覽器版的遠端裝置可能不是完整權限;每日預算只有完整權限能改。 */
const fullAccess = !window.nexus.access || window.nexus.access.role === 'full';

type StatusKind = 'running' | 'waiting' | 'queued' | 'fault';
const STATUS: Array<{ kind: StatusKind; label: string; hint: string }> = [
  { kind: 'running', label: '執行中', hint: '規劃中或執行中的節點' },
  { kind: 'waiting', label: '等你處理', hint: '等你授權或回答提問的節點' },
  { kind: 'queued', label: '排隊', hint: '有指令在排隊的節點' },
  { kind: 'fault', label: '異常', hint: '出錯或失聯的節點' },
];

/** 額度條的顏色:快到提醒門檻時轉成琥珀色,到了門檻轉成紅色。 */
const usedLevel = (used: number, warnAt: number) => (used * 100 >= warnAt ? 'crit' : used * 100 >= warnAt - 15 ? 'low' : 'ok');

/**
 * 精簡版每家後台只列最多兩個額度:不分模型的額度優先;全部都依模型分組時(Antigravity),每種視窗取用量最高的那一組。
 * 完整的清單(含各模型專屬的額度)在展開後的完整內容裡。
 */
function compactWindows(windows: UsageWindow[]): UsageWindow[] {
  const plain = windows.filter(w => !w.group);
  if (plain.length) return plain.slice(0, 2);
  const worst = new Map<string, UsageWindow>();
  for (const w of windows) { const m = worst.get(w.label); if (!m || w.used > m.used) worst.set(w.label, w); }
  return [...worst.values()].slice(0, 2);
}

/** 額度條像血量:沒用過是滿的,用光是空的(剩餘百分比 = 100 − 已用,和節點資訊卡的血量條一致)。 */
const leftPct = (w: UsageWindow) => 100 - Math.round(Math.max(0, Math.min(1, w.used)) * 100);

const winTitle = (backend: Backend, w: UsageWindow) => `${BACKEND_LABEL[backend]} 的${w.group && !w.label.includes(w.group) ? `「${w.group}」` : ''}${w.label}額度:剩餘 ${leftPct(w)}%(已用 ${Math.round(w.used * 100)}%)${w.resetsAt ? `,${when(w.resetsAt)} 重置` : ''}`;

function Bar({ value, level }: { value: number; level: string }) {
  return <span className={`dash-bar ${level}`}><span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></span>;
}

interface DashProps {
  agents: AgentInfo[];
  caps: Capability[];
  usage: Partial<Record<Backend, BackendUsage>>;
  data: DashboardData | null;
  quotaStop: number;
  observed: ObservedSession[];
  selectedId: string | null;
  open: boolean;
  onToggle: () => void;
  onSelect: (id: string) => void;
}

/** 要顯示哪幾家後台:可以使用的(含假資料),以及已經有額度資料的。 */
function shownBackends(caps: Capability[], usage: Partial<Record<Backend, BackendUsage>>): Backend[] {
  const list = BACKENDS.filter(b => caps.some(c => c.backend === b && c.available) || (usage[b]?.windows.length ?? 0) > 0);
  return list.length ? list : BACKENDS;
}

/** 提醒每半分鐘重算一次(「異常太久」是看時間的)。 */
function useWarnings(agents: AgentInfo[], usage: Partial<Record<Backend, BackendUsage>>, data: DashboardData | null, quotaStop: number): DashWarning[] {
  const [now, setNow] = useState(Date.now());
  const faulty = agents.some(a => a.state === 'error' || a.state === 'lost');
  useEffect(() => {
    if (!faulty) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), Math.min(30000, Math.max(1000, (data?.faultWarnMs ?? 60000) / 4)));
    return () => clearInterval(t);
  }, [faulty, data?.faultWarnMs]);
  return useMemo(() => dashWarnings({
    usage: BACKENDS.map(b => usage[b]).filter((u): u is BackendUsage => !!u),
    budgets: data?.budgets ?? [], quotaStop, agents, now: Math.max(now, Date.now()), faultWarnMs: data?.faultWarnMs,
  }), [agents, usage, data, quotaStop, now]);
}

/**
 * 總覽儀表的精簡版,常駐在右側欄的最上面(原本節點清單的位置):各後台的額度條、今天的預算用量,
 * 以及四個狀態數字。點狀態數字跳到對應的節點(超過一個時列出來讓你選);點其他地方展開完整內容。
 */
export function Dashboard({ agents, caps, usage, data, quotaStop, observed, selectedId, open, onToggle, onSelect }: DashProps) {
  const groups = useMemo(() => statusGroups(agents), [agents]);
  const warnings = useWarnings(agents, usage, data, quotaStop);
  const [pick, setPick] = useState<StatusKind | null>(null);
  const pickRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const picked = pick ? groups[pick] : [];
  // 清單裡的節點都離開這個狀態了就收起來
  useEffect(() => { if (pick && !picked.length) setPick(null); }, [pick, picked.length]);
  useEffect(() => {
    if (!pick) return;
    const onDown = (e: PointerEvent) => { if (e.target instanceof Node && !pickRef.current?.contains(e.target) && !statusRef.current?.contains(e.target)) setPick(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setPick(null); } };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('pointerdown', onDown, true); document.removeEventListener('keydown', onKey, true); };
  }, [pick]);
  const warnAt = quotaWarnPercent(quotaStop);
  const backends = shownBackends(caps, usage);
  const extWaiting = observed.some(o => o.state === 'awaiting');
  const clickStatus = (kind: StatusKind) => {
    const list = groups[kind];
    if (!list.length) return;
    // 只有一個就直接跳過去;超過一個時列出來
    if (list.length === 1) { setPick(null); onSelect(list[0].id); return; }
    setPick(p => (p === kind ? null : kind));
  };
  const top = warnings[0];
  const severe = warnings.some(w => w.kind !== 'budget' || w.level === 'over');

  return (
    <section className={`dash ${open ? 'open' : ''}`} aria-label="總覽">
      <div className="panel-title dash-title">
        總覽
        {observed.length > 0 && <button className={`ghost dash-ext ${extWaiting ? 'warn' : ''}`} onClick={onToggle} title="外部觀察節點(在主控台以外執行的 CLI);點一下在完整內容裡查看">外部 <b>{observed.length}</b></button>}
        <button className={`ghost dash-expand ${open ? 'on' : ''}`} onClick={onToggle} aria-expanded={open} title="完整內容:花費、今天的任務、每日預算設定、外部觀察節點">{open ? '收合' : '展開'}</button>
      </div>
      <div className="dash-quota" role="button" tabIndex={0} aria-label="各後台的剩餘額度;點一下展開完整內容" onClick={onToggle} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}>
        {backends.map(b => {
          const u = usage[b];
          const wins = compactWindows(u?.windows ?? []);
          const budget = data?.budgets.find(x => x.backend === b);
          return (
            <div key={b} className="dq" data-backend={b}>
              <div className="dq-head">
                <i style={{ background: hex(BACKEND_COLOR[b]) }} />
                <span className="dq-name">{BACKEND_LABEL[b]}</span>
                {budget && budget.window && budget.used !== null && budget.budget > 0 && (
                  <span className={`dq-budget b-${budget.level}`} title={`今天已用每週額度的 ${percentText(budget.used)};每日預算 ${percentText(budget.budget)}(超過只提醒,不擋指令)`}>今天 {percentText(budget.used)} / {percentText(budget.budget)}</span>
                )}
              </div>
              {wins.length > 0 ? (
                <div className="dq-wins">
                  {wins.map(w => (
                    <div key={`${w.group ?? ''}:${w.label}`} className={`dq-win ${usedLevel(w.used, warnAt)}`} data-label={w.label} title={winTitle(b, w)}>
                      <span className="dq-label">{w.label}</span>
                      <Bar value={leftPct(w)} level={usedLevel(w.used, warnAt)} />
                      <b className="dq-pct">{leftPct(w)}%</b>
                      <span className="dq-reset">{w.resetsAt ? `${when(w.resetsAt)} 重置` : ''}</span>
                    </div>
                  ))}
                </div>
              ) : <div className="dq-none">{u?.unsupported ? '不提供剩餘額度' : '尚未取得額度(節點執行一次後更新)'}</div>}
            </div>
          );
        })}
      </div>
      <div className="dash-status" ref={statusRef}>
        {STATUS.map(s => {
          const n = groups[s.kind].length;
          return (
            <button key={s.kind} className={`ds ds-${s.kind} ${n ? 'has' : ''} ${pick === s.kind ? 'on' : ''}`} data-kind={s.kind} disabled={!n} onClick={() => clickStatus(s.kind)}
              title={n ? `${s.hint}:${groups[s.kind].map(a => a.name).join('、')}。點一下${n === 1 ? '打開它的對話視窗' : '列出來'}` : `沒有${s.hint}`}>
              <span>{s.label}</span><b>{n}</b>
            </button>
          );
        })}
      </div>
      {pick && picked.length > 0 && (
        <div className="dash-pick" ref={pickRef} role="dialog" aria-label={`${STATUS.find(s => s.kind === pick)?.label}的節點`}>
          {picked.map(a => (
            <button key={a.id} className={`dash-pick-row s-${a.state} ${a.id === selectedId ? 'on' : ''}`} onClick={() => { setPick(null); onSelect(a.id); }} title={`打開「${a.name}」的對話視窗`}>
              <span className="dot" style={{ borderColor: hex(BACKEND_COLOR[a.backend]), background: hex(STATE_COLOR[a.state]) }} />
              <span className="dp-name">{a.parentId ? '↳ ' : ''}{a.name}</span>
              <span className="dp-state">{pick === 'queued' ? `排隊 ${a.queued.length} 筆${a.queuePaused ? '(已暫停)' : ''}` : a.detail || STATE_LABEL[a.state]}</span>
            </button>
          ))}
        </div>
      )}
      {top && (
        <button className={`dash-warn ${severe ? 'bad' : ''}`} onClick={onToggle} title={`${warnings.map(w => warningText(w, BACKEND_LABEL)).join('\n')}\n\n點一下看完整內容`}>
          <span className="dw-text">{warningText(top, BACKEND_LABEL)}</span>
          {warnings.length > 1 && <em>另外 {warnings.length - 1} 則</em>}
        </button>
      )}
    </section>
  );
}

function CostCells({ c }: { c: Cost | undefined }) {
  return <><td className="num">{c && c.tokens > 0 ? formatTokens(c.tokens) : '—'}</td><td className="num">{formatUsd(c?.usd ?? 0)}</td></>;
}

/** 每日預算的輸入欄:改完按 Enter 或離開欄位才送出,打字途中的數字不會生效。 */
function BudgetInput({ status }: { status: BudgetStatus }) {
  const [draft, setDraft] = useState(String(status.budget));
  useEffect(() => { setDraft(String(status.budget)); }, [status.budget]);
  const commit = () => {
    const n = Number(draft);
    if (draft.trim() === '' || !Number.isFinite(n) || n < 0 || n > 100) { setDraft(String(status.budget)); return; }
    if (Math.round(n * 10) / 10 !== status.budget) void window.nexus.setDailyBudget(status.backend, n);
  };
  return (
    <input className="df-budget-input" type="number" min={0} max={100} step={0.1} value={draft} aria-label={`${BACKEND_LABEL[status.backend]} 的每日預算(%)`}
      onChange={e => setDraft(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }} />
  );
}

/**
 * 總覽儀表的完整內容(浮動面板,開在右側欄的左邊):提醒、各後台的全部額度與每日預算、
 * 今天與本週的花費(依後台與節點)、今天的任務統計、外部觀察節點。
 */
/** 分派紀錄:最近的節點交辦。點一列打開被呼叫節點的對話視窗。 */
function DispatchLog({ list, tasks, alive, onSelect }: { list: DispatchEntry[]; tasks: TaskInfo[]; alive: Set<string>; onSelect: (id: string) => void }) {
  const [now, setNow] = useState(Date.now());
  const running = list.some(d => d.status === 'running');
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  if (!list.length) return <p className="remote-note">節點用 ask_node 交辦工作給其他節點後,會記在這裡(保留 30 天、最多 50 筆)。</p>;
  return (
    <table className="df-table df-dispatch">
      <thead><tr><th>時間</th><th>誰 → 誰</th><th>內容</th><th>狀態</th><th>耗時</th><th>花費</th></tr></thead>
      <tbody>
        {list.map(d => {
          const r = dispatchRow(d, now, tasks);
          const ok = alive.has(d.toId);
          return (
            <tr key={d.id} data-row={`dispatch:${d.id}`} data-status={d.status} className={`df-agent ${ok ? '' : 'gone'}`} onClick={() => { if (ok) onSelect(d.toId); }} title={ok ? `打開「${d.toName}」的對話視窗` : '節點已不在面板上'}>
              <td className="df-dtime">{when(d.startedAt)}</td>
              <td className="df-dwho">{d.fromName} → {d.toName}</td>
              <td className="df-dtitle">{d.title}</td>
              <td className={`df-dstatus s-${d.status}`}>{r.status}</td>
              <td className="df-dtime">{durationText(r.durationMs)}</td>
              <td className="df-dtime">{r.cost ? `${formatTokens(r.cost.tokens)}${r.cost.usd > 0 ? ` · ${formatUsd(r.cost.usd)}` : ''}` : '—'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function DashboardFull({ agents, caps, usage, data, quotaStop, observed, dispatches, tasks: allTasks, onClose, onSelect }: Omit<DashProps, 'open' | 'onToggle' | 'selectedId'> & { dispatches: DispatchEntry[]; tasks: TaskInfo[]; onClose: () => void }) {
  const warnings = useWarnings(agents, usage, data, quotaStop);
  const warnAt = quotaWarnPercent(quotaStop);
  const backends = shownBackends(caps, usage);
  const today = useMemo(() => (data ? sumSpend(data.spend, data.date, data.date) : null), [data]);
  const week = useMemo(() => (data ? sumSpend(data.spend, data.weekStart, data.date) : null), [data]);
  const tasks = totalTasks(data?.tasks ?? []);
  const names = useMemo(() => new Map(agents.map(a => [a.id, a.name])), [agents]);
  const anyUsd = (week?.total.usd ?? 0) > 0;

  return (
    <div className="dash-full" role="dialog" aria-label="總覽">
      <div className="remote-head"><b>總覽</b>{data && <span className="df-date">{data.date}</span>}<span className="spacer" /><button className="ghost" onClick={onClose} aria-label="關閉">✕</button></div>

      {warnings.length > 0 && (
        <div className="df-warns">
          {warnings.map((w, i) => (
            w.kind === 'fault'
              ? <button key={i} className="df-warn bad" onClick={() => onSelect(w.agentId)} title="打開這個節點的對話視窗">{warningText(w, BACKEND_LABEL)}</button>
              : <div key={i} className={`df-warn ${w.kind === 'budget' && w.level === 'near' ? '' : 'bad'}`}>{warningText(w, BACKEND_LABEL)}</div>
          ))}
        </div>
      )}

      <div className="remote-sub first">額度與每日預算</div>
      {backends.map(b => {
        const u = usage[b];
        const budget = data?.budgets.find(x => x.backend === b);
        return (
          <div key={b} className="df-backend" data-backend={b}>
            <div className="df-bhead"><i style={{ background: hex(BACKEND_COLOR[b]) }} /><b>{BACKEND_LABEL[b]}</b>{u && u.windows.length > 0 && u.updatedAt > 0 && <span>{ago(u.updatedAt)}更新</span>}</div>
            {u && u.windows.length > 0 ? u.windows.map(w => (
              <div key={`${w.group ?? ''}:${w.label}`} className={`df-win ${usedLevel(w.used, warnAt)}`} title={winTitle(b, w)}>
                <span className="df-label">{w.group && !w.label.includes(w.group) ? `${w.group} · ` : ''}{w.label}</span>
                <Bar value={leftPct(w)} level={usedLevel(w.used, warnAt)} />
                <b>{leftPct(w)}%</b>
                <span className="df-reset">{w.resetsAt ? `${when(w.resetsAt)} 重置` : ''}</span>
              </div>
            )) : <div className="remote-note">{u?.unsupported ? '這個後台不提供剩餘額度。' : '尚未取得額度,這個後台的節點執行一次後會更新。'}</div>}
            {budget && budget.window ? (
              <div className={`df-budget b-${budget.level}`}>
                <span className="df-budget-text">今天已用 <b className="df-used">{budget.used === null ? '—' : percentText(budget.used)}</b> / 每日預算</span>
                {fullAccess ? <BudgetInput status={budget} /> : <b className="df-budget-value">{budget.budget}</b>}
                <span>%</span>
                {fullAccess && <button className="ghost df-budget-reset" disabled={!budget.custom} onClick={() => void window.nexus.setDailyBudget(b, null)} title={`改回預設值:${budget.window}額度的 1/${budget.days}`}>預設 {percentText(defaultDailyBudget(budget.days))}</button>}
                {budget.budget > 0 && budget.used !== null && <Bar value={(budget.used / budget.budget) * 100} level={budget.level === 'over' ? 'crit' : budget.level === 'near' ? 'low' : 'ok'} />}
                <span className="df-budget-note">{budget.budget === 0 ? '預算設為 0:不提醒。' : budget.used === null ? `今天還沒有${budget.window}額度的讀數。` : budget.level === 'over' ? '已超過今天的預算(只提醒,不會擋下指令)。' : `以「${budget.window}」額度計算。`}</span>
              </div>
            ) : u && u.windows.length > 0 && <div className="remote-note">這個後台沒有每週額度,不計算每日預算。</div>}
          </div>
        );
      })}
      <p className="remote-note">每日預算是「今天最多用掉每週額度的幾 %」,預設是每週額度的 1/7。今天的用量 = 目前的每週額度讀數 − 今天的起點;每週額度在當天重置時,起點歸零重新累計。超過預算只會提醒,不會擋下指令;要擋下新指令請用頂部的「額度上限」。</p>

      <div className="remote-sub">花費</div>
      {week && today && week.total.tokens + week.total.usd > 0 ? (
        <table className="df-table df-spend">
          <thead><tr><th /><th colSpan={2}>今天</th><th colSpan={2}>本週(週一起)</th></tr></thead>
          <tbody>
            <tr className="df-total" data-row="total"><th>合計</th><CostCells c={today.total} /><CostCells c={week.total} /></tr>
            {week.byBackend.map(r => (
              <tr key={r.backend} data-row={`backend:${r.backend}`}><th><i style={{ background: hex(BACKEND_COLOR[r.backend]) }} />{BACKEND_LABEL[r.backend]}</th><CostCells c={today.byBackend.find(x => x.backend === r.backend)} /><CostCells c={r} /></tr>
            ))}
            <tr className="df-sep"><th colSpan={5}>依節點</th></tr>
            {week.byAgent.map(r => {
              const alive = names.has(r.agentId);
              return (
                <tr key={r.agentId} data-row={`agent:${r.agentId}`} className={alive ? 'df-agent' : 'df-agent gone'} onClick={() => { if (alive) onSelect(r.agentId); }} title={alive ? '打開這個節點的對話視窗' : '節點已不在面板上'}>
                  <th><i style={{ background: hex(BACKEND_COLOR[r.backend]) }} />{names.get(r.agentId) ?? r.agentName}{alive ? '' : '(已移除)'}</th><CostCells c={today.byAgent.find(x => x.agentId === r.agentId)} /><CostCells c={r} />
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : <div className="remote-note">本週還沒有花費紀錄;節點完成回合後會累計在這裡。</div>}
      <p className="remote-note">數字是各家 CLI 回報的 token 數{anyUsd ? '與估算金額(金額只有 Claude Code 會回報,訂閱制下只是估算值)' : ';金額只有 Claude Code 會回報'}。只計入這個版本之後的花費。</p>

      <div className="remote-sub">今天的任務</div>
      <div className="df-tasks">
        <span data-stat="assigned">交辦 <b>{tasks.assigned}</b></span>
        <span data-stat="done">完成 <b>{tasks.done}</b></span>
        <span data-stat="failed" className={tasks.failed ? 'bad' : ''}>失敗 <b>{tasks.failed}</b></span>
        <span data-stat="interrupted">中斷 <b>{tasks.interrupted}</b></span>
        <span data-stat="running">進行中 <b>{tasks.running}</b></span>
      </div>

      <div className="remote-sub">分派紀錄</div>
      <DispatchLog list={dispatches} tasks={allTasks} alive={new Set(agents.map(a => a.id))} onSelect={onSelect} />

      {/* 外部觀察節點只給完整權限(遠端的操作、唯讀角色收不到這份資料) */}
      {fullAccess && <>
        <div className="remote-sub">外部觀察</div>
        {observed.length > 0
          ? <ObservedRows list={observed} onOpened={onSelect} />
          : <p className="remote-note">目前沒有外部節點。在主控台以外執行的 Claude Code 裝上 hooks 後會出現在這裡(設定在頂部的「遠端」面板)。</p>}
      </>}
    </div>
  );
}
