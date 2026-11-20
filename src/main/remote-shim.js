// 瀏覽器版的完整介面:電腦的瀏覽器連到手機遠端服務時,載入的是和桌面視窗同一份畫面程式。
// 這支腳本取代 Electron 的 preload:提供同一組 window.nexus 函式,改用 HTTP(/api/rpc)與串流(/api/stream)和主控台溝通,
// 並處理配對。原生視窗才有的功能(選檔案、選資料夾)換成上傳與頁面內的資料夾清單。
(() => {
  'use strict';
  const KEY = 'nexus.token';
  const entry = document.currentScript.dataset.entry;
  let token = localStorage.getItem(KEY) || '';

  // <img> 不能帶 Authorization 標頭,所以另外放一份在 cookie;伺服器只在讀圖片(/api/file、/api/portrait)時接受它
  const setCookie = () => { document.cookie = `nexus_token=${token}; path=/api/; SameSite=Strict; max-age=${token ? 31536000 : 0}`; };
  const auth = () => ({ Authorization: 'Bearer ' + token });
  const forget = why => {
    token = '';
    localStorage.removeItem(KEY);
    setCookie();
    sessionStorage.setItem('nexus.gate', why || '');
    location.reload();
  };

  const el = (tag, style, text) => { const e = document.createElement(tag); if (style) e.style.cssText = style; if (text != null) e.textContent = text; return e; };
  const BOX = 'background:#0a1420;border:1px solid var(--line);padding:22px 24px;display:flex;flex-direction:column;gap:12px;box-shadow:0 0 40px rgba(63,216,230,.12);user-select:none';
  const FIELD = 'font:inherit;color:var(--text);background:rgba(6,10,18,.8);border:1px solid var(--line);padding:7px 10px;outline:none;user-select:text';
  const BACK = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(3,6,12,.72)';

  async function reply(r) {
    if (r.status === 401) { forget('配對已失效,請重新配對。'); throw new Error('尚未配對'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `操作失敗(${r.status})`);
    return j;
  }
  const call = async (method, ...args) => (await reply(await fetch('/api/rpc', { method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) }))).result;

  /** 把這台電腦上的檔案上傳到主控台,回傳主控台那邊存好的路徑。 */
  // 非完整權限的裝置只能上傳圖片與 PDF(和手機版相同的限制)
  const upload = async (blob, name) => (await reply(await fetch(api.access && api.access.role !== 'full' ? '/api/upload' : '/api/attach', { method: 'POST', headers: { ...auth(), 'Content-Type': blob.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(name || '') }, body: blob }))).path;

  function pickFiles() {
    return new Promise(resolve => {
      const input = el('input', 'display:none');
      input.type = 'file';
      input.multiple = true;
      input.onchange = async () => {
        const out = [];
        for (const f of input.files) { try { out.push(await upload(f, f.name)); } catch (e) { alert(`「${f.name}」上傳失敗:${e.message}`); } }
        input.remove();
        resolve(out);
      };
      input.addEventListener('cancel', () => { input.remove(); resolve([]); });
      document.body.append(input);
      input.click();
    });
  }

  /** 選資料夾:列出主控台那台電腦上的資料夾(原生的選擇視窗只能在那台電腦上跳出來)。 */
  function pickDirectory() {
    return new Promise(resolve => {
      const back = el('div', BACK);
      const box = el('div', BOX + ';width:560px;max-width:92vw');
      const path = el('input', FIELD + ';font-family:var(--mono)');
      path.placeholder = '資料夾路徑(主控台所在的電腦)';
      const list = el('div', 'height:320px;overflow:auto;border:1px solid var(--line-soft);background:rgba(6,10,18,.5)');
      const note = el('div', 'color:var(--dim);min-height:1.5em');
      const row = el('div', 'display:flex;gap:8px;justify-content:flex-end');
      const up = el('button', 'margin-right:auto', '上一層');
      const ok = el('button', '', '選這個資料夾');
      ok.className = 'primary';
      const cancel = el('button', '', '取消');
      let cur = { path: '', parent: null };
      const done = v => { back.remove(); window.removeEventListener('keydown', onKey, true); resolve(v); };
      const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } };
      const load = async p => {
        note.textContent = '讀取中…';
        try {
          cur = await reply(await fetch('/api/dirs?path=' + encodeURIComponent(p), { headers: auth() }));
          path.value = cur.path;
          list.replaceChildren(...cur.dirs.map(d => {
            const item = el('div', 'padding:5px 10px;cursor:pointer;font-family:var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis', cur.path ? d.replace(/[\\/]$/, '').split(/[\\/]/).pop() : d);
            item.title = d;
            item.onmouseenter = () => { item.style.background = 'rgba(63,216,230,.12)'; };
            item.onmouseleave = () => { item.style.background = ''; };
            item.onclick = () => void load(d);
            return item;
          }));
          list.scrollTop = 0;
          note.textContent = cur.dirs.length ? '' : '這裡沒有子資料夾';
          up.disabled = cur.parent == null;
          ok.disabled = !cur.path;
        } catch (e) { note.textContent = e.message; }
      };
      path.onkeydown = e => { if (e.key === 'Enter') void load(path.value.trim()); };
      up.onclick = () => void load(cur.parent ?? '');
      ok.onclick = () => done(cur.path || null);
      cancel.onclick = () => done(null);
      back.onmousedown = e => { if (e.target === back) done(null); };
      window.addEventListener('keydown', onKey, true);
      row.append(up, cancel, ok);
      box.append(el('div', 'color:var(--accent);letter-spacing:2px', '選擇工作目錄'), path, list, note, row);
      back.append(box);
      document.body.append(back);
      void load('');
    });
  }

  // 主控台的更新:一條串流分送給畫面上所有的訂閱者
  const listeners = new Set();
  let banner = null;
  const showBanner = on => {
    if (on && !banner) { banner = el('div', 'position:fixed;top:0;left:0;right:0;z-index:99998;text-align:center;padding:4px;background:rgba(255,77,94,.85);color:#fff', '與主控台的連線中斷,重新連線中…'); document.body.append(banner); }
    if (!on && banner) { banner.remove(); banner = null; }
  };
  function stream() {
    return new Promise(ready => {
      void (async () => {
        let dropped = false;
        for (;;) {
          try {
            const r = await fetch('/api/stream?full=1', { headers: auth() });
            if (r.status === 401) { forget('配對已被撤銷,請重新配對。'); return; }
            if (!r.ok) throw new Error(String(r.status));
            // 斷線期間的更新已經錯過,重新載入整個畫面最保險
            if (dropped) { location.reload(); return; }
            showBanner(false);
            ready();
            const reader = r.body.getReader();
            const dec = new TextDecoder();
            let buf = '';
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += dec.decode(value, { stream: true });
              let i;
              while ((i = buf.indexOf('\n\n')) >= 0) {
                const chunk = buf.slice(0, i);
                buf = buf.slice(i + 2);
                if (!chunk.startsWith('data: ')) continue;
                let u;
                try { u = JSON.parse(chunk.slice(6)); } catch { continue; }
                for (const cb of [...listeners]) { try { cb(u); } catch (e) { console.error(e); } }
              }
            }
          } catch { /* 連不上就稍後重試 */ }
          dropped = true;
          showBanner(true);
          await new Promise(r => setTimeout(r, 2000));
        }
      })();
    });
  }

  // 與 preload/index.ts 相同的函式,右邊是主行程的方法名稱
  const METHODS = {
    getSnapshot: 'snapshot', getHistory: 'history', createAgent: 'create', removeAgent: 'remove', send: 'send', updateAgent: 'updateAgent',
    attachmentPreview: 'attachmentPreview', openTerminal: 'openTerminal', closeTerminal: 'closeTerminal', termAttach: 'termAttach', termWrite: 'termWrite', termResize: 'termResize',
    respondApproval: 'approval', interrupt: 'interrupt', enqueue: 'enqueue', cancelQueued: 'cancelQueued', editQueued: 'editQueued', resumeQueue: 'resumeQueue',
    answerQuestion: 'answer', sleep: 'sleep', wake: 'wake', setAutopilot: 'autopilot', setMaxActive: 'maxActive', getAvatar: 'getAvatar', getPersona: 'getPersona', setPersona: 'setPersona',
    clearFinishedTasks: 'clearTasks', getTaskChanges: 'taskChanges', listOldSessions: 'oldSessions', inspectDir: 'inspectDir', revertTask: 'revertTask', commitTask: 'commitTask',
    sendReviewComments: 'sendReviewComments', requestReview: 'requestReview', worktreeStatus: 'worktreeStatus', mergeWorktree: 'mergeWorktree', openPullRequest: 'openPr',
    setQuotaStop: 'quotaStop', remoteStatus: 'remoteStatus', remoteSet: 'remoteSet', remoteNewCode: 'remoteNewCode', remoteRevoke: 'remoteRevoke', remotePairAccess: 'remotePairAccess', remoteSetDevice: 'remoteSetDevice', remoteAudit: 'remoteAudit',
    observeStatus: 'observeStatus', observeInstall: 'observeInstall', observeUninstall: 'observeUninstall', observeNewToken: 'observeNewToken', observeTakeover: 'observeTakeover',
    openOldSession: 'openOldSession', forkAgent: 'forkAgent', setChief: 'setChief',
  };
  const api = Object.fromEntries(Object.entries(METHODS).map(([name, method]) => [name, (...args) => call(method, ...args)]));
  Object.assign(api, {
    pickFiles,
    pickDirectory,
    uploadFile: f => upload(f, f.name),
    savePastedImage: (mime, data) => upload(new Blob([data], { type: mime }), 'paste'),
    // 瀏覽器拿不到檔案在磁碟上的路徑;畫面看到 uploadFile 存在就會改用上傳
    pathForFile: () => '',
    openPortraitsFolder: async () => { alert('立繪資料夾在主控台所在的電腦上(%APPDATA%\\entropy-nexus\\portraits),請到那台電腦上開啟。'); },
    // 檔案總管在主控台那台電腦上,瀏覽器版不提供
    canReveal: async () => false,
    revealPath: async () => {},
    // 語音模式只在主控台那台電腦的桌面畫面提供(伺服器端也不接受這組呼叫)
    voiceStatus: async () => ({ enabled: false, command: '', defaultCommand: '', model: '', state: 'unsupported', detail: '瀏覽器版不提供語音模式', device: '', log: [], ttsDir: '', ttsModel: '', tts: { state: 'off', detail: '' } }),
    voiceSet: async () => { throw new Error('瀏覽器版不提供語音模式'); },
    voiceTranscribe: async () => { throw new Error('瀏覽器版不提供語音模式'); },
    voiceTts: async () => null,
    voiceTtsPower: async () => { throw new Error('瀏覽器版不提供語音模式'); },
    speechRender: async () => null,
    speechSettings: async () => ({ settings: { engines: [] }, engines: [], clips: [] }),
    speechSet: async () => ({ settings: { engines: [] }, engines: [], clips: [] }),
    speechClip: async () => null,
    voiceCharacters: async () => [],
    voiceProfile: async () => null,
    voiceProfileSave: async () => { throw new Error('瀏覽器版不提供語音模式'); },
    voiceProfileImport: async () => null,
    voiceProfileAudio: async () => null,
    onVoice: () => () => {},
    // 語音播報只在主控台那台電腦的桌面畫面
    onSpeech: () => () => {},
    onUpdate: cb => { listeners.add(cb); return () => { listeners.delete(cb); }; },
  });
  // 權限要等配對確認後才知道,所以到 boot 讀完才凍結
  window.nexus = api;

  /** 配對畫面:輸入桌面主控台「手機」面板上的配對碼。 */
  function gate(message) {
    const back = el('div', BACK + ';background:none');
    const box = el('form', BOX + ';width:360px;max-width:92vw');
    const code = el('input', FIELD + ';font-family:var(--mono);letter-spacing:3px;text-transform:uppercase');
    code.placeholder = '配對碼';
    code.autocomplete = 'off';
    code.value = new URLSearchParams(location.search).get('pair') || '';
    const name = el('input', FIELD);
    name.placeholder = '這台裝置的名稱';
    name.maxLength = 40;
    name.value = /Mac/i.test(navigator.platform) ? 'Mac 瀏覽器' : /Linux/i.test(navigator.platform) ? 'Linux 瀏覽器' : 'Windows 瀏覽器';
    const note = el('div', 'color:var(--bad);min-height:1.5em', message || '');
    const btn = el('button', 'padding:8px', '配對');
    btn.className = 'primary';
    const alt = el('a', 'color:var(--dim);text-align:center', '改用手機版介面');
    alt.href = '/m' + location.search;
    box.onsubmit = async e => {
      e.preventDefault();
      btn.disabled = true;
      try {
        const r = await fetch('/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code.value.trim(), name: name.value.trim() }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || '配對失敗');
        token = j.token;
        localStorage.setItem(KEY, token);
        location.replace(location.pathname);
      } catch (err) { note.textContent = err.message; btn.disabled = false; }
    };
    box.append(
      el('div', 'color:var(--accent);font-size:20px;letter-spacing:4px;font-weight:600', 'ENTROPY NEXUS'),
      el('div', 'color:var(--dim)', '在電腦的主控台按上方的「手機」,輸入面板上的配對碼。配對後這個瀏覽器的權限和坐在那台電腦前相同。'),
      code, name, btn, note, alt,
    );
    back.append(box);
    document.body.append(back);
    (code.value ? name : code).focus();
  }

  const boot = async () => {
    const why = sessionStorage.getItem('nexus.gate');
    sessionStorage.removeItem('nexus.gate');
    if (!token) { gate(why); return; }
    setCookie();
    // 先接上串流再載入畫面,載入期間的更新才不會漏掉
    await stream();
    // 這支裝置的權限:畫面依它隱藏不能用的按鈕(真正的限制在伺服器)
    api.access = (await reply(await fetch('/api/state', { headers: auth() }))).access || { role: 'full', agents: null };
    Object.freeze(api);
    if (api.access.role !== 'full') {
      document.body.classList.add('role-' + api.access.role);
      const scope = api.access.agents ? ` · ${api.access.agents.length} 個節點` : ' · 全部節點';
      document.body.append(el('div', 'position:fixed;left:10px;bottom:6px;z-index:99997;padding:1px 8px;font-size:11px;color:var(--warn);border:1px solid rgba(255,176,32,.45);background:#0a1420;pointer-events:none', (api.access.role === 'viewer' ? '唯讀權限' : '操作權限') + scope));
    }
    await import(new URL(entry, location.href).href);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void boot()); else void boot();
})();
