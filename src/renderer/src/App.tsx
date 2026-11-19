import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BACKEND_LABEL, STATE_LABEL, type AgentInfo, type AgentState, type Backend, type BackendUsage, type Capability, type DirInfo, type NexusEvent, type ObservedSession, type PermissionMode, type TaskInfo,
} from '../../shared/types';
import { HoverCard } from './Hover';
import { ObservedRows, ObservePanel } from './Observe';
import { OldSessions } from './OldSessions';
import { PersonaEditor } from './PersonaEditor';
import { RemotePanel } from './Remote';
import { Review } from './Review';
import { TaskPanel } from './Tasks';
import { Dialog } from './Dialog';
import { BoardScene } from './board';
import { chime, isMuted, isSpeakOn, setMuted, setSpeakOn, speak, stopSpeaking } from './sound';
import { BACKEND_COLOR, STATE_COLOR, hex } from './theme';

const MAX_EVENTS = 80;
// 「需要你」的排最上面
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
  const [maxActive, setMaxActive] = useState(4);
  const [quotaStop, setQuotaStop] = useState(0);
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [usage, setUsage] = useState<Partial<Record<Backend, BackendUsage>>>({});
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [showOld, setShowOld] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  const [showRemote, setShowRemote] = useState(false);
  const [showObserve, setShowObserve] = useState(false);
  const [observed, setObserved] = useState<Record<string, ObservedSession>>({});
  const [hover, setHover] = useState<{ id: string; x: number; y: number; side: 'right' | 'left' } | null>(null);
  const [muted, setMutedState] = useState(isMuted());
  // 主面板的節點在六角形裡顯示角色的 Q 版頭像(角色資料夾裡有 avatar 圖檔時);預設開啟,設定會記住
  const [avatarsOn, setAvatarsOn] = useState(() => localStorage.getItem('nexus.avatars') !== '0');
  const [speakOn, setSpeakOnState] = useState(isSpeakOn());
  const [speaking, setSpeaking] = useState(false);

  useEffect(() => {
    let alive = true;
    const lastReply = new Map<string, string>();
    void window.nexus.getSnapshot().then(s => {
      if (!alive) return;
      setAgents(Object.fromEntries(s.agents.map(a => [a.id, a])));
      setEvents(s.events.slice(-MAX_EVENTS));
      setCaps(s.capabilities);
      setAutopilot(s.autopilot);
      setMaxActive(s.maxActive);
      setQuotaStop(s.quotaStop);
      setTasks(s.tasks);
      setUsage(Object.fromEntries(s.usage.map(u => [u.backend, u])));
      setObserved(Object.fromEntries((s.observed ?? []).map(o => [o.sessionId, o])));
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
        // 提示音只留給待授權與異常
        if (e.type === 'state' && e.state === 'awaiting') chime('ask');
        else if (e.type === 'state' && (e.state === 'error' || e.state === 'lost')) chime('fault');
        // 朗讀:記下這個回合最後一則回覆,回合結束(回到待命)時念出來;子代理不念
        if (e.type === 'message') { if (e.role === 'agent') lastReply.set(e.agentId, e.text); else lastReply.delete(e.agentId); }
        else if (e.type === 'state' && e.state === 'idle' && !u.agent?.parentId) {
          const text = lastReply.get(e.agentId);
          lastReply.delete(e.agentId);
          if (text && isSpeakOn()) speak(text, setSpeaking);
        }
      }
      if (u.maxActive !== undefined) setMaxActive(u.maxActive);
      if (u.quotaStop !== undefined) setQuotaStop(u.quotaStop);
      if (u.task) { const t = u.task; setTasks(prev => (prev.some(x => x.id === t.id) ? prev.map(x => (x.id === t.id ? t : x)) : [...prev, t])); }
      if (u.tasks) setTasks(u.tasks);
      if (u.usage) { const x = u.usage; setUsage(prev => ({ ...prev, [x.backend]: x })); }
      if (u.autopilot !== undefined) setAutopilot(u.autopilot);
      if (u.observed) {
        const o = u.observed;
        // 外部節點進入待授權也響一聲;授權要到外部的終端機處理
        setObserved(prev => { if (o.state === 'awaiting' && prev[o.sessionId]?.state !== 'awaiting') chime('ask'); return { ...prev, [o.sessionId]: o }; });
      }
      if (u.observedRemovedId) { const id = u.observedRemovedId; setObserved(prev => { const next = { ...prev }; delete next[id]; return next; }); }
    });
    return () => { alive = false; off(); };
  }, []);

  const list = useMemo(() => Object.values(agents), [agents]);
  // 節點清單:需要你的排最上面;子節點緊跟在呼叫它的節點後面
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
        if (showKeys) setShowKeys(false); else if (selectedId) setSelectedId(null);
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
  }, [agents, roster, selectedId, reviewId, showOld, showKeys]);
  const reviewTask = reviewId ? tasks.find(t => t.id === reviewId) ?? null : null;
  // 對話視窗的「變更」按鈕:這個節點最近一個有變更資料的任務
  const latestTask = (agentId: string) => tasks.filter(t => t.agentId === agentId && t.changes).sort((a, b) => b.startedAt - a.startedAt)[0]?.id ?? null;
  const needYou = list.filter(a => a.state === 'awaiting' || a.state === 'error' || a.state === 'lost').length;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">ENTROPY NEXUS</div>
        <div className="caps">
          {caps.map(c => (
            <span key={c.backend} className="chip" title={c.note}>
              <i style={{ background: hex(BACKEND_COLOR[c.backend]) }} />
              {BACKEND_LABEL[c.backend]}
              <em>{c.simulated ? '模擬' : c.available ? c.version ?? '已連線' : '未安裝'}</em>
            </span>
          ))}
        </div>
        <div className="spacer" />
        <span className="stat">節點 <b>{list.filter(a => !a.parentId).length}</b></span>
        <span className={`stat ${needYou ? 'warn' : ''}`}>需要你 <b>{needYou}</b></span>
        <label className="limit need-full" title="同時執行中的節點數上限;超過時新的指令不會送出">
          同時上限
          <input type="number" min={1} max={32} value={maxActive} onChange={e => { const n = Number(e.target.value); if (Number.isInteger(n) && n >= 1 && n <= 32) void window.nexus.setMaxActive(n); }} />
        </label>
        <label className="limit need-full" title="某家後台的額度用到這個百分比,就不再送出新指令;0 表示不限制">
          額度上限
          <input type="number" min={0} max={100} value={quotaStop} onChange={e => { const n = Number(e.target.value); if (Number.isInteger(n) && n >= 0 && n <= 100) void window.nexus.setQuotaStop(n); }} />%
        </label>
        <button className={`ghost mute need-full ${showRemote ? 'on' : ''}`} onClick={() => setShowRemote(v => !v)} title="讓手機透過 Tailscale 連進來操作">手機</button>
        <button className={`ghost mute need-full ${showObserve ? 'on' : ''}`} onClick={() => setShowObserve(v => !v)} title="觀察在主控台以外執行的 Claude Code(hooks)">外部觀察</button>
        <button className={`ghost mute ${showKeys ? 'on' : ''}`} onClick={() => setShowKeys(v => !v)} title="顯示快捷鍵(F1)">快捷鍵</button>
        <button className={`ghost mute ${avatarsOn ? 'on' : ''}`} onClick={() => { localStorage.setItem('nexus.avatars', avatarsOn ? '0' : '1'); setAvatarsOn(!avatarsOn); }} title="在節點的六角形裡顯示角色的 Q 版頭像(角色資料夾裡的 avatar.png);關閉時顯示原本的六角形">{avatarsOn ? '頭像 開' : '頭像 關'}</button>
        <button className={`ghost mute ${muted ? '' : 'on'}`} onClick={() => { setMuted(!muted); setMutedState(!muted); }} title="待授權與異常時的提示音">{muted ? '提示音 關' : '提示音 開'}</button>
        <button className={`ghost mute ${speakOn ? 'on' : ''}`} onClick={() => { setSpeakOn(!speakOn); setSpeakOnState(!speakOn); if (speakOn) setSpeaking(false); }} title="回合完成時朗讀 agent 的最後一則回覆(略過程式碼)">{speakOn ? '朗讀 開' : '朗讀 關'}</button>
        {speaking && <button className="ghost mute" onClick={() => { stopSpeaking(); setSpeaking(false); }} title="停止目前的朗讀">停止朗讀</button>}
        {caps.some(c => c.simulated) && (
          <label className="toggle need-full" title="假資料節點在待命時自動收到指令">
            <input type="checkbox" checked={autopilot} onChange={e => void window.nexus.setAutopilot(e.target.checked)} />
            模擬自動運作
          </label>
        )}
      </header>

      {showRemote && <RemotePanel onClose={() => setShowRemote(false)} />}
      {showObserve && <ObservePanel onClose={() => setShowObserve(false)} />}
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
        <Board agents={list} selectedId={selectedId} avatars={avatarsOn} onSelect={setSelectedId} onHover={h => setHover(h ? { ...h, side: 'right' } : null)} />
        {hover && agents[hover.id] && hover.side === 'right' && <HoverCard agent={agents[hover.id]} usage={usage[agents[hover.id].backend]} x={hover.x} y={hover.y} side="right" />}
        {selected && <Dialog key={selected.id} agent={selected} cap={caps.find(c => c.backend === selected.backend)} parentName={selected.parentId ? agents[selected.parentId]?.name ?? '' : ''} reviewTaskId={latestTask(selected.id)} onReview={setReviewId} onClose={() => setSelectedId(null)} onOpen={setSelectedId} />}
        {reviewTask && <Review key={reviewTask.id} task={reviewTask} agents={list} onClose={() => setReviewId(null)} />}
        {showOld && <OldSessions onOpened={id => { setShowOld(false); setSelectedId(id); }} onClose={() => setShowOld(false)} />}
      </main>

      {hover && agents[hover.id] && hover.side === 'left' && <HoverCard agent={agents[hover.id]} usage={usage[agents[hover.id].backend]} x={hover.x} y={hover.y} side="left" />}
      <aside className="roster">
        <div className="panel-title">節點清單</div>
        <div className="roster-list">
          {roster.map(a => (
            <button key={a.id} className={`row ${a.id === selectedId ? 'on' : ''} s-${a.state} ${a.parentId ? 'sub' : ''}`} onClick={() => setSelectedId(a.id)}
              onMouseEnter={e => { const r = e.currentTarget.getBoundingClientRect(); setHover({ id: a.id, x: r.left, y: r.top, side: 'left' }); }} onMouseLeave={() => setHover(null)}>
              <span className="dot" style={{ borderColor: hex(BACKEND_COLOR[a.backend]), background: hex(STATE_COLOR[a.state]) }} />
              <span className="row-main">
                <span className="row-name">{a.name}</span>
                <span className="row-sub">{a.parentId ? `子代理 · ${agents[a.parentId]?.name ?? ''}` : `${BACKEND_LABEL[a.backend]}${a.model ? ` · ${a.model}` : ''}${a.simulated ? ' · 模擬' : ''}`}</span>
              </span>
              <span className="row-state">{STATE_LABEL[a.state]}</span>
            </button>
          ))}
          {list.length === 0 && <div className="empty">還沒有節點。按下方按鈕新增。</div>}
          <ObservedRows list={Object.values(observed).sort((a, b) => a.startedAt - b.startedAt)} onOpened={setSelectedId} />
        </div>
        {!adding && <TaskPanel tasks={tasks} agents={agents} selectedId={selectedId} onSelect={setSelectedId} onReview={setReviewId} />}
        {adding ? <AddNode caps={caps} agents={list} onDone={() => setAdding(false)} /> : (
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
function Board({ agents, selectedId, avatars, onSelect, onHover }: { agents: AgentInfo[]; selectedId: string | null; avatars: boolean; onSelect: (id: string | null) => void; onHover: (h: { id: string; x: number; y: number } | null) => void }) {
  const hoverRef = useRef(onHover);
  hoverRef.current = onHover;
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<BoardScene | null>(null);
  const latest = useRef({ agents, selectedId, avatars });
  latest.current = { agents, selectedId, avatars };

  useEffect(() => {
    let dead = false;
    const s = new BoardScene(onSelect, h => hoverRef.current(h));
    void s.init(host.current!).then(() => {
      if (dead) { s.destroy(); return; }
      scene.current = s;
      s.setAvatars(latest.current.avatars);
      s.sync(latest.current.agents, latest.current.selectedId);
    });
    return () => { dead = true; scene.current?.destroy(); scene.current = null; };
  }, [onSelect]);

  useEffect(() => { scene.current?.sync(agents, selectedId); }, [agents, selectedId]);
  useEffect(() => { scene.current?.setAvatars(avatars); }, [avatars]);

  return <div className="board" ref={host} />;
}

function AddNode({ caps, agents, onDone }: { caps: Capability[]; agents: AgentInfo[]; onDone: () => void }) {
  const firstUsable = caps.find(c => c.available)?.backend ?? 'claude';
  const [name, setName] = useState('');
  const [character, setCharacter] = useState('');
  const [characters, setCharacters] = useState<string[]>([]);
  // 每次打開面板都重新讀取立繪資料夾,剛放進去的角色馬上選得到
  useEffect(() => { void window.nexus.getSnapshot().then(s => setCharacters(s.characters)); }, []);
  const [backend, setBackend] = useState<Backend>(firstUsable);
  const [cwd, setCwd] = useState('');
  const [mode, setMode] = useState<PermissionMode>('ask');
  const [model, setModel] = useState('');
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
  const cap = caps.find(c => c.backend === backend);
  // 同一個資料夾已有節點時提醒:它們會互相覆寫,變更檢視也分不出是誰改的
  const norm = (p: string) => p.trim().replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
  const sameDir = cwd.trim() ? agents.filter(a => !a.parentId && norm(a.cwd) === norm(cwd)) : [];
  const create = async () => {
    try {
      await window.nexus.createAgent({ isolate, name, character, model, backend, cwd, permissionMode: cap?.approvals === false ? 'ask' : mode });
      onDone();
    } catch (e) {
      setError(String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    }
  };
  return (
    <div className="addform">
      <div className="panel-title">新增節點</div>
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
          </label>
        )}
      {error && <div className="form-error">{error}</div>}
      <div className="addform-actions">
        <button onClick={onDone}>取消</button>
        <button className="primary" disabled={!name.trim() || !cwd.trim() || !cap?.available} onClick={() => void create()}>新增</button>
      </div>
    </div>
  );
}
