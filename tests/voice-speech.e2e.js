// 語音播報(Phase 2a)的驗收,在主控台畫面裡執行(假資料模式)。tests/voice-speech-client.mjs 扮演節點的 CLI 做節點互相呼叫。
// 檢查:桌面發起的回合完成只播一次、摘要內容;兩個節點同時完成都會念到;中斷不播;提問與授權會提醒;
// 節點互相呼叫的回合(被呼叫的一方)不播完成。朗讀會真的從喇叭念出來。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const ok = (cond, what, extra = '') => log(cond ? '通過' : '不符', what + (cond || !extra ? '' : ` → ${String(extra).slice(0, 300)}`));
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const until = async (fn, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await wait(200); } return null; };
  try {
    localStorage.setItem('nexus.speak', '1');
    const notes = [];
    window.nexus.onSpeech(n => notes.push(n));
    await window.nexus.setAutopilot(false);
    const cwd = window.__TEST_CWD__;
    const mk = (name, backend, permissionMode = 'auto') => window.nexus.createAgent({ name, character: '', model: '', backend, cwd, permissionMode });
    const id = {};
    for (const [n, b, m] of [['A', 'claude'], ['F', 'codex'], ['B', 'codex'], ['C', 'antigravity'], ['D', 'claude'], ['E', 'claude', 'ask'], ['G', 'claude'], ['H', 'codex']]) id[n] = (await mk(n, b, m)).id;
    await wait(2500);
    log('READY', JSON.stringify(id));
    const agent = async n => (await window.nexus.getSnapshot()).agents.find(a => a.id === id[n]);
    const of = (n, kind) => notes.filter(x => x.agentId === id[n] && x.kind === kind);
    const spoken = () => window.__nexusSpokenLog ?? [];

    // 1. 兩個節點同時完成:各播一次,摘要是回覆內容,兩段都念到(沒有被下一段切掉)
    await Promise.all([
      window.nexus.send(id.A, '圖片測試\n已修好登入頁的錯誤,測試全部通過。'),
      window.nexus.send(id.F, '圖片測試\nFixed the adapter and tests passed.'),
    ]);
    await until(() => of('A', 'done').length && of('F', 'done').length);
    await wait(1500);
    ok(of('A', 'done').length === 1 && of('A', 'done')[0].summary === '已修好登入頁的錯誤,測試全部通過。', 'A 完成時播一次,摘要是回覆內容', JSON.stringify(of('A', 'done')));
    ok(of('F', 'done').length === 1 && of('F', 'done')[0].summary === 'Fixed the adapter and tests passed.', 'F 完成時播一次(英文回覆)', JSON.stringify(of('F', 'done')));
    const both = await until(() => spoken().some(t => t.startsWith('A:')) && spoken().some(t => t.startsWith('F:')), 30000);
    ok(!!both, '兩個節點的完成通知都念到了(依序播放,沒有互相切掉)', JSON.stringify(spoken()));

    // 2. 中斷:不播完成
    await window.nexus.send(id.B, '一般指令,請慢慢做');
    await until(async () => ['planning', 'working', 'awaiting'].includes((await agent('B'))?.state));
    await wait(400);
    await window.nexus.interrupt(id.B);
    await until(async () => (await agent('B'))?.state === 'idle');
    await wait(1500);
    ok(of('B', 'done').length === 0, '被中斷的回合不播完成通知', JSON.stringify(of('B', 'done')));

    // 3. 提問:提醒一次;回答後回合完成照常播
    await window.nexus.send(id.D, '提問測試');
    const q = await until(() => of('D', 'question')[0]);
    ok(!!q, '節點提問時播提醒', JSON.stringify(notes.filter(x => x.agentId === id.D)));
    const pq = await until(async () => (await agent('D'))?.pendingQuestion);
    ok(pq && q && pq.requestId === q.requestId, '提醒帶的 requestId 對應到這個提問');
    // 等提醒念出來再回答(前面的通知可能還在念;在輪到它之前就回答的話,提醒會被正確地略過)
    ok(await until(() => spoken().some(t => t.includes('D 有問題要問你')), 30000), '提問的提醒有念出來', JSON.stringify(spoken()));
    if (pq) await window.nexus.answerQuestion(id.D, pq.requestId, { q1: ['紅色'] });
    const dq = await until(() => of('D', 'done')[0]);
    ok(dq?.summary?.includes('紅色'), '回答後回合完成照常播', JSON.stringify(dq));

    // 4. 節點互相呼叫:G 呼叫 C(自動模式不跳授權)、E(每次詢問)呼叫 H(先在 E 跳授權)
    log('INTEROP-GO');
    const pa = await until(async () => (await agent('E'))?.pendingApproval, 20000);
    const an = await until(() => of('E', 'approval')[0], 5000);
    ok(pa && an && an.requestId === pa.requestId, '主控台發出的授權(呼叫節點)也會提醒', JSON.stringify(notes.filter(x => x.agentId === id.E)));
    if (pa) await window.nexus.respondApproval(id.E, pa.requestId, 'allow');
    const hist = async n => (await window.nexus.getHistory(id[n])).filter(e => e.type === 'message' && e.role === 'agent').map(e => e.text).join('\n');
    // 被呼叫的指令前面有主控台的說明,假資料節點會走一般回合(回「完成。」)
    const doneTurn = async n => (await hist(n)).length > 0 && (await agent(n))?.state === 'idle';
    await until(() => doneTurn('C'), 30000);
    await until(() => doneTurn('H'), 30000);
    await wait(1500);
    ok(await doneTurn('C') && await doneTurn('H'), '被呼叫的節點都完成了');
    ok(of('C', 'done').length === 0 && of('H', 'done').length === 0, '節點互相呼叫的回合不播完成通知', JSON.stringify(notes.filter(x => [id.C, id.H].includes(x.agentId))));
    ok(!spoken().some(t => /^[CH]:/.test(t)), '沒有念出被呼叫節點的回覆', JSON.stringify(spoken()));

    // 5. 遠端收不到:nexus:speech 只送桌面,這裡確認播報沒有混進一般的狀態更新
    let leaked = false;
    const off = window.nexus.onUpdate(u => { if (u && 'speech' in u) leaked = true; });
    await window.nexus.send(id.A, '圖片測試\n第二次完成。');
    await until(() => of('A', 'done').length === 2);
    off();
    ok(!leaked && of('A', 'done').length === 2, '播報不走一般的狀態更新(遠端拿不到)');
    log('主控台端結束');
  } catch (err) {
    log('失敗', err.stack ?? err.message);
  }
  await wait(500);
  document.title = 'QUIT';
})();
