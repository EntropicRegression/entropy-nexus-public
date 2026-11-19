// 階段 7 驗收(真實 CLI):獨立工作區、還原與提交、合併、花費。
// 工作目錄是一個已有提交的 git 版本庫(見 tests/stage7.sh)。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const shot = async name => { document.title = `SHOT:${name}`; await wait(900); };
  const snap = () => window.nexus.getSnapshot();
  const DONE = ['idle', 'error', 'lost'];
  const until = async (what, fn, timeout = 200000) => { const t0 = Date.now(); while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await wait(250); } throw new Error(`等不到:${what}`); };
  const agentOf = async id => (await snap()).agents.find(a => a.id === id);
  const lastTask = async id => (await snap()).tasks.filter(t => t.agentId === id).sort((a, b) => b.startedAt - a.startedAt)[0];
  const err = e => String(e.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  // 同時跑多個節點,授權一律允許,等全部結束且變更摘要算完
  const runAll = async jobs => {
    for (const [a, prompt] of jobs) await window.nexus.send(a.id, prompt);
    await until('開始', async () => (await Promise.all(jobs.map(([a]) => agentOf(a.id)))).every(a => !DONE.includes(a.state)), 60000);
    await until('完成', async () => {
      let all = true;
      for (const [a] of jobs) { const x = await agentOf(a.id); if (x.pendingApproval) await window.nexus.respondApproval(x.id, x.pendingApproval.requestId, 'allow'); if (!DONE.includes(x.state)) all = false; }
      return all;
    });
    await until('變更摘要', async () => (await Promise.all(jobs.map(([a]) => lastTask(a.id)))).every(t => t?.endedAt && t.changes?.end), 40000);
  };
  const files = async id => { const t = await lastTask(id); const set = await window.nexus.getTaskChanges(t.id); return set.files.map(f => `${f.status} ${f.path} +${f.added} -${f.removed}`); };

  try {
    const cwd = window.__TEST_CWD__;
    log('資料夾檢查', JSON.stringify(await window.nexus.inspectDir(cwd)), '| 非版本庫', JSON.stringify(await window.nexus.inspectDir(cwd.replace(/repo$/, 'plain'))));

    // 1. 兩個節點各自在獨立工作區裡改同一個檔案
    const a = await window.nexus.createAgent({ isolate: true, name: 'Iso-A', character: '', model: 'haiku', backend: 'claude', cwd, permissionMode: 'ask' });
    const b = await window.nexus.createAgent({ isolate: true, name: 'Iso-B', character: '', model: 'gemini-3.8-flash-low', backend: 'antigravity', cwd, permissionMode: 'ask' });
    await until('兩個節點待命', async () => (await snap()).agents.every(x => x.state === 'idle'), 60000);
    log('Iso-A 工作區', a.worktree.branch, '基於', a.worktree.base, '| 資料夾不同於原版本庫', a.cwd !== cwd, '| 兩個節點資料夾不同', a.cwd !== b.cwd);
    await runAll([
      [a, '請把 app.js 裡的函式名稱 greet 改成 hello(定義與呼叫都要改)。不要動其他檔案,不要提交。完成後只回覆「完成」。'],
      [b, '請在 app.js 的最後面加上一行註解「// reviewed by B」。其他內容都不要改,不要提交。完成後只回覆「完成」。'],
    ]);
    log('Iso-A 的變更', JSON.stringify(await files(a.id)));
    log('Iso-B 的變更', JSON.stringify(await files(b.id)));
    const ta = await lastTask(a.id), tb = await lastTask(b.id);
    log('花費 Iso-A', JSON.stringify(ta.cost), '| Iso-B', JSON.stringify(tb.cost), '| 節點累計', JSON.stringify((await agentOf(a.id)).spent));
    log('工作區狀態 A', JSON.stringify(await window.nexus.worktreeStatus(a.id)), '| B', JSON.stringify(await window.nexus.worktreeStatus(b.id)));

    // 畫面:對話視窗的工作區列、變更檢視的操作列
    [...document.querySelectorAll('.row')].find(r => r.textContent.includes('Iso-A')).click();
    await wait(700);
    log('對話視窗工作區列', document.querySelector('.dlg-worktree')?.textContent?.replace(/\s+/g, ' ').slice(0, 90));
    await shot('1-worktree-bar');
    await shot('1-worktree-bar-b');
    document.querySelector('.task-changes')?.click();
    await wait(900);
    log('變更檢視操作列', [...document.querySelectorAll('.rv-actions button, .rv-path button')].map(x => x.textContent).join(' | '));
    await shot('2-review-actions');
    await shot('2-review-actions-b');
    document.querySelector('.review .rv-head .ghost[aria-label="關閉"]').click();

    // 2. 提交 A 的任務,再把兩個工作區依序合併回原本的分支
    log('提交 Iso-A 的任務', await window.nexus.commitTask(ta.id, '把 greet 改名為 hello'), '| 任務標記', (await lastTask(a.id)).changes.committed);
    log('合併 Iso-A', await window.nexus.mergeWorktree(a.id).catch(err));
    log('合併 Iso-B', await window.nexus.mergeWorktree(b.id).catch(err));
    log('合併後狀態 A', JSON.stringify(await window.nexus.worktreeStatus(a.id)));
    log('開 PR(這個版本庫沒有遠端,預期會被擋下)', await window.nexus.openPullRequest(a.id).catch(err));

    // 3. 還原:一般節點(不隔離)在原版本庫做兩個修改,先還原其中一個檔案,再還原整個任務
    const c = await window.nexus.createAgent({ name: 'Plain-C', character: '', model: 'haiku', backend: 'claude', cwd, permissionMode: 'ask' });
    await until('Plain-C 待命', async () => (await agentOf(c.id)).state === 'idle', 60000);
    await runAll([[c, '請用 Write 工具建立 tmp.txt,內容是 temp;再用 Edit 工具在 notes.txt 最後加上一行「C 加的一行」。不要動其他檔案,不要提交。完成後只回覆「完成」。']]);
    const tc = await lastTask(c.id);
    log('Plain-C 的變更', JSON.stringify(await files(c.id)));
    log('還原單一檔案', JSON.stringify(await window.nexus.revertTask(tc.id, ['notes.txt'])), '| 剩下', JSON.stringify(await files(c.id)));
    log('還原整個任務', JSON.stringify(await window.nexus.revertTask(tc.id, null)), '| 剩下', JSON.stringify(await files(c.id)));

    // 4. 終止:已合併且乾淨的工作區會自動移除
    await window.nexus.removeAgent(a.id);
    await window.nexus.removeAgent(b.id);
    await wait(2500);
    log('終止後面板節點', (await snap()).agents.map(x => x.name).join(','));
    log('全部步驟完成');
  } catch (e) {
    log('失敗', err(e));
    await shot('9-failed');
  }
  await wait(500);
  document.title = 'QUIT';
})();
