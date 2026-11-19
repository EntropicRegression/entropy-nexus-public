// Antigravity 剩餘額度的驗收(真正的 agy,不送任何指令所以不花額度):
// 節點啟動後要取得各模型群組的額度,資訊卡只顯示節點模型所屬的那一組。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const shot = async n => { document.title = 'SHOT:' + n; await wait(900); document.title = 'SHOT:' + n + '-b'; await wait(900); };
  try {
    await wait(3000);
    const cwd = window.__TEST_CWD__;
    const specs = [['Agy-Flash', 'gemini-3.8-flash-low'], ['Agy-Claude', 'claude-sonnet-5-5-low'], ['Agy-Argon', 'gemini-4-argon-low'], ['Agy-Default', '']];
    for (const [name, model] of specs) await window.nexus.createAgent({ name, character: '', model, backend: 'antigravity', cwd, permissionMode: 'ask' });
    let u;
    for (let i = 0; i < 20 && !(u?.windows.length); i++) { await wait(1500); u = (await window.nexus.getSnapshot()).usage.find(x => x.backend === 'antigravity'); }
    log('額度', JSON.stringify(u?.windows.map(w => `${w.group}/${w.label} 已用${Math.round(w.used * 100)}% 重置${w.resetsAt ? new Date(w.resetsAt * 1000).toISOString().slice(5, 16) : '-'} [${(w.match || []).join('|')}]`)));
    log('unsupported', u?.unsupported);
    for (const [name] of specs) {
      const row = [...document.querySelectorAll('.row')].find(x => x.textContent.includes(name));
      row?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await wait(700);
      log(name, '→', document.querySelector('.hovercard')?.textContent.replace(/\s+/g, ' ').slice(0, 160));
      if (name === 'Agy-Flash') await shot('hover');
      row?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      await wait(300);
    }
    for (const a of (await window.nexus.getSnapshot()).agents) await window.nexus.removeAgent(a.id);
  } catch (err) { log('失敗', err.message); }
  document.title = 'QUIT';
})();
