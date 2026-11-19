import { useState } from 'react';
import type { PendingQuestion } from '../../shared/types';

/**
 * agent 向使用者提問時的作答區:每題可點選項,也可以自己輸入;全部作答後送出,或略過不回答。
 */
export function QuestionPanel({ agentId, pending }: { agentId: string; pending: PendingQuestion }) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});

  const answerOf = (id: string) => [...(picked[id] ?? []), ...(other[id]?.trim() ? [other[id].trim()] : [])];
  const ready = pending.questions.every(q => answerOf(q.id).length > 0);
  const toggle = (id: string, label: string, multi: boolean) => setPicked(p => {
    const cur = p[id] ?? [];
    return { ...p, [id]: multi ? (cur.includes(label) ? cur.filter(x => x !== label) : [...cur, label]) : (cur.includes(label) ? [] : [label]) };
  });
  const submit = () => {
    if (!ready) return;
    void window.nexus.answerQuestion(agentId, pending.requestId, Object.fromEntries(pending.questions.map(q => [q.id, answerOf(q.id)])));
  };

  return (
    <div className="dlg-question">
      <div className="q-head"><b>它有問題要問你</b><span className="spacer" /><button className="ghost" onClick={() => void window.nexus.answerQuestion(agentId, pending.requestId, null)} title="不回答,讓它自己決定">略過</button></div>
      {pending.questions.map(q => (
        <div key={q.id} className="q-item">
          <div className="q-text">{q.header && <em>{q.header}</em>}{q.question}{q.multi && <small>(可複選)</small>}</div>
          <div className="q-options">
            {q.options.map(o => (
              <button key={o.label} className={(picked[q.id] ?? []).includes(o.label) ? 'on' : ''} onClick={() => toggle(q.id, o.label, q.multi)} title={o.description}>{o.label}</button>
            ))}
            <input value={other[q.id] ?? ''} onChange={e => setOther(v => ({ ...v, [q.id]: e.target.value }))} placeholder={q.options.length ? '其他(自行輸入)' : '輸入你的回答'}
              onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit(); }} />
          </div>
        </div>
      ))}
      <div className="q-actions"><button className="primary warn" disabled={!ready} onClick={submit}>送出回答</button></div>
    </div>
  );
}
