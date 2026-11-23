import { useState } from 'react';
import type { AgentInfo, MoveTarget } from '../../shared/types';

const clean = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/**
 * 轉移工作區(docs/工作區轉移規劃.md):換到既有的資料夾,或在某個 git 版本庫開一個新的獨立工作區。
 * 節點用同一個 session 在新資料夾續接;只有桌面完整權限、節點停下來時能用。Antigravity 暫不支援。
 */
export function MovePanel({ agent: a, busy, onDone }: { agent: AgentInfo; busy: boolean; onDone: (note: string) => void }) {
  const [kind, setKind] = useState<MoveTarget['kind']>('folder');
  const [path, setPath] = useState('');
  const [sure, setSure] = useState(false);
  const [working, setWorking] = useState(false);
  const [err, setErr] = useState('');
  if (a.backend === 'antigravity') {
    return <div className="dlg-settings dlg-move need-full"><span className="muted">轉移工作區:Antigravity 換資料夾續接後仍以原本的資料夾為主要工作目錄,暫時不支援。</span></div>;
  }
  const pick = async () => { const p = await window.nexus.pickDirectory(); if (p) { setPath(p); setSure(false); } };
  const go = async () => {
    if (!sure) { setSure(true); return; }
    setWorking(true);
    setErr('');
    try {
      const r = await window.nexus.moveWorkspace(a.id, kind === 'folder' ? { kind, path } : { kind, repo: path });
      setPath(''); setSure(false);
      onDone(r.note);
    } catch (e) { setErr(clean(e)); setSure(false); }
    setWorking(false);
  };
  return (
    <div className="dlg-settings dlg-move need-full">
      <label>轉移工作區
        <select value={kind} onChange={e => { setKind(e.target.value as MoveTarget['kind']); setSure(false); }}>
          <option value="folder">換到既有的資料夾</option>
          <option value="worktree">在 git 版本庫開新的獨立工作區</option>
        </select>
      </label>
      <label>{kind === 'folder' ? '目的資料夾' : '版本庫資料夾'}
        <input value={path} onChange={e => { setPath(e.target.value); setSure(false); }} placeholder="資料夾路徑" />
      </label>
      <button onClick={() => void pick()}>瀏覽…</button>
      <span className="muted">
        目前:{a.cwd}{a.worktree ? `(獨立工作區,分支 ${a.worktree.branch})` : ''}。會停下 session,用同一個 session 在新資料夾續接,對話內容保留。
        {a.worktree ? '原本的獨立工作區乾淨且已合併才會移除,否則保留。' : ''}
      </span>
      {sure && <span className="note warn">確定要把「{a.name}」轉移到這裡嗎?再按一次「轉移」執行。</span>}
      {err && <span className="note err">{err}</span>}
      <span className="spacer" />
      <button className="primary" disabled={busy || working || !path.trim()} title={busy ? '節點正在執行,等它停下來再轉移' : ''} onClick={() => void go()}>{working ? '轉移中…' : sure ? '確定轉移' : '轉移'}</button>
    </div>
  );
}
