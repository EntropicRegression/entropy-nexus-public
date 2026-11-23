import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentInfo } from '../../shared/types';
import {
  TERMINAL_STATUSES, flowElapsed,
  type ApprovalCard, type DecisionChoice, type FlowAttemptView, type FlowRunView, type FlowStepView, type FlowTemplateInfo,
  type PendingDecision, type PendingKind, type ProjectFlowConfig, type ScopeViolation, type StepReport, type VerifyResult,
} from '../../shared/flow';

/**
 * 協作流程的畫面(M4):任務面板裡的流程卡、「套用流程」對話框、流程詳情(步驟條、step_report、核實結果、待決事項、授權卡、違規)。
 * 資料全部來自主行程的 FlowRunView(Snapshot.flows 與 Update.flow,只有桌面畫面收得到);這裡只負責呈現與呼叫 flow* IPC。
 * 視覺依 Hagemi 的介面稿 console-workflow-m4.html 轉成主控台既有的語彙:燈號用「圖示+文字+邊框線型」區分,不只靠顏色。
 */

// ---- 標籤與燈號 ----

/** 步驟條的顯示燈號:主行程的 StepLamp,加上畫面自己推導的 timeout(核實逾時或步驟超時的待決事項)。 */
type Lamp = FlowStepView['lamp'] | 'timeout';

const LAMP: Record<Lamp, { icon: string; label: string; tip: string }> = {
  active: { icon: '▶', label: '進行', tip: '這一步正在進行' },
  passed: { icon: '✓', label: '通過', tip: '這一步通過' },
  rejected: { icon: '✕', label: '失敗', tip: '審查有必修或核實失敗,退回修正(計入退回輪數)' },
  blocked: { icon: '⊘', label: '環境擋住', tip: '被環境擋住(檔案被鎖、找不到指令等),不計入退回輪數' },
  timeout: { icon: '⧗', label: '逾時', tip: '核實或步驟逾時,不計入退回輪數' },
  awaiting_approval: { icon: '⚿', label: '待授權', tip: '等你在授權卡上允許或拒絕' },
  awaiting_user: { icon: '?', label: '需裁示', tip: '等你決定下一步' },
  halted: { icon: '■', label: '停機', tip: '流程在這一步停機或停止' },
  idle: { icon: '○', label: '未開始', tip: '還沒輪到這一步' },
};
/** 圖例只列介面稿的 7 種主要狀態。 */
const LEGEND: Lamp[] = ['active', 'passed', 'rejected', 'blocked', 'timeout', 'awaiting_approval', 'awaiting_user'];

const STATUS_LABEL: Record<string, string> = {
  running: '執行中', paused: '已暫停', awaiting_user: '等你決定', halted: '已停機', stopping: '停止中', stopped: '已停止', completed: '已完成',
};
const PHASE_LABEL: Record<string, string> = {
  dispatching: '交辦中', working: '節點工作中', awaiting_report: '等 step_report', snapshotting: '拍下版本', verifying: '核實中',
  exporting_copy: '匯出審查副本', reviewing: '審查中', post_review: '審查後處理', finishing: '收尾',
};
const ATTEMPT_LABEL: Record<string, string> = {
  queued: '排隊中', running: '執行中', awaiting_report: '等回報', reported: '已回報', unreported: '未回報',
  interrupted: '已中斷', superseded: '已取代', failed: '失敗', stopped: '已停止',
};
const OUTCOME_LABEL: Record<string, string> = { pass: '通過', fail: '失敗', blocked: '環境擋住', timeout: '逾時', skipped: '略過', modified: '改到受版控的檔案' };
const PENDING_LABEL: Record<PendingKind, string> = {
  unreported: '節點沒交 step_report', needs_ruling: '需要你裁示', verify_blocked: '核實被環境擋住', verify_timeout: '核實逾時',
  verify_modified: '核實指令改到檔案', version_changed: '版本已改變', need_agent: '需要指定節點', agent_error: '節點出錯',
  copy_written: '審查副本被寫入', limit: '到達上限', not_ended: '節點還沒停下來', copy_missing: '審查副本不在了', step_approval: '交辦前要先授權',
};
const VIOLATION_LABEL: Record<string, string> = {
  forbidden_action: '禁止動作', out_of_scope: '範圍外檔案', refs_changed: 'refs 改變(自行 commit 或 push)', copy_written: '審查副本被寫入',
  verify_modified: '核實指令改檔', artifact_changed: '打包產出改動', protected_write: '寫入受保護的資料夾',
};
const ACTION_LABEL: Record<string, string> = {
  commit: '本地 commit', push: 'push 到遠端', real_vault: '碰真實記憶庫', install: '安裝或覆蓋', dist: '打包安裝檔(dist)',
  merge_pr: '合併 PR', approve_pr: '核准 PR', force_push: 'force push', delete_branch: '刪分支',
};
const CARD_STATUS: Record<string, string> = { pending: '待決', approved: '已允許', denied: '已拒絕', expired: '已失效' };

const short = (tree: string) => (tree ? tree.slice(0, 8) : '');
const label = (map: Record<string, string>, key: string | undefined) => (key ? map[key] ?? key : '');
const isTerminal = (r: FlowRunView) => TERMINAL_STATUSES.includes(r.status);
const errText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export function fmtSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** 只計執行中的時間,算法見 shared/flow.ts 的 flowElapsed(從 viewAt 起算,不重複計算)。 */
const elapsed = flowElapsed;

/** 已用時間:自己每秒更新,不讓整個詳情跟著重繪。data-ms 給驗收腳本比對。 */
function Elapsed({ run, className }: { run: FlowRunView; className?: string }) {
  const now = useNow(run.status === 'running');
  const ms = elapsed(run, now);
  return <span className={className} data-ms={ms}>{fmtSpan(ms)}</span>;
}

function lampOf(r: FlowRunView, s: FlowStepView): Lamp {
  if (s.id === r.stepId && r.status === 'awaiting_user' && (r.pending?.kind === 'verify_timeout' || r.pending?.kind === 'limit')) return 'timeout';
  return s.lamp;
}

/** 燈號:圖示 + 文字 + 邊框線型(.l-<燈號>),不認得的狀態顯示原文。compact 時文字換成步驟名稱(狀態寫在提示文字)。 */
function LampBadge({ lamp, text, title }: { lamp: string; text?: string; title?: string }) {
  const d = LAMP[lamp as Lamp] ?? { icon: '?', label: `未知(${lamp})`, tip: '不認得的狀態' };
  const known = lamp in LAMP;
  return (
    <span className={`flow-lamp l-${known ? lamp : 'unknown'}`} data-lamp={lamp} title={title ?? `${d.label}:${d.tip}`}>
      <i aria-hidden="true">{d.icon}</i>
      <span>{text ?? d.label}</span>
      {text !== undefined && <span className="sr-only">({d.label})</span>}
    </span>
  );
}

/** 浮動面板打開時把焦點移進去(鍵盤使用者不用從頭 Tab 過來);關閉時還給原本有焦點的元素(還在畫面上的話)。 */
function useFocusOnOpen<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = ref.current;
    node?.focus({ preventScroll: true });
    return () => {
      // 焦點還在面板裡(或已經掉到 body)才還回去;使用者已經點到別處就不搶
      const cur = document.activeElement;
      if (before && before.isConnected && (!cur || cur === document.body || node?.contains(cur))) before.focus({ preventScroll: true });
    };
  }, []);
  return ref;
}

/** 再按一次確認的按鈕:終止流程這類無法復原的動作用。第一次按顯示「確定」與「取消」。 */
function ConfirmButton({ className = '', label: text, confirmText, disabled, onConfirm, title, data }: {
  className?: string; label: string; confirmText: string; disabled?: boolean; onConfirm: () => void; title?: string; data?: string;
}) {
  const [ask, setAsk] = useState(false);
  if (!ask) return <button className={className} data-choice={data} disabled={disabled} title={title} onClick={() => setAsk(true)}>{text}</button>;
  return (
    <span className="flow-confirm" data-confirm={data}>
      <span className="flow-confirm-text">{confirmText}</span>
      <button className="danger flow-confirm-yes" disabled={disabled} onClick={() => { setAsk(false); onConfirm(); }}>確定</button>
      <button className="flow-confirm-no" disabled={disabled} onClick={() => setAsk(false)}>取消</button>
    </span>
  );
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/** 需要你處理的程度:待決事項、待決授權卡排最前面。 */
function attention(r: FlowRunView): number {
  if (r.pending || r.approvals.some(c => c.status === 'pending')) return 0;
  if (!isTerminal(r)) return 1;
  return 2;
}

// ---- 任務面板裡的流程卡 ----

/** 任務面板的流程區:進行中、需要處理的流程,加上最近結束的 4 個(可以展開看全部已結束的)。 */
export function FlowCards({ flows, onOpen }: { flows: FlowRunView[]; onOpen: (runId: string) => void }) {
  const [all, setAll] = useState(false);
  const { open, ended } = useMemo(() => ({
    open: flows.filter(r => attention(r) < 2).sort((a, b) => attention(a) - attention(b) || b.startedAt - a.startedAt),
    ended: flows.filter(r => attention(r) === 2).sort((a, b) => b.updatedAt - a.updatedAt),
  }), [flows]);
  if (!open.length && !ended.length) return null;
  const shownEnded = all ? ended : ended.slice(0, 4);
  return (
    <div className="flow-cards" role="region" aria-label="協作流程">
      <div className="flow-card-list" role="list">
        {[...open, ...shownEnded].map(r => <div role="listitem" key={r.id}><FlowCard run={r} onOpen={() => onOpen(r.id)} /></div>)}
      </div>
      {ended.length > 4 && <button className="ghost flow-more" aria-expanded={all} onClick={() => setAll(v => !v)}>{all ? '只看最近結束的 4 個' : `顯示全部已結束的流程(${ended.length})`}</button>}
    </div>
  );
}

function FlowCard({ run, onOpen }: { run: FlowRunView; onOpen: () => void }) {
  const waitingCard = run.approvals.find(c => c.status === 'pending');
  return (
    <div className={`flow-card fs-${run.status}`} data-flow={run.id}>
      <button className="flow-card-open" onClick={onOpen} title="打開流程詳情:步驟條、step_report、授權卡">
        <span className="task-head">
          <span className="flow-status">流程 · {label(STATUS_LABEL, run.status)}{run.status === 'running' && run.phase ? ` · ${label(PHASE_LABEL, run.phase)}` : ''}</span>
          <Elapsed run={run} className="task-time" />
        </span>
        <span className="task-title">{run.flowName}:{run.topic}</span>
      </button>
      <div className="flow-mini">
        {run.steps.map(s => <LampBadge key={s.id} lamp={lampOf(run, s)} text={s.label} title={`${s.label}:${(LAMP[lampOf(run, s)] ?? { label: s.lamp }).label}`} />)}
      </div>
      <span className="flow-meta">退回 {run.rejections}/{run.maxRejections} 輪 · 交辦 {run.dispatches}/{run.maxDispatches} 次</span>
      {run.pending && <button className="flow-attn" onClick={onOpen}>待你決定:{label(PENDING_LABEL, run.pending.kind)}</button>}
      {!run.pending && waitingCard && <button className="flow-attn gold" onClick={onOpen}>⚿ 授權卡待決:{label(ACTION_LABEL, waitingCard.action)}</button>}
      {run.reason && isTerminal(run) && <span className="flow-card-reason">{run.reason}</span>}
      <FlowControls run={run} compact />
    </div>
  );
}

/** 暫停 / 繼續 / 停止。停止要再按一次確認。 */
function FlowControls({ run, compact = false }: { run: FlowRunView; compact?: boolean }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { setConfirm(false); }, [run.status]);
  if (isTerminal(run)) return null;
  const act = (p: Promise<unknown>) => { setBusy(true); setErr(''); void p.catch(e => setErr(errText(e))).finally(() => { setBusy(false); setConfirm(false); }); };
  return (
    <div className={`flow-controls ${compact ? 'compact' : ''}`}>
      {run.status === 'running' && <button className="flow-pause" disabled={busy} onClick={() => act(window.nexus.flowPause(run.id))} title="暫停:目前的交辦照常跑完,之後不再往下推進;暫停的時間不計入時間上限">暫停</button>}
      {run.status === 'paused' && <button className="flow-resume primary" disabled={busy} onClick={() => act(window.nexus.flowResume(run.id))}>繼續</button>}
      {run.status !== 'stopping' && !confirm && <button className="flow-stop danger" disabled={busy} onClick={() => setConfirm(true)} title="停止流程:先中斷進行中的交辦,確認節點停下來後才算停止">停止</button>}
      {confirm && <>
        <span className="flow-confirm-text">確定停止這個流程?</span>
        <button className="flow-stop-yes danger" disabled={busy} onClick={() => act(window.nexus.flowStop(run.id))}>確定停止</button>
        <button disabled={busy} onClick={() => setConfirm(false)}>取消</button>
      </>}
      {run.status === 'stopping' && <span className="flow-confirm-text">停止中:等節點停下來…</span>}
      {err && <span className="flow-error" role="alert">{err}</span>}
    </div>
  );
}

// ---- 套用流程對話框 ----

const norm = (p: string) => p.trim().replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

type ProjectInfo = { projectId: string; projectName: string; config: ProjectFlowConfig | null; errors: string[] };

export function FlowApply({ agents, onClose, onStarted }: { agents: AgentInfo[]; onClose: () => void; onStarted: (runId: string) => void }) {
  const roots = useMemo(() => agents.filter(a => !a.parentId), [agents]);
  const [templates, setTemplates] = useState<FlowTemplateInfo[] | null>(null);
  const [tplId, setTplId] = useState('');
  const [topic, setTopic] = useState('');
  // 專案:面板上節點的工作目錄(去重),或自己選的資料夾
  const dirs = useMemo(() => {
    const seen = new Map<string, string>();
    for (const a of roots) if (a.cwd && !seen.has(norm(a.cwd))) seen.set(norm(a.cwd), a.cwd);
    return [...seen.values()];
  }, [roots]);
  const [cwd, setCwd] = useState('');
  const [custom, setCustom] = useState(false);
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [projectErr, setProjectErr] = useState('');
  const [roles, setRoles] = useState<Record<string, string>>({});
  const [desktop, setDesktop] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    void window.nexus.flowTemplates().then(list => {
      if (!alive) return;
      setTemplates(list);
      setTplId(cur => cur || list.find(t => !t.errors.length)?.id || '');
    }).catch(e => { if (alive) { setTemplates([]); setError(`讀不到流程範本:${errText(e)}`); } });
    return () => { alive = false; };
  }, []);
  const tpl = templates?.find(t => t.id === tplId) ?? null;

  // 資料夾改變後讀專案設定(角色對照、允許桌面核實)
  useEffect(() => {
    setProject(null); setProjectErr('');
    if (!cwd.trim()) return;
    let alive = true;
    const t = setTimeout(() => {
      void window.nexus.flowProjectConfig(cwd.trim()).then(p => { if (alive) setProject(p); }).catch(e => { if (alive) setProjectErr(errText(e)); });
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [cwd]);

  // 範本或專案改變時,角色依專案設定預填(節點名稱或 id);沒有設定的角色保留原本的選擇
  useEffect(() => {
    if (!tpl?.roles) return;
    const want = project?.config?.roles ?? {};
    setRoles(prev => {
      const next: Record<string, string> = {};
      for (const role of Object.keys(tpl.roles!)) {
        const hint = want[role];
        const a = hint ? roots.find(x => x.id === hint) ?? roots.find(x => x.name === hint) : undefined;
        next[role] = a?.id ?? (roots.some(x => x.id === prev[role]) ? prev[role] : '');
      }
      return next;
    });
    setDesktop(project?.config?.allowDesktopVerify === true);
    // roots 不放進相依:節點狀態一直在更新,不要因此蓋掉使用者改過的角色
  }, [tpl, project?.projectId]);

  const missing = tpl?.roles ? Object.keys(tpl.roles).filter(r => !roles[r]) : [];
  const canStart = !!tpl && !tpl.errors.length && !!topic.trim() && !!cwd.trim() && !!project && !busy;
  const start = async () => {
    if (!canStart || !tpl || !project) return;
    setBusy(true); setError('');
    let wrote = false;
    try {
      // 允許桌面核實寫回專案設定(啟動時依專案設定決定,所以要先寫)
      const was = project.config?.allowDesktopVerify === true;
      if (desktop !== was) {
        const base: ProjectFlowConfig = project.config ?? { projectId: project.projectId, roles: {}, allowDesktopVerify: false };
        await window.nexus.flowSetProjectConfig({ ...base, projectId: project.projectId, allowDesktopVerify: desktop });
        wrote = true;
      }
      const chosen = Object.fromEntries(Object.entries(roles).filter(([, v]) => v));
      const run = await window.nexus.flowStart({ templateId: tpl.id, topic: topic.trim(), cwd: cwd.trim(), ...(Object.keys(chosen).length ? { roles: chosen } : {}) });
      onStarted(run.id);
    } catch (e) {
      let msg = errText(e);
      if (wrote) {
        // 開始失敗,但勾選已經寫回:重讀專案設定(角色的選擇不受影響,下次開始不會重寫),並說明清楚
        const fresh = await window.nexus.flowProjectConfig(cwd.trim()).catch(() => null);
        if (fresh) setProject(fresh);
        msg += `(「允許桌面核實」已經寫回專案設定:${desktop ? '勾選' : '不勾'};要改回請調整勾選後再開始)`;
      }
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const cfg = project?.config;
  const root = useFocusOnOpen<HTMLDivElement>();
  return (
    <div className="flow-panel flow-apply" role="dialog" aria-label="套用流程" tabIndex={-1} ref={root}>
      <div className="flow-head">
        <b>套用流程</b>
        <span className="spacer" />
        <button className="ghost" onClick={onClose} aria-label="關閉">✕</button>
      </div>
      <div className="flow-body">
        <label className="flow-field">流程範本
          <select className="flow-tpl" value={tplId} onChange={e => setTplId(e.target.value)} disabled={!templates}>
            {!templates && <option value="">讀取中…</option>}
            {templates?.length === 0 && <option value="">沒有可用的範本</option>}
            {templates?.map(t => <option key={`${t.source}:${t.file ?? t.id}`} value={t.id} disabled={!t.id || t.errors.length > 0}>{t.name}{t.source === 'builtin' ? '(內建)' : ''}{t.errors.length ? '(有錯誤,不能用)' : ''}</option>)}
          </select>
        </label>
        {templates?.some(t => t.errors.length) && (
          <div className="flow-warn">有範本寫錯了,不能使用:{templates.filter(t => t.errors.length).map(t => `${t.file ?? t.name}:${t.errors.join(';')}`).join(' / ')}</div>
        )}
        {tpl && <TemplateSummary tpl={tpl} cfg={cfg ?? null} />}

        <label className="flow-field">主題
          <textarea className="flow-topic-input" value={topic} rows={2} placeholder="這次要做什麼,例如「會議紀錄卡的空結論提示」"
            onChange={e => setTopic(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); void start(); } }} />
        </label>

        <label className="flow-field">專案(工作目錄)
          <select className="flow-project" value={custom ? '__custom' : cwd} onChange={e => {
            if (e.target.value === '__custom') { setCustom(true); setCwd(''); } else { setCustom(false); setCwd(e.target.value); }
          }}>
            <option value="">選擇專案…</option>
            {dirs.map(d => <option key={d} value={d}>{baseName(d)} — {d}</option>)}
            <option value="__custom">其他資料夾…</option>
          </select>
        </label>
        {custom && (
          <div className="flow-pick">
            <input className="flow-cwd" value={cwd} onChange={e => setCwd(e.target.value)} placeholder="資料夾路徑" />
            <button onClick={async () => { const d = await window.nexus.pickDirectory(); if (d) setCwd(d); }}>瀏覽</button>
          </div>
        )}
        {projectErr && <div className="flow-error" role="alert">{projectErr}</div>}
        {project && <div className="flow-note">專案:<b>{project.projectName}</b>{cfg ? '(有專案設定)' : '(還沒有專案設定,使用範本預設)'}</div>}
        {project && project.errors.length > 0 && <div className="flow-warn">專案設定有誤(這次不會套用,也不會寫回):{project.errors.join(';')}</div>}

        {tpl?.roles && (
          <div className="flow-roles">
            {Object.entries(tpl.roles).map(([role, def]) => (
              <label key={role} className="flow-field">
                <span>{role}<em className="flow-mode">{def.mode === 'write' ? '寫入' : '審查'}</em>{def.description ? ` · ${def.description}` : ''}</span>
                <select className="flow-role" data-role={role} value={roles[role] ?? ''} onChange={e => setRoles(prev => ({ ...prev, [role]: e.target.value }))}>
                  <option value="">選擇節點…</option>
                  {roots.map(a => <option key={a.id} value={a.id}>{a.name} · {baseName(a.cwd)}</option>)}
                </select>
              </label>
            ))}
          </div>
        )}
        {missing.length > 0 && <div className="flow-note">還沒指定節點的角色:{missing.join('、')}(寫入角色的節點必須在這個專案的資料夾裡工作)</div>}

        <label className={`flow-check ${desktop ? '' : 'is-off'}`}>
          <input type="checkbox" className="flow-desktop" checked={desktop} disabled={!project || project.errors.length > 0} onChange={e => setDesktop(e.target.checked)} />
          <span>
            <b>允許桌面核實(會開視窗的核實指令)</b>
            <small>預設不勾。不勾時 desktop 指令不跑,紀錄寫「未跑桌面核實」。勾選狀態會寫回這個專案的設定。</small>
          </span>
        </label>
      </div>
      {error && <div className="flow-error flow-start-error" role="alert">{error}</div>}
      <div className="flow-actions">
        <button onClick={onClose}>取消</button>
        <button className="primary flow-start" disabled={!canStart} onClick={() => void start()} title="開始流程(Ctrl+Enter)">{busy ? '啟動中…' : '開始'}</button>
      </div>
    </div>
  );
}

function TemplateSummary({ tpl, cfg }: { tpl: FlowTemplateInfo; cfg: ProjectFlowConfig | null }) {
  if (tpl.errors.length) return <div className="flow-error">範本有錯誤:{tpl.errors.join(';')}</div>;
  const allowed = cfg?.allowedPaths ?? tpl.allowedPaths ?? [];
  return (
    <div className="flow-tpl-sum">
      {tpl.description && <p>{tpl.description}</p>}
      {tpl.steps && <div className="flow-chain">{tpl.steps.map((s, i) => <span key={s.id}>{i > 0 && <i aria-hidden="true">→</i>}{s.label}{s.requiresApproval.length ? <em title="交辦前要先在授權卡上允許">⚿{s.requiresApproval.map(a => label(ACTION_LABEL, a)).join('、')}</em> : null}</span>)}</div>}
      {tpl.verify && (
        <div className="flow-sum-row"><b>核實指令(主控台重跑)</b>
          {tpl.verify.length === 0 && <span>沒有</span>}
          <ul>{tpl.verify.map(c => <li key={c.id}><code>{c.id}</code> {c.run}<small>(逾時 {c.timeout} 秒{c.needs.length ? `,需先通過 ${c.needs.join('、')}` : ''}{c.desktop ? ',桌面' : ''})</small></li>)}</ul>
          {cfg?.verify && <span className="flow-note">專案設定{cfg.verify.mode === 'replace' ? '取代' : '追加'}了 {cfg.verify.commands.length} 條核實指令(啟動時套用)。</span>}
        </div>
      )}
      <div className="flow-sum-row"><b>範圍</b><span>{allowed.length ? allowed.join('、') : '不限制'}{cfg?.allowedPaths ? '(專案設定)' : ''};改到範圍外只標示、不擋,提交時要你勾選才納入。</span></div>
      <div className="flow-sum-row"><b>授權</b><span>
        ✓ 流程走完後詢問:{tpl.offer?.length ? tpl.offer.map(a => label(ACTION_LABEL, a)).join('、') : '無'}
        <br />✕ 節點不能自己做:{(tpl.forbiddenActions ?? []).map(a => label(ACTION_LABEL, a)).join('、')}
      </span></div>
      {tpl.limits && <div className="flow-sum-row"><b>上限</b><span>退回 {tpl.limits.maxRejections} 輪 · 全程 {tpl.limits.maxMinutes} 分鐘 · 每步 {tpl.limits.stepMinutes} 分鐘 · 交辦 {tpl.limits.maxDispatches} 次</span></div>}
    </div>
  );
}

// ---- 流程詳情 ----

export function FlowDetail({ run, agents, onClose }: { run: FlowRunView; agents: AgentInfo[]; onClose: () => void }) {
  const [sel, setSel] = useState(run.stepId);
  // 流程往下走時跟著選目前的步驟(使用者手動選過別的步驟就不跟)
  const [follow, setFollow] = useState(true);
  useEffect(() => { if (follow) setSel(run.stepId); }, [run.stepId, follow]);
  const step = run.steps.find(s => s.id === sel) ?? run.steps[0];
  const cards = [...run.approvals].sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || b.createdAt - a.createdAt);
  const roleText = Object.entries(run.roles).map(([k, v]) => `${k}:${v.name}`).join('、');
  const root = useFocusOnOpen<HTMLDivElement>();
  return (
    <div className={`flow-panel flow-detail fs-${run.status}`} role="dialog" aria-label={`協作流程:${run.flowName}`} data-flow={run.id} tabIndex={-1} ref={root}>
      <div className="flow-head">
        <b>{run.flowName}</b>
        <span className="flow-head-topic" title={run.topic}>{run.topic}</span>
        <span className="spacer" />
        <span className={`flow-run-status rs-${run.status}`}>{label(STATUS_LABEL, run.status)}</span>
        <button className="ghost" onClick={onClose} aria-label="關閉流程詳情">✕</button>
      </div>
      <div className="flow-body">
        <dl className="flow-facts">
          <div><dt>階段</dt><dd>{run.status === 'running' || run.status === 'paused' ? label(PHASE_LABEL, run.phase) || '—' : '—'}</dd></div>
          <div><dt>退回輪數</dt><dd className="flow-rejections">{run.rejections} / {run.maxRejections}</dd></div>
          <div><dt>已交辦</dt><dd className="flow-dispatches">{run.dispatches} / {run.maxDispatches}</dd></div>
          <div><dt>已用時間</dt><dd><Elapsed run={run} className="flow-elapsed" /></dd></div>
          <div><dt>版本</dt><dd><code title={run.version || '還沒拍版本'}>{run.version ? `tree ${short(run.version)}` : '—'}</code></dd></div>
          <div className="wide"><dt>角色</dt><dd>{roleText || '—'}</dd></div>
        </dl>
        <details className="flow-where">
          <summary>工作目錄與紀錄資料夾</summary>
          <div><span>工作目錄</span><code>{run.cwd}</code></div>
          <div><span>紀錄資料夾(runs/{run.id})</span><code>{run.runDir || '—'}</code></div>
        </details>
        {run.reason && !isTerminal(run) && <div className="flow-reason">原因:{run.reason}</div>}
        <FlowControls run={run} />

        <section className="flow-stepper-box" aria-label="步驟條">
          <div className="flow-legend" aria-label="燈號說明">{LEGEND.map(l => <LampBadge key={l} lamp={l} />)}</div>
          <div className="flow-stepper" role="group" aria-label="步驟">
            {run.steps.map((s, i) => (
              <button key={s.id} className={`flow-step ${s.id === step?.id ? 'is-selected' : ''} ${s.id === run.stepId ? 'is-current' : ''}`} data-step={s.id} aria-pressed={s.id === step?.id}
                onClick={() => { setSel(s.id); setFollow(s.id === run.stepId); }}>
                <span className="flow-step-top"><span className="flow-step-no">STEP {i + 1}</span><LampBadge lamp={lampOf(run, s)} /></span>
                <span className="flow-step-name">{s.label}</span>
                <span className="flow-step-who">{run.roles[s.role]?.name ?? s.role} · {s.mode === 'write' ? '寫入' : '審查'}{s.attempts.length ? ` · ${s.attempts.length} 次` : ''}</span>
              </button>
            ))}
          </div>
        </section>

        {run.pending && <PendingCard key={run.pending.id} run={run} pending={run.pending} agents={agents} />}
        {isTerminal(run) && run.status !== 'completed' && <EndCard run={run} />}
        {cards.map(c => <ApprovalView key={c.id} run={run} card={c} />)}

        {step && (
          <section className="flow-step-detail" aria-label={`步驟「${step.label}」的每次嘗試`}>
            <h4>「{step.label}」的嘗試({step.attempts.length})</h4>
            <StepDetail run={run} step={step} />
          </section>
        )}

        <Violations run={run} />
      </div>
    </div>
  );
}

function StepDetail({ run, step }: { run: FlowRunView; step: FlowStepView }) {
  if (!step.attempts.length) return <div className="flow-empty">「{step.label}」還沒有交辦。</div>;
  // 最新的嘗試排最上面
  return (
    <div className="flow-attempts">
      {[...step.attempts].reverse().map((a, i) => <AttemptView key={a.assignmentId} run={run} step={step} a={a} open={i === 0} />)}
    </div>
  );
}

function AttemptView({ run, step, a, open }: { run: FlowRunView; step: FlowStepView; a: FlowAttemptView; open: boolean }) {
  const outside = run.violations.filter(v => v.kind === 'out_of_scope' && v.assignmentId === a.assignmentId).flatMap(v => v.items);
  const reasons = new Map((a.report?.scopeExceptions ?? []).map(x => [x.path, x.reason]));
  return (
    <details className={`flow-attempt as-${a.status}`} open={open} data-assignment={a.assignmentId}>
      <summary>
        <b>第 {a.attempt} 次</b>
        <span className="flow-who">{a.agentName}</span>
        <span className={`flow-cont c-${a.continuation}`} title={a.continuation === 'new' ? '開了新 session:交辦附上前一份 step_report、必修與 diff' : '送回原本的 session 延續'}>{a.continuation === 'new' ? '新 session' : '延續原 session'}</span>
        <span className="flow-att-status">{label(ATTEMPT_LABEL, a.status)}</span>
        {a.version && <code title={a.version}>tree {short(a.version)}</code>}
        <span className="spacer" />
        <time>{new Date(a.startedAt).toLocaleTimeString('zh-TW', { hour12: false })}{a.endedAt ? ` → ${new Date(a.endedAt).toLocaleTimeString('zh-TW', { hour12: false })}` : ''}</time>
      </summary>
      {a.report ? <ReportCard report={a.report} step={step} /> : <div className="flow-empty">沒有 step_report({label(ATTEMPT_LABEL, a.status)})。</div>}
      {a.verify && <VerifyView v={a.verify} />}
      {outside.length > 0 && (
        <div className="flow-sub">
          <h4>範圍外檔案(只標示、不擋)</h4>
          <ul className="flow-files">{outside.map(p => <li key={p} className={reasons.has(p) ? '' : 'unexplained'}><code>{p}</code>{reasons.has(p) ? <small>:{reasons.get(p)}</small> : <em className="flow-tag warn">未說明</em>}</li>)}</ul>
        </div>
      )}
      {a.ignored && a.ignored.length > 0 && (
        <div className="flow-sub">
          <h4>被 .gitignore 略過的新產出</h4>
          <ul className="flow-files">{a.ignored.map(p => <li key={p}><code>{p}</code></li>)}</ul>
        </div>
      )}
      {a.files.length > 0 && (
        <div className="flow-sub">
          <h4>紀錄檔(在紀錄資料夾裡)</h4>
          <ul className="flow-files">{a.files.map(f => <li key={f}><code>{f}</code></li>)}</ul>
        </div>
      )}
    </details>
  );
}

function List({ title, items, cls = '' }: { title: string; items: string[]; cls?: string }) {
  if (!items.length) return null;
  return (
    <div className={`flow-sub ${cls}`}>
      <h4>{title}</h4>
      <ul>{items.map((x, i) => <li key={i}>{x}</li>)}</ul>
    </div>
  );
}

function ReportCard({ report, step }: { report: StepReport; step: FlowStepView }) {
  const r = report;
  return (
    <div className="flow-report">
      <div className="flow-report-top">
        <strong>step_report</strong>
        {step.mode === 'review' && <span className={`flow-verdict v-${r.verdict ?? 'none'}`}>{r.verdict === 'mergeable' ? '✓ 可合併' : r.verdict === 'changes_required' ? '✕ 需修正' : '(沒填結論)'}</span>}
        {r.manual && <span className="flow-tag">手動補報</span>}
        <span className="spacer" />
        <time>{new Date(r.receivedAt).toLocaleTimeString('zh-TW', { hour12: false })}</time>
      </div>
      <p className="flow-summary">{r.summary}</p>
      <div className="flow-report-grid">
        {(r.mustFix.length > 0 || r.needsRuling.length > 0 || r.suggestions.length > 0) && (
          <div className="flow-sub">
            <h4>必修 / 需裁示 / 建議</h4>
            <ul>
              {r.mustFix.map((x, i) => <li key={`m${i}`}><em className="flow-tag bad">必修</em>{x}</li>)}
              {r.needsRuling.map((x, i) => <li key={`n${i}`}><em className="flow-tag violet">需裁示</em>{x}</li>)}
              {r.suggestions.map((x, i) => <li key={`s${i}`}><em className="flow-tag">建議</em>{x}</li>)}
            </ul>
          </div>
        )}
        {r.commandsRun.length > 0 && (
          <div className="flow-sub">
            <h4>commands_run(節點自己跑的)</h4>
            <ul>{r.commandsRun.map((c, i) => <li key={i}><code>{c.command}</code> → {c.result}</li>)}</ul>
          </div>
        )}
        <List title="not_verified(沒驗證到的)" items={r.notVerified} cls="warn" />
        <List title="questions" items={r.questions} cls="violet" />
        {r.scopeExceptions.length > 0 && (
          <div className="flow-sub">
            <h4>scope_exceptions(改到範圍外的說明)</h4>
            <ul>{r.scopeExceptions.map((x, i) => <li key={i}><code>{x.path}</code>:{x.reason}</li>)}</ul>
          </div>
        )}
      </div>
    </div>
  );
}

function VerifyView({ v }: { v: VerifyResult }) {
  const loc = v.commands[0]?.location === 'worktree' ? '獨立 worktree' : '版本副本';
  return (
    <div className={`flow-verify vo-${v.outcome}`}>
      <div className="flow-report-top">
        <strong>核實(主控台重跑)</strong>
        <span className={`flow-outcome o-${v.outcome}`}>{label(OUTCOME_LABEL, v.outcome)}</span>
        <code title={v.version}>tree {short(v.version)}</code>
        <span className="flow-note">在{loc}裡跑 · {fmtSpan(v.endedAt - v.startedAt)}</span>
      </div>
      {v.stuckAt && <div className="flow-warn">卡在:<code>{v.stuckAt}</code></div>}
      <ul className="flow-cmds">
        {v.commands.map(c => (
          <li key={c.id} className={`o-${c.outcome} ${c.id === v.stuckAt ? 'stuck' : ''}`}>
            <div className="flow-cmd-head">
              <span className={`flow-outcome o-${c.outcome}`}>{label(OUTCOME_LABEL, c.outcome)}</span>
              <code>{c.id}</code>
              <span className="flow-cmd-run">{c.run}</span>
              <span className="spacer" />
              <small>{c.exitCode !== null ? `代碼 ${c.exitCode} · ` : ''}{fmtSpan(c.ms)}</small>
            </div>
            {c.reason && <div className="flow-cmd-line">{c.reason}</div>}
            {c.lastLine && <div className="flow-cmd-line mono">最後一行:{c.lastLine}</div>}
            {c.lockers && c.lockers.length > 0 && <div className="flow-cmd-line warn">鎖定程序:{c.lockers.map(l => `${l.name}(${l.pid})`).join('、')}</div>}
            {c.envHint && <div className="flow-cmd-line warn">可能的環境原因:{c.envHint}</div>}
            {c.modified.length > 0 && <div className="flow-cmd-line warn">改到的檔案:{c.modified.join('、')}</div>}
          </li>
        ))}
      </ul>
      <List title="沒驗證到的" items={v.notVerified} cls="warn" />
      {v.modified.length > 0 && <List title="被核實指令改動的檔案(合計)" items={v.modified} cls="warn" />}
    </div>
  );
}

// ---- 待決事項 ----

function choiceLabel(kind: PendingKind, c: DecisionChoice, phase?: string): string {
  switch (c) {
    case 'manual_report': return '手動補報…';
    case 'rerun':
      if (kind === 'verify_blocked' || kind === 'verify_timeout' || kind === 'verify_modified') return phase === 'verifying' ? '重跑核實' : '重試';
      if (kind === 'copy_missing') return '重新審查';
      return '重跑這一步';
    case 'continue':
      if (kind === 'needs_ruling') return '填入裁示並繼續';
      if (kind === 'verify_modified') return '接受改動並繼續';
      if (kind === 'copy_missing') return '照用審查結果';
      if (kind === 'version_changed') return '以目前正本重新核實與審查';
      return '繼續';
    case 'reassign': return '改派節點…';
    case 'halt': return '停機,由我手動接手';
    case 'stop': return '中止此流程';
    case 'wait': return '再等';
    case 'force_ended': return '強制視為結束…';
    default: return c;
  }
}
const CHOICE_TIP: Partial<Record<DecisionChoice, string>> = {
  halt: '流程停機(結束),工作區保留原狀,由你手動接手',
  stop: '停止流程:先確認節點停下來,再結束這個流程',
  rerun: '重新交辦或重跑(不計入退回輪數)',
};

function PendingCard({ run, pending, agents }: { run: FlowRunView; pending: PendingDecision; agents: AgentInfo[] }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [mode, setMode] = useState<'' | 'manual' | 'reassign' | 'force'>('');
  const [agentId, setAgentId] = useState('');
  const [sure, setSure] = useState(false);
  const decide = (choice: DecisionChoice, payload?: { agentId?: string; note?: string }) => {
    setBusy(true); setErr('');
    void window.nexus.flowDecide(run.id, pending.id, choice, payload).catch(e => setErr(errText(e))).finally(() => setBusy(false));
  };
  const step = run.steps.find(s => s.id === pending.stepId);
  const ruling = pending.kind === 'needs_ruling';
  const halting = ruling || pending.kind === 'limit';
  const candidates = pending.candidates?.length ? pending.candidates : agents.filter(a => !a.parentId).map(a => ({ id: a.id, name: a.name }));
  const onChoice = (c: DecisionChoice) => {
    if (c === 'manual_report') { setMode(mode === 'manual' ? '' : 'manual'); return; }
    if (c === 'reassign') { setMode(mode === 'reassign' ? '' : 'reassign'); return; }
    if (c === 'force_ended') { setMode(mode === 'force' ? '' : 'force'); setSure(false); return; }
    if (c === 'continue' && ruling) { decide('continue', note.trim() ? { note: note.trim() } : undefined); return; }
    decide(c);
  };
  return (
    <section className={`flow-card-box ${halting ? 'flow-halt-card' : 'flow-pending'}`} data-kind={pending.kind} aria-label="待決事項">
      <div className="flow-box-head">
        <LampBadge lamp={pending.kind === 'verify_blocked' ? 'blocked' : pending.kind === 'verify_timeout' || pending.kind === 'limit' ? 'timeout' : pending.kind === 'step_approval' ? 'awaiting_approval' : 'awaiting_user'} />
        <b>{label(PENDING_LABEL, pending.kind)}</b>
        {step && <span className="flow-note">步驟「{step.label}」</span>}
      </div>
      <p className="flow-box-msg">{pending.message}</p>
      {pending.kind === 'step_approval' && <p className="flow-note">請在下面的授權卡上允許或拒絕;也可以直接停機或中止。</p>}
      {ruling && pending.options.includes('continue') && (
        <label className="flow-field">你的裁示(會轉給下一步的節點)
          <textarea className="flow-ruling" rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder="例如:照原名,不改檔名" />
        </label>
      )}
      <div className="flow-box-actions">
        {pending.options.map(c => (c === 'stop' || c === 'halt')
          ? <ConfirmButton key={c} className={`flow-choice ch-${c} ${c === 'stop' ? 'danger' : ''}`} data={c} disabled={busy} title={CHOICE_TIP[c]}
              label={choiceLabel(pending.kind, c, run.phase)} onConfirm={() => decide(c)}
              confirmText={c === 'stop' ? '確定中止這個流程?結束後不能復活。' : '確定停機?流程會結束、不能復活,工作區保留原狀。'} />
          : (
          <button key={c} className={`flow-choice ch-${c} ${c === 'force_ended' ? 'danger' : c === 'continue' || c === 'rerun' || c === 'manual_report' ? 'primary' : ''}`} data-choice={c}
            disabled={busy} aria-expanded={c === 'manual_report' ? mode === 'manual' : c === 'reassign' ? mode === 'reassign' : c === 'force_ended' ? mode === 'force' : undefined}
            title={CHOICE_TIP[c]} onClick={() => onChoice(c)}>{choiceLabel(pending.kind, c, run.phase)}</button>
          ))}
      </div>
      {mode === 'force' && (
        <div className="flow-force">
          <p><b>警告:</b>節點可能仍在寫檔。強制視為結束後,主控台會當作它已經停下來,繼續往下(釋放工作樹、重新交辦或改派)。
            之後它再寫入的檔案、造成的衝突,後果由你負責。請先確認節點已停止(例如在它的對話視窗按中斷,或關掉它)。</p>
          <label className="flow-check"><input type="checkbox" className="flow-force-sure" checked={sure} onChange={e => setSure(e.target.checked)} /><span>我了解,節點不會再寫檔,後果由我負責</span></label>
          <button className="danger flow-force-yes" disabled={!sure || busy} onClick={() => decide('force_ended')}>確定強制視為結束</button>
        </div>
      )}
      {mode === 'reassign' && (
        <div className="flow-reassign">
          <select className="flow-reassign-agent" value={agentId} onChange={e => setAgentId(e.target.value)} aria-label="改派給哪個節點">
            <option value="">選擇節點…</option>
            {candidates.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <button className="primary flow-reassign-yes" disabled={!agentId || busy} onClick={() => decide('reassign', { agentId })}>改派給這個節點</button>
          <span className="flow-note">寫入步驟的節點必須在這個專案的資料夾裡工作。改派後是新 session,交辦會附上前一份 step_report、必修與 diff。</span>
        </div>
      )}
      {mode === 'manual' && <ManualReport run={run} pending={pending} mode={step?.mode ?? 'write'} />}
      {err && <div className="flow-error" role="alert">{err}</div>}
    </section>
  );
}

const lines = (s: string) => s.split(/\r?\n/).map(x => x.trim()).filter(Boolean);

/** 手動補報(交辦記成未回報時):欄位和 step_report 工具相同;遲到的回報會預填。 */
function ManualReport({ run, pending, mode }: { run: FlowRunView; pending: PendingDecision; mode: 'write' | 'review' }) {
  const p = pending.prefill;
  const [summary, setSummary] = useState(p?.summary ?? '');
  const [verdict, setVerdict] = useState<string>(p?.verdict ?? '');
  const [mustFix, setMustFix] = useState((p?.mustFix ?? []).join('\n'));
  const [suggestions, setSuggestions] = useState((p?.suggestions ?? []).join('\n'));
  const [needsRuling, setNeedsRuling] = useState((p?.needsRuling ?? []).join('\n'));
  const [commands, setCommands] = useState((p?.commandsRun ?? []).map(c => `${c.command} => ${c.result}`).join('\n'));
  const [notVerified, setNotVerified] = useState((p?.notVerified ?? []).join('\n'));
  const [questions, setQuestions] = useState((p?.questions ?? []).join('\n'));
  const [scope, setScope] = useState((p?.scopeExceptions ?? []).map(x => `${x.path} => ${x.reason}`).join('\n'));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = () => {
    // 先在畫面檢查(和主行程的驗證規則相同),錯誤直接顯示
    const problems: string[] = [];
    if (!summary.trim()) problems.push('請填摘要');
    if (mode === 'review') {
      if (!verdict) problems.push('審查步驟要選結論');
      if (verdict === 'mergeable' && lines(mustFix).length) problems.push('「可合併」不能有必修');
      if (verdict === 'changes_required' && !lines(mustFix).length) problems.push('「需修正」至少要有一項必修');
    }
    const badScope = lines(scope).filter(l => { const i = l.indexOf('=>'); return i < 0 || !l.slice(0, i).trim() || !l.slice(i + 2).trim(); });
    if (badScope.length) problems.push(`範圍外檔案的說明每行要寫成「路徑 => 原因」:${badScope.join('、')}`);
    if (problems.length) { setErr(problems.join(';')); return; }
    const args: Record<string, unknown> = {
      summary: summary.trim(),
      commands_run: lines(commands).map(l => { const i = l.lastIndexOf('=>'); return i < 0 ? { command: l, result: '' } : { command: l.slice(0, i).trim(), result: l.slice(i + 2).trim() }; }),
      not_verified: lines(notVerified),
      questions: lines(questions),
      scope_exceptions: lines(scope).map(l => { const i = l.indexOf('=>'); return i < 0 ? { path: l, reason: '' } : { path: l.slice(0, i).trim(), reason: l.slice(i + 2).trim() }; }),
    };
    if (mode === 'review') Object.assign(args, { verdict, must_fix: lines(mustFix), suggestions: lines(suggestions), needs_ruling: lines(needsRuling) });
    setBusy(true); setErr('');
    void window.nexus.flowManualReport(run.id, args).catch(e => setErr(errText(e))).finally(() => setBusy(false));
  };
  const area = (title: string, v: string, set: (s: string) => void, cls: string, hint = '一行一項') => (
    <label className="flow-field">{title}<textarea className={cls} rows={2} value={v} onChange={e => set(e.target.value)} placeholder={hint} /></label>
  );
  return (
    <div className="flow-manual">
      {p && <div className="flow-note">已預填節點遲到交來的回報,可以修改後送出。</div>}
      {area('摘要(必填)', summary, setSummary, 'flow-m-summary', '這一步做了什麼')}
      {mode === 'review' && (
        <label className="flow-field">結論
          <select className="flow-m-verdict" value={verdict} onChange={e => setVerdict(e.target.value)}>
            <option value="">選擇…</option>
            <option value="mergeable">可合併(不能有必修)</option>
            <option value="changes_required">需修正(要有必修)</option>
          </select>
        </label>
      )}
      {mode === 'review' && area('必修', mustFix, setMustFix, 'flow-m-mustfix')}
      {mode === 'review' && area('建議', suggestions, setSuggestions, 'flow-m-suggestions')}
      {mode === 'review' && area('需裁示', needsRuling, setNeedsRuling, 'flow-m-ruling')}
      {area('跑過的指令', commands, setCommands, 'flow-m-commands', '一行一條:指令 => 結果')}
      {area('沒驗證到的', notVerified, setNotVerified, 'flow-m-notverified')}
      {area('問題', questions, setQuestions, 'flow-m-questions')}
      {area('範圍外檔案的說明', scope, setScope, 'flow-m-scope', '一行一筆:路徑 => 原因')}
      <div className="flow-box-actions">
        <button className="primary flow-m-submit" disabled={!summary.trim() || busy} onClick={submit}>送出補報</button>
      </div>
      {err && <div className="flow-error" role="alert">{err}</div>}
    </div>
  );
}

/** 停機或停止的流程:原因,加上最後一份回報裡還沒處理的項目。流程已結束,這裡沒有操作(工作區保留原狀,可以手動接手)。 */
function EndCard({ run }: { run: FlowRunView }) {
  const last = run.steps.flatMap(s => s.attempts).filter(a => a.report).sort((a, b) => (b.report!.receivedAt) - (a.report!.receivedAt))[0];
  const r = last?.report;
  const items = r ? [...r.mustFix.map(x => ['必修', x]), ...r.needsRuling.map(x => ['需裁示', x]), ...r.questions.map(x => ['問題', x])] : [];
  const halted = run.status === 'halted';
  return (
    <section className={`flow-card-box ${halted ? 'flow-halt-card' : 'flow-end-card'}`} aria-label={halted ? '停機卡' : '流程已停止'}>
      <div className="flow-box-head">
        <LampBadge lamp="halted" text={halted ? '停機' : '已停止'} />
        <b>{halted ? '流程已停機' : '流程已停止'}</b>
        <span className="flow-note">退回 {run.rejections}/{run.maxRejections} 輪</span>
      </div>
      {run.reason && <p className="flow-box-msg flow-end-reason">{run.reason}</p>}
      {items.length > 0 && (
        <div className="flow-sub">
          <h4>最後一份回報裡待處理的項目</h4>
          <ul>{items.map(([k, x], i) => <li key={i}><em className={`flow-tag ${k === '必修' ? 'bad' : 'violet'}`}>{k}</em>{x}</li>)}</ul>
        </div>
      )}
      <p className="flow-note">流程已經結束,不會再交辦或復活。工作區保留原狀,可以由你手動接手;要再跑一次請重新「套用流程」。</p>
    </section>
  );
}

// ---- 授權卡 ----

function ApprovalView({ run, card }: { run: FlowRunView; card: ApprovalCard }) {
  const [checked, setChecked] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const gate = !!card.stepId;
  const pending = card.status === 'pending';
  const legacy = !gate && card.action !== 'commit';
  const notes = new Map((card.scopeNotes ?? []).map(n => [n.path, n.reason]));
  const unexplained = new Set(card.unexplained ?? []);
  const step = gate ? run.steps.find(s => s.id === card.stepId) : undefined;
  const act = (opts: { deny?: boolean; include?: string[]; message?: string }) => {
    setBusy(true); setErr('');
    void window.nexus.flowApprove(run.id, card.id, opts).catch(e => setErr(errText(e))).finally(() => setBusy(false));
  };
  const toggle = (p: string, on: boolean) => setChecked(prev => (on ? [...prev, p] : prev.filter(x => x !== p)));
  return (
    <section className={`flow-approval st-${card.status} ${gate ? 'gate' : 'finish'}`} data-card={card.id} aria-label="授權卡">
      <div className="flow-box-head">
        <span className="flow-lamp l-awaiting_approval" aria-hidden="true"><i>⚿</i></span>
        <b>授權卡 · {label(ACTION_LABEL, card.action)}</b>
        <span className="flow-note">{gate ? `交辦前 · 步驟「${step?.label ?? card.stepId}」` : '流程收尾'}</span>
        <span className="spacer" />
        <code className="flow-card-tree" title={card.version}>綁定版本 tree {short(card.version)}</code>
        <span className={`flow-card-status cs-${card.status}`}>{label(CARD_STATUS, card.status)}</span>
      </div>
      {pending && <p className="flow-note">版本(正本的 tree)一變,這張授權就失效。{gate ? '允許才交辦這一步;拒絕就停機、不交辦。' : ''}</p>}
      <div className="flow-cover">
        <div className="yes"><b>✓ 這次授權涵蓋</b><ul>{card.covers.map((x, i) => <li key={i}>{x}</li>)}</ul></div>
        <div className="no"><b>✕ 不涵蓋</b><ul>{card.excludes.length ? card.excludes.map((x, i) => <li key={i}>{x}</li>) : <li>(沒有列出)</li>}</ul></div>
      </div>
      {!gate && card.paths.length > 0 && (
        <details className="flow-paths">
          <summary>範圍內的檔案({card.paths.length})</summary>
          <ul className="flow-files">{card.paths.map(p => <li key={p}><code>{p}</code></li>)}</ul>
        </details>
      )}
      {!gate && card.outOfScope.length > 0 && (
        <div className="flow-outside">
          <b>範圍外的檔案{pending ? '(勾選的才納入提交)' : ''}</b>
          {card.outOfScope.map(p => {
            const why = notes.get(p);
            const flagged = unexplained.has(p) || !why;
            const included = card.included?.includes(p);
            return (
              <label key={p} className={`flow-check ${flagged ? 'is-warn' : ''}`} data-path={p}>
                <input type="checkbox" className="flow-out" checked={pending ? checked.includes(p) : !!included} disabled={!pending || busy || legacy} onChange={e => toggle(p, e.target.checked)} />
                <span>
                  <code>{p}</code>{flagged && <em className="flow-tag warn">未說明</em>}{!pending && included && <em className="flow-tag">已納入</em>}
                  <small>{why ? `節點的說明:${why}` : '節點沒有在 scope_exceptions 寫原因'}</small>
                </span>
              </label>
            );
          })}
        </div>
      )}
      {pending && !gate && !legacy && (
        <label className="flow-field">提交訊息(可留空,用流程名稱與主題)
          <input className="flow-commit-msg" value={message} onChange={e => setMessage(e.target.value)} />
        </label>
      )}
      {pending && legacy && <div className="flow-warn">收尾的「{label(ACTION_LABEL, card.action)}」第一版不支援由主控台執行(只支援 commit)。請在流程結束後自行處理,這張卡可以按拒絕關掉。</div>}
      {pending && (
        <div className="flow-box-actions">
          {!legacy && <button className="primary flow-approve" disabled={busy} onClick={() => act(gate ? {} : { include: checked, ...(message.trim() ? { message: message.trim() } : {}) })}>
            {gate ? '✓ 允許' : `✓ 允許本地 commit${checked.length ? `(含範圍外 ${checked.length} 個)` : ''}`}
          </button>}
          {gate
            ? <ConfirmButton className="danger flow-deny" data="deny" disabled={busy} label="✕ 拒絕(停機)" confirmText="確定拒絕?流程會停機、不交辦這一步,而且不能復活。" onConfirm={() => act({ deny: true })} />
            : <button className="danger flow-deny" disabled={busy} onClick={() => act({ deny: true })}>✕ 拒絕,保留工作區</button>}
        </div>
      )}
      {card.result && <div className={`flow-card-result ${card.status === 'expired' ? 'warn' : ''}`}>{card.status === 'expired' ? '失效原因:' : '結果:'}{card.result}</div>}
      {err && <div className="flow-error" role="alert">{err}</div>}
    </section>
  );
}

// ---- 違規 ----

function Violations({ run }: { run: FlowRunView }) {
  if (!run.violations.length) return null;
  const stepLabel = (id?: string) => (id ? run.steps.find(s => s.id === id)?.label ?? id : '');
  return (
    <section className="flow-violations" aria-label="違規紀錄">
      <h4>違規紀錄({run.violations.length})</h4>
      <ul>
        {run.violations.map((v: ScopeViolation, i) => (
          <li key={i} className={`vk-${v.kind}`} data-kind={v.kind}>
            <div className="flow-v-head">
              <b>{label(VIOLATION_LABEL, v.kind)}</b>
              <span className={`flow-tag ${v.blocked ? '' : 'warn'}`}>{v.blocked ? '已擋下' : '未擋下(事後偵測或只標示)'}</span>
              {v.stepId && <span className="flow-note">步驟「{stepLabel(v.stepId)}」</span>}
              <span className="spacer" />
              <time>{new Date(v.at).toLocaleTimeString('zh-TW', { hour12: false })}</time>
            </div>
            {v.actions && v.actions.length > 0 && <div className="flow-v-actions">動作:{v.actions.map(a => <em key={a} className="flow-tag bad">{label(ACTION_LABEL, a)}</em>)}</div>}
            <div className="flow-v-detail">{v.detail}</div>
            {v.items.length > 0 && <ul className="flow-files">{v.items.slice(0, 30).map(x => <li key={x}><code>{x}</code></li>)}{v.items.length > 30 && <li>還有 {v.items.length - 30} 項</li>}</ul>}
          </li>
        ))}
      </ul>
    </section>
  );
}
