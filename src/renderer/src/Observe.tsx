import { useCallback, useEffect, useState } from 'react';
import { STATE_LABEL, type ObservedSession, type ObserveStatus } from '../../shared/types';
import { BACKEND_COLOR, STATE_COLOR, hex } from './theme';

const clean = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const folder = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

function elapsed(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} 分` : `${Math.round(m / 60)} 小時`;
}

/** 外部觀察的設定面板:接收端狀態、會加入哪些 hooks、安裝與移除。設定檔只在按下按鈕時才修改。 */
export function ObservePanel({ onClose, embedded = false }: { onClose: () => void; embedded?: boolean }) {
  const [st, setSt] = useState<ObserveStatus | null>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [showPreview, setShowPreview] = useState(false);
  const load = useCallback(() => { void window.nexus.observeStatus().then(setSt); }, []);
  useEffect(() => { load(); const t = setInterval(load, 3000); return () => clearInterval(t); }, [load]);
  const act = (p: Promise<ObserveStatus>, ok: string) => {
    setErr(''); setMsg('');
    void p.then(s => { setSt(s); setMsg(ok); }).catch(e => setErr(clean(e)));
  };

  return (
    <div className={embedded ? 'remote-section observe' : 'remote observe'}>
      {!embedded && <div className="remote-head"><b>外部觀察</b><span className="spacer" /><button className="ghost" onClick={onClose} aria-label="關閉">✕</button></div>}
      {!st ? <div className="empty">讀取中…</div> : <>
        <p className="remote-note">在主控台以外(例如 VS Code 或 Windows Terminal)執行的 Claude Code,裝上 hooks 後會即時回報狀態,顯示在右側節點清單的「外部」區塊。只能觀看,不能授權或下指令;要操作請按「接手」。</p>
        {st.listening
          ? <div className="remote-ok">接收端已啟動:127.0.0.1:{st.port}(只接受本機連線)</div>
          : <div className="remote-warn">{st.error || '接收端尚未啟動'}</div>}
        <div className="remote-sub">Claude Code 使用者設定檔</div>
        <div className="remote-url" title={st.settingsPath}>{st.settingsPath}</div>
        {st.settingsError && <div className="remote-warn">{st.settingsError}</div>}
        <div className={st.installed === 'current' ? 'remote-ok' : 'remote-note'}>
          {st.installed === 'current' ? 'hooks 已安裝。新開的 Claude Code 會開始回報。' : st.installed === 'stale' ? '裝過的 hooks 與目前的連接埠或權杖不符,請按「安裝 hooks」更新。' : '尚未安裝 hooks。'}
        </div>
        <p className="remote-note">安裝會在設定檔的 hooks 裡為 {st.events.join('、')} 各加一個 http 型 hook,指向上面的本機接收端。你原有的 hooks 與其他設定不會被修改;修改前會在同一個資料夾留一份備份。主控台沒開時,hook 連線會立刻失敗,不會拖慢 Claude Code。移除只會拿掉主控台加的項目。已經在執行的 Claude Code 要重新開啟才會讀到新的 hooks。</p>
        <button className="ghost" onClick={() => setShowPreview(v => !v)}>{showPreview ? '隱藏內容' : '顯示會加入的內容'}</button>
        {showPreview && <pre className="observe-preview">{st.preview}</pre>}
        <div className="observe-actions">
          <button className="primary" onClick={() => act(window.nexus.observeInstall(), 'hooks 已安裝。')}>{st.installed === 'none' ? '安裝 hooks' : '重新安裝 hooks'}</button>
          <button className="danger" disabled={st.installed === 'none'} onClick={() => act(window.nexus.observeUninstall(), 'hooks 已移除。')}>移除 hooks</button>
          <button className="ghost" onClick={() => act(window.nexus.observeNewToken(), '已換新權杖,請重新安裝 hooks。')} title="舊的權杖立刻失效">換新權杖</button>
        </div>
        {msg && <div className="remote-ok">{msg}</div>}
        {err && <div className="remote-warn">{err}</div>}
      </>}
    </div>
  );
}

/** 右側節點清單的「外部」區塊。 */
export function ObservedRows({ list, onOpened }: { list: ObservedSession[]; onOpened: (agentId: string) => void }) {
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  // 經過時間每隔幾秒重畫一次
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick(n => n + 1), 5000); return () => clearInterval(t); }, []);
  if (!list.length) return null;
  const take = async (o: ObservedSession) => {
    // 同一個 session 同時兩個寫入者會互相干擾:第一次按只警告,第二次才真的接手
    if (confirm !== o.sessionId) { setConfirm(o.sessionId); setErr(''); return; }
    setBusy(o.sessionId);
    try { onOpened((await window.nexus.observeTakeover(o.sessionId, folder(o.cwd) || '接手的對話')).id); setConfirm(''); }
    catch (e) { setErr(clean(e)); }
    setBusy('');
  };
  return (
    <div className="observed">
      <div className="observed-title">外部 <em>{list.length}</em></div>
      {list.map(o => (
        <div key={o.sessionId} className={`row observed-row s-${o.state}`} title={`${o.cwd}\nsession ${o.sessionId}\n\n${o.recent.map(r => `${new Date(r.ts).toLocaleTimeString('zh-TW', { hour12: false })} ${r.text}`).join('\n')}`}>
          <span className="dot ext" style={{ borderColor: hex(BACKEND_COLOR[o.backend]), background: hex(STATE_COLOR[o.state]) }} />
          <span className="row-main">
            <span className="row-name">{folder(o.cwd) || '(未知資料夾)'}</span>
            <span className="row-sub">外部 · {o.detail || STATE_LABEL[o.state]} · {elapsed(o.lastAt)}前</span>
          </span>
          <span className="row-state">{STATE_LABEL[o.state]}</span>
          <button className="observed-take" disabled={busy !== ''} onClick={() => void take(o)}>{busy === o.sessionId ? '接手中…' : confirm === o.sessionId ? '確定接手' : '接手'}</button>
          {confirm === o.sessionId && <div className="observed-warn">這個 session 還開在外部的終端機。請先在那邊結束 Claude Code(輸入 /exit),再按「確定接手」;兩邊同時使用同一個 session 會互相覆寫紀錄。</div>}
        </div>
      ))}
      {err && <div className="observed-warn">{err}</div>}
    </div>
  );
}
