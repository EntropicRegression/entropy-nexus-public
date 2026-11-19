// 驗收:開啟舊 session,並保存 session 的人物名稱。會啟動三家真正的 CLI。
// 流程:建立三個節點各說一句 → 終止 → 從「開啟舊 session」清單接回 → 確認名稱沿用、對話紀錄回來、CLI 還記得內容。
// 另外從 CLI 自己的紀錄挑一個主控台沒開過的對話,取名後開啟,再終止,確認名稱被保存。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const shot = async name => { document.title = `SHOT:${name}`; await wait(900); };
  const snap = () => window.nexus.getSnapshot();
  const DONE = ['idle', 'error', 'lost'];
  const until = async (what, fn, timeout = 150000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await wait(250); }
    throw new Error(`等不到:${what}`);
  };
  const stateOf = async id => (await snap()).agents.find(a => a.id === id)?.state;
  const ask = async (id, text) => {
    await window.nexus.send(id, text);
    await until('開始', async () => !DONE.includes(await stateOf(id)), 40000);
    await until('完成', async () => {
      const a = (await snap()).agents.find(x => x.id === id);
      if (a.pendingApproval) await window.nexus.respondApproval(id, a.pendingApproval.requestId, 'allow');
      return DONE.includes(a.state);
    });
    await wait(800);
    return (await window.nexus.getHistory(id)).filter(e => e.type === 'message' && e.role === 'agent').slice(-1)[0]?.text;
  };

  try {
    const cwd = window.__TEST_CWD__;
    const made = [];
    for (const [name, backend, model, secret] of [['阿爾法', 'claude', 'haiku', '7301'], ['貝塔', 'codex', '', '4418'], ['伽瑪', 'antigravity', 'gemini-3.8-flash-low', '9056']]) {
      made.push({ agent: await window.nexus.createAgent({ name, character: '', model, backend, cwd, permissionMode: 'ask' }), secret, backend, name });
    }
    await until('三個節點待命', async () => (await snap()).agents.every(a => a.state === 'idle'), 60000);
    for (const m of made) await ask(m.agent.id, `請記住暗號 ${m.secret}。只回覆「好」。`);
    const sessions = Object.fromEntries((await snap()).agents.map(a => [a.name, a.sessionId]));
    log('建立並對話完成,session', JSON.stringify(sessions));
    for (const m of made) await window.nexus.removeAgent(m.agent.id);
    await wait(1500);
    log('終止後面板上的節點數', (await snap()).agents.length);

    // 打開「開啟舊 session」
    document.querySelector('.add.old').click();
    await until('清單載入', () => document.querySelectorAll('.os-row').length > 0, 40000);
    await wait(500);
    const list = await window.nexus.listOldSessions();
    const by = {};
    for (const s of list) { by[s.backend] ??= { nexus: 0, cli: 0 }; by[s.backend][s.source]++; }
    log('清單總數', list.length, '| 各後台', JSON.stringify(by));
    for (const m of made) {
      const s = list.find(x => x.sessionId === sessions[m.name]);
      log('終止過的節點在清單中', m.name, s ? `來源=${s.source} 保存的名稱=${s.name} 標題=${s.title.slice(0, 20)}` : '找不到');
    }
    log('畫面第一列', document.querySelector('.os-row .os-title')?.textContent?.slice(0, 30), '| 名稱欄', document.querySelector('.os-row .os-name')?.value, '| 篩選', [...document.querySelectorAll('.os-filters button')].map(b => b.textContent).join(' / '));
    await shot('1-old-sessions');

    // 在畫面上按「開啟」接回 Claude 的那一個(名稱直接沿用,不必重填)
    const row = [...document.querySelectorAll('.os-row')].find(r => r.querySelector('.os-name').value === '阿爾法');
    row.querySelector('button.primary').click();
    await until('阿爾法 回到面板', async () => (await snap()).agents.find(a => a.name === '阿爾法' && DONE.includes(a.state)), 60000);
    const back = (await snap()).agents.find(a => a.name === '阿爾法');
    log('接回後', back.name, back.state, back.detail, '| 同一個節點 id', back.id === made[0].agent.id, '| 模型', back.model, '| 清單關閉', !document.querySelector('.oldsessions'), '| 對話視窗', document.querySelector('.dlg-id b')?.textContent);
    await wait(800);
    log('對話視窗裡的舊訊息', JSON.stringify([...document.querySelectorAll('.dlg-stream .msg p')].map(p => p.textContent).slice(0, 2)));
    log('Claude 還記得', JSON.stringify(await ask(back.id, '暗號是多少?只回答數字。')));
    await shot('2-restored');

    // 另外兩家用 API 接回
    for (const m of made.slice(1)) {
      const s = (await window.nexus.listOldSessions()).find(x => x.sessionId === sessions[m.name]);
      const a = await window.nexus.openOldSession({ backend: s.backend, sessionId: s.sessionId, cwd: s.cwd, agentId: s.agentId, name: s.name, character: s.character, model: s.model });
      await until(`${m.name} 待命`, async () => DONE.includes(await stateOf(a.id)), 60000);
      log(m.name, '接回後名稱', a.name, '| 還記得', JSON.stringify(await ask(a.id, '暗號是多少?只回答數字。')));
    }

    // 主控台沒開過的 CLI 對話:取名後開啟,終止,再看清單是否保存了名稱
    const fresh = (await window.nexus.listOldSessions()).find(s => s.source === 'cli' && s.backend === 'claude' && s.cwdExists && s.cwd.includes('review-test'));  // 只拿先前測試留下的對話來試,不碰使用者自己的
    if (fresh) {
      log('CLI 的對話', fresh.title.slice(0, 30), '| 預設名稱', fresh.name, '| 資料夾', fresh.cwd.slice(-30));
      const a = await window.nexus.openOldSession({ ...fresh, name: '德爾塔' });
      await until('德爾塔 待命', async () => DONE.includes(await stateOf(a.id)), 60000);
      log('開啟 CLI 對話後', (await snap()).agents.find(x => x.id === a.id).state, (await snap()).agents.find(x => x.id === a.id).detail);
      await window.nexus.removeAgent(a.id);
      await wait(1200);
      const again = (await window.nexus.listOldSessions()).find(s => s.sessionId === fresh.sessionId);
      log('終止後再看清單', again ? `來源=${again.source} 保存的名稱=${again.name}` : '找不到');
    } else log('沒有可用的 CLI 對話可以測');
    log('全部步驟完成');
  } catch (err) {
    log('失敗', err.message);
    await shot('9-failed');
  }
  await wait(500);
  document.title = 'QUIT';
})();
