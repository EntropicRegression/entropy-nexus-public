import { BACKEND_LABEL, STATE_LABEL, usageWindowsFor, type AgentInfo, type BackendUsage } from '../../shared/types';
import { BACKEND_COLOR, hex } from './theme';

const SEGMENTS = 20;

export function when(ts: number): string {
  const d = new Date(ts * 1000);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });
  return sameDay ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

export function ago(ms: number): string {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return '剛剛';
  if (m < 60) return `${m} 分鐘前`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} 小時前` : `${Math.round(h / 24)} 天前`;
}

/** 分段的血量條:剩餘越少顏色越警示。 */
function HpBar({ label, remaining, note, kind = 'hp' }: { label: string; remaining: number; note: string; kind?: 'hp' | 'mp' }) {
  const r = Math.max(0, Math.min(1, remaining));
  const lit = Math.round(r * SEGMENTS);
  const level = kind === 'mp' ? 'mp' : r > 0.5 ? 'ok' : r > 0.2 ? 'low' : 'crit';
  return (
    <div className={`hp ${level}`}>
      <div className="hp-head"><span>{label}</span><b>{Math.round(r * 100)}%</b></div>
      <div className="hp-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(r * 100)} aria-label={`${label}剩餘`}>
        {Array.from({ length: SEGMENTS }, (_, i) => <i key={i} className={i < lit ? 'on' : ''} />)}
      </div>
      {note && <div className="hp-note">{note}</div>}
    </div>
  );
}

/**
 * 游標停在節點上時的資訊卡:以血量條顯示這個後台帳號的剩餘額度,以及這個節點的剩餘記憶空間。
 * 額度是整個帳號共用的,同一家後台的節點會顯示相同的數字。
 */
export function HoverCard({ agent: a, usage, x, y }: { agent: AgentInfo; usage?: BackendUsage; x: number; y: number }) {
  const ctx = a.context;
  // 額度依模型分組的後台只顯示這個節點的模型所屬的那一組
  const windows = usageWindowsFor(a.model, usage?.windows ?? []);
  // 靠近右邊或下緣時把卡片翻到另一側,避免超出視窗
  const flip = x > window.innerWidth - 312 - 300;
  const up = y > window.innerHeight - 420;
  const transform = `translate(${flip ? 'calc(-100% - 44px)' : '44px'}, ${up ? 'calc(-100% + 34px)' : '-34px'})`;
  return (
    <div className="hovercard right" style={{ left: x, top: y, transform }}>
      <div className="hc-head">
        <i style={{ background: hex(BACKEND_COLOR[a.backend]) }} />
        <b>{a.name}</b>
        <span>{STATE_LABEL[a.state]}</span>
      </div>
      <div className="hc-sub">{a.parentId ? '子代理' : BACKEND_LABEL[a.backend]}{a.model ? ` · ${a.model}` : ''}</div>
      {windows.length > 0 && windows.every(w => w.group) && <div className="hc-group">{windows[0].group}</div>}
      {windows.length > 0
        ? windows.map(w => (
          <HpBar key={w.label} label={`${w.label}額度`} remaining={1 - w.used} note={w.resetsAt ? `${when(w.resetsAt)} 重置` : ''} />
        ))
        : <div className="hc-none">{usage?.unsupported ? `${BACKEND_LABEL[a.backend]} 不提供剩餘額度` : '尚未取得剩餘額度,這個後台的節點執行一次後會更新'}</div>}
      {ctx && ctx.max > 0 && <HpBar kind="mp" label="記憶空間" remaining={1 - ctx.used / ctx.max} note={`已用 ${Math.round(ctx.used / 1000)}k / ${Math.round(ctx.max / 1000)}k`} />}
      {a.spent.tokens > 0 && <div className="hc-spent">這個節點累計 {a.spent.tokens >= 1000 ? `${(a.spent.tokens / 1000).toFixed(1)}k` : a.spent.tokens} tokens{a.spent.usd > 0 ? ` · 約 $${a.spent.usd.toFixed(a.spent.usd < 0.1 ? 3 : 2)}` : ''}</div>}
      {usage && usage.windows.length > 0 && <div className="hc-foot">帳號共用 · {ago(usage.updatedAt)}更新</div>}
    </div>
  );
}
