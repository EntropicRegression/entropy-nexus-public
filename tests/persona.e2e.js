// 身分設定的驗收(真正的 CLI):三家後台的節點都要知道自己在主控台裡的名字,改名後也要知道新名字。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const cwd = window.__TEST_CWD__;
  const ask = async (id, text) => {
    const before = (await window.nexus.getHistory(id)).length;
    await window.nexus.send(id, text);
    const t0 = Date.now();
    while (Date.now() - t0 < 120000) {
      await wait(1500);
      const a = (await window.nexus.getSnapshot()).agents.find(x => x.id === id);
      const h = (await window.nexus.getHistory(id)).slice(before);
      const reply = h.filter(e => e.type === 'message' && e.role === 'agent').map(e => e.text).join(' ');
      if (a.state === 'idle' && reply) return reply.replace(/\s+/g, ' ').slice(0, 120);
      if (a.state === 'error') return '錯誤:' + a.detail;
    }
    return '逾時';
  };
  try {
    await wait(3000);
    const q = '你在這個主控台裡叫什麼名字?只回答名字,不要做其他事。';
    const nodes = [
      ['claude', '曙光', 'haiku'],
      ['antigravity', 'Kestrel-7', 'gemini-3.8-flash-low'],
      ['codex', '北辰', ''],
    ];
    for (const [backend, name, model] of nodes) {
      try {
        const a = await window.nexus.createAgent({ name, character: '', model, backend, cwd, permissionMode: 'ask' });
        await wait(2500);
        log(backend, '名字', name, '→', await ask(a.id, q));
        const renamed = name + '改';
        await window.nexus.updateAgent(a.id, { name: renamed });
        log(backend, '改名', renamed, '→', await ask(a.id, '你現在的名字是什麼?只回答名字。'));
        const h = await window.nexus.getHistory(a.id);
        log(backend, '紀錄裡的使用者訊息', JSON.stringify(h.filter(e => e.type === 'message' && e.role === 'user').map(e => e.text.slice(0, 30))));
        await window.nexus.removeAgent(a.id);
      } catch (err) { log(backend, '失敗', err.message); }
    }
  } catch (err) {
    log('失敗', err.message);
  }
  document.title = 'QUIT';
})();
