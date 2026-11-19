import { useCallback, useEffect, useMemo, useState } from 'react';
import { BACKEND_LABEL, type Backend, type Capability, type OldSession } from '../../shared/types';
import { ForkPanel } from './Fork';
import { BACKEND_COLOR, hex } from './theme';

function ago(ms: number): string {
  if (!ms) return '';
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return '剛剛';
  if (m < 60) return `${m} 分鐘前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小時前`;
  const d = Math.round(h / 24);
  return d < 60 ? `${d} 天前` : new Date(ms).toLocaleDateString('zh-TW');
}

const key = (s: OldSession) => `${s.backend}:${s.sessionId}`;

/**
 * 開啟舊 session:列出主控台終止過的節點,以及三家 CLI 留在這台電腦上的舊對話。
 * 主控台開過的 session 會記住當時的名稱與角色,再開啟時直接沿用;第一次開啟的 CLI 對話則以這裡填的名稱保存。
 */
export function OldSessions({ onOpened, onClose }: { onOpened: (agentId: string) => void; onClose: () => void }) {
  const [list, setList] = useState<OldSession[] | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<Backend | 'all'>('all');
  const [query, setQuery] = useState('');
  const [names, setNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  // 可能正在別處使用的對話,要按第二次才開啟
  const [confirm, setConfirm] = useState('');
  // 分支:新節點有自己的 session,不佔用這個舊 session;只有支援的後台可以用
  const [forking, setForking] = useState('');
  const [caps, setCaps] = useState<Capability[]>([]);
  useEffect(() => { void window.nexus.getSnapshot().then(s => setCaps(s.capabilities)); }, []);

  const load = useCallback(() => {
    setList(null);
    setError('');
    window.nexus.listOldSessions().then(setList).catch(e => setError(String((e as Error).message ?? e)));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (list ?? []).filter(s => (filter === 'all' || s.backend === filter) && (!q || `${s.name} ${s.title} ${s.cwd}`.toLowerCase().includes(q)));
  }, [list, filter, query]);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: list?.length ?? 0 };
    for (const s of list ?? []) c[s.backend] = (c[s.backend] ?? 0) + 1;
    return c;
  }, [list]);

  const open = async (s: OldSession) => {
    if (s.maybeActive && confirm !== key(s)) { setConfirm(key(s)); return; }
    setBusy(key(s));
    setError('');
    try {
      const agent = await window.nexus.openOldSession({ backend: s.backend, sessionId: s.sessionId, cwd: s.cwd, agentId: s.agentId, name: (names[key(s)] ?? s.name).trim(), character: s.character, model: s.model });
      onOpened(agent.id);
    } catch (e) {
      setError(String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
      setBusy('');
    }
  };

  return (
    <section className="review oldsessions" role="dialog" aria-label="開啟舊 session">
      <header className="rv-head">
        <b>開啟舊 SESSION</b>
        <div className="os-filters">
          {(['all', 'claude', 'codex', 'antigravity'] as const).map(b => (
            <button key={b} className={`ghost ${filter === b ? 'on' : ''}`} onClick={() => setFilter(b)}>
              {b === 'all' ? '全部' : BACKEND_LABEL[b]} <em>{counts[b] ?? 0}</em>
            </button>
          ))}
        </div>
        <input className="os-search" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜尋名稱、內容或資料夾" autoFocus />
        <span className="spacer" />
        <button onClick={load}>重新整理</button>
        <button className="ghost" onClick={onClose} aria-label="關閉">✕</button>
      </header>
      {error && <div className="rv-note err">{error}</div>}
      <div className="os-list">
        {list === null && !error && <div className="empty">讀取三家 CLI 的舊 session 中…</div>}
        {list !== null && shown.length === 0 && <div className="empty">沒有符合的舊 session。</div>}
        {shown.map(s => {
          const cap = caps.find(c => c.backend === s.backend);
          const forkWhy = !s.cwdExists ? '原本的工作目錄已經不存在' : !cap?.fork ? `${BACKEND_LABEL[s.backend]} 不支援分支對話` : '';
          return (<div key={key(s)}>
          <div className={`os-row ${s.cwdExists ? '' : 'missing'}`}>
            <i className="os-dot" style={{ background: hex(BACKEND_COLOR[s.backend]) }} title={BACKEND_LABEL[s.backend]} />
            <div className="os-main">
              <div className="os-title">{s.title}</div>
              <div className="os-meta">
                <span>{BACKEND_LABEL[s.backend]}</span>
                <span className={`os-src ${s.source}`}>{s.source === 'nexus' ? '主控台開過' : 'CLI 的對話'}</span>
                {s.maybeActive && <span className="os-active" title="這個對話幾分鐘內還有更新,可能正被其他程式使用;同時在兩邊使用可能互相干擾">可能使用中</span>}
                <span className="os-cwd" title={s.cwd}>{s.cwd}</span>
                <span>{ago(s.updatedAt)}</span>
              </div>
            </div>
            <input className="os-name" value={names[key(s)] ?? s.name} onChange={e => setNames(n => ({ ...n, [key(s)]: e.target.value }))}
              title={s.source === 'nexus' ? '上次使用的名稱,會直接沿用' : '第一次開啟:這個名稱會跟著這個 session 保存'} aria-label="節點名稱" />
            <button className="primary" disabled={!s.cwdExists || busy !== '' || !(names[key(s)] ?? s.name).trim()} onClick={() => void open(s)}
              title={s.cwdExists ? '建立節點並接回這個 session' : '原本的工作目錄已經不存在'}>{busy === key(s) ? '開啟中…' : !s.cwdExists ? '資料夾不存在' : confirm === key(s) ? '確定開啟?' : '開啟'}</button>
            <span title={forkWhy || '分支出新節點,有自己的 session,不會佔用這個舊 session'}>
              <button className={forking === key(s) ? 'on' : ''} disabled={forkWhy !== '' || busy !== ''} onClick={() => setForking(f => (f === key(s) ? '' : key(s)))}>分支</button>
            </span>
          </div>
          {forking === key(s) && !forkWhy && (
            <div className="os-fork">
              <ForkPanel source={{ kind: 'session', backend: s.backend, sessionId: s.sessionId, cwd: s.cwd, agentId: s.agentId }} cwd={s.cwd}
                defaultName={`${(names[key(s)] ?? s.name).trim() || '舊對話'}-分支`} model={s.model} models={cap?.models ?? []}
                onCancel={() => setForking('')} onDone={a => onOpened(a.id)} />
            </div>
          )}
          </div>);
        })}
      </div>
    </section>
  );
}
