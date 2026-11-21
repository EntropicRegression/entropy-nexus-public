import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BACKEND_LABEL, STATE_LABEL, type AgentInfo, type AgentState, type Backend, type BackendUsage, type Capability, type DirInfo, type DispatchEntry, type LinkInfo, type NexusEvent, type ObservedSession, type PermissionMode, type TaskInfo,
} from '../../shared/types';
import type { DashboardData } from '../../shared/dashboard';
import { Dashboard, DashboardFull } from './Dashboard';
import { HoverCard } from './Hover';
import { VoicePanel } from './Voice';
import { OldSessions } from './OldSessions';
import { PersonaEditor } from './PersonaEditor';
import { RemoteHub } from './Remote';
import { Review } from './Review';
import { TaskPanel } from './Tasks';
import { Dialog } from './Dialog';
import { AgyAllowEditor } from './AgyAllow';
import { BoardScene, type BoardMore } from './board';
import { chime, enqueueSpeech, initSpeech, isMuted, setMuted, stopSpeaking } from './sound';
import { BACKEND_COLOR, ZONE_TITLE, hex } from './theme';

const MAX_EVENTS = 80;
// Alt+N 依序跳到需要你的節點:待授權的排最前面
const ATTENTION: Record<AgentState, number> = { awaiting: 0, error: 1, lost: 1, working: 2, planning: 2, idle: 3, sleeping: 4 };

/** 瀏覽器版的遠端裝置可能不是完整權限(操作或唯讀);桌面視窗一律是完整。 */
const fullAccess = !window.nexus.access || window.nexus.access.role === 'full';

export function App() {
  const [agents, setAgents] = useState<Record<string, AgentInfo>>({});
  const [events, setEvents] = useState<NexusEvent[]>([]);
  const [caps, setCaps] = useState<Capability[]>([]);
  const [autopilot, setAutopilot] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  /** 新增節點面板是不是從總管區塊的「+」打開的(新增後指定為總管,也可以直接指定現有節點)。 */
  const [addingChief, setAddingChief] = useState(false);
  const [chiefId, setChiefId] = useState<string | null>(null);
  const [links, setLinks] = useState<LinkInfo[]>([]);
  const [dispatches, setDispatches] = useState<DispatchEntry[]>([]);
  const [maxActive, setMaxActive] = useState(4);
  const [quotaStop, setQuotaStop] = useState(0);
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [usage, setUsage] = useState<Partial<Record<Backend, BackendUsage>>>({});
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [showOld, setShowOld] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  const [showRemote, setShowRemote] = useState(false);
  const [showView, setShowView] = useState(false);
  const [showLimitHelp, setShowLimitHelp] = useState(false);
  const [showVoice, setShowVoice] = useState(false);
  // 頂部列的「更多」選單:視窗窄的時候,較少用的按鈕收進這裡(寬度夠時這些按鈕直接排在頂部列,見 styles.css)
  const [showMore, setShowMore] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const [observed, setObserved] = useState<Record<string, ObservedSession>>({});
  // 總覽儀表:需要資料庫才算得出來的部分(預算、花費、任務統計)由主行程推送;showDash 是完整內容有沒有展開
  const [dash, setDash] = useState<DashboardData | null>(null);
  const [showDash, setShowDash] = useState(false);
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  const [muted, setMutedState] = useState(isMuted());
  // 主面板的節點在六角形裡顯示角色的 Q 版頭像(角色資料夾裡有 avatar 圖檔時);預設開啟,設定會記住
  const [avatarsOn, setAvatarsOn] = useState(() => localStorage.getItem('nexus.avatars') !== '0');
  const [speaking, setSpeaking] = useState(false);
  // 語音播報播之前要用最新的節點狀態確認:授權或提問還在等、故障還沒恢復
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  // 已經處理掉的授權與提問。播報通知可能比節點狀態的更新先到,所以用「是否已處理」判斷,不看畫面上的狀態
  const resolvedRef = useRef(new Set<string>());

  // 語音播報(Phase 2a):主行程判斷什麼時候該念、算好摘要,這裡排隊播放
  useEffect(() => {
    initSpeech({
      onChange: setSpeaking,
      isPending: n => {
        const a = agentsRef.current[n.agentId];
        if (n.kind === 'approval' || n.kind === 'question') return !resolvedRef.current.has(n.requestId) && (!a || a.state !== 'sleeping');
        // 故障:剛發生的照念;排了一陣子才輪到的,節點已經恢復就不念
        if (n.kind === 'failed' && n.reason !== 'quota' && n.reason !== 'budget' && Date.now() - n.ts > 3000) return !!a && (a.state === 'error' || a.state === 'lost');
        return true;
      },
    });
    return window.nexus.onSpeech(n => enqueueSpeech(n));
  }, []);

  useEffect(() => {
    let alive = true;
    void window.nexus.getSnapshot().then(s => {
      if (!alive) return;
      setAgents(Object.fromEntries(s.agents.map(a => [a.id, a])));
      setEvents(s.events.slice(-MAX_EVENTS));
      setCaps(s.capabilities);
      setAutopilot(s.autopilot);
      setMaxActive(s.maxActive);
      setQuotaStop(s.quotaStop);
      setChiefId(s.chiefId ?? null);
      setLinks(s.links ?? []);
      setDispatches(s.dispatches ?? []);
      setTasks(s.tasks);
      setUsage(Object.fromEntries(s.usage.map(u => [u.backend, u])));
      setObserved(Object.fromEntries((s.observed ?? []).map(o => [o.sessionId, o])));
      setDash(prev => prev ?? s.dashboard ?? null);
    });
    const off = window.nexus.onUpdate(u => {
      if (u.agent) { const a = u.agent; setAgents(prev => ({ ...prev, [a.id]: a })); }
      if (u.removedId) {
        const id = u.removedId;
        setAgents(prev => { const next = { ...prev }; delete next[id]; return next; });
        setSelectedId(cur => (cur === id ? null : cur));
      }
      if (u.event) {
        const e = u.event;
        setEvents(prev => [...prev, e].slice(-MAX_EVENTS));
        if (e.type === 'approval_resolved' || e.type === 'question_resolved') {
          resolvedRef.current.add(e.requestId);
          if (resolvedRef.current.size > 500) resolvedRef.current = new Set([...resolvedRef.current].slice(-200));
        }
        // 提示音只留給待授權與異常
        if (e.type === 'state' && e.state === 'awaiting') chime('ask');
        else if (e.type === 'state' && (e.state === 'error' || e.state === 'lost')) chime('fault');
      }
      if (u.maxActive !== undefined) setMaxActive(u.maxActive);
      if (u.quotaStop !== undefined) setQuotaStop(u.quotaStop);
      if (u.task) { const t = u.task; setTasks(prev => (prev.some(x => x.id === t.id) ? prev.map(x => (x.id === t.id ? t : x)) : [...prev, t])); }
      if (u.tasks) setTasks(u.tasks);
      if (u.usage) { const x = u.usage; setUsage(prev => ({ ...prev, [x.backend]: x })); }
      if (u.dashboard) setDash(u.dashboard);
      if (u.links) setLinks(u.links);
      if (u.dispatches) setDispatches(u.dispatches);
      if (u.autopilot !== undefined) setAutopilot(u.autopilot);
      if (u.chiefId !== undefined) setChiefId(u.chiefId);
      if (u.observed) {
        const o = u.observed;
        // 外部節點進入待授權也響一聲;授權要到外部的終端機處理
        setObserved(prev => { if (o.state === 'awaiting' && prev[o.sessionId]?.state !== 'awaiting') chime('ask'); return { ...prev, [o.sessionId]: o }; });
      }
      if (u.observedRemovedId) { const id = u.observedRemovedId; setObserved(prev => { const next = { ...prev }; delete next[id]; return next; }); }
    });
    return () => { alive = false; off(); };
  }, []);

  // 「更多」選單打開時,點選單以外的地方就收起來
  useEffect(() => {
    if (!showMore) return;
    const close = (e: PointerEvent) => { if (!moreRef.current?.contains(e.target as Node)) setShowMore(false); };
    window.addEventListener('pointerdown', close, true);
    return () => window.removeEventListener('pointerdown', close, true);
  }, [showMore]);

  const list = useMemo(() => Object.values(agents), [agents]);
  const observedList = useMemo(() => Object.values(observed).sort((a, b) => a.startedAt - b.startedAt), [observed]);
  // 自我檢查用:依名稱(或 id)打開節點的對話視窗,效果和在主面板上點那個節點相同
  useEffect(() => {
    const dbg = window as unknown as Record<string, unknown>;
    dbg.__nexusSelect = (key: string) => {
      const a = agentsRef.current[key] ?? Object.values(agentsRef.current).find(x => x.name === key) ?? Object.values(agentsRef.current).find(x => x.name.includes(key));
      if (a) setSelectedId(a.id);
      return !!a;
    };
    return () => { delete dbg.__nexusSelect; };
  }, []);
  // Alt+N 的順序:需要你的排最前面;子節點緊跟在呼叫它的節點後面
  const roster = useMemo(() => {
    const roots = list.filter(a => !a.parentId || !agents[a.parentId]).sort((a, b) => ATTENTION[a.state] - ATTENTION[b.state] || a.createdAt - b.createdAt);
    return roots.flatMap(r => [r, ...list.filter(a => a.parentId === r.id).sort((a, b) => a.createdAt - b.createdAt)]);
  }, [list, agents]);
  const selected = selectedId ? agents[selectedId] ?? null : null;
  // 快捷鍵。終端機模式下按鍵都交給原生 CLI,只保留 F1
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F1') { e.preventDefault(); setShowKeys(v => !v); return; }
      const cur = selectedId ? agents[selectedId] ?? null : null;
      if (cur?.terminal) return;
      const k = e.key.toLowerCase();
      if (e.ctrlKey && !e.altKey && !e.shiftKey && k === 'n') { e.preventDefault(); if (fullAccess) setAdding(true); return; }
      if (e.ctrlKey && !e.altKey && !e.shiftKey && k === 'o') { e.preventDefault(); if (fullAccess) setShowOld(true); return; }
      if (e.key === 'Escape' && !reviewId && !showOld) {
        if (showMore) setShowMore(false); else if (showKeys) setShowKeys(false); else if (showDash) setShowDash(false); else if (selectedId) setSelectedId(null);
        return;
      }
      if (!e.altKey || e.ctrlKey) return;
      if (k === 'n') {
        e.preventDefault();
        const waiting = roster.filter(a => a.state === 'awaiting' || a.state === 'error' || a.state === 'lost');
        if (waiting.length) setSelectedId(waiting[(waiting.findIndex(a => a.id === selectedId) + 1) % waiting.length].id);
      } else if (cur?.pendingApproval && (k === 'a' || k === 's' || k === 'd')) {
        e.preventDefault();
        if (k === 's' && !cur.pendingApproval.canAllowSession) return;
        void window.nexus.respondApproval(cur.id, cur.pendingApproval.requestId, k === 'a' ? 'allow' : k === 's' ? 'allow_session' : 'deny');
      } else if (k === 'i' && cur && (cur.state === 'planning' || cur.state === 'working' || cur.state === 'awaiting')) {
        e.preventDefault();
        void window.nexus.interrupt(cur.id);
      } else if (k === 'w' && selectedId) {
        e.preventDefault();
        setSelectedId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [agents, roster, selectedId, reviewId, showOld, showKeys, showMore, showDash]);
  const reviewTask = reviewId ? tasks.find(t => t.id === reviewId) ?? null : null;
  // 對話視窗的「變更」按鈕:這個節點最近一個有變更資料的任務
  const latestTask = (agentId: string) => tasks.filter(t => t.agentId === agentId && t.changes).sort((a, b) => b.startedAt - a.startedAt)[0]?.id ?? null;
  const needYou = list.filter(a => a.state === 'awaiting' || a.state === 'error' || a.state === 'lost').length;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">ENTROPY NEXUS</div>
        <div className="caps">
          {caps.map(c => {
            const status = c.simulated ? '模擬' : c.available ? c.version ?? '已連線' : '未安裝';
            // 視窗窄的時候標籤縮成圓點,名稱與狀態改從提示文字看
            return (
              <span key={c.backend} className={`chip ${c.simulated || c.available ? '' : 'off'}`} title={`${BACKEND_LABEL[c.backend]}:${status}${c.note ? `
${c.note}` : ''}`}>
                <i style={{ background: hex(BACKEND_COLOR[c.backend]) }} />
                <span className="chip-text">{BACKEND_LABEL[c.backend]}</span>
                <em>{status}</em>
              </span>
            );
          })}
        </div>
        <div className="spacer" />
        <span className="stat">節點 <b>{list.filter(a => !a.parentId).length}</b></span>
        <span className={`stat ${needYou ? 'warn' : ''}`}>需要你 <b>{needYou}</b></span>
        <div className="limits need-full">
          <label className="limit" title="同時執行中的節點數上限(1 到 32)。計入規劃中、執行中、等待授權的頂層節點;子代理不計。已達上限時,新送出的指令會排進節點的佇列,有名額時自動送出。按右邊的「?」看完整說明。">
            <span>同時<span className="tb-long">上限</span></span>
            <input type="number" min={1} max={32} value={maxActive} onChange={e => { const n = Number(e.target.value); if (Number.isInteger(n) && n >= 1 && n <= 32) void window.nexus.setMaxActive(n); }} />
          </label>
          <label className="limit" title="某家後台的額度用到這個百分比,就不再對它的節點送出新指令,排隊中的指令會暫停(0 表示不限制)。按右邊的「?」看完整說明。">
            <span>額度<span className="tb-long">上限</span></span>
            <input type="number" min={0} max={100} value={quotaStop} onChange={e => { const n = Number(e.target.value); if (Number.isInteger(n) && n >= 0 && n <= 100) void window.nexus.setQuotaStop(n); }} />%
          </label>
          <button className={`ghost help ${showLimitHelp ? 'on' : ''}`} onClick={() => setShowLimitHelp(v => !v)} title="說明:同時上限與額度上限" aria-label="說明:同時上限與額度上限">?</button>
        </div>
        <span className="topbar-sep" aria-hidden />
        <button className={`ghost mute need-full ${showVoice ? 'on' : ''}`} onClick={() => setShowVoice(v => !v)} title="語音:朗讀(語音播報)開關,以及語音輸入(實驗性)的設定">語音</button>
        <button className={`ghost mute need-full ${showRemote ? 'on' : ''}`} onClick={() => setShowRemote(v => !v)} title="遠端:讓手機或另一台電腦的瀏覽器連進來操作,以及觀察在主控台以外執行的 Claude Code">遠端</button>
        {speaking && <button className="ghost mute stop-speak" onClick={() => { stopSpeaking(); setSpeaking(false); }} title="停止目前的朗讀(並清空還沒念的)">停止朗讀</button>}
        {/* 較少用的按鈕:寬度夠時直接排在頂部列;視窗窄的時候收進「更多」選單(同一組按鈕,只是換位置) */}
        <div className={`topbar-more ${showMore ? 'open' : ''}`} ref={moreRef}>
          <button className={`ghost mute more-btn ${showMore || showKeys || showView ? 'on' : ''}`} onClick={() => setShowMore(v => !v)} title="更多:快捷鍵、顯示與提示" aria-label="更多" aria-haspopup="menu" aria-expanded={showMore}>⋯</button>
          <div className="more-items" role="group" aria-label="更多" onClick={e => { if ((e.target as HTMLElement).closest('button')) setShowMore(false); }}>
            <button className={`ghost mute ${showKeys ? 'on' : ''}`} onClick={() => setShowKeys(v => !v)} title="顯示快捷鍵(F1)">快捷鍵</button>
            <button className={`ghost mute ${showView ? 'on' : ''}`} onClick={() => setShowView(v => !v)} title="顯示與提示:節點頭像、提示音">顯示</button>
            {caps.some(c => c.simulated) && (
              <label className="toggle need-full" title="假資料節點在待命時自動收到指令">
                <input type="checkbox" checked={autopilot} onChange={e => void window.nexus.setAutopilot(e.target.checked)} />
                模擬自動運作
              </label>
            )}
          </div>
        </div>
      </header>

      {showDash && <DashboardFull dispatches={dispatches} tasks={tasks} agents={list} caps={caps} usage={usage} data={dash} quotaStop={quotaStop} observed={observedList} onClose={() => setShowDash(false)} onSelect={setSelectedId} />}
      {showRemote && <RemoteHub onClose={() => setShowRemote(false)} />}
      {showVoice && <VoicePanel onClose={() => setShowVoice(false)} />}
      {showView && (
        <div className="topbar-pop view-pop">
          <div className="remote-head"><b>顯示與提示</b><span className="spacer" /><button className="ghost" onClick={() => setShowView(false)} aria-label="關閉">✕</button></div>
          <div className="pop-row">
            <button className={`ghost mute ${avatarsOn ? 'on' : ''}`} onClick={() => { localStorage.setItem('nexus.avatars', avatarsOn ? '0' : '1'); setAvatarsOn(!avatarsOn); }} title="在節點的六角形裡顯示角色的 Q 版頭像(角色資料夾裡的 avatar.png);關閉時顯示原本的六角形">{avatarsOn ? '頭像 開' : '頭像 關'}</button>
            <span className="remote-note">節點的六角形裡顯示角色的 Q 版頭像;關閉時顯示原本的六角形。</span>
          </div>
          <div className="pop-row">
            <button className={`ghost mute ${muted ? '' : 'on'}`} onClick={() => { setMuted(!muted); setMutedState(!muted); }} title="待授權與異常時的提示音">{muted ? '提示音 關' : '提示音 開'}</button>
            <span className="remote-note">節點進入待授權或異常時響一聲,其他狀態保持安靜。</span>
          </div>
          <p className="remote-note">朗讀(語音播報)的開關在「語音」面板。</p>
        </div>
      )}
      {showLimitHelp && (
        <div className="topbar-pop limit-pop">
          <div className="remote-head"><b>同時上限與額度上限</b><span className="spacer" /><button className="ghost" onClick={() => setShowLimitHelp(false)} aria-label="關閉">✕</button></div>
          <div className="remote-sub first">同時上限(目前 {maxActive})</div>
          <p className="remote-note">同時「執行中」的節點最多幾個(1 到 32,預設 4),用來避免一次開太多節點把訂閱額度用完。</p>
          <ul className="help-list">
            <li>計入:規劃中、執行中、等待你授權的頂層節點,以及正在送出第一句的節點。子代理不計;待命、休眠、失聯、出錯的節點不計。</li>
            <li>已達上限時,你再對待命的節點送指令,不會送出,而是排進那個節點的佇列(對話裡會出現「已達同時執行上限」),等有節點停下來空出名額時,依排入時間先後自動送出。</li>
            <li>已在執行的節點中途插話不受影響。模擬自動運作的指令達上限時直接略過,不排隊。</li>
          </ul>
          <div className="remote-sub">額度上限(目前 {quotaStop === 0 ? '不限制' : `${quotaStop}%`})</div>
          <p className="remote-note">某家後台的額度用到這個百分比,主控台就不再對那家後台的節點送出新指令。0 表示不限制(範圍 0 到 100)。</p>
          <ul className="help-list">
            <li>看的是該後台各額度視窗(例如每五小時、每週)裡用量最高的一個;依模型分組的額度只看節點使用的模型所屬的那一組;還沒有額度資料的後台不受限制。</li>
            <li>已達上限時:你直接送出的指令不會送出,對話裡顯示錯誤;排隊中的指令留在佇列並暫停,調高上限或等額度重置後,按佇列的「繼續」才會恢復。</li>
            <li>只擋新指令,已經在執行的回合不會被中斷;其他後台不受影響。</li>
          </ul>
        </div>
      )}
      {showKeys && (
        <div className="keys">
          <b>快捷鍵</b>
          <div><span>跳到下一個需要你的節點</span><kbd>Alt+N</kbd></div>
          <div><span>允許</span><kbd>Alt+A</kbd></div>
          <div><span>本次 session 都允許</span><kbd>Alt+S</kbd></div>
          <div><span>拒絕</span><kbd>Alt+D</kbd></div>
          <div><span>中斷</span><kbd>Alt+I</kbd></div>
          <div><span>關閉對話視窗</span><kbd>Esc</kbd> <kbd>Alt+W</kbd></div>
          <div><span>對話視窗展開到滿 / 還原</span><kbd>Alt+F</kbd></div>
          <div><span>輸入框展開 / 收回(展開時 Ctrl+Enter 送出)</span><kbd>Alt+E</kbd></div>
          <div><span>新增節點</span><kbd>Ctrl+N</kbd></div>
          <div><span>開啟舊 session</span><kbd>Ctrl+O</kbd></div>
          <div><span>送出指令 / 換行</span><kbd>Enter</kbd> <kbd>Shift+Enter</kbd></div>
          <div><span>排進佇列(回合完成後自動送出)</span><kbd>Alt+Enter</kbd></div>
          <div><span>顯示這張表</span><kbd>F1</kbd></div>
        </div>
      )}
      <main className={`stage ${selected ? 'dim' : ''}`}>
        <Board agents={list} selectedId={selectedId} avatars={avatarsOn} chiefId={chiefId} links={links} onSelect={setSelectedId} onHover={setHover} onAddChief={() => { if (fullAccess) { setAdding(true); setAddingChief(true); } }} />
        {hover && agents[hover.id] && <HoverCard agent={agents[hover.id]} usage={usage[agents[hover.id].backend]} x={hover.x} y={hover.y} />}
        {selected && <Dialog key={selected.id} agent={selected} cap={caps.find(c => c.backend === selected.backend)} parentName={selected.parentId ? agents[selected.parentId]?.name ?? '' : ''} reviewTaskId={latestTask(selected.id)} onReview={setReviewId} onClose={() => setSelectedId(null)} onOpen={setSelectedId} isChief={selected.id === chiefId} />}
        {reviewTask && <Review key={reviewTask.id} task={reviewTask} agents={list} onClose={() => setReviewId(null)} />}
        {showOld && <OldSessions onOpened={id => { setShowOld(false); setSelectedId(id); }} onClose={() => setShowOld(false)} />}
      </main>

      {/* 右側欄:最上面是常駐的總覽儀表(原本節點清單的位置),下面是任務面板與新增節點 */}
      <aside className="sidebar">
        <Dashboard agents={list} caps={caps} usage={usage} data={dash} quotaStop={quotaStop} observed={observedList} selectedId={selectedId} open={showDash} onToggle={() => setShowDash(v => !v)} onSelect={setSelectedId} />
        {!adding && <TaskPanel tasks={tasks} chiefId={chiefId} agents={agents} selectedId={selectedId} onSelect={setSelectedId} onReview={setReviewId} />}
        {adding ? <AddNode key={addingChief ? 'chief' : 'node'} caps={caps} agents={list} chief={addingChief} onDone={() => { setAdding(false); setAddingChief(false); }} /> : (
          <div className="add-row">
            <button className="add need-full" onClick={() => setAdding(true)}>+ 新增節點</button>
            <button className="add old need-full" onClick={() => setShowOld(true)} title="接回終止過的節點,或三家 CLI 留在這台電腦上的舊對話">開啟舊 session</button>
          </div>
        )}
      </aside>

      <footer className="log">
        {events.slice(-5).map(e => (
          <div key={e.seq} className={`log-line t-${e.type}`}>
            <time>{new Date(e.ts).toLocaleTimeString('zh-TW', { hour12: false })}</time>
            <b>{agents[e.agentId]?.name ?? '已移除'}</b>
            <span>{describe(e)}</span>
          </div>
        ))}
      </footer>
    </div>
  );
}

function describe(e: NexusEvent): string {
  switch (e.type) {
    case 'state': return `狀態 → ${STATE_LABEL[e.state]}${e.detail ? `(${e.detail})` : ''}`;
    case 'message': return `${e.role === 'user' ? '指令' : '回覆'}:${e.text.replace(/\s+/g, ' ').slice(0, 160)}`;
    case 'tool': return `工具${e.phase === 'start' ? '開始' : '結束'}:${e.name} · ${e.summary}`;
    case 'approval_request': return `請求授權:${e.tool} · ${e.summary}`;
    case 'approval_resolved': return `授權結果:${e.decision === 'deny' ? '拒絕' : '允許'}`;
    case 'session': return `session ${e.sessionId}`;
    case 'usage': return '用量更新';
    case 'note': return e.text;
    case 'image': return `圖片:${e.caption || e.path}`;
    case 'delta': return '';
    case 'question': return `提問:${e.questions[0]?.question ?? ''}`;
    case 'question_resolved': return e.answers ? `已回答:${Object.values(e.answers).flat().join('、')}` : '略過提問';
    case 'plan': return `更新計畫:${e.steps.filter(s => s.status === 'done').length}/${e.steps.length} 個步驟完成`;
    case 'subagent': return e.phase === 'start' ? `啟動子代理:${e.name}` : `子代理結束:${e.name}${e.failed ? '(失敗)' : ''}`;
    case 'error': return `錯誤:${e.message}`;
  }
}

/** PixiJS 主面板的 React 外殼。 */
function Board({ agents, selectedId, avatars, chiefId, links, onSelect, onHover, onAddChief }: { agents: AgentInfo[]; selectedId: string | null; avatars: boolean; chiefId: string | null; links: LinkInfo[]; onSelect: (id: string | null) => void; onHover: (h: { id: string; x: number; y: number } | null) => void; onAddChief: () => void }) {
  const hoverRef = useRef(onHover);
  hoverRef.current = onHover;
  const addChiefRef = useRef(onAddChief);
  addChiefRef.current = onAddChief;
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<BoardScene | null>(null);
  const latest = useRef({ agents, selectedId, avatars, chiefId });
  const latestLinks = useRef(links);
  latestLinks.current = links;
  latest.current = { agents, selectedId, avatars, chiefId };
  // 區塊排不下時「另外 N 個」的清單:點面板上的標記打開,列出被收起來的節點
  const [more, setMore] = useState<BoardMore | null>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!more) return;
    const close = () => scene.current?.closeMore();
    // 點清單和面板以外的地方、或按 Esc 就關掉(面板上的點擊由面板自己處理)
    const onDown = (e: PointerEvent) => { if (e.target instanceof Node && !moreRef.current?.contains(e.target) && !host.current?.contains(e.target)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('pointerdown', onDown, true); document.removeEventListener('keydown', onKey, true); };
  }, [more !== null]);

  useEffect(() => {
    let dead = false;
    const s = new BoardScene(id => { s.closeMore(); onSelect(id); }, h => hoverRef.current(h), () => addChiefRef.current(), setMore);
    void s.init(host.current!).then(() => {
      if (dead) { s.destroy(); return; }
      scene.current = s;
      s.setAvatars(latest.current.avatars);
      s.setLinks(latestLinks.current);
      s.sync(latest.current.agents, latest.current.selectedId, latest.current.chiefId);
    });
    return () => { dead = true; scene.current?.destroy(); scene.current = null; };
  }, [onSelect]);

  useEffect(() => { scene.current?.sync(agents, selectedId, chiefId); }, [agents, selectedId, chiefId]);
  useEffect(() => { scene.current?.setAvatars(avatars); }, [avatars]);
  useEffect(() => { scene.current?.setLinks(links); }, [links]);

  // 清單放在標記的上方或下方(看哪邊空間大),不超出面板
  const box = host.current?.parentElement;
  const zoneName = more ? ZONE_TITLE[more.zone].split(' ')[0] : '';
  const moreStyle = (() => {
    if (!more || !box) return undefined;
    const W = box.clientWidth, H = box.clientHeight, width = Math.min(232, W - 16);
    const top = more.y - 34 * more.zoom, bottom = more.y + 64 * more.zoom;
    const left = Math.max(8, Math.min(more.x - width / 2, W - width - 8));
    return H - bottom >= top
      ? { left, width, top: bottom + 4, maxHeight: Math.max(96, Math.min(360, H - bottom - 12)) }
      : { left, width, bottom: `calc(100% - ${Math.round(top - 4)}px)`, maxHeight: Math.max(96, Math.min(360, top - 12)) };
  })();
  return (
    <>
      <div className="board" ref={host} />
      {more && moreStyle && (
        <div className="board-more" ref={moreRef} style={moreStyle} role="dialog" aria-label={`${zoneName}區塊的其他節點`}>
          <div className="bm-head">
            <b>{zoneName}</b><span>另外 {more.ids.length} 個</span>
            <button className="ghost" aria-label="關閉清單" onClick={() => scene.current?.closeMore()}>×</button>
          </div>
          <div className="bm-list">
            {more.ids.map(id => agents.find(a => a.id === id)).filter((a): a is AgentInfo => !!a).map(a => (
              <button key={a.id} className={`bm-row s-${a.state}`} onClick={() => { scene.current?.closeMore(); onSelect(a.id); }} title={`打開「${a.name}」的對話視窗`}>
                <i style={{ background: hex(BACKEND_COLOR[a.backend]) }} />
                <span className="bm-name">{a.parentId ? '↳ ' : ''}{a.name}</span>
                <span className="bm-state">{a.detail || STATE_LABEL[a.state]}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function AddNode({ caps, agents, chief = false, onDone }: { caps: Capability[]; agents: AgentInfo[]; chief?: boolean; onDone: () => void }) {
  // 總管的預設建議(tests/chief-real 的實測:Claude Code 的 sonnet 最快、回覆最精簡):有就預選,沒有就照一般節點
  const chiefClaude = chief ? caps.find(c => c.backend === 'claude' && c.available) : undefined;
  const firstUsable = chiefClaude?.backend ?? caps.find(c => c.available)?.backend ?? 'claude';
  const [name, setName] = useState('');
  const [character, setCharacter] = useState('');
  const [characters, setCharacters] = useState<string[]>([]);
  // 每次打開面板都重新讀取立繪資料夾,剛放進去的角色馬上選得到
  useEffect(() => { void window.nexus.getSnapshot().then(s => setCharacters(s.characters)); }, []);
  const [backend, setBackend] = useState<Backend>(firstUsable);
  const [cwd, setCwd] = useState('');
  const [mode, setMode] = useState<PermissionMode>('ask');
  const [model, setModel] = useState(chiefClaude?.models.includes('sonnet') ? 'sonnet' : '');
  const [isolate, setIsolate] = useState(false);
  const [dir, setDir] = useState<DirInfo | null>(null);
  // 資料夾改變後查一下它是不是 git 版本庫,決定能不能用獨立工作區
  useEffect(() => {
    if (!cwd.trim()) { setDir(null); setIsolate(false); return; }
    let alive = true;
    const t = setTimeout(() => { void window.nexus.inspectDir(cwd.trim()).then(d => { if (alive) { setDir(d); if (!d.isRepo || !d.hasCommit) setIsolate(false); } }); }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [cwd]);
  const [error, setError] = useState('');
  // 名稱或角色對得上封存的記憶時問要不要接回(刪除節點時歸檔的工作履歷)
  const [archive, setArchive] = useState<{ path: string; date: string; name: string } | null>(null);
  const [attach, setAttach] = useState(true);
  useEffect(() => {
    let alive = true;
    const names = [name.trim(), character.trim()].filter(Boolean);
    if (!names.length) { setArchive(null); return; }
    const t = setTimeout(() => { void window.nexus.findMemoryArchive(names).then(r => { if (alive) setArchive(r); }).catch(() => { if (alive) setArchive(null); }); }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [name, character]);
  const cap = caps.find(c => c.backend === backend);
  // 同一個資料夾已有節點時提醒:它們會互相覆寫,變更檢視也分不出是誰改的
  const norm = (p: string) => p.trim().replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
  const sameDir = cwd.trim() ? agents.filter(a => !a.parentId && norm(a.cwd) === norm(cwd)) : [];
  const create = async () => {
    try {
      const made = await window.nexus.createAgent({ isolate, name, character, model, backend, cwd, permissionMode: cap?.approvals === false ? 'ask' : mode, ...(chief ? { chief: true } : {}) });
      // 接回封存的記憶失敗不影響節點建立
      if (archive && attach) await window.nexus.attachMemoryArchive(made.id, archive.path).catch(() => null);
      onDone();
    } catch (e) {
      setError(String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    }
  };
  const pickChief = async (id: string) => {
    try { await window.nexus.setChief(id); onDone(); } catch (e) { setError(String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
  };
  const candidates = agents.filter(a => !a.parentId);
  return (
    <div className={`addform ${chief ? 'chief' : ''}`}>
      <div className="panel-title">{chief ? '指定總管節點' : '新增節點'}</div>
      {/* 欄位放在自己的捲動區;標題、錯誤訊息和「取消、新增」固定在外面,視窗再矮也按得到 */}
      <div className="addform-body">
      {chief && <>
        <p className="note">總管負責接收你交代的事(可以在它的對話視窗用語音說),判斷交給哪個節點,再用節點互相呼叫分派出去。建議用「每次詢問」模式:每次分派前會先問你。</p>
        <p className="note">預設建議:Claude Code 搭配 sonnet 模型。實測(tests/chief-real)它是反應最快、回覆最精簡的組合,適合只負責判斷與分派的總管;已為你預選,可以自行更換。</p>
        {candidates.length > 0 && <div className="chief-pick">
          <span className="note">直接指定現有節點:</span>
          {candidates.map(a => <button key={a.id} onClick={() => void pickChief(a.id)} title={`${BACKEND_LABEL[a.backend]}${a.model ? ` · ${a.model}` : ''}`}>{a.name}</button>)}
        </div>}
        <div className="note">或新增一個節點當總管:</div>
      </>}
      <label>名稱<input value={name} onChange={e => setName(e.target.value)} placeholder="例如 Sirius" autoFocus /></label>
      <label>角色
        <span className="pick">
          <select value={character} onChange={e => setCharacter(e.target.value)}>
            <option value="">預設([REDACTED])</option>
            {characters.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <button onClick={() => void window.nexus.openPortraitsFolder()} title="開啟立繪資料夾,放入自己的角色圖檔">資料夾</button>
        </span>
        {characters.length === 0 && <span className="note">還沒有自訂立繪。按「資料夾」看放置方式。</span>}
      </label>
      {character && <PersonaEditor character={character} />}
      {archive && <label className="check addform-archive" title="封存是刪除節點時存進記憶庫的工作履歷">
        <span><input type="checkbox" checked={attach} onChange={e => setAttach(e.target.checked)} /> 找到 {archive.name} 的封存記憶({archive.date}),要接回嗎?</span>
        <span className="note">接回後,封存裡的特長與解決問題的流程會複製進新節點的側寫。</span>
      </label>}
      <label>後台 CLI
        <select value={backend} onChange={e => { setBackend(e.target.value as Backend); setModel(''); }}>
          {caps.map(c => (
            <option key={c.backend} value={c.backend} disabled={!c.available}>
              {BACKEND_LABEL[c.backend]}{c.simulated ? '(模擬)' : c.available ? '' : '(無法使用)'}
            </option>
          ))}
        </select>
        {cap && <span className="note">{cap.note}</span>}
      </label>
      {backend === 'antigravity' && <AgyAllowEditor />}
      <label>模型
        <input list="model-options" value={model} onChange={e => setModel(e.target.value)} placeholder="預設(使用 CLI 的設定)" />
        <datalist id="model-options">{(cap?.models ?? []).map(m => <option key={m} value={m} />)}</datalist>
        <span className="note">留空用 CLI 的預設;可從清單選或自行輸入模型代號。</span>
      </label>
      <label>工作目錄
        <span className="pick">
          <input value={cwd} onChange={e => setCwd(e.target.value)} placeholder="選擇資料夾" />
          <button onClick={async () => { const d = await window.nexus.pickDirectory(); if (d) setCwd(d); }}>瀏覽</button>
        </span>
      </label>
      <label className="check" title="每個節點在自己的 git worktree 與分支上工作,互不覆寫">
        <span><input type="checkbox" checked={isolate} disabled={!dir?.isRepo || !dir.hasCommit} onChange={e => setIsolate(e.target.checked)} /> 獨立工作區(git worktree)</span>
        <span className="note">{!cwd.trim() ? '先選工作目錄。' : !dir ? '檢查資料夾中…' : !dir.exists ? '資料夾不存在。' : !dir.isRepo ? '這個資料夾不是 git 版本庫,無法使用。' : !dir.hasCommit ? '版本庫還沒有任何提交,無法使用。' : isolate ? `會從 ${dir.branch} 建立新分支,在另一個資料夾工作。新的工作區只有已提交的檔案,沒有 node_modules 與 .env。` : `目前分支 ${dir.branch}。勾選後節點不會直接改這個資料夾。`}</span>
      </label>
      {sameDir.length > 0 && !isolate && <div className="form-warn">這個資料夾已有節點「{sameDir.map(a => a.name).join('、')}」。多個節點同時修改同一個資料夾會互相覆寫,變更檢視也會混在一起。</div>}
      {cap?.approvals === false
        ? <label>權限模式<span className="note warn">這個後台不支援在視窗內授權,新增後不會詢問你。</span></label>
        : (
          <label>權限模式
            <select value={mode} onChange={e => setMode(e.target.value as PermissionMode)}>
              <option value="ask">每次詢問</option>
              <option value="auto">自動執行</option>
            </select>
            {mode === 'auto' && <span className="note warn">修改檔案與一般指令不會再詢問,只有判斷為有風險或超出工作目錄的動作才會擋下或詢問。節點上會標示 AUTO。</span>}
            {chief && mode === 'auto' && <span className="note warn">總管會在不問你的情況下,把工作交給其他節點執行。建議維持「每次詢問」,分派前先由你確認。</span>}
          </label>
        )}
      </div>
      {error && <div className="form-error">{error}</div>}
      <div className="addform-actions">
        <button onClick={onDone}>取消</button>
        <button className="primary" disabled={!name.trim() || !cwd.trim() || !cap?.available} onClick={() => void create()}>{chief ? '新增並指定為總管' : '新增'}</button>
      </div>
    </div>
  );
}
