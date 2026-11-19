// 背景子代理也要顯示在面板上。由 tests/bg-subagent.sh 啟動:Claude Code 轉接器接到假的 CLI(tests/claude-fake-cli.js),
// 它照劇本啟動一個背景子代理與一個前景子代理。檢查背景的子節點在工具回報「已啟動」與回合結束後都還在,
// 收到進度時更新狀態,收到完成通知後才結束並移除;前景的維持原本的行為。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const until = async (what, fn, timeout = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await wait(100); }
    throw new Error(`等不到:${what}`);
  };
  let bad = 0;
  const expect = (label, ok, detail = '') => { if (!ok) bad++; log(`${ok ? '通過' : '不符'}:${label}${detail ? ` → ${detail}` : ''}`); };
  const agents = async () => (await window.nexus.getSnapshot()).agents;
  try {
    const a = await window.nexus.createAgent({ name: 'Boss', character: '', model: '', backend: 'claude', cwd: window.__TEST_CWD__, permissionMode: 'ask' });
    await until('節點待命', async () => (await agents()).find(x => x.id === a.id && x.state === 'idle'));
    const sub = async name => (await agents()).find(x => x.parentId === a.id && x.name === name);
    await window.nexus.send(a.id, '開始');

    const bg = await until('背景子節點出現', () => sub('背景工作'));
    await until('前景子節點出現', () => sub('前景工作'));
    expect('背景子代理啟動後留在面板上', (await sub('背景工作'))?.state === 'working', JSON.stringify(await sub('背景工作')));
    document.title = 'SHOT:bg-1-both'; await wait(700);

    // 回合結束:主節點回到待命,前景的結束,背景的還在執行
    await until('主節點回合結束', async () => (await agents()).find(x => x.id === a.id && x.state === 'idle'));
    const fgAfter = await sub('前景工作'), bgAfter = await sub('背景工作');
    expect('回合結束後前景子代理已結束', !fgAfter || fgAfter.state === 'idle', JSON.stringify(fgAfter?.state));
    expect('回合結束後背景子代理還在執行', bgAfter?.state === 'working', JSON.stringify(bgAfter));
    expect('主節點不再顯示等待子代理', !/等待/.test((await agents()).find(x => x.id === a.id).detail));

    const progressed = await until('背景子節點收到進度', async () => { const s = await sub('背景工作'); return s && /Read/.test(s.detail) ? s : null; });
    expect('進度顯示在子節點上', /Read/.test(progressed.detail), progressed.detail);
    document.title = 'SHOT:bg-2-progress'; await wait(700);

    await until('背景子代理完成', async () => { const s = await sub('背景工作'); return !s || s.state === 'idle'; });
    const hist = await window.nexus.getHistory(bg.id);
    expect('完成的摘要記在子節點', hist.some(e => e.type === 'note' && e.text.includes('背景工作的最終報告')), JSON.stringify(hist.map(e => e.type)));
    await until('子節點自動移除', async () => !(await sub('背景工作')), 8000);
    const parentHist = await window.nexus.getHistory(a.id);
    const ends = parentHist.filter(e => e.type === 'subagent' && e.phase === 'end').map(e => e.name);
    expect('兩個子代理各結束一次', JSON.stringify(ends.sort()) === JSON.stringify(['前景工作', '背景工作'].sort()), JSON.stringify(ends));
    expect('完成後主節點回報', parentHist.some(e => e.type === 'message' && e.text === '背景子代理也完成了。'));
    log(bad ? `有 ${bad} 項不符` : '全部通過');
  } catch (err) {
    log('失敗', err.message, JSON.stringify((await agents()).map(x => [x.name, x.state, x.detail])));
  }
  document.title = 'QUIT';
})();
