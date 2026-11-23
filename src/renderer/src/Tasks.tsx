import { useEffect, useMemo, useState } from 'react';
import type { AgentInfo, TaskInfo, TaskStatus, TaskVerdict } from '../../shared/types';
import { sourceLabel } from '../../shared/collab';
import type { FlowRunView } from '../../shared/flow';
import { BACKEND_COLOR, hex } from './theme';
import { FlowCards } from './Flow';

const LABEL: Record<TaskStatus, string> = { running: '執行中', awaiting: '待授權', done: '完成', failed: '失敗', interrupted: '已中斷' };
const ORDER: Record<TaskStatus, number> = { awaiting: 0, running: 1, failed: 2, interrupted: 3, done: 3 };
const SUB_LABEL = { running: '執行中', done: '完成', failed: '失敗' } as const;

function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** 驗收按鈕:再按一次同樣的結果就取消。事件處理放在 span 上,因為任務卡本身是按鈕(按鈕裡不能再放按鈕)。 */
function VerdictButtons({ task, caseStatus }: { task: TaskInfo; caseStatus: string }) {
  // 正常完成的任務預設已驗收:再按「✓」不會取消,取消「退回」就回到已驗收;失敗或中斷的任務維持原本的切換(再按一次取消)
  const base: TaskVerdict = task.status === 'done' ? 'accepted' : null;
  const set = (v: Exclude<TaskVerdict, null>) => {
    const next = task.verdict !== v ? v : base === v ? v : base;
    if (next === (task.verdict ?? null)) return;
    void window.nexus.setTaskVerdict(task.id, next).catch(() => {});
  };
  const btn = (v: Exclude<TaskVerdict, null>, text: string, title: string) => (
    <span className={`task-verdict-btn v-${v} ${task.verdict === v ? 'on' : ''}`} role="button" tabIndex={0} aria-pressed={task.verdict === v} title={title}
      onClick={e => { e.stopPropagation(); set(v); }}
      onKeyDown={e => { if (e.key === 'Enter') { e.stopPropagation(); set(v); } }}>{text}</span>
  );
  return (
    <span className="task-verdict need-op">
      {btn('accepted', '✓ 驗收', task.verdict === 'accepted' ? (task.status === 'done' ? '已驗收:正常完成的任務預設算驗收,結果不對請按「退回」' : '已驗收:結果符合你的要求(再按一次取消)') : '驗收:結果符合你的要求。「完成」只代表回合正常結束,驗收才代表結果對,兩者分開統計')}
      {btn('rejected', '✗ 退回', task.verdict === 'rejected' ? '已退回:結果不符合你的要求(再按一次取消)。把評論送回節點修改時也會自動標成退回' : '退回:結果不符合你的要求,會計入這個節點的驗收率')}
      <CaseMark task={task} status={caseStatus} />
    </span>
  );
}

/** 「記下這個解法」:請承辦節點把這個任務寫成判例;已經有判例或正在撰寫時改顯示標籤。 */
function CaseMark({ task, status }: { task: TaskInfo; status: string }) {
  const [msg, setMsg] = useState('');
  if (task.caseId) return <span className="task-case" title="這個任務的解法已記成判例,在記憶庫管理 app 確認後總管才查得到">判例 {task.caseId}({status || '未確認'})</span>;
  if (task.casePending) return <span className="task-case pending" title="已請承辦節點撰寫,它提交後這裡會出現案號">判例撰寫中…</span>;
  if (task.source === 'case' || task.source === 'draft') return null;
  const mark = () => { setMsg(''); void window.nexus.markCase(task.id).catch(e => setMsg(String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))); };
  return (
    <>
      <span className="task-verdict-btn task-case-btn need-op" role="button" tabIndex={0} title="請承辦節點把這個任務的解法寫成判例(先標成未確認,之後在記憶庫管理 app 確認)"
        onClick={e => { e.stopPropagation(); mark(); }}
        onKeyDown={e => { if (e.key === 'Enter') { e.stopPropagation(); mark(); } }}>記下這個解法</span>
      {msg && <span className="task-case-err">{msg}</span>}
    </>
  );
}

/**
 * 任務面板:每送出一句指令就自動多一筆任務,顯示內容、狀態、由誰執行與經過時間;
 * 後台有回報計畫步驟或呼叫子代理時一併列出。資料全部來自核心服務,這裡只負責呈現。
 */
export function TaskPanel({ tasks, chiefId, agents, selectedId, onSelect, onReview, flows, onOpenFlow, onApplyFlow }: {
  tasks: TaskInfo[];
  chiefId: string | null;
  agents: Record<string, AgentInfo>;
  selectedId: string | null;
  onSelect: (agentId: string) => void;
  onReview: (taskId: string) => void;
  /** 協作流程(只有完整權限的桌面畫面才有;沒有時不顯示流程區與「套用流程」)。 */
  flows?: FlowRunView[] | null;
  onOpenFlow?: (runId: string) => void;
  onApplyFlow?: () => void;
}) {
  const active = tasks.filter(t => t.endedAt === null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active.length) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active.length]);

  // 任務卡上的判例標籤要顯示記憶庫裡目前的狀態(未確認、已確認…);讀不到就當作未確認
  const caseKey = tasks.map(t => t.caseId ?? '').filter(Boolean).join(',');
  const [caseStatus, setCaseStatus] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!caseKey) return;
    void window.nexus.getMemoryVault().then(v => {
      const m: Record<string, string> = {};
      for (const e of v.entries) { const id = /^(\d{4}-\d{4,})/.exec(e.path.split('/').pop() ?? '')?.[1]; if (id && e.kind === 'case') m[id] = e.status; }
      setCaseStatus(m);
    }).catch(() => {});
  }, [caseKey]);

  // 進行中的排最上面(待授權優先),其餘依結束時間由新到舊
  const sorted = useMemo(() => [...tasks].sort((a, b) => {
    const pa = a.endedAt === null ? ORDER[a.status] : 9, pb = b.endedAt === null ? ORDER[b.status] : 9;
    return pa - pb || (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt);
  }).slice(0, 40), [tasks]);
  const finished = tasks.length - active.length;
  // 排隊中的指令還不是任務,送出後才會變成一筆任務;依排入時間列在進行中的任務後面
  const queued = useMemo(() => Object.values(agents).flatMap(a => a.queued.map(q => ({ a, q }))).sort((x, y) => x.q.createdAt - y.q.createdAt), [agents]);

  return (
    <section className="tasks">
      <div className="panel-title tasks-title">
        任務
        <span className="tasks-count">{active.length ? `${active.length} 項進行中` : '沒有進行中的任務'}{queued.length ? ` · ${queued.length} 項排隊中` : ''}</span>
        {finished > 0 && <button className="ghost need-full" onClick={() => void window.nexus.clearFinishedTasks()} title="清除已結束的任務">清除已結束</button>}
        {flows && onApplyFlow && <button className="ghost need-full flow-apply-btn" onClick={onApplyFlow} title="套用協作流程:選範本、主題與專案,由主控台依步驟交辦、核實與審查">套用流程</button>}
      </div>
      <div className="tasks-list">
        {flows && onOpenFlow && <FlowCards flows={flows} onOpen={onOpenFlow} />}
        {queued.map(({ a, q }) => (
          <div key={q.id} className={`task t-queued ${a.id === selectedId ? 'on' : ''}`} role="button" tabIndex={0} onClick={() => onSelect(a.id)} title="開啟這個節點的對話視窗">
            <span className="task-head">
              <span className="task-status">排隊中{a.queuePaused ? '(已暫停)' : ''}</span>
              <span className="task-cancel" role="button" tabIndex={0} title="取消這句排隊中的指令"
                onClick={e => { e.stopPropagation(); void window.nexus.cancelQueued(a.id, q.id); }}
                onKeyDown={e => { if (e.key === 'Enter') { e.stopPropagation(); void window.nexus.cancelQueued(a.id, q.id); } }}>取消</span>
            </span>
            <span className="task-title">{q.text}</span>
            <span className="task-who"><i style={{ background: hex(BACKEND_COLOR[a.backend]) }} />{a.name}{a.model ? ` · ${a.model}` : ''}</span>
          </div>
        ))}
        {sorted.map(t => {
          const alive = Boolean(agents[t.agentId]);
          const done = t.steps.filter(s => s.status === 'done').length;
          const current = t.steps.find(s => s.status === 'active') ?? t.steps.find(s => s.status === 'pending');
          return (
            <button key={t.id} className={`task t-${t.status} ${t.agentId === selectedId ? 'on' : ''} ${alive ? '' : 'gone'}`} onClick={() => { if (alive) onSelect(t.agentId); }} title={alive ? '開啟這個節點的對話視窗' : '節點已不在面板上'}>
              <span className="task-head">
                <span className="task-status">{LABEL[t.status]}</span>
                <span className="task-time">{span((t.endedAt ?? now) - t.startedAt)}</span>
              </span>
              <span className="task-title">{t.title}</span>
              {sourceLabel(t, chiefId) && <span className="task-from" data-from={t.source}>{sourceLabel(t, chiefId)}</span>}
              <span className="task-who">
                <i style={{ background: hex(BACKEND_COLOR[t.backend]) }} />
                {t.agentName}{t.model ? ` · ${t.model}` : ''}{alive ? '' : '(已移除)'}
              </span>
              {t.endedAt === null && agents[t.agentId]?.detail && <span className="task-now">目前:{agents[t.agentId].detail}</span>}
              {t.steps.length > 0 && (
                <span className="task-steps">
                  <span className="bar"><span style={{ width: `${(done / t.steps.length) * 100}%` }} /></span>
                  步驟 {done}/{t.steps.length}{current && t.endedAt === null ? ` · ${current.text}` : ''}
                </span>
              )}
              {t.subs.map(s => <span key={s.id} className={`task-sub s-${s.status}`}>↳ {s.name}<em>{SUB_LABEL[s.status]}</em></span>)}
              {t.changes && (t.endedAt === null || t.changes.files > 0) && (
                <span className="task-changes" role="button" tabIndex={0} title="檢視這個任務改了哪些檔案"
                  onClick={e => { e.stopPropagation(); onReview(t.id); }}
                  onKeyDown={e => { if (e.key === 'Enter') { e.stopPropagation(); onReview(t.id); } }}>
                  {t.endedAt === null ? '檢視目前變更' : <>{t.changes.committed ? '已提交 · ' : ''}變更 {t.changes.files} 個檔案 <i className="plus">+{t.changes.added}</i> <i className="minus">−{t.changes.removed}</i></>}
                </span>
              )}
              {t.cost && t.cost.tokens > 0 && <span className="task-cost">花費 {t.cost.tokens >= 1000 ? `${(t.cost.tokens / 1000).toFixed(1)}k` : t.cost.tokens} tokens{t.cost.usd > 0 ? ` · 約 $${t.cost.usd.toFixed(t.cost.usd < 0.1 ? 3 : 2)}` : ''}</span>}
              {t.note && <span className="task-note">{t.note}</span>}
              {t.endedAt !== null && <VerdictButtons task={t} caseStatus={caseStatus[t.caseId ?? ''] ?? ''} />}
            </button>
          );
        })}
        {tasks.length === 0 && <div className="empty">對節點下指令後,任務會自動出現在這裡。</div>}
      </div>
    </section>
  );
}
