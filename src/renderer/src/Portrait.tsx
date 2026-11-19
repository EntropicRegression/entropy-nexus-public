import { useEffect, useState } from 'react';
import type { AgentState, Backend } from '../../shared/types';
import { BACKEND_COLOR, STATE_COLOR, hex } from './theme';

type Mood = 'neutral' | 'thinking' | 'busy' | 'asking' | 'troubled' | 'asleep';

const MOOD: Record<AgentState, Mood> = {
  idle: 'neutral',
  planning: 'thinking',
  working: 'busy',
  awaiting: 'asking',
  error: 'troubled',
  lost: 'troubled',
  sleeping: 'asleep',
};

/**
 * 立繪。節點有指定角色且立繪資料夾裡有對應圖檔時顯示圖檔,表情隨狀態切換;
 * 否則顯示內建的 [REDACTED] 預設圖。
 */
export function Portrait({ backend, state, character }: { backend: Backend; state: AgentState; character: string }) {
  const mood = MOOD[state];
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [character]);
  if (character && !broken) {
    return (
      <div className={`portrait-frame mood-${mood}`} style={{ borderColor: hex(BACKEND_COLOR[backend]) }}>
        <img src={window.nexus.uploadFile ? `/api/portrait?c=${encodeURIComponent(character)}&mood=${mood}` : `nexus-portrait://c/${encodeURIComponent(character)}/${mood}`} alt={`${character} 的立繪`} onError={() => setBroken(true)} draggable={false} />
      </div>
    );
  }
  return <Silhouette backend={backend} state={state} mood={mood} />;
}

/** 沒有自訂立繪時的預設圖:[REDACTED] 字樣,上方保留隨狀態切換的指示(平常、思考、忙碌、詢問、困擾)。 */
function Silhouette({ backend, state, mood }: { backend: Backend; state: AgentState; mood: Mood }) {
  const frame = hex(BACKEND_COLOR[backend]);
  const core = hex(STATE_COLOR[state]);
  return (
    <svg className={`portrait mood-${mood}`} viewBox="0 0 160 220" role="img" aria-label={`尚未設定立繪([REDACTED]),${mood}`}>
      <defs>
        <linearGradient id={`pg-${backend}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={frame} stopOpacity="0.38" />
          <stop offset="1" stopColor={frame} stopOpacity="0.06" />
        </linearGradient>
      </defs>
      <path d="M12 2H148L158 12V208L148 218H12L2 208V12Z" fill="rgba(6,10,18,0.85)" stroke={frame} strokeOpacity="0.6" />
      {[40, 80, 120, 160, 200].map(y => <line key={y} x1="2" x2="158" y1={y} y2={y} stroke={frame} strokeOpacity="0.07" />)}
      <rect x="3" y="3" width="154" height="214" fill={`url(#pg-${backend})`} fillOpacity="0.35" />
      {/* 還沒有正式立繪:整張以「已遮蔽」的樣式呈現,只留上方的狀態指示 */}
      <g transform="translate(0,-48)">
        <rect x="56" y="74" width="48" height="20" rx="3" fill="rgba(6,10,18,0.9)" stroke={core} strokeOpacity="0.8" />
        {mood === 'neutral' && <line x1="64" x2="96" y1="84" y2="84" stroke={core} strokeWidth="2.5" strokeLinecap="round" />}
        {mood === 'asleep' && <line x1="68" x2="92" y1="86" y2="86" stroke={core} strokeWidth="2" strokeLinecap="round" strokeOpacity="0.5" />}
        {mood === 'thinking' && [68, 80, 92].map((x, i) => <circle key={x} className="blink" style={{ animationDelay: `${i * 0.22}s` }} cx={x} cy="84" r="3" fill={core} />)}
        {mood === 'busy' && <rect className="scan" x="60" y="78" width="8" height="12" fill={core} />}
        {mood === 'asking' && <text x="80" y="90" textAnchor="middle" fontSize="16" fontWeight="700" fill={core}>?</text>}
        {mood === 'troubled' && <path d="M62 88L70 80L78 88L86 80L94 88L98 84" fill="none" stroke={core} strokeWidth="2.2" strokeLinejoin="round" />}
      </g>
      {[[20, 70, 120], [20, 82, 84], [20, 142, 104], [20, 154, 120], [20, 166, 62], [20, 186, 92]].map(([x, y, w]) => <rect key={y} x={x} y={y} width={w} height="6" fill={frame} fillOpacity="0.16" />)}
      <rect x="12" y="98" width="136" height="34" fill="#02050a" stroke={frame} strokeOpacity="0.85" strokeWidth="1.5" />
      <text x="80" y="121" textAnchor="middle" fontSize="18" fontWeight="700" letterSpacing="1" fontFamily='"Cascadia Mono", Consolas, monospace' fill={frame}>[REDACTED]</text>
    </svg>
  );
}
