import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { BACKEND_LABEL, type AgentInfo, type ChangeSet, type ReviewComment, type RevertResult, type TaskInfo } from '../../shared/types';
import { lineLabel, patchRows, rowAnchor } from '../../shared/review';

const STATUS = { A: '新增', M: '修改', D: '刪除' } as const;
const BUSY = new Set(['planning', 'working', 'awaiting']);

/** 畫面上的一則評論;id 只用來編輯與刪除。 */
type Comment = ReviewComment & { id: number };
/** 編輯中的評論:id 為 null 表示新增。 */
type Draft = Omit<Comment, 'id'> & { id: number | null };

/** 變更檢視:左邊是這個任務改過的檔案,右邊是選取檔案的前後對照。點一下差異的某一行可以留評論。 */
export function Review({ task, agents, onClose }: { task: TaskInfo; agents: AgentInfo[]; onClose: () => void }) {
  const [data, setData] = useState<ChangeSet | null>(null);
  const [error, setError] = useState('');
  const [index, setIndex] = useState(0);
  const running = task.endedAt === null;
  const [message, setMessage] = useState(task.title.slice(0, 72));
  const [status, setStatus] = useState('');
  const [confirm, setConfirm] = useState('');
  const [working, setWorking] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [nextId, setNextId] = useState(1);
  const clean = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const describe = (r: RevertResult) => `已還原 ${r.reverted.length} 個檔案${r.skipped.length ? `;跳過 ${r.skipped.length} 個(${r.skipped[0].path}:${r.skipped[0].reason})` : ''}`;
  // 還原要按兩次才執行
  const revert = async (paths: string[] | null, key: string) => {
    if (confirm !== key) { setConfirm(key); return; }
    setConfirm('');
    setWorking(true);
    try { setStatus(describe(await window.nexus.revertTask(task.id, paths))); } catch (e) { setStatus(clean(e)); }
    setWorking(false);
  };
  const commit = async () => {
    setWorking(true);
    try { setStatus(`已提交:${await window.nexus.commitTask(task.id, message)}`); } catch (e) { setStatus(clean(e)); }
    setWorking(false);
  };

  const load = useCallback(() => {
    setError('');
    window.nexus.getTaskChanges(task.id).then(d => { setData(d); setIndex(i => Math.min(i, Math.max(0, d.files.length - 1))); })
      .catch(e => setError(String((e as Error).message ?? e)));
  }, [task.id]);
  // 任務結束時自動重新讀取一次,拿到最終結果
  useEffect(load, [load, task.endedAt, task.changes?.end, task.changes?.committed]);
  const canAct = !running && data?.source === 'git' && data.files.length > 0;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 在輸入框裡打字時不切換檔案,也不關閉畫面
      if ((e.target as HTMLElement | null)?.closest?.('textarea, input, select')) return;
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowDown' && data) setIndex(i => Math.min(i + 1, data.files.length - 1));
      if (e.key === 'ArrowUp') setIndex(i => Math.max(i - 1, 0));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, data]);

  const file = data?.files[index];
  const rows = useMemo(() => (file && !file.binary && file.patch ? patchRows(file.patch) : []), [file]);
  const added = data?.files.reduce((n, f) => n + f.added, 0) ?? 0;
  const removed = data?.files.reduce((n, f) => n + f.removed, 0) ?? 0;

  // 評論
  const saveDraft = () => {
    if (!draft || !draft.text.trim()) return;
    if (draft.id === null) { setComments(cs => [...cs, { ...draft, id: nextId }]); setNextId(n => n + 1); }
    else setComments(cs => cs.map(c => (c.id === draft.id ? { ...c, text: draft.text } : c)));
    setDraft(null);
  };
  const startAt = (row: number) => {
    const anchor = file && rowAnchor(rows[row]);
    if (!file || !anchor) return;
    setDraft({ id: null, path: file.path, row, side: anchor.side, line: anchor.line, text: '' });
  };
  const author = agents.find(a => a.id === task.agentId) ?? null;
  const sendBlock = !author ? '產生這個任務的節點已不存在,無法送回。'
    : author.terminal ? '節點在終端機模式,回到對話後才能送回。'
      : author.state === 'sleeping' ? '節點休眠中,喚醒後才能送回。'
        : running ? '任務還在執行,等它停下來再送回。' : '';
  const sendBack = async () => {
    // 依檔案與行的順序送出,整體意見放最前面
    const order = new Map(data?.files.map((f, i) => [f.path, i]) ?? []);
    const list = [...comments].sort((a, b) => (a.path === null ? -1 : order.get(a.path) ?? 0) - (b.path === null ? -1 : order.get(b.path) ?? 0) || (a.row ?? 0) - (b.row ?? 0));
    setWorking(true);
    try {
      await window.nexus.sendReviewComments(task.id, list.map(({ id: _id, ...c }) => c));
      setComments([]);
      setDraft(null);
      setStatus(`已把 ${list.length} 則評論送回 ${author?.name ?? ''} 修改。`);
    } catch (e) { setStatus(clean(e)); }
    setWorking(false);
  };
  // 可以審查的節點:排除自己、子代理、休眠、異常與終端機模式;忙碌的可選,但會標示
  const reviewers = agents.filter(a => a.id !== task.agentId && !a.parentId && !a.terminal && !['sleeping', 'error', 'lost'].includes(a.state));
  const requestReview = async (id: string) => {
    const who = agents.find(a => a.id === id);
    if (!who) return;
    setWorking(true);
    try { await window.nexus.requestReview(task.id, id); setStatus(`已把這個任務的變更送交 ${who.name} 審查。`); } catch (e) { setStatus(clean(e)); }
    setWorking(false);
  };
  const reviewBlock = running ? '任務還在執行,等它停下來再送審。' : !data?.files.length ? '這個任務沒有修改任何檔案。' : !reviewers.length ? '沒有其他可用的節點(休眠、異常、終端機模式與子代理不能審查)。' : '';

  const editor = (d: Draft) => (
    <div className="rv-cmt edit">
      <div className="rv-cmt-at">{d.path === null ? '整體意見' : `${d.path} · ${lineLabel(d)}`}</div>
      <textarea autoFocus value={d.text} placeholder="寫下要給 agent 的修改意見(Ctrl+Enter 儲存,Esc 取消)" aria-label="評論內容"
        onChange={e => setDraft({ ...d, text: e.target.value })}
        onKeyDown={e => {
          if (e.key === 'Escape') { e.preventDefault(); setDraft(null); }
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveDraft(); }
        }} />
      <div className="rv-cmt-btns">
        <button className="primary" disabled={!d.text.trim()} onClick={saveDraft}>{d.id === null ? '新增評論' : '儲存'}</button>
        <button className="ghost" onClick={() => setDraft(null)}>取消</button>
      </div>
    </div>
  );
  const shown = (c: Comment) => (draft?.id === c.id ? <Fragment key={c.id}>{editor(draft)}</Fragment> : (
    <div key={c.id} className="rv-cmt">
      <div className="rv-cmt-at">{c.path === null ? '整體意見' : lineLabel(c)}</div>
      <div className="rv-cmt-text">{c.text}</div>
      <div className="rv-cmt-btns">
        <button className="ghost" onClick={() => setDraft({ ...c })}>編輯</button>
        <button className="ghost" onClick={() => setComments(cs => cs.filter(x => x.id !== c.id))}>刪除</button>
      </div>
    </div>
  ));
  const general = comments.filter(c => c.path === null);

  return (
    <section className="review" role="dialog" aria-label="變更檢視">
      <header className="rv-head">
        <b>變更檢視</b>
        <span className="rv-task" title={task.title}>{task.agentName} · {task.title}</span>
        <span className="spacer" />
        {data && <span className="rv-sum">{data.files.length} 個檔案 <i className="plus">+{added}</i> <i className="minus">−{removed}</i></span>}
        {running && <button onClick={load} title="任務還在執行,重新讀取目前的變更">重新整理</button>}
        <button className="ghost" onClick={onClose} aria-label="關閉">✕</button>
      </header>
      {canAct && (
        <div className="rv-actions need-full">
          <input value={message} onChange={e => setMessage(e.target.value)} placeholder="提交訊息" aria-label="提交訊息" />
          <button className="primary" disabled={working || !message.trim()} onClick={() => void commit()} title="把這個任務改過的檔案提交成一筆 commit">{task.changes?.committed ? `再提交一次(上次 ${task.changes.committed})` : '提交這些變更'}</button>
          <span className="spacer" />
          <button className="danger" disabled={working} onClick={() => void revert(null, 'all')} title="把這個任務改過的檔案恢復成任務開始前的內容;之後又被改過的檔案會跳過">{confirm === 'all' ? '確定還原整個任務?' : '還原整個任務'}</button>
        </div>
      )}
      {status && <div className="rv-note ok">{status}</div>}
      {data?.note && <div className="rv-note">{data.note}</div>}
      {running && <div className="rv-note">任務還在執行,這是到目前為止的變更。</div>}
      {error && <div className="rv-note err">讀取失敗:{error}</div>}
      <div className="rv-body">
        <nav className="rv-files">
          {data?.files.map((f, i) => {
            const count = comments.filter(c => c.path === f.path).length;
            return (
              <button key={`${f.path}-${i}`} className={`rv-file ${i === index ? 'on' : ''} st-${f.status}`} onClick={() => setIndex(i)} title={f.path}>
                <em>{STATUS[f.status]}</em>
                <span>{f.path}</span>
                <small>{f.binary ? '二進位' : <><i className="plus">+{f.added}</i> <i className="minus">−{f.removed}</i></>}{count > 0 && <b className="rv-cnt" title={`${count} 則評論`}>{count}</b>}</small>
              </button>
            );
          })}
          {data && data.files.length === 0 && <div className="empty">{running ? '目前還沒有檔案被修改。' : '這個任務沒有修改任何檔案。'}</div>}
          {!data && !error && <div className="empty">讀取中…</div>}
          {data?.truncated && <div className="empty">檔案太多,只顯示前 300 個。</div>}
        </nav>
        <div className="rv-diff">
          {file && <div className="rv-path"><span>{file.path}</span>{canAct && <button className="ghost need-full" disabled={working} onClick={() => void revert([file.path], file.path)}>{confirm === file.path ? '確定還原這個檔案?' : '還原這個檔案'}</button>}</div>}
          {file && (file.binary
            ? <div className="empty">二進位檔案,無法顯示內容。</div>
            : file.patch
              ? <pre>{rows.map((r, i) => {
                const anchor = rowAnchor(r);
                const kind = r.kind === 'ctx' ? '' : r.kind;
                return (
                  <Fragment key={i}>
                    <span className={`ln ${kind}${anchor ? ' can' : ''}`} onClick={anchor ? () => startAt(i) : undefined} title={anchor ? `點一下對${lineLabel(anchor)}新增評論` : undefined}>
                      <i className="ln-no">{r.old ?? ''}</i><i className="ln-no">{r.new ?? ''}</i>{r.text || ' '}{'\n'}
                    </span>
                    {comments.filter(c => c.path === file.path && c.row === i).map(shown)}
                    {draft && draft.id === null && draft.path === file.path && draft.row === i && editor(draft)}
                  </Fragment>
                );
              })}</pre>
              : <div className="empty">{file.status === 'D' ? '檔案已刪除。' : '沒有可顯示的文字差異(可能是空檔案或只改了權限)。'}</div>)}
        </div>
      </div>
      {(general.length > 0 || draft?.path === null) && (
        <div className="rv-general">
          {general.map(shown)}
          {draft && draft.id === null && draft.path === null && editor(draft)}
        </div>
      )}
      <footer className="rv-foot need-full">
        <button onClick={() => setDraft({ id: null, path: null, row: null, side: null, line: null, text: '' })} title="新增一則不綁定特定行的意見">新增整體意見</button>
        <span className="rv-count">{comments.length ? `${comments.length} 則評論` : '點一下差異的某一行可以留評論'}</span>
        <span className="spacer" />
        {sendBlock && (comments.length > 0 || !author) && <span className="rv-why">{sendBlock}</span>}
        <button className="primary" disabled={working || !comments.length || !!sendBlock} onClick={() => void sendBack()} title={sendBlock || '把所有評論整理成一則指令,送給產生這個任務的節點修改'}>送回此節點修改</button>
        <select className="rv-reviewer" value="" disabled={working || !!reviewBlock} title={reviewBlock || '選一個節點,把這個任務的變更送給它審查(只回覆意見,不修改檔案)'} aria-label="送交其他節點審查"
          onChange={e => { if (e.target.value) void requestReview(e.target.value); }}>
          <option value="">{reviewBlock ? '送交其他節點審查(無法使用)' : '送交其他節點審查…'}</option>
          {reviewers.map(a => (
            <option key={a.id} value={a.id}>{a.name} · {BACKEND_LABEL[a.backend]}{a.model ? ` · ${a.model}` : ''}{BUSY.has(a.state) ? '(忙碌中)' : ''}{a.simulated ? '(模擬)' : ''}</option>
          ))}
        </select>
      </footer>
    </section>
  );
}
