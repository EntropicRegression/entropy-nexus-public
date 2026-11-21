import { useCallback, useEffect, useState } from 'react';
import type { AgentInfo, AuditEntry, RemoteAccess, RemoteRole, RemoteStatus } from '../../shared/types';
import { ObservePanel } from './Observe';

const ROLE_LABEL: Record<RemoteRole, string> = { full: '完整', operator: '操作', viewer: '唯讀' };
const ROLE_HINT: Record<RemoteRole, string> = {
  full: '和坐在這台電腦前相同:所有節點、新增與終止、設定、角色卡、配對其他裝置。',
  operator: '對範圍內的節點下指令、排隊、中斷、回應授權、回答提問、休眠與喚醒。不能新增或終止節點,也不能改設定。',
  viewer: '只能看範圍內節點的狀態與對話,不能下指令。',
};
const ACTION_LABEL: Record<string, string> = {
  pair: '配對', revoke: '撤銷裝置', setAccess: '修改權限', send: '送出指令', enqueue: '排隊', cancelQueued: '取消排隊', editQueued: '修改排隊', resumeQueue: '繼續佇列',
  approval: '回應授權', answer: '回答提問', interrupt: '中斷', sleep: '休眠', wake: '喚醒', create: '新增節點', remove: '終止節點', updateAgent: '修改節點',
  settings: '修改設定', setPersona: '編輯角色卡', attach: '上傳檔案', upload: '上傳附件', openTerminal: '終端機模式', closeTerminal: '離開終端機', openOldSession: '開啟舊 session',
  forkAgent: '分支對話', revertTask: '還原變更', commitTask: '提交變更', mergeWorktree: '合併工作區', openPr: '開 PR', clearTasks: '清除任務', autopilot: '自動運作',
  remoteSet: '遠端開關', remoteNewCode: '產生配對碼', remotePairAccess: '設定配對權限', remoteSetDevice: '修改裝置權限', remoteRevoke: '撤銷裝置',
  observeInstall: '安裝 hooks', observeUninstall: '移除 hooks', observeNewToken: '換觀察權杖', observeTakeover: '接手外部節點', sendReviewComments: '送回修改', requestReview: '送交審查',
  remoteStatus: '讀取配對碼', remoteAudit: '讀取操作紀錄', getPersona: '讀取角色卡', oldsessions: '讀取舊 session', oldSessions: '讀取舊 session', dirs: '瀏覽資料夾', inspect: '檢查資料夾',
  inspectDir: '檢查資料夾', persona: '讀取角色卡', termWrite: '終端機輸入', termAttach: '終端機畫面', termResize: '終端機尺寸', observeStatus: '讀取外部觀察',
};
const time = (ts: number) => new Date(ts).toLocaleString('zh-TW', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const summary = (a: RemoteAccess, agents: AgentInfo[]) => {
  if (a.role === 'full') return '完整';
  if (!a.agents) return `${ROLE_LABEL[a.role]} · 全部節點`;
  const names = a.agents.map(id => agents.find(x => x.id === id)?.name).filter(Boolean);
  return `${ROLE_LABEL[a.role]} · ${names.length ? names.join('、') : '沒有節點'}`;
};

/** 角色與節點範圍的編輯:完整角色不限節點;其他角色可選全部或指定幾個節點。 */
function AccessEditor({ value, agents, onChange }: { value: RemoteAccess; agents: AgentInfo[]; onChange: (a: RemoteAccess) => void }) {
  const picked = new Set(value.agents ?? []);
  const toggle = (id: string) => { const next = new Set(picked); if (next.has(id)) next.delete(id); else next.add(id); onChange({ role: value.role, agents: [...next] }); };
  // 自動模式的節點不會詢問授權,開放給操作角色等於交出這台電腦
  const risky = value.role === 'operator' && agents.some(a => a.permissionMode === 'auto' && (!value.agents || picked.has(a.id)));
  return (
    <div className="remote-access">
      <div className="remote-roles">
        {(['full', 'operator', 'viewer'] as RemoteRole[]).map(r => (
          <button key={r} className={value.role === r ? 'primary' : ''} onClick={() => onChange(r === 'full' ? { role: 'full', agents: null } : { role: r, agents: value.role === 'full' ? null : value.agents })}>{ROLE_LABEL[r]}</button>
        ))}
      </div>
      <p className="remote-note">{ROLE_HINT[value.role]}</p>
      {value.role !== 'full' && <>
        <label className="remote-toggle sub"><input type="radio" checked={value.agents === null} onChange={() => onChange({ role: value.role, agents: null })} /><span>全部節點(包括之後新增的)</span></label>
        <label className="remote-toggle sub"><input type="radio" checked={value.agents !== null} onChange={() => onChange({ role: value.role, agents: [] })} /><span>只有指定的節點</span></label>
        {value.agents !== null && (
          <div className="remote-agents">
            {agents.length === 0 && <span className="muted">目前沒有節點。</span>}
            {agents.map(a => (
              <label key={a.id} className="remote-toggle sub">
                <input type="checkbox" checked={picked.has(a.id)} onChange={() => toggle(a.id)} />
                <span>{a.name}{a.permissionMode === 'auto' ? '(自動模式)' : ''}</span>
              </label>
            ))}
          </div>
        )}
        {risky && <p className="remote-note warn">範圍裡有自動模式的節點:它不會詢問授權,能對它下指令的人等於能在這台電腦上執行任何動作。</p>}
      </>}
    </div>
  );
}

/** 手機遠端的設定面板:開關、配對用的 QR code 與權限、已配對的裝置(改權限、撤銷)、操作紀錄。 */
export function RemotePanel({ onClose, embedded = false }: { onClose: () => void; embedded?: boolean }) {
  const [st, setSt] = useState<RemoteStatus | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [editing, setEditing] = useState<{ id: string; access: RemoteAccess } | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [log, setLog] = useState<AuditEntry[]>([]);
  const [who, setWho] = useState('');
  const [deniedOnly, setDeniedOnly] = useState(false);
  const load = useCallback(() => {
    void window.nexus.remoteStatus().then(setSt);
    void window.nexus.getSnapshot().then(s => setAgents(s.agents.filter(a => !a.parentId)));
  }, []);
  useEffect(() => {
    load();
    // 配對成功、Tailscale 連上等狀態都靠定時重新讀取
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => {
    if (!showLog) return;
    const read = () => void window.nexus.remoteAudit().then(setLog);
    read();
    const t = setInterval(read, 4000);
    return () => clearInterval(t);
  }, [showLog]);
  const act = (p: Promise<void>) => void p.then(load);
  const left = st ? Math.max(0, Math.round((st.pairExpires - Date.now()) / 1000)) : 0;
  const names = [...new Set(log.map(e => e.device))];
  const shown = log.filter(e => (!who || e.device === who) && (!deniedOnly || !e.ok));

  return (
    <div className={embedded ? 'remote-section' : 'remote'}>
      {!embedded && <div className="remote-head"><b>手機遠端</b><span className="spacer" /><button className="ghost" onClick={onClose} aria-label="關閉">✕</button></div>}
      {!st ? <div className="empty">讀取中…</div> : <>
        <label className="remote-toggle">
          <input type="checkbox" checked={st.enabled} onChange={e => act(window.nexus.remoteSet({ enabled: e.target.checked }))} />
          <span>允許手機連線到這台主控台</span>
        </label>
        <p className="remote-note">配對過的裝置依它的權限看節點、下指令、回應授權。用另一台電腦的瀏覽器開啟同一個網址,會看到和這裡相同的完整介面。</p>

        {st.enabled && (st.tailscaleIp
          ? <div className="remote-ok">Tailscale 已連線:{st.tailscaleIp}</div>
          : <div className="remote-warn">這台電腦沒有偵測到 Tailscale。請在電腦與手機都安裝 Tailscale 並用同一個帳號登入,連上後這裡會自動出現 QR code。</div>)}

        {st.enabled && (
          <label className="remote-toggle sub">
            <input type="checkbox" checked={st.lan} onChange={e => act(window.nexus.remoteSet({ lan: e.target.checked }))} />
            <span>也允許同一個 Wi-Fi 連線{st.lanIp ? `(${st.lanIp})` : ''}</span>
          </label>
        )}
        {st.enabled && st.lan && <p className="remote-note warn">區域網路的連線沒有加密,同一個網路上的其他人可能看得到內容。只在信任的網路使用。</p>}
        {st.error && <div className="remote-warn">{st.error}</div>}

        {st.enabled && <>
          <div className="remote-sub">下一支配對裝置的權限</div>
          <AccessEditor value={st.pairAccess} agents={agents} onChange={a => act(window.nexus.remotePairAccess(a))} />
        </>}

        {st.enabled && st.url && st.qr && (
          <div className="remote-pair">
            <img src={st.qr} alt="配對用的 QR code" width={168} height={168} />
            <div>
              <div className="remote-step">用手機相機掃描,或在手機、另一台電腦的瀏覽器開啟:</div>
              <div className="remote-url">{st.url.replace(/\?pair=.*/, '')}</div>
              <div className="remote-step">配對碼(權限:{summary(st.pairAccess, agents)})</div>
              <div className="remote-code">{st.pairCode}</div>
              <div className="remote-step">{left > 0 ? `${Math.floor(left / 60)} 分 ${left % 60} 秒內有效,只能用一次` : '已過期'}</div>
              <button onClick={() => act(window.nexus.remoteNewCode())}>重新產生</button>
            </div>
          </div>
        )}

        <div className="remote-sub">已配對的裝置</div>
        {st.devices.length === 0 && <div className="empty">還沒有配對任何裝置。</div>}
        {st.devices.map(d => (
          <div key={d.id} className="remote-dev-box">
            <div className="remote-dev">
              <span className="remote-dev-name">{d.name}<span className={`remote-role r-${d.role}`}>{summary(d, agents)}</span></span>
              <span className="muted">上次連線 {time(d.lastSeen)}</span>
              <button onClick={() => setEditing(editing?.id === d.id ? null : { id: d.id, access: { role: d.role, agents: d.agents } })}>權限</button>
              <button className="danger" onClick={() => act(window.nexus.remoteRevoke(d.id))} title="這支裝置立刻無法再連線">撤銷</button>
            </div>
            {editing?.id === d.id && (
              <div className="remote-edit">
                <AccessEditor value={editing.access} agents={agents} onChange={access => setEditing({ id: d.id, access })} />
                <div className="remote-edit-actions">
                  <button className="primary" onClick={() => { act(window.nexus.remoteSetDevice(d.id, editing.access)); setEditing(null); }}>儲存</button>
                  <button onClick={() => setEditing(null)}>取消</button>
                </div>
              </div>
            )}
          </div>
        ))}

        <div className="remote-sub remote-log-head">
          <button className="ghost" onClick={() => setShowLog(v => !v)}>{showLog ? '▾' : '▸'} 操作紀錄</button>
          {showLog && <>
            <select value={who} onChange={e => setWho(e.target.value)}><option value="">所有裝置</option>{names.map(n => <option key={n} value={n}>{n}</option>)}</select>
            <label className="remote-toggle sub"><input type="checkbox" checked={deniedOnly} onChange={e => setDeniedOnly(e.target.checked)} /><span>只看被拒絕的</span></label>
          </>}
        </div>
        {showLog && (
          <div className="remote-log">
            {shown.length === 0 && <div className="empty">沒有紀錄。會改變狀態的操作與被拒絕的嘗試才會記下來,保留 90 天。</div>}
            {shown.map(e => (
              <div key={e.id} className={`remote-log-row ${e.ok ? '' : 'denied'}`}>
                <span className="muted">{time(e.ts)}</span>
                <span className="remote-log-who" title={e.role === 'desktop' ? '在主控台上操作' : ROLE_LABEL[e.role]}>{e.device}{e.role === 'desktop' ? '(主控台)' : ''}</span>
                <span className="remote-log-what">{e.ok ? '' : '被拒 · '}{ACTION_LABEL[e.action] ?? e.action}{e.agentName ? ` → ${e.agentName}` : ''}{e.detail ? `:${e.detail}` : ''}</span>
              </div>
            ))}
          </div>
        )}
      </>}
    </div>
  );
}

/** 頂部「遠端」的面板:兩個分頁,手機與瀏覽器遠端、外部觀察(各自的內容與行為和原本的獨立面板相同)。 */
export function RemoteHub({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'remote' | 'observe'>('remote');
  return (
    <div className="remote hub">
      <div className="remote-head"><b>遠端</b><span className="spacer" /><button className="ghost" onClick={onClose} aria-label="關閉">✕</button></div>
      <div className="hub-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'remote'} className={`ghost ${tab === 'remote' ? 'on' : ''}`} onClick={() => setTab('remote')} title="讓手機或另一台電腦的瀏覽器透過 Tailscale 連進來操作">手機與瀏覽器遠端</button>
        <button role="tab" aria-selected={tab === 'observe'} className={`ghost ${tab === 'observe' ? 'on' : ''}`} onClick={() => setTab('observe')} title="觀察在主控台以外執行的 Claude Code(hooks)">外部觀察</button>
      </div>
      {tab === 'remote' ? <RemotePanel embedded onClose={onClose} /> : <ObservePanel embedded onClose={onClose} />}
    </div>
  );
}
