// 驗收(假資料模式):分支對話。NEXUS_FAKE=1、NEXUS_FAKE_FORK_LAZY=1(模擬 Claude Code:分支的 session 要等第一句指令才建立)。
// 第一次執行:建立節點 → 對話 → 從對話視窗按「分支對話」建立獨立工作區的分支 → 檢查新 session、複製的紀錄與說明、
// 分支來源只用一次(休眠、喚醒、換模型)→ 來源忙碌時分支 → 從舊 session(CLI 的對話、已終止的節點)分支 →
// 留一個還沒建立 session 的分支後結束。第二次執行(同一個資料夾):確認重開後那個分支仍從來源分支。
// NEXUS_TEST_CWD 要指向一個有提交的 git 版本庫。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const shot = async name => { document.title = `SHOT:${name}`; await wait(900); };
  const snap = () => window.nexus.getSnapshot();
  const DONE = ['idle', 'error', 'lost'];
  const until = async (what, fn, timeout = 30000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await wait(150); }
    throw new Error(`等不到:${what}`);
  };
  const agentOf = async id => (await snap()).agents.find(a => a.id === id);
  const byName = async name => (await snap()).agents.find(a => a.name === name);
  const ask = async (id, text) => {
    await window.nexus.send(id, text);
    await until('開始', async () => !DONE.includes((await agentOf(id)).state), 10000);
    await until('完成', async () => DONE.includes((await agentOf(id)).state));
  };
  const history = async id => (await window.nexus.getHistory(id)).filter(e => ['message', 'note', 'tool', 'error'].includes(e.type));
  const userTexts = async id => (await window.nexus.getHistory(id)).filter(e => e.type === 'message' && e.role === 'user').map(e => e.text);
  const notes = async id => (await window.nexus.getHistory(id)).filter(e => e.type === 'note').map(e => e.text);
  const clean = e => String(e.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  let pass = 0, fail = 0;
  const check = (label, ok, extra = '') => { if (ok) pass++; else fail++; log(ok ? 'PASS' : 'FAIL', label, extra); };

  try {
    await window.nexus.setAutopilot(false);
    const cwd = window.__TEST_CWD__;
    const pending = await byName('丁-待續');
    if (pending) {
      // ---- 第二次執行:重開後,還沒建立 session 的分支仍要從來源分支
      check('重開後待續的分支仍沒有 session id', pending.sessionId === null, `sessionId=${pending.sessionId}`);
      await window.nexus.wake(pending.id);
      const w = await until('喚醒', async () => { const a = await agentOf(pending.id); return a.state === 'idle' && a; });
      check('重開後喚醒仍以分支啟動', w.detail === '已分支', `detail=${w.detail}`);
      await ask(pending.id, '重開後的第一句');
      const after = await agentOf(pending.id);
      check('第一句後拿到自己的 session id', Boolean(after.sessionId) && after.sessionId !== (await byName('甲')).sessionId, after.sessionId);
      log(`結果 PASS=${pass} FAIL=${fail}`);
      document.title = 'QUIT';
      return;
    }

    // ---- 1. 建立來源節點並對話
    const src = await window.nexus.createAgent({ name: '甲', character: '', model: '', backend: 'claude', cwd, permissionMode: 'auto' });
    await until('甲 待命', async () => (await agentOf(src.id)).state === 'idle');
    await ask(src.id, '暗號是 5521,請記住');
    const srcSession = (await agentOf(src.id)).sessionId;
    log('甲 session', srcSession);

    // ---- 2. 從對話視窗按「分支對話」
    [...document.querySelectorAll('.roster .row')].find(r => r.textContent.includes('甲')).click();
    await until('對話視窗', () => document.querySelector('.dlg-id'));
    const forkBtn = await until('分支對話按鈕', () => [...document.querySelectorAll('.dlg-id button')].find(b => b.textContent === '分支對話'));
    check('甲 的分支對話按鈕可用', !forkBtn.disabled);
    forkBtn.click();
    const panel = await until('分支面板', () => document.querySelector('.fork-panel'));
    const nameInput = panel.querySelector('input[aria-label="新節點名稱"]');
    check('預設名稱是「原名-分支」', nameInput.value === '甲-分支', nameInput.value);
    const iso = await until('獨立工作區可勾選', () => { const c = panel.querySelector('input[type=checkbox]'); return c && !c.disabled && c; });
    check('沒勾獨立工作區時顯示同資料夾警告', [...panel.querySelectorAll('.form-warn')].some(w => w.textContent.includes('互相覆寫')));
    await shot('fork-1-panel');
    iso.click();
    await until('勾選後警告消失', () => ![...panel.querySelectorAll('.form-warn')].some(w => w.textContent.includes('互相覆寫')));
    [...panel.querySelectorAll('button')].find(b => b.textContent === '建立分支').click();
    const b = await until('甲-分支 出現', () => byName('甲-分支'));
    await until('甲-分支 待命', async () => (await agentOf(b.id)).state === 'idle');
    await until('對話視窗切到新節點', () => document.querySelector('.dlg-id b')?.textContent === '甲-分支');
    let bi = await agentOf(b.id);
    check('分支有獨立工作區', Boolean(bi.worktree), bi.worktree ? bi.worktree.branch : '');
    check('分支啟動時是「已分支」', bi.detail === '已分支', bi.detail);
    check('第一句之前還沒有 session id(模擬 Claude Code)', bi.sessionId === null, String(bi.sessionId));
    check('複製了來源的對話', (await userTexts(b.id)).includes('暗號是 5521,請記住'), JSON.stringify(await userTexts(b.id)));
    const n1 = (await notes(b.id))[0] ?? '';
    check('有分支說明', n1.includes('從節點「甲」的對話分支') && n1.includes(srcSession), n1);
    check('分支說明在複製的紀錄之後', (await history(b.id)).at(-1)?.type === 'note');
    check('還沒有 session 時分支按鈕停用', [...document.querySelectorAll('.dlg-id button')].find(x => x.textContent === '分支對話')?.disabled === true);
    let err = '';
    try { await window.nexus.forkAgent({ source: { kind: 'agent', agentId: b.id }, name: 'x' }); } catch (e) { err = clean(e); }
    check('沒有 session 的節點不能當來源', err.includes('還沒有建立 session'), err);
    await shot('fork-2-new-node');

    // ---- 3. 新 session id 還沒回報就休眠:喚醒後仍從來源分支
    await window.nexus.sleep(b.id);
    await window.nexus.wake(b.id);
    bi = await until('喚醒', async () => { const a = await agentOf(b.id); return a.state === 'idle' && a; });
    check('沒拿到新 id 前休眠,喚醒仍以分支啟動', bi.detail === '已分支' && bi.sessionId === null, bi.detail);
    await ask(b.id, '分支裡的第一句');
    bi = await agentOf(b.id);
    const forkSession = bi.sessionId;
    check('分支拿到自己的 session id', Boolean(forkSession) && forkSession !== srcSession, `${forkSession} vs ${srcSession}`);
    await window.nexus.sleep(b.id);
    await window.nexus.wake(b.id);
    bi = await until('喚醒', async () => { const a = await agentOf(b.id); return a.state === 'idle' && a; });
    check('之後喚醒用新 id 續接', bi.detail === '已續接' && bi.sessionId === forkSession, `${bi.detail} ${bi.sessionId}`);
    await window.nexus.updateAgent(b.id, { model: 'sonnet' });
    bi = await until('換模型後待命', async () => { const a = await agentOf(b.id); return a.state === 'idle' && a; });
    check('換模型重啟也用新 id 續接', bi.detail === '已續接' && bi.sessionId === forkSession, `${bi.detail} ${bi.sessionId}`);

    // ---- 4. 來源不受影響,而且忙碌時也能分支
    await ask(src.id, '甲 繼續工作');
    check('來源 session 不變', (await agentOf(src.id)).sessionId === srcSession);
    check('來源的紀錄沒有分支的內容', !(await userTexts(src.id)).includes('分支裡的第一句'));
    await window.nexus.send(src.id, '一個比較久的任務');
    await until('甲 執行中', async () => !DONE.includes((await agentOf(src.id)).state), 10000);
    const busyFork = await window.nexus.forkAgent({ source: { kind: 'agent', agentId: src.id }, name: '乙', model: 'haiku', character: '' });
    const n2 = (await notes(busyFork.id))[0] ?? '';
    check('忙碌時分支有提醒分支點', n2.includes('仍在執行') && n2.includes('已寫入紀錄'), n2);
    check('分支可指定模型', busyFork.model === 'haiku', busyFork.model);
    check('不隔離時和來源同一個資料夾', busyFork.cwd === src.cwd && busyFork.worktree === null);
    await until('甲 完成', async () => DONE.includes((await agentOf(src.id)).state));

    // ---- 5. 從舊 session 分支:CLI 的對話只放說明;已終止的節點複製它的紀錄
    const cli = await window.nexus.forkAgent({ source: { kind: 'session', backend: 'codex', sessionId: 'cli-session-001', cwd, agentId: null }, name: '丙' });
    const ch = await history(cli.id);
    check('CLI 舊對話的分支只有說明', ch.length === 1 && ch[0].type === 'note' && ch[0].text.includes('Codex 的舊對話'), JSON.stringify(ch.map(e => e.type)));
    check('CLI 舊對話的分支後台正確', cli.backend === 'codex');
    const gone = await window.nexus.createAgent({ name: '戊', character: '', model: 'opus', backend: 'claude', cwd, permissionMode: 'auto' });
    await until('戊 待命', async () => (await agentOf(gone.id)).state === 'idle');
    await ask(gone.id, '戊 說過的話');
    const goneSession = (await agentOf(gone.id)).sessionId;
    await window.nexus.removeAgent(gone.id);
    const revived = await window.nexus.forkAgent({ source: { kind: 'session', backend: 'claude', sessionId: goneSession, cwd, agentId: gone.id }, name: '戊-分支' });
    check('已終止節點的分支複製了紀錄', (await userTexts(revived.id)).includes('戊 說過的話'));
    check('已終止節點的分支沿用模型', revived.model === 'opus', revived.model);
    check('已終止節點的說明', ((await notes(revived.id))[0] ?? '').includes('已終止的節點「戊」'));

    // ---- 6. 留一個還沒建立 session 的分支,下次啟動時檢查
    const d = await window.nexus.forkAgent({ source: { kind: 'agent', agentId: src.id }, name: '丁-待續' });
    await until('丁 待命', async () => (await agentOf(d.id)).state === 'idle');
    await window.nexus.sleep(d.id);
    log(`結果 PASS=${pass} FAIL=${fail}`);
  } catch (err) {
    log('FAIL 例外', clean(err));
  }
  document.title = 'QUIT';
})();
