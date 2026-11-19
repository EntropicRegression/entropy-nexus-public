import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

type Block =
  | { t: 'code'; lang: string; text: string }
  | { t: 'h'; level: number; text: string }
  | { t: 'list'; ordered: boolean; items: string[] }
  | { t: 'p'; text: string };

/** 把回覆文字切成區塊:程式碼區塊、標題、清單、段落。只處理常見語法,其餘原樣顯示。 */
function parse(src: string): Block[] {
  const blocks: Block[] = [];
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  let para: string[] = [];
  const flush = () => { if (para.length) { blocks.push({ t: 'p', text: para.join('\n') }); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      // 還在生成中的回覆可能沒有結尾的 ```,就收到最後一行
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      blocks.push({ t: 'code', lang: fence[1].trim(), text: body.join('\n') });
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { flush(); blocks.push({ t: 'h', level: h[1].length, text: h[2] }); continue; }
    const li = /^\s*([-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flush();
      const ordered = /\d/.test(li[1]);
      const last = blocks[blocks.length - 1];
      if (last?.t === 'list' && last.ordered === ordered) last.items.push(li[2]);
      else blocks.push({ t: 'list', ordered, items: [li[2]] });
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    para.push(line);
  }
  flush();
  return blocks;
}

const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

/** 看起來像本機圖片路徑的文字(絕對路徑、相對路徑或 file:// 網址);http 等網址不算。 */
function isLocalImage(s: string): boolean {
  if (s.length > 400 || !IMG_EXT.test(s) || /[<>"|?*\n]|\]\(/.test(s)) return false;
  if (/^file:\/\//i.test(s)) return true;
  if (/^[a-z][\w+.-]*:\/\//i.test(s)) return false;
  // 含空白時必須有路徑分隔符號,避免把一般句子當成路徑
  return /[\\/]/.test(s) || !/\s/.test(s);
}

/** 段落裡單獨成行、或以行內程式碼出現的圖片路徑;會在該段下方附上預覽。 */
function bareImages(text: string): string[] {
  const found: string[] = [];
  for (const line of text.split('\n')) {
    const t = line.replace(/^\s*([-*•]|\d+[.)])\s+/, '').trim().replace(/^(["'`])(.*)\1$/, '$2').trim();
    if (isLocalImage(t)) found.push(t);
  }
  for (const m of text.matchAll(/`([^`\n]+)`/g)) if (isLocalImage(m[1].trim())) found.push(m[1].trim());
  return [...new Set(found)];
}

/** 本機圖片一律經主行程的受限協定讀取:只開放節點工作目錄與主控台媒體資料夾裡的圖片。 */
/** 瀏覽器版(經手機遠端載入的完整介面)沒有自訂協定,改走遠端服務的 /api/file,限制相同。 */
export const fileUrl = (agentId: string, path: string) => (window.nexus.uploadFile
  ? `/api/file?id=${encodeURIComponent(agentId)}&path=${encodeURIComponent(path)}`
  : `nexus-file://img/${encodeURIComponent(agentId)}?path=${encodeURIComponent(path)}`);

/**
 * 回覆或工具結果裡的一張圖片。本機路徑經受限協定載入;遠端 http(s) 圖片預設不載入(避免對外洩漏與追蹤),
 * 按了才載入。載入失敗時退回顯示原本的路徑文字;段落下方的預覽(quiet)路徑已經在文字裡,失敗就不顯示。點一下放大檢視。
 */
export function MdImage({ src, alt, agentId, quiet }: { src: string; alt?: string; agentId?: string; quiet?: boolean }) {
  const [failed, setFailed] = useState(false);
  const [allowRemote, setAllowRemote] = useState(false);
  const [zoom, setZoom] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);
  useEffect(() => {
    if (!zoom) return;
    // 放大檢視時 Esc 只關掉放大,不關對話視窗
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setZoom(false); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [zoom]);
  const remote = /^https?:\/\//i.test(src);
  const url = remote || /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(src) ? src : agentId ? fileUrl(agentId, src) : null;
  if ((failed || !url) && quiet) return null;
  if (failed || !url) return <code className="md-img-fail" title={failed ? '圖片無法載入(檔案不存在,或不在節點的工作目錄內)' : undefined}>{src}</code>;
  if (remote && !allowRemote) {
    let host = src;
    try { host = new URL(src).host; } catch { /* 顯示原字串 */ }
    return <button className="ghost md-img-remote" title={`遠端圖片預設不載入:${src}`} onClick={() => setAllowRemote(true)}>載入圖片{alt ? `「${alt}」` : ''} · {host}</button>;
  }
  return (
    <>
      <img className="md-img" src={url} alt={alt ?? ''} title={alt || src} referrerPolicy="no-referrer" draggable={false} onError={() => setFailed(true)} onClick={() => setZoom(true)} />
      {zoom && createPortal(<div className="md-lightbox" onClick={() => setZoom(false)} title="點一下關閉"><img src={url} alt={alt ?? ''} referrerPolicy="no-referrer" /></div>, document.body)}
    </>
  );
}

/** 值得問主行程的文字:有路徑分隔符號,或以副檔名結尾(可帶 :行號);網址與太長的不問。 */
const pathLike = (s: string) => s.length <= 400 && (/^file:\/\//i.test(s) || (!/[\n<>"|?*]|:\/\//.test(s) && (/[\\/]/.test(s) || /^[^\s]+\.\w{1,8}(:\d+){0,2}$/.test(s))));

// 查詢結果的快取:存在的記住,不存在的過一陣子再問(檔案可能之後才建立)
const revealCache = new Map<string, { ok: boolean; at: number }>();
const revealPending = new Map<string, Promise<boolean>>();
function canReveal(agentId: string, text: string): Promise<boolean> {
  const key = `${agentId}\n${text}`;
  const hit = revealCache.get(key);
  if (hit && (hit.ok || Date.now() - hit.at < 30000)) return Promise.resolve(hit.ok);
  let p = revealPending.get(key);
  if (!p) {
    p = window.nexus.canReveal(agentId, text).catch(() => false).then(ok => { revealCache.set(key, { ok, at: Date.now() }); revealPending.delete(key); return ok; });
    revealPending.set(key, p);
  }
  return p;
}

/** 行內程式碼。內容是這台電腦上存在的檔案或資料夾時變成連結,點一下在檔案總管中顯示(選取文字時不觸發)。 */
function InlineCode({ text, agentId }: { text: string; agentId?: string }) {
  const key = agentId ? `${agentId}\n${text}` : '';
  const [ok, setOk] = useState(() => !!key && revealCache.get(key)?.ok === true);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (!agentId || !pathLike(text)) { setOk(false); return; }
    let alive = true;
    void canReveal(agentId, text).then(v => { if (alive) setOk(v); });
    return () => { alive = false; };
  }, [agentId, text]);
  if (!ok || !agentId) return <code>{text}</code>;
  const open = () => {
    if (window.getSelection()?.toString()) return;
    window.nexus.revealPath(agentId, text).then(() => setMissing(false), () => { setMissing(true); revealCache.delete(key); });
  };
  return <code className={`md-path ${missing ? 'missing' : ''}`} role="link" tabIndex={0} title={missing ? '找不到這個檔案或資料夾(可能已被移動或刪除)' : '在檔案總管中顯示'}
    onClick={open} onKeyDown={e => { if (e.key === 'Enter') open(); }}>{text}</code>;
}

/**
 * Markdown 連結。目標是這台電腦上存在的檔案或資料夾時(Antigravity 習慣把檔名寫成 [檔名](file:///路徑)),
 * 點一下在檔案總管中顯示;其他連結只顯示文字與網址,不會開啟。
 */
function MdLink({ text, href, agentId }: { text: string; href: string; agentId?: string }) {
  const local = !!agentId && href.length <= 1000 && !/^(https?|mailto|data|javascript):/i.test(href);
  const key = local ? `${agentId}\n${href}` : '';
  const [ok, setOk] = useState(() => !!key && revealCache.get(key)?.ok === true);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (!local) { setOk(false); return; }
    let alive = true;
    void canReveal(agentId!, href).then(v => { if (alive) setOk(v); });
    return () => { alive = false; };
  }, [agentId, href]);
  // 連結文字常常又包了一層行內程式碼的反引號
  const label = text.replace(/^`([^`]+)`$/, '$1');
  if (!ok) return <span className="md-link" title={href}>{label}</span>;
  const open = () => {
    if (window.getSelection()?.toString()) return;
    window.nexus.revealPath(agentId!, href).then(() => setMissing(false), () => { setMissing(true); revealCache.delete(key); });
  };
  return <span className={`md-link md-path ${missing ? 'missing' : ''}`} role="link" tabIndex={0} title={missing ? '找不到這個檔案或資料夾(可能已被移動或刪除)' : `在檔案總管中顯示:${href}`}
    onClick={open} onKeyDown={e => { if (e.key === 'Enter') open(); }}>{label}</span>;
}

/** 行內語法:`程式碼`、**粗體**、[文字](連結)、![說明](圖片);圖片路徑有空白時可寫成 ![說明](<路徑>)。連結的目標是本機存在的檔案或資料夾時可以點開檔案總管,其他連結只顯示文字與網址,不會開啟。 */
function inline(text: string, agentId?: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(!\[([^\]\n]*)\]\((<[^>\n]+>|[^)\s]+)\))|(\[[^\]\n]+\]\((?:<[^>\n]+>|[^)\s]+)\))/g;
  let last = 0, m: RegExpExecArray | null, k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const s = m[0];
    if (s.startsWith('`')) out.push(<InlineCode key={k++} text={s.slice(1, -1)} agentId={agentId} />);
    else if (s.startsWith('**')) out.push(<b key={k++}>{s.slice(2, -2)}</b>);
    else if (s.startsWith('![')) out.push(<MdImage key={k++} src={m[5].replace(/^<(.*)>$/, '$1').trim()} alt={m[4]} agentId={agentId} />);
    else { const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(s)!; out.push(<MdLink key={k++} text={mm[1]} href={mm[2].replace(/^<(.*)>$/, '$1').trim()} agentId={agentId} />); }
    last = m.index + s.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** 段落下方的圖片預覽;沒有 agentId(不知道工作目錄)時不顯示。 */
function Previews({ text, agentId }: { text: string; agentId?: string }) {
  const paths = agentId ? bareImages(text) : [];
  return paths.length ? <div className="md-previews">{paths.map(p => <MdImage key={p} src={p} agentId={agentId} quiet />)}</div> : null;
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1500); };
    navigator.clipboard?.writeText(text).then(done).catch(() => {
      // 剪貼簿 API 不能用時改用選取複製
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } finally { ta.remove(); }
    });
  };
  return (
    <div className="md-code">
      <div className="md-code-head"><span>{lang || '程式碼'}</span><button className="ghost" onClick={copy}>{copied ? '已複製' : '複製'}</button></div>
      <pre>{text}</pre>
    </div>
  );
}

/**
 * 回覆的排版:程式碼區塊(等寬字、可複製)、標題、清單、粗體、行內程式碼與圖片。
 * agentId 用來讀取該節點工作目錄裡的圖片;不給就只顯示路徑文字。
 */
export function Markdown({ text, tail, agentId }: { text: string; tail?: ReactNode; agentId?: string }) {
  const blocks = parse(text);
  return (
    <div className="md">
      {blocks.map((b, i) => {
        const end = i === blocks.length - 1 ? tail : null;
        if (b.t === 'code') return <CodeBlock key={i} lang={b.lang} text={b.text} />;
        if (b.t === 'h') return <div key={i} className={`md-h md-h${b.level}`}>{inline(b.text, agentId)}{end}</div>;
        if (b.t === 'list') {
          const items = b.items.map((it, j) => <li key={j}>{inline(it, agentId)}{j === b.items.length - 1 ? end : null}</li>);
          return <Fragment key={i}>{b.ordered ? <ol>{items}</ol> : <ul>{items}</ul>}<Previews text={b.items.join('\n')} agentId={agentId} /></Fragment>;
        }
        return <Fragment key={i}><p>{inline(b.text, agentId)}{end}</p><Previews text={b.text} agentId={agentId} /></Fragment>;
      })}
      {blocks.length === 0 || blocks[blocks.length - 1].t === 'code' ? tail : null}
    </div>
  );
}
