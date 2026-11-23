// 總覽儀表的驗收,在主控台畫面裡執行(假資料模式,由 tests/dashboard.sh 啟動)。
// 用量與花費由指令裡的「〔測試用量:…〕」指定(見 src/main/adapters/fake.ts),所以畫面上的數字都可以預期。
// 檢查的是畫面上實際顯示的數字與效果:額度條的百分比與重置時間、狀態數字與點下去選到的節點、
// 花費表格、任務統計、預算提醒的出現與消失、週額度重置後起點歸零、外部觀察節點。
// 遠端裝置的部分(唯讀、限定節點只看得到範圍內的資料)由 tests/dashboard-remote.mjs 從外部檢查,做完會送一句「遠端檢查完成」。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const ok = (cond, what, extra = '') => log(cond ? '通過' : '不符', what + (cond || extra === '' ? '' : ` → ${String(typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 320)}`));
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await wait(150); } return null; };
  const shot = async name => { document.title = `SHOT:${name}`; await wait(800); };
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const text = el => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const snap = () => window.nexus.getSnapshot();
  // 和畫面相同的重置時間格式(當天只顯示時間,其他日子加上日期)
  const when = ts => { const d = new Date(ts * 1000); const t = d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false }); return d.toDateString() === new Date().toDateString() ? t : `${d.getMonth() + 1}/${d.getDate()} ${t}`; };
  const idle = id => until(async () => { const s = await snap(); return s.agents.find(a => a.id === id)?.state === 'idle' && !s.tasks.some(t => t.agentId === id && t.endedAt === null); });
  /** 讓節點回報指定的用量與花費,等回合結束、儀表更新。 */
  const report = async (id, usage) => { await window.nexus.send(id, `〔測試用量:${JSON.stringify(usage)}〕`); const done = await idle(id); await wait(700); return !!done; };
  const quota = (backend, label) => $(`.dash .dq[data-backend="${backend}"] .dq-win[data-label="${label}"]`);
  const budgetChip = backend => $(`.dash .dq[data-backend="${backend}"] .dq-budget`);
  const count = kind => Number(text($(`.dash .ds[data-kind="${kind}"] b`)));
  const warns = () => text($('.dash .dash-warn'));
  const setInput = (el, value) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(value)); el.dispatchEvent(new Event('input', { bubbles: true })); };
  try {
    await window.nexus.setAutopilot(false);
    const cwd = window.__TEST_CWD__;
    const mk = (name, backend, permissionMode) => window.nexus.createAgent({ name, character: '', model: '', backend, cwd, permissionMode });
    const A = await mk('甲-Claude', 'claude', 'auto');
    const B = await mk('乙-Codex', 'codex', 'auto');
    const C = await mk('丙-Agy', 'antigravity', 'ask');
    const D = await mk('丁-Claude', 'claude', 'auto');
    await until(async () => (await snap()).agents.every(a => a.state === 'idle'));
    // 快照比畫面早一步:等畫面也畫出最新的狀態
    await wait(600);

    // ---------- 1. 節點清單拿掉了,儀表在右側欄最上面,任務面板與新增按鈕還在下面
    const side = $('.sidebar');
    ok(!$('.roster-list') && !$$('.panel-title').some(e => text(e) === '節點清單') && $$('.sidebar > *').every(e => !e.matches('.row')), '右側的節點清單已經拿掉');
    ok(side?.firstElementChild?.matches('.dash') && !!$('.sidebar .tasks') && !!$('.sidebar button.add') && !!$('.sidebar button.add.old'), '儀表在右側欄最上面,任務面板、新增節點與開啟舊 session 還在');
    const dashBox = $('.dash').getBoundingClientRect(), taskBox = $('.tasks').getBoundingClientRect(), addBox = $('button.add').getBoundingClientRect();
    ok(dashBox.bottom <= taskBox.top + 1 && taskBox.height >= 200 && addBox.bottom <= innerHeight, '儀表沒有把任務面板與新增按鈕擠出畫面', { dash: dashBox.height, tasks: taskBox.height, add: addBox.bottom, h: innerHeight });
    ok($$('.dash .dq').length === 3 && $$('.dash .dq-none').length === 3 && $$('.dash .dq-none').every(e => text(e).includes('尚未取得額度')), '還沒有額度資料時,三家後台都顯示「尚未取得額度」', $$('.dash .dq').map(text));
    ok(['running', 'waiting', 'queued', 'fault'].every(k => count(k) === 0 && $(`.dash .ds[data-kind="${k}"]`).disabled), '沒有節點在跑時四個狀態數字都是 0,而且不能點', $$('.dash .ds').map(e => `${text(e)}/${e.disabled}`));
    ok(!$('.dash .dash-warn'), '一開始沒有提醒');

    // ---------- 2. 額度條:百分比、重置時間與送進去的資料一致
    const now = Math.round(Date.now() / 1000);
    const R5 = now + 3 * 3600 + 120, RW = now + 4 * 86400;
    ok(await report(A.id, { windows: [{ label: '5 小時', used: 0.42, resetsAt: R5 }, { label: '每週', used: 0.10, resetsAt: RW }], spent: { tokens: 12000, usd: 0.05 } }), '甲回報用量(5 小時 42%、每週 10%)');
    const five = quota('claude', '5 小時'), weekly = quota('claude', '每週');
    ok(text($('.dq-pct', five)) === '58%' && $('.dash-bar > span', five)?.style.width === '58%', '5 小時額度已用 42%:額度條像血量,顯示剩餘 58%(數字與長度)', `${text(five)} / ${$('.dash-bar > span', five)?.style.width}`);
    ok(text($('.dq-reset', five)) === `${when(R5)} 重置` && $('.dq-reset', five).getBoundingClientRect().width > 0, '5 小時額度顯示重置時間', `${text($('.dq-reset', five))} ≠ ${when(R5)} 重置`);
    ok(text($('.dq-pct', weekly)) === '90%' && $('.dash-bar > span', weekly)?.style.width === '90%' && text($('.dq-reset', weekly)) === `${when(RW)} 重置`, '每週額度已用 10%:顯示剩餘 90% 與重置時間', text(weekly));
    ok(five.title.includes('剩餘 58%') && five.title.includes('已用 42%') && five.title.includes(when(R5)), '額度條的提示文字也有百分比與重置時間', five.title);
    ok(text(budgetChip('claude')) === '今天 0% / 14.3%' && budgetChip('claude').classList.contains('b-ok'), '今天第一筆讀數是起點:今天已用 0%,預設預算 14.3%', text(budgetChip('claude')));
    ok($$('.dash .dq[data-backend="codex"] .dq-none').length === 1 && !budgetChip('codex'), '其他後台不受影響(Codex 仍然沒有額度資料)');
    let d = (await snap()).dashboard;
    ok(d.budgets.find(b => b.backend === 'claude').used === 0 && d.budgets.find(b => b.backend === 'claude').budget === 14.3 && d.budgets.find(b => b.backend === 'codex').window === null, '快照裡的預算狀況一致', d.budgets);

    // ---------- 3. 今天的用量 = 目前的每週讀數 − 起點;還在預算內時沒有提醒
    await report(A.id, { windows: [{ label: '5 小時', used: 0.5, resetsAt: R5 }, { label: '每週', used: 0.18, resetsAt: RW }], spent: { tokens: 8000, usd: 0.03 } });
    ok(text(budgetChip('claude')) === '今天 8% / 14.3%' && budgetChip('claude').classList.contains('b-ok') && !$('.dash .dash-warn'), '每週 10% → 18%:今天已用 8%,沒有提醒', `${text(budgetChip('claude'))} | ${warns()}`);

    // ---------- 4. 超過每日預算:只提醒(畫面警示、開了朗讀會念),不擋指令
    localStorage.setItem('nexus.speak', '1');
    const spokenBefore = (window.__nexusSpokenLog ?? []).length;
    await report(A.id, { windows: [{ label: '5 小時', used: 0.55, resetsAt: R5 }, { label: '每週', used: 0.30, resetsAt: RW }], spent: { tokens: 5000, usd: 0.02 } });
    ok(text(budgetChip('claude')) === '今天 20% / 14.3%' && budgetChip('claude').classList.contains('b-over'), '每週 10% → 30%:今天已用 20%,超過預算', text(budgetChip('claude')));
    ok(warns().includes('Claude Code 今天已用 20%,超過每日預算 14.3%') && $('.dash .dash-warn').classList.contains('bad'), '儀表出現超過預算的提醒', warns());
    const spoke = await until(() => (window.__nexusSpokenLog ?? []).slice(spokenBefore).find(t => t.includes('今天的用量超過每日預算')), 20000);
    ok(spoke === 'Claude Code 今天的用量超過每日預算了。', '開了朗讀:念出超過預算的提醒', JSON.stringify((window.__nexusSpokenLog ?? []).slice(spokenBefore)));
    localStorage.setItem('nexus.speak', '0');
    await window.nexus.send(A.id, '〔測試執行:300〕超過預算後照樣可以下指令');
    await wait(150);
    const afterOver = (await snap()).agents.find(a => a.id === A.id);
    ok(afterOver.state === 'working' && afterOver.queued.length === 0, '超過預算後指令照常送出(只提醒、不擋)', afterOver.state);
    await idle(A.id);
    await shot('1-compact-over');

    // ---------- 5. 完整內容:點儀表展開;預算可以調整,調高後提醒消失、改回預設又出現
    $('.dash .dash-quota').click();
    const full = await until(() => $('.dash-full'), 3000);
    ok(!!full && $('.dash .dash-expand').getAttribute('aria-expanded') === 'true', '點儀表展開完整內容');
    const fb = backend => $(`.dash-full .df-backend[data-backend="${backend}"]`);
    ok($$('.df-win', fb('claude')).length === 2 && text($$('.df-win', fb('claude'))[1]).includes('70%') && text($$('.df-win', fb('claude'))[1]).includes(`${when(RW)} 重置`), '完整內容列出這個後台全部的額度', text(fb('claude')));
    ok(text($('.df-used', fb('claude'))) === '20%' && $('.df-budget', fb('claude')).classList.contains('b-over') && $('.df-budget-input', fb('claude')).value === '14.3', '預算區塊:今天已用 20%、每日預算 14.3%', text($('.df-budget', fb('claude'))));
    ok($$('.dash-full .df-warn').some(e => text(e).includes('超過每日預算')), '完整內容的提醒區也列出超過預算');
    ok($('.df-budget-reset', fb('claude')).disabled, '還沒調整過預算時「預設」按鈕不能按');
    await shot('2-full-over');
    const input = $('.df-budget-input', fb('claude'));
    input.focus();
    setInput(input, 30);
    input.blur();
    d = await until(async () => { const x = (await snap()).dashboard; return x.budgets.find(b => b.backend === 'claude').budget === 30 ? x : null; }, 5000);
    await wait(500);
    ok(!!d && d.budgets.find(b => b.backend === 'claude').custom === true && d.budgets.find(b => b.backend === 'claude').level === 'ok', '在畫面上把預算改成 30% 會存起來', d?.budgets);
    ok(text(budgetChip('claude')) === '今天 20% / 30%' && !$('.dash .dash-warn') && !$$('.dash-full .df-warn').length, '預算調高到 30%:提醒消失', `${text(budgetChip('claude'))} | ${warns()}`);
    $('.df-budget-reset', fb('claude')).click();
    await until(async () => (await snap()).dashboard.budgets.find(b => b.backend === 'claude').custom === false, 5000);
    await wait(500);
    ok(text(budgetChip('claude')) === '今天 20% / 14.3%' && warns().includes('超過每日預算'), '按「預設」改回 14.3%:提醒又出現', `${text(budgetChip('claude'))} | ${warns()}`);
    await window.nexus.setDailyBudget('claude', 25);
    await wait(700);
    ok(warns().includes('Claude Code 今天已用 20%,快到每日預算 25%') && !$('.dash .dash-warn').classList.contains('bad') && budgetChip('claude').classList.contains('b-near'), '預算 25%(已用八成):提醒「快到每日預算」,不是紅色', warns());
    await window.nexus.setDailyBudget('claude', 101);
    await window.nexus.setDailyBudget('claude', -3);
    ok((await snap()).dashboard.budgets.find(b => b.backend === 'claude').budget === 25, '不合理的預算(超過 100、負數)不會被接受');
    await window.nexus.setDailyBudget('claude', 0);
    await wait(700);
    ok(!budgetChip('claude') && !$('.dash .dash-warn') && text($('.df-budget-note', fb('claude'))).includes('不提醒'), '預算設成 0:不提醒', warns());
    await window.nexus.setDailyBudget('claude', 30);

    // ---------- 6. 每週額度在當天重置:起點歸零,從重置後重新累計
    await report(A.id, { windows: [{ label: '5 小時', used: 0.05, resetsAt: R5 }, { label: '每週', used: 0.04, resetsAt: RW + 7 * 86400 }], spent: { tokens: 1000 } });
    ok(text(budgetChip('claude')) === '今天 4% / 30%' && (await snap()).dashboard.budgets.find(b => b.backend === 'claude').used === 4, '每週額度重置(30% → 4%):起點歸零,今天已用 4%', text(budgetChip('claude')));
    await report(A.id, { windows: [{ label: '每週', used: 0.07, resetsAt: RW + 7 * 86400 }] });
    ok(text(budgetChip('claude')) === '今天 7% / 30%', '重置後繼續累計:4% → 7%', text(budgetChip('claude')));

    // ---------- 7. 額度快滿的提醒;設了額度上限時提早提醒
    await report(B.id, { windows: [{ label: '5 小時', used: 0.93, resetsAt: R5 }, { label: '每週', used: 0.52, resetsAt: RW }], spent: { tokens: 5000 } });
    ok(quota('codex', '5 小時').classList.contains('crit') && text($('.dq-pct', quota('codex', '5 小時'))) === '7%', 'Codex 的 5 小時額度已用 93%(剩 7%):額度條轉成紅色', quota('codex', '5 小時').className);
    ok(warns().includes('Codex 的5 小時額度已用 93%,快滿了'), '出現額度快滿的提醒', warns());
    ok(!$$('.dash-full .df-warn').some(e => text(e).includes('每週額度已用 52%')), '每週 52% 還沒到門檻,不提醒');
    await window.nexus.setQuotaStop(55);
    await wait(500);
    ok($$('.dash-full .df-warn').some(e => text(e).includes('Codex 的每週額度已用 52%,快滿了')), '額度上限設 55%:50% 起就提醒,每週 52% 也列入', $$('.dash-full .df-warn').map(text));
    await window.nexus.setQuotaStop(0);
    await wait(400);

    // ---------- 8. 花費:今天與本週,依後台與節點,和送進去的數字一致
    // 甲:12000+8000+5000+1000 = 26000 tokens、$0.10;乙:5000 tokens、沒有金額
    const row = key => $$(`.dash-full .df-spend tr[data-row="${key}"] td`).map(text);
    ok(JSON.stringify(row(`agent:${A.id}`)) === JSON.stringify(['26.0k', '$0.10', '26.0k', '$0.10']), '花費:甲今天與本週 26.0k tokens、$0.10', row(`agent:${A.id}`));
    ok(JSON.stringify(row(`agent:${B.id}`)) === JSON.stringify(['5.0k', '—', '5.0k', '—']), '花費:乙 5.0k tokens,沒有金額顯示「—」', row(`agent:${B.id}`));
    ok(JSON.stringify(row('backend:claude')) === JSON.stringify(['26.0k', '$0.10', '26.0k', '$0.10']) && JSON.stringify(row('backend:codex')) === JSON.stringify(['5.0k', '—', '5.0k', '—']), '花費:依後台加總', [row('backend:claude'), row('backend:codex')]);
    ok(JSON.stringify(row('total')) === JSON.stringify(['31.0k', '$0.10', '31.0k', '$0.10']), '花費:合計 31.0k tokens、$0.10', row('total'));
    ok(text($(`.dash-full .df-spend tr[data-row="agent:${A.id}"] th`)) === '甲-Claude' && !$(`.dash-full .df-spend tr[data-row="agent:${C.id}"]`), '花費表列出節點名稱;沒有花費的節點不列');
    d = (await snap()).dashboard;
    const sum = id => d.spend.filter(r => r.agentId === id).reduce((n, r) => n + r.tokens, 0);
    ok(sum(A.id) === 26000 && sum(B.id) === 5000 && d.spend.every(r => r.date === d.date) && d.weekStart <= d.date, '快照裡依日期彙總的花費一致', d.spend);
    ok((await snap()).agents.find(a => a.id === A.id).spent.tokens === 26000, '和節點自己的累計花費一致');
    $(`.dash-full .df-spend tr[data-row="agent:${B.id}"]`).click();
    ok(await until(() => text($('.dialog .dlg-id b')) === '乙-Codex', 3000), '點花費表的節點會打開它的對話視窗');
    $('.dialog button[aria-label="關閉"]')?.click();
    await wait(300);

    // ---------- 9. 狀態數字與節點的狀態一致;點下去跳到節點
    await window.nexus.send(C.id, '提問');
    await until(async () => (await snap()).agents.find(a => a.id === C.id).state === 'awaiting');
    await window.nexus.send(D.id, '〔測試執行:9000〕');
    await window.nexus.enqueue(D.id, '〔測試執行:300〕排隊的指令');
    await window.nexus.send(B.id, '〔測試出錯〕');
    await until(async () => (await snap()).agents.find(a => a.id === B.id).state === 'error');
    await wait(400);
    ok(count('running') === 1 && count('waiting') === 1 && count('queued') === 1 && count('fault') === 1, '狀態數字:執行中 1、等你處理 1、排隊 1、異常 1', ['running', 'waiting', 'queued', 'fault'].map(count));
    const st = (await snap()).agents;
    ok(st.find(a => a.id === D.id).state === 'working' && st.find(a => a.id === D.id).queued.length === 1 && st.find(a => a.id === C.id).state === 'awaiting' && st.find(a => a.id === B.id).state === 'error', '和節點實際的狀態一致', st.map(a => `${a.name}:${a.state}`));
    ok($('.dash .ds-waiting').classList.contains('has') && !$('.dash .ds-waiting').disabled, '有節點在等你時,數字亮起來而且可以點');
    $('.dash .ds-waiting').click();
    ok(await until(() => text($('.dialog .dlg-id b')) === '丙-Agy', 3000) && !$('.dash-pick'), '點「等你處理」(只有一個):直接打開等你的節點的對話視窗', text($('.dialog .dlg-id b')));
    ok(!!$('.dialog .dlg-question'), '對話視窗裡看得到它的提問');
    $('.dash .ds-fault').click();
    ok(await until(() => text($('.dialog .dlg-id b')) === '乙-Codex', 3000), '點「異常」:打開出錯的節點', text($('.dialog .dlg-id b')));
    $('.dash .ds-queued').click();
    ok(await until(() => text($('.dialog .dlg-id b')) === '丁-Claude', 3000), '點「排隊」:打開有排隊指令的節點', text($('.dialog .dlg-id b')));
    // 兩個節點在等:列出來讓你選
    await window.nexus.send(A.id, '提問');
    await until(async () => (await snap()).agents.find(a => a.id === A.id).state === 'awaiting');
    await wait(400);
    ok(count('waiting') === 2, '第二個節點也在等:等你處理 2', count('waiting'));
    $('.dash .ds-waiting').click();
    const pick = await until(() => $('.dash-pick'), 3000);
    const pickRows = $$('.dash-pick-row');
    ok(!!pick && pickRows.length === 2 && pickRows.some(r => text(r).includes('甲-Claude')) && pickRows.some(r => text(r).includes('丙-Agy')), '點「等你處理」(兩個):列出兩個節點', pickRows.map(text));
    const pr = pick.getBoundingClientRect(), sb = side.getBoundingClientRect();
    ok(pr.left >= sb.left - 1 && pr.right <= sb.right + 1 && pr.bottom <= innerHeight && document.elementFromPoint(pr.left + pr.width / 2, pr.top + 14)?.closest('.dash-pick'), '清單在右側欄裡、沒有被蓋住', [pr.left, pr.top, pr.right, pr.bottom]);
    await shot('3-pick');
    pickRows.find(r => text(r).includes('甲-Claude')).click();
    ok(await until(() => text($('.dialog .dlg-id b')) === '甲-Claude' && !$('.dash-pick'), 3000), '從清單選一個:打開它的對話視窗,清單關閉', text($('.dialog .dlg-id b')));

    // ---------- 10. 節點異常太久的提醒(這次測試把門檻縮短成 3 秒)
    ok(d.faultWarnMs === 3000, '測試用的異常門檻是 3 秒', d.faultWarnMs);
    const fault = await until(() => $$('.dash-full .df-warn').find(e => text(e).includes('乙-Codex 出錯已經')), 12000);
    ok(!!fault, '節點出錯超過門檻:出現「異常太久」的提醒', $$('.dash-full .df-warn').map(text));
    fault?.click();
    ok(await until(() => text($('.dialog .dlg-id b')) === '乙-Codex', 3000), '點這則提醒:打開那個節點');
    await shot('4-full-status');

    // 收尾:回答提問、中斷丁(留下一筆「中斷」)、喚回乙
    for (const id of [A.id, C.id]) { const q = (await snap()).agents.find(a => a.id === id).pendingQuestion; if (q) await window.nexus.answerQuestion(id, q.requestId, { q1: ['紅色'] }); }
    await window.nexus.cancelQueued(D.id, (await snap()).agents.find(a => a.id === D.id).queued[0]?.id);
    await window.nexus.interrupt(D.id);
    await window.nexus.send(B.id, '〔測試執行:200〕恢復');
    await until(async () => (await snap()).agents.every(a => a.state === 'idle'), 30000);
    await wait(700);
    ok(['running', 'waiting', 'queued', 'fault'].every(k => count(k) === 0), '節點都回到待命:四個狀態數字歸零', ['running', 'waiting', 'queued', 'fault'].map(count));
    ok(!$$('.dash-full .df-warn').some(e => text(e).includes('出錯已經')), '節點恢復後「異常太久」的提醒消失', $$('.dash-full .df-warn').map(text));

    // ---------- 11. 今天的任務統計;清除任務面板後統計不變
    const stat = k => Number(text($(`.dash-full .df-tasks [data-stat="${k}"] b`)));
    const tasks = (await snap()).tasks;
    const by = s => tasks.filter(t => t.status === s).length;
    ok(tasks.length === 12 && by('failed') === 1 && by('interrupted') === 1 && by('done') === 10, '這次測試交辦了 12 個任務:完成 10、出錯 1、中斷 1', { n: tasks.length, done: by('done'), failed: by('failed'), interrupted: by('interrupted') });
    ok(stat('assigned') === 12 && stat('done') === 10 && stat('failed') === 1 && stat('interrupted') === 1 && stat('running') === 0, '今天的任務統計和任務清單一致', ['assigned', 'done', 'failed', 'interrupted', 'running'].map(stat));
    await window.nexus.clearFinishedTasks();
    await wait(700);
    ok((await snap()).tasks.length === 0 && stat('assigned') === 12 && stat('done') === 10 && stat('failed') === 1, '清除已結束的任務後,今天的統計不變', ['assigned', 'done', 'failed'].map(stat));

    // ---------- 12. 外部觀察節點移進儀表;遠端裝置(由外部腳本檢查)
    ok(!$('.dash .dash-ext') && text($('.dash-full')).includes('目前沒有外部節點'), '沒有外部節點時,儀表標題列沒有「外部」');
    $('.dash-full button[aria-label="關閉"]').click();
    await wait(300);
    ok(!$('.dash-full') && $('.dash .dash-expand').getAttribute('aria-expanded') === 'false', '按 ✕ 收合完整內容');
    await window.nexus.remoteSet({ enabled: true });
    // hooks 只裝進測試用的設定檔(外層腳本用 NEXUS_CLAUDE_SETTINGS 指到暫存資料夾);不是的話不安裝,免得動到真正的設定
    const obs = await window.nexus.observeStatus();
    if (!/nexus-dash/.test(obs.settingsPath)) throw new Error(`設定檔不在測試資料夾:${obs.settingsPath}`);
    await window.nexus.observeInstall();
    await wait(1200);
    const rs = await window.nexus.remoteStatus();
    log('PAIR', rs.pairCode, A.id, rs.port, B.id);
    const done = await until(async () => (await window.nexus.getHistory(A.id)).some(e => e.type === 'message' && e.role === 'user' && e.text.includes('遠端檢查完成')), 90000);
    ok(!!done, '外部腳本(遠端裝置的檢查)已回報');
    const ext = await until(() => $('.dash .dash-ext'), 8000);
    ok(text(ext) === '外部 1' && ext.classList.contains('warn'), '外部節點在等授權:儀表標題列出現「外部 1」並轉成警示色', text(ext));
    ok(count('waiting') === 0, '外部節點不算進「等你處理」(那邊的授權要到外部的終端機處理)', count('waiting'));
    ext.click();
    const rows = await until(() => ($$('.dash-full .observed-row').length ? $$('.dash-full .observed-row') : null), 3000);
    ok(rows?.length === 1 && text(rows[0]).includes('work') && text(rows[0]).includes('待授權') && !!$('.observed-take', rows[0]), '點「外部」展開:外部觀察區塊列出那個節點,可以接手', rows?.map(text));
    ok(!$('.sidebar .observed-row'), '外部節點不再出現在右側欄');
    await shot('5-full-observed');
    $('.dash-full button[aria-label="關閉"]').click();

    // ---------- 13. 小視窗:儀表精簡成每家後台一列,任務面板與新增按鈕還看得到
    document.title = 'SIZE:960,540';
    await wait(1800);
    const dh = $('.dash').getBoundingClientRect(), th = $('.tasks').getBoundingClientRect(), ah = $('button.add').getBoundingClientRect();
    ok(dh.height <= 230 && th.height >= 150 && ah.bottom <= innerHeight + 1, '960×540:儀表不高於 230,任務面板至少 150 高,新增按鈕在畫面內', { dash: dh.height, tasks: th.height, add: ah.bottom, h: innerHeight });
    ok(text($('.dq-pct', quota('claude', '每週'))) === '93%' && quota('claude', '每週').title.includes('重置'), '小視窗仍顯示百分比,重置時間在提示文字');
    await shot('6-small');
    $('.dash .dash-expand').click();
    const sf = (await until(() => $('.dash-full'), 3000))?.getBoundingClientRect();
    ok(!!sf && sf.left >= 0 && sf.right <= innerWidth && sf.bottom <= innerHeight + 1 && $('.dash-full').scrollHeight >= $('.dash-full').clientHeight, '960×540:完整內容在畫面內(內容太長時自己捲動)', sf && [sf.left, sf.top, sf.right, sf.bottom]);
    await shot('7-small-full');

    log('主控台端結束');
  } catch (err) {
    log('失敗', err.stack ?? err.message);
  }
  document.title = 'QUIT';
})();
