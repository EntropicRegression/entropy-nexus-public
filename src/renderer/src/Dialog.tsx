import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { ATTACHMENT_LABEL, attachmentKind, BACKEND_LABEL, STATE_LABEL, type AgentInfo, type ApprovalDecision, type Capability, type NexusEvent, type WorktreeStatus } from '../../shared/types';
import { Markdown, MdImage } from './Markdown';
import { PersonaEditor } from './PersonaEditor';
import { Portrait } from './Portrait';
import { TerminalView } from './Terminal';
import { QuestionPanel } from './Question';
import { ForkPanel } from './Fork';
import { MicButton } from './Voice';

type Item =
  | { kind: 'user'; seq: number; text: string }
  | { kind: 'agent'; seq: number; text: string }
  | { kind: 'image'; seq: number; path: string; caption: string }
  | { kind: 'tool'; seq: number; name: string; summary: string; input: string; output: string; status: 'running' | 'done' | 'failed' }
  | { kind: 'approval'; seq: number; requestId: string; tool: string; summary: string; decision: ApprovalDecision | null }
  | { kind: 'error'; seq: number; text: string }
  | { kind: 'sub'; seq: number; text: string };

const DECISION: Record<ApprovalDecision, string> = { allow: '已允許', allow_session: '已允許(本次 session)', deny: '已拒絕' };

/** 把事件紀錄整理成對話視窗要顯示的項目。 */
function toItems(events: NexusEvent[]): Item[] {
  const items: Item[] = [];
  for (const e of events) {
    if (e.type === 'message') items.push({ kind: e.role, seq: e.seq, text: e.text });
    else if (e.type === 'image') items.push({ kind: 'image', seq: e.seq, path: e.path, caption: e.caption ?? '' });
    else if (e.type === 'error') items.push({ kind: 'error', seq: e.seq, text: e.message });
    else if (e.type === 'subagent') items.push({ kind: 'sub', seq: e.seq, text: e.phase === 'start' ? `啟動子代理:${e.name}(已加入面板)` : `子代理結束:${e.name}${e.failed ? '(失敗)' : ''}` });
    else if (e.type === 'note') items.push({ kind: 'sub', seq: e.seq, text: e.text });
    else if (e.type === 'question') items.push({ kind: 'sub', seq: e.seq, text: `提問:${e.questions.map(q => q.question).join(' / ')}` });
    else if (e.type === 'question_resolved') items.push({ kind: 'sub', seq: e.seq, text: e.answers ? `你的回答:${Object.values(e.answers).flat().join('、')}` : '你略過了這個提問' });
    else if (e.type === 'approval_request') items.push({ kind: 'approval', seq: e.seq, requestId: e.requestId, tool: e.tool, summary: e.summary, decision: null });
    else if (e.type === 'approval_resolved') {
      const it = items.findLast(i => i.kind === 'approval' && i.requestId === e.requestId);
      if (it?.kind === 'approval') it.decision = e.decision;
    } else if (e.type === 'tool') {
      if (e.phase === 'start') items.push({ kind: 'tool', seq: e.seq, name: e.name, summary: e.summary, input: e.detail ?? '', output: '', status: 'running' });
      else {
        const it = items.findLast(i => i.kind === 'tool' && i.status === 'running' && i.name === e.name && i.summary === e.summary);
        if (it?.kind === 'tool') { it.status = e.failed ? 'failed' : 'done'; it.output = e.detail ?? ''; }
      }
    }
  }
  return items;
}

/** 逐字打出最新的回覆。 */
function Typed({ text }: { text: string }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    setN(0);
    const step = Math.max(2, Math.ceil(text.length / 120));
    const t = setInterval(() => setN(v => { if (v >= text.length) { clearInterval(t); return v; } return v + step; }), 16);
    return () => clearInterval(t);
  }, [text]);
  return <>{text.slice(0, n)}{n < text.length && <span className="caret" />}</>;
}

/** 對話視窗:左側立繪,右側對話紀錄、工具活動、授權選項與輸入欄。 */
export function Dialog({ agent: a, cap, parentName, reviewTaskId, onReview, onClose, onOpen, isChief = false }: { agent: AgentInfo; cap?: Capability; parentName: string; reviewTaskId: string | null; onReview: (taskId: string) => void; onClose: () => void; onOpen?: (agentId: string) => void; isChief?: boolean }) {
  const isSub = a.parentId !== null;
  const [events, setEvents] = useState<NexusEvent[]>([]);
  const [liveFrom, setLiveFrom] = useState(Number.MAX_SAFE_INTEGER);
  const [raw, setRaw] = useState(false);
  const [text, setText] = useState('');
  // 生成中的回覆片段;整段回覆到齊後清掉
  const [live, setLive] = useState('');
  const streamed = useRef(false);
  // 對話視窗向上展開到佔滿面板(設定會記住);輸入框展開成多行編輯(送出後收回)
  const [full, setFull] = useState(() => localStorage.getItem('nexus.dlgFull') === '1');
  const [tall, setTall] = useState(false);
  const toggleFull = () => setFull(v => { localStorage.setItem('nexus.dlgFull', v ? '0' : '1'); return !v; });
  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const k = e.key.toLowerCase();
      if (k === 'f') { e.preventDefault(); toggleFull(); }
      else if (k === 'e') { e.preventDefault(); setTall(v => !v); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    let alive = true;
    setEvents([]);
    setLiveFrom(Number.MAX_SAFE_INTEGER);
    const buffered: NexusEvent[] = [];
    let loaded = false;
    setLive('');
    const off = window.nexus.onUpdate(u => {
      if (u.delta && u.delta.agentId === a.id) { const piece = u.delta.text; streamed.current = true; setLive(v => v + piece); }
      const e = u.event;
      if (!e || e.agentId !== a.id) return;
      if ((e.type === 'message' && e.role === 'agent') || (e.type === 'state' && (e.state === 'idle' || e.state === 'error' || e.state === 'lost'))) setLive('');
      if (!loaded) buffered.push(e);
      else setEvents(prev => (prev.length && prev[prev.length - 1].seq >= e.seq ? prev : [...prev, e]));
    });
    void window.nexus.getHistory(a.id).then(h => {
      if (!alive) return;
      const last = h.length ? h[h.length - 1].seq : 0;
      setLiveFrom(last);
      setEvents([...h, ...buffered.filter(e => e.seq > last)]);
      loaded = true;
    });
    return () => { alive = false; off(); };
  }, [a.id]);

  const items = useMemo(() => toItems(events), [events]);
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items, raw, live]);
  // 圖片載入後高度才確定;原本停在底部的話跟著捲到底
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onLoad = () => { if (stick.current) el.scrollTop = el.scrollHeight; };
    el.addEventListener('load', onLoad, true);
    return () => el.removeEventListener('load', onLoad, true);
  }, [a.terminal]);

  const busy = a.state === 'planning' || a.state === 'working' || a.state === 'awaiting';
  const offline = a.state === 'sleeping' || a.state === 'lost';
  // 附加的檔案:路徑一律寫進指令,後台能內嵌的類型(cap.attachments)另外直接交給模型看
  const [files, setFiles] = useState<string[]>([]);
  // 送出前的縮圖:經主行程讀取,只限這次選取、貼上或拖放的圖片
  const [previews, setPreviews] = useState<Record<string, string | null>>({});
  const addFiles = (paths: string[]) => setFiles(cur => [...cur, ...paths.filter(p => p && !cur.includes(p))]);
  useEffect(() => {
    for (const f of files) {
      if (f in previews || attachmentKind(f) !== 'image') continue;
      setPreviews(v => ({ ...v, [f]: null }));
      void window.nexus.attachmentPreview(f).then(url => setPreviews(v => ({ ...v, [f]: url })));
    }
  }, [files]);
  const embeds = (f: string) => (cap?.attachments ?? []).includes(attachmentKind(f));
  const canSend = !busy && !offline && (text.trim().length > 0 || files.length > 0);
  const send = () => {
    if (!canSend) return;
    const list = files.length ? `\n\n附加的檔案:\n${files.map(f => `- ${f}`).join('\n')}` : '';
    void window.nexus.send(a.id, (text.trim() || '請看附加的檔案。') + list, files);
    setText('');
    setTall(false);
    setFiles([]);
    stick.current = true;
  };
  // 排隊:忙碌時先把下一句排進佇列,節點待命後依序自動送出(附件的處理和送出相同)
  const canQueue = !isSub && (text.trim().length > 0 || files.length > 0);
  const queue = () => {
    if (!canQueue) return;
    const list = files.length ? `\n\n附加的檔案:\n${files.map(f => `- ${f}`).join('\n')}` : '';
    window.nexus.enqueue(a.id, (text.trim() || '請看附加的檔案。') + list, files).then(() => { setText(''); setTall(false); setFiles([]); }, e => setNote(clean(e)));
  };
  const [qEdit, setQEdit] = useState<{ id: string; text: string } | null>(null);
  const saveQueued = () => {
    if (!qEdit || !qEdit.text.trim()) return;
    window.nexus.editQueued(a.id, qEdit.id, qEdit.text).then(() => setQEdit(null), e => { setNote(clean(e)); setQEdit(null); });
  };
  // 瀏覽器版:檔案在使用者那台電腦上,先上傳到主控台再附加
  const uploadAll = (list: File[]) => {
    for (const f of list) void window.nexus.uploadFile!(f).then(path => { setNote(''); addFiles([path]); }, err => setNote(String((err as Error).message ?? err)));
  };
  // 貼上:有路徑的檔案直接附加;剪貼簿裡的截圖之類沒有路徑的圖片,由主行程存成暫存檔再附加
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const list = [...e.clipboardData.files];
    if (!list.length) return;
    e.preventDefault();
    if (window.nexus.uploadFile) { uploadAll(list); return; }
    for (const f of list) {
      const p = window.nexus.pathForFile(f);
      if (p) { addFiles([p]); continue; }
      if (!f.type.startsWith('image/')) { setNote(`貼上的「${f.name || '檔案'}」沒有路徑,無法附加;請改用「附加」或拖放。`); continue; }
      void f.arrayBuffer().then(buf => window.nexus.savePastedImage(f.type, buf)).then(path => { setNote(''); addFiles([path]); }, err => setNote(clean(err)));
    }
  };
  // 節點設定:名稱、角色、模型
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: a.name, character: a.character, model: a.model });
  const [characters, setCharacters] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const clean = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const openSettings = () => {
    setForm({ name: a.name, character: a.character, model: a.model });
    setNote('');
    setEditing(v => !v);
    void window.nexus.getSnapshot().then(s => setCharacters(s.characters));
  };
  const save = async () => {
    try { await window.nexus.updateAgent(a.id, form); setEditing(false); setNote(''); } catch (e) { setNote(clean(e)); }
  };
  const toggleTerminal = async () => {
    setNote('');
    try { if (a.terminal) await window.nexus.closeTerminal(a.id); else await window.nexus.openTerminal(a.id, 100, 28); } catch (e) { setNote(clean(e)); }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // 中文輸入法選字時的 Enter 不送出;Alt+Enter 排進佇列
    if (e.key === 'Enter' && e.altKey && !e.nativeEvent.isComposing) { e.preventDefault(); queue(); return; }
    // 輸入框展開時是多行編輯:Enter 換行,Ctrl+Enter 才送出
    if (tall) { if (e.key === 'Enter' && e.ctrlKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
  };
  // 獨立工作區的狀態:節點停下來時重新查一次
  const [wt, setWt] = useState<WorktreeStatus | null>(null);
  const [wtMsg, setWtMsg] = useState('');
  const [wtBusy, setWtBusy] = useState(false);
  useEffect(() => {
    if (!a.worktree) { setWt(null); return; }
    let alive = true;
    void window.nexus.worktreeStatus(a.id).then(s => { if (alive) setWt(s); });
    return () => { alive = false; };
  }, [a.id, a.worktree, a.state, wtMsg]);
  const wtAction = async (fn: () => Promise<string>, done: (r: string) => string) => {
    setWtBusy(true);
    setWtMsg('');
    try { setWtMsg(done(await fn())); } catch (e) { setWtMsg(String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
    setWtBusy(false);
  };
  // 分支對話:需要後台支援,而且節點已經有 session
  const [forking, setForking] = useState(false);
  // 終止最上層節點:先確認要不要請它寫工作總結再歸檔進記憶庫(ask = 等使用者選,busy = 正在寫總結)
  const [rm, setRm] = useState<null | 'ask' | 'busy'>(null);
  const [rmNote, setRmNote] = useState('');
  const removeWith = async (mode: 'summary' | 'stats') => {
    setRm('busy');
    setRmNote(mode === 'summary' ? '正在請它寫工作總結,最多等 3 分鐘…' : '正在歸檔統計…');
    try { await window.nexus.removeAgentArchived(a.id, mode); }
    catch (e) { setRmNote(`終止失敗:${String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`); setRm('ask'); }
  };
  const forkWhy = !cap?.fork ? `${BACKEND_LABEL[a.backend]} 不支援分支對話。` : !a.sessionId ? '這個節點還沒有 session(先對話一次),沒有可以分支的內容。' : '';
  const lastAgentSeq = items.findLast(i => i.kind === 'agent')?.seq ?? -1;
  const p = a.pendingApproval;

  return (
    <section className={`dialog s-${a.state} ${full ? 'full' : ''}`}
      onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
      onDrop={e => { if (!e.dataTransfer.files.length) return; e.preventDefault(); const dropped = [...e.dataTransfer.files]; if (window.nexus.uploadFile) uploadAll(dropped); else addFiles(dropped.map(f => window.nexus.pathForFile(f))); }}>
      <div className="dlg-portrait">
        <Portrait backend={a.backend} state={a.state} character={a.character} />
      </div>
      <div className="dlg-main">
        <header className="dlg-id">
          <b>{a.name}</b>
          {isChief && <span className="tag-chief" title="總管節點:你交代的事由它判斷交給哪個節點(對它用語音說話就等於全域語音)">總管</span>}
          <span className="muted">{isSub ? `子代理 · 由 ${parentName || '上層節點'} 呼叫` : `${BACKEND_LABEL[a.backend]}${a.simulated ? ' · 模擬' : ''}`}</span>
          {!isSub && a.model && <span className="tag-model" title="這個節點指定的模型">{a.model}</span>}
          <span className="muted path" title={a.cwd}>{a.cwd}</span>
          {a.permissionMode === 'auto' && <span className="tag-auto" title="檔案修改與一般指令不會詢問,有風險的動作才會擋下或詢問">自動執行</span>}
          {cap && !cap.approvals && <span className="tag-auto" title={cap.note}>不詢問權限</span>}
          <span className="spacer" />
          <span className="state">{STATE_LABEL[a.state]}</span>
          {reviewTaskId && <button className="ghost" onClick={() => onReview(reviewTaskId)} title="檢視最近一個任務改了哪些檔案">變更</button>}
          {!isSub && <button className={`ghost need-full ${editing ? 'on' : ''}`} onClick={openSettings} title="修改名稱、角色或模型">設定</button>}
          {!isSub && <span className="need-full" title={forkWhy || '從目前的對話分支出新節點,之後兩邊各自發展'}><button className={`ghost ${forking ? 'on' : ''}`} disabled={forkWhy !== ''} onClick={() => setForking(v => !v)}>分支對話</button></span>}
          {!isSub && !a.simulated && <button className={`ghost need-full ${a.terminal ? 'on' : ''}`} disabled={busy} onClick={() => void toggleTerminal()} title="切換到原生 CLI 的終端機畫面,或回到對話模式">{a.terminal ? '回到對話' : '終端機'}</button>}
          {isChief && <button className="ghost need-full" onClick={() => void window.nexus.setChief(null)} title="不再把這個節點當總管;它會收到通知,不再套用總管守則">解除總管</button>}
          <button className={`ghost ${raw ? 'on' : ''}`} onClick={() => setRaw(v => !v)} title="切換原始輸出">原始輸出</button>
          {isSub ? null : offline
            ? (a.terminal ? null : <button className="primary need-op" onClick={() => void window.nexus.wake(a.id)}>{a.state === 'lost' ? '重新連線' : '喚醒'}</button>)
            : <button className="need-op" onClick={() => void window.nexus.sleep(a.id)} disabled={busy} title="結束行程並保留 session">休眠</button>}
          {isSub
            ? <button className="need-full" onClick={() => void window.nexus.removeAgent(a.id)} title="只從面板移除,不會停止子代理">從面板移除</button>
            : <button className="danger need-full" onClick={() => setRm(r => r ?? 'ask')} disabled={rm === 'busy'}>終止</button>}
          <button className={`ghost dlg-full ${full ? 'on' : ''}`} onClick={toggleFull} title={full ? '還原成下半部(Alt+F)' : '向上展開到佔滿面板(Alt+F)'} aria-label={full ? '還原對話視窗' : '展開對話視窗'}>{full ? '▼ 還原' : '▲ 展開'}</button>
          <button className="ghost" onClick={onClose} aria-label="關閉">✕</button>
        </header>

        {rm && !isSub && (
          <div className="dlg-settings dlg-remove need-full">
            <span className="muted">終止「{a.name}」前,要先請它寫一份工作總結,和任務統計一起封存進記憶庫嗎?之後建立同名節點時可以接回。</span>
            <span className="spacer" />
            {rmNote && <span className="muted">{rmNote}</span>}
            <button className="primary" disabled={rm === 'busy'} onClick={() => void removeWith('summary')}>先請它寫工作總結再刪除</button>
            <button className="danger" disabled={rm === 'busy'} onClick={() => void removeWith('stats')}>直接刪除(只存統計)</button>
            <button className="ghost" disabled={rm === 'busy'} onClick={() => { setRm(null); setRmNote(''); }}>取消</button>
          </div>
        )}

        {editing && (
          <div className="dlg-settings">
            <label>名稱<input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></label>
            <label>角色
              <select value={form.character} onChange={e => setForm(f => ({ ...f, character: e.target.value }))}>
                <option value="">預設([REDACTED])</option>
                {characters.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label>模型
              <input list="dlg-models" value={form.model} onChange={e => setForm(f => ({ ...f, model: e.target.value }))} placeholder="預設" />
              <datalist id="dlg-models">{(cap?.models ?? []).map(m => <option key={m} value={m} />)}</datalist>
            </label>
            <span className="muted">換模型會重新啟動 session,對話內容保留。工作目錄不能更換,請另外新增節點。</span>
            <span className="spacer" />
            <button onClick={() => setEditing(false)}>取消</button>
            <button className="primary" disabled={!form.name.trim()} onClick={() => void save()}>儲存</button>
          </div>
        )}
        {forking && !forkWhy && (
          <ForkPanel source={{ kind: 'agent', agentId: a.id }} cwd={a.cwd} defaultName={`${a.name}-分支`} model={a.model} models={cap?.models ?? []}
            warn={busy ? '節點正在執行:分支點是目前已寫入紀錄的對話,進行中的這一回合可能不完整或沒有包含在內。' : undefined}
            onCancel={() => setForking(false)} onDone={n => { setForking(false); onOpen?.(n.id); }} />
        )}
        {editing && form.character && <PersonaEditor character={form.character} />}
        {note && <div className="line err">{note}</div>}

        {a.worktree && (
          <div className="dlg-worktree">
            <span className="tag-model">獨立工作區</span>
            <span>分支 <b>{a.worktree.branch}</b>(基於 {a.worktree.base})</span>
            {wt && <span className="muted">{wt.exists ? `${wt.ahead} 筆提交${wt.dirty ? ' · 有未提交的修改' : ''}` : '工作區資料夾已不存在'}</span>}
            <span className="spacer" />
            {wtMsg && <span className="wt-msg" title={wtMsg}>{wtMsg}</span>}
            <button className="need-full" disabled={wtBusy || busy || !wt?.exists || (!wt.dirty && wt.ahead === 0)} title="先提交工作區裡的修改,再合併回原本的分支;有衝突會自動取消"
              onClick={() => void wtAction(() => window.nexus.mergeWorktree(a.id), sha => `已合併回 ${a.worktree!.base}(${sha})`)}>合併回 {a.worktree.base}</button>
            <button className="need-full" disabled={wtBusy || busy || !wt?.exists || (!wt.dirty && wt.ahead === 0)} title="推送這個分支並用 GitHub CLI 開 PR"
              onClick={() => void wtAction(() => window.nexus.openPullRequest(a.id), url => `PR 已建立:${url}`)}>開 PR</button>
          </div>
        )}

        {a.terminal ? <TerminalView agentId={a.id} /> : <>
        <div className="dlg-stream" ref={scroller} onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
          {raw
            ? <pre className="raw">{events.slice(-300).map(e => JSON.stringify(e)).join('\n')}</pre>
            : items.length === 0 && !live
              ? <div className="muted hint">{isSub ? '子代理還沒有回報任何活動。' : offline ? '節點目前沒有在執行。' : '在下方輸入指令開始。'}</div>
              : <>{items.map(it => {
                if (it.kind === 'user') return <div key={it.seq} className="msg user"><span className="who">你</span><p>{it.text}</p></div>;
                if (it.kind === 'agent') return <div key={it.seq} className="msg agent"><span className="who">{a.name}</span><Markdown text={it.text} agentId={a.id} /></div>;
                if (it.kind === 'image') return <div key={it.seq} className="msg agent image"><span className="who">{a.name}</span><div className="md"><MdImage src={it.path} agentId={a.id} />{it.caption && <div className="md-caption">{it.caption}</div>}</div></div>;
                if (it.kind === 'sub') return <div key={it.seq} className="line sub">{it.text}</div>;
                if (it.kind === 'error') return <div key={it.seq} className="line err">錯誤:{it.text}</div>;
                if (it.kind === 'approval') return <div key={it.seq} className="line appr">請求授權:{it.tool} · {it.summary}{it.decision ? ` → ${DECISION[it.decision]}` : ''}</div>;
                return (
                  <details key={it.seq} className={`tool ${it.status}`}>
                    <summary><i />{it.name}<span>{it.summary}</span><em>{it.status === 'running' ? '執行中' : it.status === 'failed' ? '失敗' : '完成'}</em></summary>
                    {it.input && <pre>{it.input}</pre>}
                    {it.output && <pre className="out">{it.output}</pre>}
                  </details>
                );
              })}{live && <div className="msg agent live"><span className="who">{a.name}</span><Markdown text={live} tail={<span className="caret" />} agentId={a.id} /></div>}</>}
        </div>

        {a.pendingQuestion && <QuestionPanel key={a.pendingQuestion.requestId} agentId={a.id} pending={a.pendingQuestion} />}

        {p && (
          <div className="dlg-approval">
            <div className="appr-text">
              <b>需要你的授權</b>
              <span>{p.tool} · {p.summary}</span>
              {p.detail && <details><summary>檢視完整內容</summary><pre>{p.detail}</pre></details>}
            </div>
            <button className="primary warn need-op" onClick={() => void window.nexus.respondApproval(a.id, p.requestId, 'allow')}>允許</button>
            {p.canAllowSession && <button className="need-op" onClick={() => void window.nexus.respondApproval(a.id, p.requestId, 'allow_session')}>本次 session 都允許</button>}
            <button className="need-op" onClick={() => void window.nexus.respondApproval(a.id, p.requestId, 'deny')}>拒絕</button>
          </div>
        )}

        {isSub ? <div className="dlg-readonly">子代理由上層節點指揮,這裡只能觀看它的進度。要下指令請到 {parentName || '上層節點'}。</div> : (
        <div className="dlg-inputwrap">
        {a.queued.length > 0 && (
          <div className="dlg-queue">
            {a.queuePaused && (
              <div className="queue-paused">
                <span>佇列已暫停:{a.queuePaused}。手動送出下一句或按「繼續」後恢復。</span>
                <button className="primary" onClick={() => void window.nexus.resumeQueue(a.id)}>繼續</button>
              </div>
            )}
            {a.queued.map((q, i) => (
              <div key={q.id} className="queue-item">
                <span className="queue-no">排隊 {i + 1}</span>
                {qEdit?.id === q.id
                  ? <>
                    <input autoFocus value={qEdit.text} onChange={e => setQEdit({ id: q.id, text: e.target.value })}
                      onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); saveQueued(); } else if (e.key === 'Escape') { e.stopPropagation(); setQEdit(null); } }} />
                    <button className="ghost" disabled={!qEdit.text.trim()} onClick={saveQueued}>儲存</button>
                    <button className="ghost" onClick={() => setQEdit(null)}>取消編輯</button>
                  </>
                  : <>
                    <span className="queue-text" title={q.text}>{q.text}</span>
                    <button className="ghost" onClick={() => setQEdit({ id: q.id, text: q.text })}>編輯</button>
                    <button className="ghost" onClick={() => void window.nexus.cancelQueued(a.id, q.id)}>取消</button>
                  </>}
              </div>
            ))}
          </div>
        )}
        {files.length > 0 && (
          <div className="dlg-files">
            {files.map(f => {
              const name = f.split(/[\\/]/).pop() ?? f;
              const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1].toUpperCase() ?? '?';
              return (
                <span key={f} className="file-chip" title={`${ATTACHMENT_LABEL[attachmentKind(f)]} · ${f}`}>
                  {previews[f] ? <img className="file-thumb" src={previews[f]!} alt="" /> : <i className="file-ext">{ext}</i>}
                  <span className="file-name">{name}</span>
                  <em className={embeds(f) ? 'embed' : 'pathonly'} title={embeds(f) ? '會直接交給模型看' : '這個後台不能內嵌這種檔案,只會把路徑寫進指令'}>{embeds(f) ? '內嵌' : '僅路徑'}</em>
                  <button className="ghost" onClick={() => setFiles(cur => cur.filter(x => x !== f))} aria-label="移除">✕</button>
                </span>
              );
            })}
          </div>
        )}
        <div className={`dlg-input ${tall ? 'tall' : ''}`}>
          <button className="ghost attach" disabled={offline} onClick={() => void window.nexus.pickFiles().then(addFiles)} title="附加檔案或圖片(也可以把檔案拖進來,或在輸入框貼上截圖)">附加</button>
          <MicButton disabled={offline} onText={t => setText(cur => (cur.trim() ? `${cur.trimEnd()} ${t}` : t))} onNote={setNote} />
          <textarea
            rows={1}
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={onKey}
            onPaste={onPaste}
            disabled={offline}
            placeholder={offline ? '節點沒有在執行,請先喚醒' : busy ? '執行中,可輸入下一句按「排隊」(Alt+Enter),或按右側中斷' : tall ? '多行編輯:Enter 換行,Ctrl+Enter 送出' : '輸入指令,Enter 送出,Shift+Enter 換行'}
            autoFocus
          />
          <button className={`ghost dlg-tall ${tall ? 'on' : ''}`} onClick={() => setTall(v => !v)} title={tall ? '收回成單行(Alt+E)' : '展開輸入框,方便寫多行的指令(Alt+E)'} aria-label={tall ? '收回輸入框' : '展開輸入框'}>{tall ? '收回' : '展開'}</button>
          {busy && <button className="primary" disabled={!canQueue} onClick={queue} title="排進佇列,這個回合完成後自動送出(Alt+Enter)">排隊</button>}
          {busy
            ? <button className="danger" onClick={() => void window.nexus.interrupt(a.id)}>中斷</button>
            : <button className="primary" disabled={!canSend} onClick={send}>送出</button>}
        </div>
        </div>
        )}
        </>}
      </div>
    </section>
  );
}
