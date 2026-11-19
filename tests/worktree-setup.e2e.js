// 缺口 1 驗收(假資料模式):獨立工作區建立後的環境初始化。由 tests/worktree-setup.sh 啟動兩次。
// 第一次:在兩個測試版本庫(沒有/有 .worktreeinclude)各建立一個獨立工作區節點,檢查對話裡的初始化摘要。
// 第二次(同一份資料夾,節點已存在):終止節點,讓主控台移除工作區;檔案系統由外部的 sh 檢查。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const err = e => String(e.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  try {
    const base = window.__TEST_CWD__;
    await window.nexus.setAutopilot(false);
    const iso = (await window.nexus.getSnapshot()).agents.filter(a => a.worktree);
    if (!iso.length) {
      for (const [name, repo] of [['EnvA', 'repo-a'], ['EnvB', 'repo-b']]) {
        // 從子資料夾 app 建立,工作區裡也要進到同一個子資料夾
        const a = await window.nexus.createAgent({ isolate: true, name, character: '', model: '', backend: 'claude', cwd: `${base}\\${repo}\\app`, permissionMode: 'ask' });
        await wait(600);
        const note = (await window.nexus.getHistory(a.id)).find(e => e.type === 'note' && e.text.includes('環境初始化'));
        log(`${name} 工作區`, a.worktree.path, '| cwd', a.cwd);
        log(`${name} 初始化摘要`, note ? note.text : '(沒有)');
        log(`${name} 工作區狀態`, JSON.stringify(await window.nexus.worktreeStatus(a.id)));
      }
      log('第一階段完成');
    } else {
      for (const a of iso) {
        log(`${a.name} 終止前狀態`, JSON.stringify(await window.nexus.worktreeStatus(a.id)));
        await window.nexus.removeAgent(a.id);
      }
      log('剩下的節點', (await window.nexus.getSnapshot()).agents.filter(a => a.worktree).length);
      log('第二階段完成');
    }
  } catch (e) {
    log('失敗', err(e));
  }
  await wait(400);
  document.title = 'QUIT';
})();
