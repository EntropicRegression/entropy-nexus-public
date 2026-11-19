// 驗收:變更檢視。工作目錄是一個 git 版本庫,裡面已有一筆「任務開始前就存在」的未提交修改。
// 三家節點依序各做一個修改,檢查每個任務只算到自己期間的變更;最後用非 git 資料夾測替代做法。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const shot = async name => { document.title = `SHOT:${name}`; await wait(900); };
  const snap = () => window.nexus.getSnapshot();
  const DONE = ['idle', 'error', 'lost'];
  const until = async (what, fn, timeout = 200000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await wait(250); }
    throw new Error(`等不到:${what}`);
  };
  const lastTask = async agentId => (await snap()).tasks.filter(t => t.agentId === agentId).sort((a, b) => b.startedAt - a.startedAt)[0];
  // 送出指令,授權一律允許,等任務結束且變更摘要算完
  const run = async (agent, prompt) => {
    await window.nexus.send(agent.id, prompt);
    await until(`${agent.name} 開始`, async () => !DONE.includes((await snap()).agents.find(a => a.id === agent.id).state), 40000);
    await until(`${agent.name} 完成`, async () => {
      const a = (await snap()).agents.find(x => x.id === agent.id);
      if (a.pendingApproval) await window.nexus.respondApproval(a.id, a.pendingApproval.requestId, 'allow');
      return DONE.includes(a.state);
    });
    const t = await until(`${agent.name} 的變更摘要`, async () => { const x = await lastTask(agent.id); return x?.endedAt && x.changes && (x.changes.end || !x.changes.git) ? x : null; }, 30000);
    const set = await window.nexus.getTaskChanges(t.id);
    log(agent.name, '任務', t.status, '| 摘要', JSON.stringify({ git: t.changes.git, files: t.changes.files, added: t.changes.added, removed: t.changes.removed }),
      '| 檔案', JSON.stringify(set.files.map(f => `${f.status} ${f.path} +${f.added} -${f.removed}`)), set.note ? `| 備註 ${set.note.slice(0, 30)}…` : '');
    return { task: t, set };
  };

  try {
    const cwd = window.__TEST_CWD__;
    const cl = await window.nexus.createAgent({ name: 'Claude-R', character: '', model: 'haiku', backend: 'claude', cwd, permissionMode: 'ask' });
    const cx = await window.nexus.createAgent({ name: 'Codex-R', character: '', model: '', backend: 'codex', cwd, permissionMode: 'ask' });
    const ag = await window.nexus.createAgent({ name: 'Agy-R', character: '', model: 'gemini-3.8-flash-low', backend: 'antigravity', cwd, permissionMode: 'ask' });
    await until('三個節點待命', async () => (await snap()).agents.every(a => a.state === 'idle'), 60000);

    const r1 = await run(cl, '請把 app.js 裡的函式名稱 greet 改成 hello(定義與呼叫都要改),並新增一個檔案 CHANGELOG.md,內容是「- 改名 greet 為 hello」。不要動其他檔案。完成後只回覆「完成」。');
    log('Claude 的差異是否包含任務前就存在的 dirty.txt', r1.set.files.some(f => f.path.includes('dirty.txt')));
    log('app.js 的差異片段', JSON.stringify((r1.set.files.find(f => f.path.endsWith('app.js'))?.patch ?? '').split('\n').filter(l => /^[+-]/.test(l)).slice(0, 6)));

    // 在畫面上打開變更檢視
    const chip = [...document.querySelectorAll('.task-changes')][0];
    log('任務面板的變更標籤', chip?.textContent);
    chip.click();
    await wait(900);
    log('檢視畫面', document.querySelector('.rv-sum')?.textContent, '| 檔案列', JSON.stringify([...document.querySelectorAll('.rv-file')].map(f => f.textContent)), '| 紅綠行數', document.querySelectorAll('.rv-diff .ln.rm').length, document.querySelectorAll('.rv-diff .ln.ins').length);
    await wait(600);
    await shot('1-review-claude');
    await shot('1-review-claude');
    document.querySelectorAll('.rv-file')[1]?.click();
    await wait(400);
    await shot('2-review-second-file');
    document.querySelector('.review .ghost').click();
    await wait(300);

    await run(cx, '請用 shell 指令(不要用 apply_patch)刪除 old.txt,並在 notes.txt 最後加上一行「codex 到此一遊」。不要動其他檔案。完成後只回覆「完成」。');
    await run(ag, '請建立 agy.md,內容是「# Antigravity」。不要動其他檔案。完成後只回覆「完成」。');
    await shot('3-task-panel');

    // 非 git 資料夾:只能列出編輯工具回報的修改
    const plain = await window.nexus.createAgent({ name: 'Claude-NoGit', character: '', model: 'haiku', backend: 'claude', cwd: window.__TEST_CWD__.replace(/repo ws$/, 'plain ws'), permissionMode: 'ask' });
    await until('非 git 節點待命', async () => (await snap()).agents.find(a => a.id === plain.id).state === 'idle', 60000);
    const r4 = await run(plain, '請用 Write 工具建立 plain.txt,內容是兩行:第一行 a,第二行 b。完成後只回覆「完成」。');
    [...document.querySelectorAll('.task')].find(t => t.textContent.includes('Claude-NoGit'))?.querySelector('.task-changes')?.click();
    await wait(900);
    log('非 git 的檢視畫面備註', document.querySelector('.rv-note')?.textContent?.slice(0, 40), '| 來源', r4.set.source);
    await shot('4-review-nogit');
    log('全部步驟完成');
  } catch (err) {
    log('失敗', err.message);
    await shot('9-failed');
  }
  await wait(500);
  document.title = 'QUIT';
})();
