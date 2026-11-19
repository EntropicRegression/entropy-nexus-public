import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef } from 'react';

/** 終端機模式的畫面:顯示原生 CLI 的輸出,並把按鍵送回去。 */
export function TerminalView({ agentId }: { agentId: string }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current!;
    const term = new Terminal({
      fontFamily: '"Cascadia Mono", Consolas, "Microsoft JhengHei", monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: { background: '#05090f', foreground: '#d8f4f8', cursor: '#3fd8e6', selectionBackground: 'rgba(63, 216, 230, 0.3)' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    const resize = () => { try { fit.fit(); void window.nexus.termResize(agentId, term.cols, term.rows); } catch { /* 元素還沒有尺寸 */ } };
    resize();
    let alive = true;
    // 先補回掛上之前的輸出,再接即時資料
    void window.nexus.termAttach(agentId).then(buf => { if (alive && buf) term.write(buf); });
    const off = window.nexus.onUpdate(u => { if (u.term && u.term.agentId === agentId) term.write(u.term.data); });
    const sub = term.onData(data => void window.nexus.termWrite(agentId, data));
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    term.focus();
    (window as unknown as Record<string, unknown>).__nexusTerm = { text: () => { const b = term.buffer.active; const out: string[] = []; for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? ''); return out.join('\n'); } };
    return () => { alive = false; off(); sub.dispose(); ro.disconnect(); term.dispose(); };
  }, [agentId]);

  return <div className="dlg-terminal" ref={host} />;
}
