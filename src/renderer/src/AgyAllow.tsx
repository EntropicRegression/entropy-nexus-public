import { useEffect, useState } from 'react';

const clean = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/**
 * 「Antigravity 允許的工具」:所有 Antigravity 節點共用的白名單(見 shared/agy-allow.ts)。
 * 主控台用無視窗模式啟動 Antigravity,它沒辦法在畫面上詢問權限,不在白名單裡的動作會被自動拒絕。
 * 新增節點(後台選 Antigravity)與 Antigravity 節點的「設定」裡都有這個區塊;平常收合,只顯示條數。
 */
export function AgyAllowEditor() {
  const [open, setOpen] = useState(false);
  const [rules, setRules] = useState<string[] | null>(null);
  const [draft, setDraft] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { void window.nexus.getAgyAllow().then(r => { setRules(r); setDraft(r.join('\n')); }, () => setRules(null)); }, []);
  if (rules === null) return null;
  const dirty = draft.split(/\r?\n/).map(s => s.trim()).filter(Boolean).join('\n') !== rules.join('\n');
  const save = () => {
    setMsg(null);
    void window.nexus.setAgyAllow(draft).then(
      r => { setRules(r); setDraft(r.join('\n')); setMsg({ ok: true, text: '已儲存。正在執行的 Antigravity 節點要重新啟動才會套用(對話視窗按「休眠」再「喚醒」)。' }); },
      e => setMsg({ ok: false, text: clean(e) }),
    );
  };
  return (
    <div className="agy-allow need-full">
      <button type="button" className="ghost agy-allow-head" aria-expanded={open} onClick={() => setOpen(v => !v)}>
        {open ? '▾' : '▸'} Antigravity 允許的工具({rules.length ? `${rules.length} 條` : '沒有'})
      </button>
      {open && <>
        <p className="note">Antigravity 在主控台裡不會詢問權限:不在這份清單上、需要審核的動作會被自動拒絕(例如工作目錄以外的檔案、沒放行的 MCP 工具)。所有 Antigravity 節點共用。一行一條,格式和 agy 的 settings.json 相同,例如 <code>mcp(StitchMCP/*)</code>、<code>mcp(StitchMCP/create_project)</code>。</p>
        <textarea value={draft} onChange={e => setDraft(e.target.value)} rows={Math.min(8, Math.max(3, draft.split('\n').length + 1))} placeholder={'mcp(StitchMCP/*)'} spellCheck={false} />
        <div className="agy-allow-actions">
          {msg && <span className={msg.ok ? 'agy-allow-ok' : 'agy-allow-err'}>{msg.text}</span>}
          <span className="spacer" />
          <button type="button" className="primary" disabled={!dirty} onClick={save}>儲存</button>
        </div>
      </>}
    </div>
  );
}
