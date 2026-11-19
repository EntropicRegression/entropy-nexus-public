// Claude 剩餘額度的驗收(真正的 claude,不送任何指令所以不花額度):
// 節點一啟動就要取得最新額度;模型專屬的每週額度只顯示在使用該模型的節點上;模型選項要有 fable。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const shot = async n => { document.title = 'SHOT:' + n; await wait(900); document.title = 'SHOT:' + n + '-b'; await wait(900); };
  try {
    await wait(3000);
    const cwd = window.__TEST_CWD__;
    const snap = await window.nexus.getSnapshot();
    log('模型選項', JSON.stringify(snap.capabilities.find(c => c.backend === 'claude')?.models));
    log('啟動前的額度', JSON.stringify(snap.usage.find(x => x.backend === 'claude')?.windows ?? []));
    const specs = [['C-Opus', 'opus'], ['C-Fable', 'fable']];
    for (const [name, model] of specs) await window.nexus.createAgent({ name, character: '', model, backend: 'claude', cwd, permissionMode: 'ask' });
    let u;
    for (let i = 0; i < 20 && !(u?.windows.length); i++) { await wait(1500); u = (await window.nexus.getSnapshot()).usage.find(x => x.backend === 'claude'); }
    log('額度', JSON.stringify(u?.windows.map(w => `${w.label} 已用${Math.round(w.used * 100)}% 重置${w.resetsAt ? new Date(w.resetsAt * 1000).toString().slice(4, 21) : '-'}${w.group ? ` [${w.group}]` : ''}`)));
    for (const [name] of specs) {
      const row = [...document.querySelectorAll('.row')].find(x => x.textContent.includes(name));
      row?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await wait(700);
      log(name, '→', document.querySelector('.hovercard')?.textContent.replace(/\s+/g, ' ').slice(0, 200));
      if (name === 'C-Fable') await shot('hover');
      row?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      await wait(300);
    }
    for (const a of (await window.nexus.getSnapshot()).agents) await window.nexus.removeAgent(a.id);
  } catch (err) { log('失敗', err.message); }
  document.title = 'QUIT';
})();
