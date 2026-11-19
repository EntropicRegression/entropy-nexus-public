// 驗收:變更檢視的行內評論、送回此節點修改、送交其他節點審查。
// 用假資料轉接器執行(NEXUS_FAKE=1),由 tests/review-comments.sh 啟動;NEXUS_FAKE_SNAPSHOT=1 讓假資料節點也拍工作區快照,
// 截圖「1-task-started」出現後,外層腳本會直接修改測試版本庫的檔案,當作這個任務做的修改。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const shot = async name => { document.title = `SHOT:${name}`; await wait(900); };
  const snap = () => window.nexus.getSnapshot();
  const until = async (what, fn, timeout = 60000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await wait(200); }
    throw new Error(`等不到:${what}`);
  };
  const agentOf = async id => (await snap()).agents.find(a => a.id === id);
  // React 受控元件要用原生的 setter 設值再送出事件,狀態才會更新
  const setValue = (el, v) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  };
  const button = (text, root = document) => [...root.querySelectorAll('button')].find(b => b.textContent.trim() === text);
  const comment = async (row, text) => {
    row.click();
    await wait(200);
    const ta = document.querySelector('.rv-cmt.edit textarea');
    setValue(ta, text);
    await wait(100);
    button('新增評論').click();
    await wait(200);
  };
  const lastUser = async id => (await window.nexus.getHistory(id)).filter(e => e.type === 'message' && e.role === 'user').slice(-1)[0]?.text ?? '';
  const notes = async id => (await window.nexus.getHistory(id)).filter(e => e.type === 'note').map(e => e.text);

  try {
    await window.nexus.setAutopilot(false);
    const cwd = window.__TEST_CWD__;
    const other = cwd.replace(/repo$/, 'other');
    const a = await window.nexus.createAgent({ name: 'Author-A', character: '', model: 'opus', backend: 'claude', cwd, permissionMode: 'ask' });
    const b = await window.nexus.createAgent({ name: 'Codex-B', character: '', model: '', backend: 'codex', cwd, permissionMode: 'ask' });
    const c = await window.nexus.createAgent({ name: 'Agy-C', character: '', model: '', backend: 'antigravity', cwd: other, permissionMode: 'ask' });
    const d = await window.nexus.createAgent({ name: 'Sleepy-D', character: '', model: '', backend: 'codex', cwd, permissionMode: 'ask' });
    await until('四個節點待命', async () => (await snap()).agents.every(x => x.state === 'idle'));
    await window.nexus.sleep(d.id);
    await until('D 休眠', async () => (await agentOf(d.id)).state === 'sleeping');

    // A 的任務:假資料節點先提問並等待;這段期間由外層腳本修改檔案
    await window.nexus.send(a.id, '請先提問再修改 app.js');
    await until('A 提問', async () => (await agentOf(a.id)).pendingQuestion);
    const task = (await snap()).tasks.find(t => t.agentId === a.id);
    log('任務開始,快照', JSON.stringify(task.changes));
    await shot('1-task-started');
    const live = await until('外層腳本修改的檔案出現在差異裡', async () => { const s = await window.nexus.getTaskChanges(task.id); return s.files.length >= 4 ? s : null; }, 30000);
    log('執行中的差異', JSON.stringify(live.files.map(f => `${f.status} ${f.path} +${f.added} -${f.removed}${f.binary ? ' 二進位' : ''}`)));
    const q = (await agentOf(a.id)).pendingQuestion;
    await window.nexus.answerQuestion(a.id, q.requestId, { q1: ['紅色'] });
    const done = await until('A 的任務結束且結束快照算完', async () => { const t = (await snap()).tasks.find(x => x.id === task.id); return t.endedAt && t.changes?.end ? t : null; });
    log('任務結束', done.status, JSON.stringify({ files: done.changes.files, added: done.changes.added, removed: done.changes.removed }));

    // 開啟變更檢視
    await wait(500);
    const chip = [...document.querySelectorAll('.task')].find(t => t.textContent.includes('Author-A'))?.querySelector('.task-changes');
    chip.click();
    await until('變更檢視', async () => document.querySelector('.rv-file'));
    log('檔案列', JSON.stringify([...document.querySelectorAll('.rv-file')].map(f => f.textContent)));
    [...document.querySelectorAll('.rv-file')].find(f => f.textContent.includes('app.js')).click();
    await wait(300);
    const lines = [...document.querySelectorAll('.rv-diff .ln')];
    log('app.js 的差異行(舊號|新號|內容)', JSON.stringify(lines.map(l => [...l.querySelectorAll('.ln-no')].map(n => n.textContent).join('|') + '|' + l.textContent.replace(/^\d*\d*/, '').slice(0, 40))));
    log('可評論的行數', document.querySelectorAll('.rv-diff .ln.can').length, '/', lines.length, '| hunk 標頭可評論?', document.querySelector('.rv-diff .ln.hunk')?.classList.contains('can'));

    const ins = lines.find(l => l.classList.contains('ins') && l.textContent.includes('`hi ${name}`'));
    const rm = lines.find(l => l.classList.contains('rm') && l.textContent.includes('"hi " + name'));
    const tailRm = lines.find(l => l.classList.contains('rm') && l.textContent.includes('old tail'));
    await comment(ins, '模板字串可以,但 name 是 undefined 時要給預設值');
    await comment(rm, '原本的寫法為什麼要刪?');
    await comment(tailRm, '這個函式還有人呼叫,不能刪');
    // 再加一則,之後刪掉
    await comment(lines.find(l => l.classList.contains('can') && !l.classList.contains('ins') && !l.classList.contains('rm')), '要刪掉的評論');
    log('評論方塊', JSON.stringify([...document.querySelectorAll('.rv-diff .rv-cmt')].map(x => x.querySelector('.rv-cmt-at').textContent + ' :: ' + x.querySelector('.rv-cmt-text').textContent)));
    // 編輯第一則
    const first = [...document.querySelectorAll('.rv-diff .rv-cmt')].find(x => x.textContent.includes('預設值'));
    button('編輯', first).click();
    await wait(200);
    setValue(document.querySelector('.rv-cmt.edit textarea'), '模板字串可以,但 name 是 undefined 時要給預設值 "訪客"');
    button('儲存').click();
    await wait(200);
    // 刪除多的那一則
    button('刪除', [...document.querySelectorAll('.rv-diff .rv-cmt')].find(x => x.textContent.includes('要刪掉的評論'))).click();
    await wait(200);
    // 整體意見
    button('新增整體意見').click();
    await wait(200);
    setValue(document.querySelector('.rv-general textarea'), '整體來說請補上單元測試');
    button('新增評論').click();
    await wait(200);
    log('底部', document.querySelector('.rv-foot .rv-count').textContent, '| 檔案列的評論數', JSON.stringify([...document.querySelectorAll('.rv-cnt')].map(x => x.textContent)), '| 送回按鈕可按', !button('送回此節點修改').disabled);
    await shot('2-comments');

    // 送回此節點修改
    button('送回此節點修改').click();
    const prompt = await until('A 收到評論指令', async () => { const t = await lastUser(a.id); return t.includes('審查意見') ? t : null; }, 15000);
    await wait(300);
    log('送出後的提示', document.querySelector('.rv-note.ok')?.textContent, '| 剩下評論', document.querySelector('.rv-foot .rv-count').textContent);
    log('A 收到的指令全文 >>>');
    for (const l of prompt.split('\n')) log('  |', l);
    log('<<<');
    await shot('3-sent-back');

    // 送交其他節點審查
    const select = document.querySelector('.rv-reviewer');
    log('審查下拉選單', JSON.stringify([...select.options].map(o => o.textContent)));
    // 直接呼叫的防呆
    for (const [label, id] of [['自己', a.id], ['休眠節點', d.id]]) {
      try { await window.nexus.requestReview(task.id, id); log(label, '沒有被擋下(不應該)'); } catch (e) { log(`送給${label}審查被擋下:`, String(e.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
    }
    setValue(select, c.id);
    const reviewPrompt = await until('C 收到審查請求', async () => { const t = await lastUser(c.id); return t.includes('審查請求') ? t : null; }, 15000);
    await wait(500);
    log('送審後的提示', document.querySelector('.rv-note.ok')?.textContent);
    log('C 收到的審查請求 >>>');
    for (const l of reviewPrompt.split('\n')) log('  |', l);
    log('<<< 全長', reviewPrompt.length);
    log('審查請求包含:不要修改', reviewPrompt.includes('不要修改任何檔案'), '| 完整 diff', reviewPrompt.includes('## 完整 diff'), '| 二進位只列檔名', reviewPrompt.includes('logo.png(二進位檔,只列檔名)') && !reviewPrompt.includes('### logo.png'), '| 工作目錄不同的說明', reviewPrompt.includes('這不是你目前的工作目錄'));
    log('C 的對話備註', JSON.stringify(await notes(c.id)));
    log('A 的對話備註', JSON.stringify(await notes(a.id)));
    // B 跟 A 在同一個工作目錄
    setValue(document.querySelector('.rv-reviewer'), b.id);
    const bPrompt = await until('B 收到審查請求', async () => { const t = await lastUser(b.id); return t.includes('審查請求') ? t : null; }, 15000);
    log('B 的審查請求說明工作目錄相同', bPrompt.includes('就是你目前的工作目錄'));
    // 開 C 的對話視窗截圖
    document.querySelector('.review .ghost').click();
    await wait(300);
    [...document.querySelectorAll('.row')].find(r => r.textContent.includes('Agy-C'))?.click();
    await wait(900);
    await shot('4-reviewer-dialog');

    // 原節點被移除後:送回按鈕停用並說明
    await until('A 停下來', async () => ['idle', 'error'].includes((await agentOf(a.id)).state), 30000);
    await window.nexus.removeAgent(a.id);
    await wait(500);
    document.querySelector('button[aria-label="關閉"]')?.click();
    await wait(300);
    const chip2 = [...document.querySelectorAll('.task')].find(t => t.querySelector('.task-title')?.textContent === '請先提問再修改 app.js')?.querySelector('.task-changes');
    if (chip2) {
      chip2.click();
      await until('變更檢視', async () => document.querySelector('.rv-file'));
      [...document.querySelectorAll('.rv-diff .ln.can')][1]?.click();
      await wait(200);
      setValue(document.querySelector('.rv-cmt.edit textarea'), '節點不在了');
      button('新增評論').click();
      await wait(300);
      log('節點移除後:送回按鈕停用', button('送回此節點修改').disabled, '| 說明', document.querySelector('.rv-why')?.textContent);
      try { await window.nexus.sendReviewComments(task.id, [{ path: null, row: null, side: null, line: null, text: 'x' }]); log('直接呼叫沒有被擋下(不應該)'); } catch (e) { log('直接呼叫被擋下:', String(e.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
      await shot('5-author-removed');
    } else log('移除節點後任務面板找不到這個任務', JSON.stringify([...document.querySelectorAll('.task')].map(t => t.textContent.slice(0, 60))));
    log('全部步驟完成');
  } catch (err) {
    log('失敗', err.message);
    await shot('9-failed');
  }
  await wait(500);
  document.title = 'QUIT';
})();
