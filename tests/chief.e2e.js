// 總管節點(主控語音模式)的驗收,在主控台畫面裡執行(假資料模式,NEXUS_FAKE_ECHO=1 讓節點回吐收到的身分設定與指令)。
// 檢查:總管區塊與「+」六角形、點「+」開啟指定總管面板、指定現有節點、總管固定放在總管區塊、
// 總管收到總管守則(下一則指令前的主控台通知)、解除總管、新增時直接指定、刪除總管節點後回到沒有總管。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const ok = (cond, what, extra = '') => log(cond ? '通過' : '不符', what + (cond || !extra ? '' : ` → ${String(extra).slice(0, 300)}`));
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await wait(150); } return null; };
  const shot = async name => { document.title = `SHOT:${name}`; await wait(600); };
  const click = async (x, y) => { document.title = `INPUT:${Date.now()}|${JSON.stringify({ type: 'click', x: Math.round(x), y: Math.round(y) })}`; await wait(400); };
  try {
    await window.nexus.setAutopilot(false);
    // 假資料節點偶爾會要求授權(每次詢問模式):測試期間一律允許,回合才不會卡住
    const approver = setInterval(async () => { for (const x of (await window.nexus.getSnapshot()).agents) if (x.pendingApproval) void window.nexus.respondApproval(x.id, x.pendingApproval.requestId, 'allow'); }, 300);
    const cwd = window.__TEST_CWD__;
    const mk = (name, extra = {}) => window.nexus.createAgent({ name, character: '', model: '', backend: 'claude', cwd, permissionMode: 'ask', ...extra });
    const a = await mk('Alpha');
    const b = await mk('Beta');
    await wait(2500);
    const board = window.__nexusBoard;
    const canvas = document.querySelector('.board canvas').getBoundingClientRect();
    ok((await window.nexus.getSnapshot()).chiefId === null, '一開始沒有總管');
    const plus = board.chiefPlus();
    const chiefRect = board.rect('chief'), activeRect = board.rect('active');
    ok(plus.visible, '總管區塊顯示「+」六角形', JSON.stringify(plus));
    ok(chiefRect && activeRect && chiefRect.x > activeRect.x + activeRect.w && Math.abs(chiefRect.y - activeRect.y) < 1, '總管區塊在執行區塊的右側、同一列', JSON.stringify({ chiefRect, activeRect }));
    await shot('1-board');

    // 點「+」:開啟指定總管面板
    await click(canvas.left + plus.x, canvas.top + plus.y);
    const panel = await until(() => document.querySelector('.addform.chief'));
    ok(!!panel && panel.textContent.includes('指定總管節點'), '點「+」開啟指定總管面板', document.querySelector('.addform')?.textContent);
    const pick = [...(panel?.querySelectorAll('.chief-pick button') ?? [])].map(x => x.textContent);
    ok(pick.includes('Alpha') && pick.includes('Beta'), '面板列出現有節點可以直接指定', JSON.stringify(pick));
    await shot('2-panel');

    // 直接指定 Beta
    [...panel.querySelectorAll('.chief-pick button')].find(x => x.textContent === 'Beta').click();
    const chief1 = await until(async () => (await window.nexus.getSnapshot()).chiefId);
    ok(chief1 === b.id, '指定現有節點為總管', chief1);
    // 節點會以動畫移過去
    const r = board.rect('chief');
    const inside = () => { const p = board.positions().find(x => x.id === b.id); return p && p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h ? p : null; };
    ok(await until(inside, 6000), '總管節點放在總管區塊裡', JSON.stringify({ pos: board.positions().find(x => x.id === b.id), r }));
    ok(!board.chiefPlus().visible, '有總管時不顯示「+」');
    await shot('3-chief');

    // 下一則指令前收到總管守則
    await window.nexus.send(b.id, '幫我看一下大家在做什麼');
    const echo = async id => (await window.nexus.getHistory(id)).filter(e => e.type === 'note' && e.text.startsWith('[echo] send:')).map(e => e.text);
    const sent = await until(async () => (await echo(b.id))[0]);
    ok(sent?.includes('你已被指定為總管節點') && sent.includes('ask_node') && sent.includes('list_nodes'), '總管在下一則指令前收到總管守則', sent);

    // 解除總管
    await until(async () => (await window.nexus.getSnapshot()).agents.find(x => x.id === b.id)?.state === 'idle', 20000);
    await window.nexus.setChief(null);
    ok((await window.nexus.getSnapshot()).chiefId === null, '解除總管');
    await window.nexus.send(b.id, '第二句');
    const sent2 = await until(async () => (await echo(b.id))[1]);
    ok(sent2?.includes('不再套用總管守則') && !sent2.includes('你已被指定為總管節點'), '解除後下一則指令前收到解除通知', JSON.stringify({ sent2, all: await echo(b.id), state: (await window.nexus.getSnapshot()).agents.find(x => x.id === b.id)?.state }));
    await wait(500);
    ok(board.chiefPlus().visible, '解除後又顯示「+」');

    // 新增時直接指定為總管:第一個身分設定就帶著守則
    const c = await mk('Gamma', { chief: true });
    ok((await window.nexus.getSnapshot()).chiefId === c.id, '新增節點時直接指定為總管');
    const persona = await until(async () => (await window.nexus.getHistory(c.id)).find(e => e.type === 'note' && e.text.startsWith('[echo] persona:'))?.text);
    ok(persona?.includes('「總管」節點') && persona.includes('ask_node'), '新的總管啟動時身分設定就有總管守則', persona);
    const p2 = (await window.nexus.getHistory(a.id)).find(e => e.type === 'note' && e.text.startsWith('[echo] persona:'))?.text;
    ok(p2 && !p2.includes('總管'), '一般節點的身分設定沒有總管守則', p2);

    // 刪除總管節點:回到沒有總管
    await window.nexus.removeAgent(c.id);
    ok(await until(async () => (await window.nexus.getSnapshot()).chiefId === null), '刪除總管節點後回到沒有總管');
    clearInterval(approver);
    log('主控台端結束');
  } catch (err) {
    log('失敗', err.stack ?? err.message);
  }
  await wait(300);
  document.title = 'QUIT';
})();
