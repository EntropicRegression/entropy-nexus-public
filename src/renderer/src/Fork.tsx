import { useEffect, useState } from 'react';
import type { AgentInfo, DirInfo, ForkAgentInput } from '../../shared/types';

const clean = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const norm = (p: string) => p.trim().replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();

/**
 * 分支對話的小面板:填新節點的名稱、模型,選擇是否使用獨立工作區。
 * 對話視窗與「開啟舊 session」共用;新節點有自己的 session,來源不受影響。
 */
export function ForkPanel({ source, cwd, defaultName, model, models, warn, onDone, onCancel }: {
  source: ForkAgentInput['source'];
  cwd: string;
  defaultName: string;
  model: string;
  models: string[];
  /** 額外的提醒,例如來源節點仍在執行。 */
  warn?: string;
  onDone: (agent: AgentInfo) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(defaultName);
  const [form, setForm] = useState({ model, isolate: false });
  const [dir, setDir] = useState<DirInfo | null>(null);
  const [sameDir, setSameDir] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  // 查資料夾能不能開獨立工作區,以及同一個資料夾已有哪些節點
  useEffect(() => {
    let alive = true;
    void window.nexus.inspectDir(cwd).then(d => { if (alive) setDir(d); });
    void window.nexus.getSnapshot().then(s => { if (alive) setSameDir(s.agents.filter(a => !a.parentId && norm(a.cwd) === norm(cwd)).map(a => a.name)); });
    return () => { alive = false; };
  }, [cwd]);
  const canIsolate = Boolean(dir?.isRepo && dir.hasCommit);
  const fork = async () => {
    setWorking(true);
    setError('');
    try {
      onDone(await window.nexus.forkAgent({ source, name: name.trim(), isolate: form.isolate, model: form.model.trim() }));
    } catch (e) {
      setError(clean(e));
      setWorking(false);
    }
  };
  return (
    <div className="fork-panel">
      <div className="dlg-settings">
        <b className="fork-title">分支對話</b>
        <label>新節點名稱<input value={name} onChange={e => setName(e.target.value)} autoFocus aria-label="新節點名稱" /></label>
        <label>模型
          <input list="fork-models" value={form.model} onChange={e => setForm(f => ({ ...f, model: e.target.value }))} placeholder="預設" />
          <datalist id="fork-models">{models.map(m => <option key={m} value={m} />)}</datalist>
        </label>
        <label className="fork-check" title={canIsolate ? '新節點在自己的 git worktree 與分支上工作,不會和來源互相覆寫' : '工作目錄不是有提交的 git 版本庫,無法使用'}>
          <span><input type="checkbox" checked={form.isolate} disabled={!canIsolate} onChange={e => setForm(f => ({ ...f, isolate: e.target.checked }))} /> 獨立工作區(git worktree)</span>
        </label>
        <span className="muted">新節點從目前的對話往下發展,有自己的 session;原本的對話不受影響。</span>
        <span className="spacer" />
        <button onClick={onCancel}>取消</button>
        <button className="primary" disabled={working || !name.trim()} onClick={() => void fork()}>{working ? '分支中…' : '建立分支'}</button>
      </div>
      {warn && <div className="form-warn">{warn}</div>}
      {sameDir.length > 0 && !form.isolate && <div className="form-warn">這個資料夾已有節點「{sameDir.join('、')}」。多個節點同時修改同一個資料夾會互相覆寫,變更檢視也會混在一起。{canIsolate ? '可以勾選獨立工作區。' : ''}</div>}
      {error && <div className="line err">{error}</div>}
    </div>
  );
}
