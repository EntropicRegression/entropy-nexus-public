import { useEffect, useState } from 'react';
import { VoiceEditor } from './Voice';

const clean = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/**
 * 角色卡的檢視與編輯:新增節點面板與對話視窗的「設定」共用。
 * 角色卡存在立繪資料夾的角色子資料夾裡,同一個角色的所有節點共用一份。
 * 底下是同一個角色的聲音(語音播報用的參考錄音、錄音內容與語氣),也是同一個角色的節點共用。
 */
export function PersonaEditor({ character }: { character: string }) {
  const [text, setText] = useState('');
  const [saved, setSaved] = useState('');
  const [max, setMax] = useState(8000);
  const [note, setNote] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    setNote('');
    void window.nexus.getPersona(character).then(p => {
      if (!alive) return;
      setText(p.text); setSaved(p.text); setMax(p.max);
      if (p.truncated) setNote(`角色卡超過 ${p.max} 字,超出的部分不會交給 agent;儲存後會以截斷後的內容覆寫。`);
    }).catch(e => { if (alive) setNote(clean(e)); });
    return () => { alive = false; };
  }, [character]);
  const save = async () => {
    try { await window.nexus.setPersona(character, text); setSaved(text.trim()); setText(text.trim()); setNote('已儲存。使用這個角色的節點會在下一則指令前收到新的角色設定。'); } catch (e) { setNote(clean(e)); }
  };
  const dirty = text.trim() !== saved;
  return (
    <>
    <div className="persona-edit">
      <div className="persona-head">
        <span>角色卡 · {character}</span>
        <span className="note">{saved ? `${saved.length} 字` : '尚未設定'}</span>
        <span className="spacer" />
        <button className="ghost" onClick={() => setOpen(v => !v)}>{open ? '收起' : saved ? '檢視/編輯' : '撰寫'}</button>
      </div>
      {open && (
        <>
          <textarea value={text} maxLength={max} rows={6} onChange={e => setText(e.target.value)}
            placeholder="寫下這個角色的身分、說話風格與職責,例如:你是嚴格的 QA 審查員,回覆簡潔、先列出風險……" />
          <div className="persona-head">
            <span className="note">{text.length} / {max} 字。同一個角色的節點共用這份角色卡。</span>
            <span className="spacer" />
            <button className="primary" disabled={!dirty} onClick={() => void save()}>儲存角色卡</button>
          </div>
        </>
      )}
      {note && <span className="note">{note}</span>}
    </div>
    <VoiceEditor character={character} />
    </>
  );
}
