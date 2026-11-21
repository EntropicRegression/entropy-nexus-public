// 驗收:長期記憶階段 1(假資料模式,由 tests/memory-phase1.sh 啟動;需要 NEXUS_FAKE=1、NEXUS_FAKE_ECHO=1、NEXUS_CHIEF_STATS_MS=5000)。
// 外層腳本準備:git 版本庫 repo 與它的 worktree wt、非 git 資料夾 plain,以及啟動前就放進記憶庫的 knowledge\startup\pre.md;
// 截圖「vault-drop」「vault-edit」「vault-delete」出現時,外層腳本會新增、修改、刪除記憶庫裡的檔案。
// 檢查:交辦時寫入專案(worktree 與主版本庫同一個專案)、驗收按鈕、評論送回自動退回、記憶庫索引、總管收到的節點統計數字與通知頻率。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  let bad = 0;
  const ok = (cond, what, extra = '') => { if (!cond) bad++; log(cond ? '通過' : '不符', what, cond || !extra ? '' : `→ ${String(extra).slice(0, 600)}`); };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const snap = () => window.nexus.getSnapshot();
  const until = async (what, fn, timeout = 40000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await wait(200); }
    throw new Error(`等不到:${what}`);
  };
  const shot = async name => { document.title = `SHOT:${name}`; await wait(1200); };
  const errText = e => String(e.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const tasksOf = async id => (await snap()).tasks.filter(t => t.agentId === id).sort((a, b) => a.startedAt - b.startedAt);
  const notes = async id => (await window.nexus.getHistory(id)).filter(e => e.type === 'note' && e.text.startsWith('[echo] ')).map(e => e.text.slice(7));
  const idle = id => until('回到待命', async () => ['idle', 'error'].includes((await snap()).agents.find(a => a.id === id)?.state));
  // 送一句指令並等這個節點的任務結束,回傳那筆任務
  const run = async (id, text) => {
    const before = (await tasksOf(id)).length;
    await window.nexus.send(id, text);
    const t = await until('任務結束', async () => { const l = await tasksOf(id); return l.length > before && l[before].endedAt !== null ? l[before] : null; });
    await idle(id);
    return t;
  };
  // 送一句指令給總管,回傳假資料轉接器實際收到的文字
  const ask = async (id, text) => {
    const before = (await notes(id)).filter(t => t.startsWith('send:')).length;
    await window.nexus.send(id, text);
    const sent = await until('送出的回吐', async () => (await notes(id)).filter(t => t.startsWith('send:'))[before]);
    await window.nexus.interrupt(id);
    await idle(id);
    return sent.slice(5);
  };
  const create = async (name, cwd) => {
    const a = await window.nexus.createAgent({ name, character: '', model: '', backend: 'claude', cwd, permissionMode: 'auto' });
    await until(`${name} 待命`, async () => (await snap()).agents.find(x => x.id === a.id)?.state === 'idle');
    return a;
  };
  const vault = async () => (await window.nexus.getMemoryVault());

  try {
    await window.nexus.setAutopilot(false);
    const repo = window.__TEST_CWD__;
    const wt = repo.replace(/repo$/, 'wt'), plain = repo.replace(/repo$/, 'plain');

    // ---- 記憶庫:啟動時就掃描了啟動前放進去的檔案
    const v0 = await vault();
    ok(/memory-vault$/.test(v0.dir), '記憶庫資料夾在資料目錄下', v0.dir);
    const pre = v0.entries.find(e => e.path === 'knowledge/startup/pre.md');
    ok(pre && pre.title === '啟動前放的知識' && pre.kind === 'knowledge' && pre.scope === '專案' && pre.projectId === 'startup' && pre.status === '已確認', '啟動時掃描並索引啟動前放的檔案', JSON.stringify(v0.entries));
    ok(v0.entries.length === 1, '索引裡只有這一筆(說明檔不算)', v0.entries.length);

    // ---- 專案:交辦當下寫入
    const A = await create('AlphaA', repo), B = await create('BetaB', wt), C = await create('GammaC', plain), D = await create('總管乙', plain);
    const a1 = await run(A.id, '〔測試執行:300〕甲任務一');
    const b1 = await run(B.id, '〔測試執行:300〕乙任務');
    ok(a1.status === 'done' && a1.project && a1.project.name === 'repo', '主版本庫節點的任務有專案,名稱是資料夾名稱', JSON.stringify(a1.project));
    ok(b1.project && b1.project.id === a1.project.id && b1.project.name === 'repo', 'worktree 節點的任務和主版本庫是同一個專案', JSON.stringify([a1.project, b1.project]));
    const c1 = await run(C.id, '〔測試執行:300〕丙任務一');
    ok(c1.project && c1.project.name === 'plain' && c1.project.id !== a1.project.id, '非 git 資料夾是另一個專案,名稱是資料夾名稱', JSON.stringify(c1.project));
    const c2 = await run(C.id, '〔測試出錯〕丙任務二');
    ok(c2.status === 'failed' && c2.project && c2.project.id === c1.project.id, '失敗的任務也有專案', JSON.stringify([c2.status, c2.project]));
    // 專案已經存進任務紀錄:重新讀取快照仍在(不是畫面暫存)
    const reread = (await tasksOf(A.id))[0];
    ok(reread.project?.id === a1.project.id, '重新取得快照時專案仍在', JSON.stringify(reread.project));

    // ---- 驗收:API
    ok(a1.verdict === undefined || a1.verdict === null, '新任務尚未驗收', String(a1.verdict));
    await window.nexus.setTaskVerdict(a1.id, 'accepted');
    ok((await tasksOf(A.id))[0].verdict === 'accepted', '驗收之後快照的 verdict 是 accepted');
    await window.nexus.setTaskVerdict(a1.id, null);
    ok(((await tasksOf(A.id))[0].verdict ?? null) === null, '清除之後回到尚未驗收');
    try { await window.nexus.setTaskVerdict(a1.id, 'maybe'); ok(false, '不正確的驗收結果被拒絕'); } catch (e) { ok(/不正確/.test(errText(e)), '不正確的驗收結果被拒絕', errText(e)); }
    try { await window.nexus.setTaskVerdict('no-such-task', 'accepted'); ok(false, '找不到的任務被拒絕'); } catch (e) { ok(/找不到/.test(errText(e)), '找不到的任務被拒絕', errText(e)); }

    // ---- 驗收:任務面板的按鈕(真的點擊)
    const card = title => [...document.querySelectorAll('.tasks-list .task')].find(el => el.querySelector('.task-title')?.textContent.includes(title));
    const clickIn = (title, cls) => { const b = card(title)?.querySelector(`.task-verdict-btn.${cls}`); if (b) b.click(); return Boolean(b); };
    ok(await until('任務卡出現驗收按鈕', () => card('甲任務一')?.querySelectorAll('.task-verdict-btn.v-accepted, .task-verdict-btn.v-rejected').length === 2), '已結束的任務卡有 ✓ 驗收 與 ✗ 退回 兩個按鈕');
    ok(clickIn('甲任務一', 'v-accepted'), '點擊 ✓ 驗收');
    ok(await until('驗收寫入', async () => (await tasksOf(A.id))[0].verdict === 'accepted', 8000), '按下 ✓ 驗收之後任務是 accepted');
    ok(await until('按鈕亮起', () => card('甲任務一')?.querySelector('.v-accepted.on'), 8000), '按鈕顯示為已驗收');
    // 驗收按鈕是「再按一次就切換」:每次只點一下,等資料和按鈕外觀都更新後再點下一下(連點會來回切換,結果不固定)
    clickIn('甲任務一', 'v-accepted');
    ok(await until('已清除', async () => ((await tasksOf(A.id))[0].verdict ?? null) === null && !card('甲任務一')?.querySelector('.v-accepted.on'), 8000), '再按一次取消驗收');
    clickIn('甲任務一', 'v-accepted');
    ok(await until('再次驗收', async () => (await tasksOf(A.id))[0].verdict === 'accepted' && card('甲任務一')?.querySelector('.v-accepted.on'), 8000), '取消後再按一次又變回驗收');
    ok(clickIn('丙任務一', 'v-rejected'), '點擊 ✗ 退回');
    ok(await until('退回寫入', async () => (await tasksOf(C.id))[0].verdict === 'rejected', 8000), '按下 ✗ 退回之後任務是 rejected');
    await window.nexus.setTaskVerdict(c1.id, null);
    const running = await window.nexus.send(B.id, '〔測試執行:2500〕乙任務二').then(() => until('乙任務二開始', async () => (await tasksOf(B.id)).find(t => t.endedAt === null)));
    ok(!card('乙任務二')?.querySelector('.task-verdict-btn'), '執行中的任務卡沒有驗收按鈕');
    try { await window.nexus.setTaskVerdict(running.id, 'accepted'); ok(false, '執行中的任務不能驗收'); } catch (e) { ok(/還沒結束/.test(errText(e)), '執行中的任務不能驗收', errText(e)); }
    await until('乙任務二結束', async () => (await tasksOf(B.id)).every(t => t.endedAt !== null));
    await idle(B.id);

    // ---- 評論送回節點:自動退回
    const a2 = await run(A.id, '〔測試執行:300〕甲任務二');
    ok((a2.verdict ?? null) === null, '送出評論之前第二個任務尚未驗收');
    await window.nexus.sendReviewComments(a2.id, [{ path: 'a.txt', row: null, side: 'new', line: 1, text: '這裡要改' }]);
    ok((await tasksOf(A.id)).find(t => t.id === a2.id).verdict === 'rejected', '把評論送回節點之後,原任務自動標成 rejected');
    // 評論送回後重做的任務本身是判例候選,判例庫會另外排一個「請寫判例」的任務(來源 case);這裡只看一般任務
    await until('評論產生的任務結束', async () => { const l = (await tasksOf(A.id)).filter(t => t.source !== 'case'); return l.length === 3 && l[2].endedAt !== null; }, 60000);
    await idle(A.id);
    const a3 = (await tasksOf(A.id)).filter(t => t.source !== 'case')[2];
    ok(a3.status === 'interrupted' || a3.status === 'done', '評論產生了新任務(第三筆)', a3.status);
    await window.nexus.interrupt(A.id).catch(() => {});
    await shot('1-tasks-panel');

    // ---- 記憶庫:外部新增、修改、刪除
    await shot('vault-drop');
    const dropped = await until('索引到新放的檔案', async () => (await vault()).entries.find(e => e.path === 'preferences/dropped.md'), 15000);
    ok(dropped.title === '回報要精簡' && dropped.kind === 'preference' && dropped.scope === '全域', '外部放進來的檔案被索引', JSON.stringify(dropped));
    await shot('vault-edit');
    const edited = await until('索引更新', async () => (await vault()).entries.find(e => e.path === 'preferences/dropped.md' && e.title === '回報要詳細'), 15000);
    ok(edited.status === '已確認' && (await vault()).entries.filter(e => e.path === 'preferences/dropped.md').length === 1, '外部修改之後重新讀取:標題與狀態更新、沒有重複', JSON.stringify(edited));
    await shot('vault-delete');
    ok(await until('索引移除', async () => !(await vault()).entries.some(e => e.path === 'preferences/dropped.md'), 15000), '外部刪除檔案後從索引移除');

    // ---- 總管收到的節點統計
    // 目前:A 3 筆;B 2 筆(乙任務一、乙任務二,都完成,沒驗收);C 2 筆(丙一完成、丙二失敗)
    const stateA = (await tasksOf(A.id)).filter(t => t.source !== 'case');
    const doneA = stateA.filter(t => t.status === 'done').length;
    const accA = stateA.filter(t => t.verdict === 'accepted').length, rejA = stateA.filter(t => t.verdict === 'rejected').length;
    log('A 的任務', JSON.stringify(stateA.map(t => [t.title.slice(0, 8), t.status, t.verdict ?? null])));
    await window.nexus.setChief(D.id);
    const first = await ask(D.id, '請看一下');
    ok(first.includes('你已被指定為總管節點') && first.includes('各節點的近況(主控台統計'), '指定總管之後,下一則指令前的通知帶有節點統計段落', first.slice(0, 300));
    const lineOf = (text, name) => text.split('\n').find(l => l.startsWith(`- ${name}(`)) ?? '';
    const finA = doneA + stateA.filter(t => ['failed', 'interrupted'].includes(t.status)).length;
    const pctA = Math.round(doneA / finA * 100);
    const lA = lineOf(first, 'AlphaA'), lB = lineOf(first, 'BetaB'), lC = lineOf(first, 'GammaC');
    ok(lA.includes(`完成率 ${pctA}%(${doneA}/${finA})`) && lA.includes(`驗收率 ${Math.round(accA / (accA + rejA) * 100)}%(${accA}/${accA + rejA})`) && lA.endsWith('近期專案 repo') && /平均耗時 \d/.test(lA), 'AlphaA 的完成率、驗收率(含分子分母)與專案正確', lA);
    ok(lB.includes('完成率 100%(2/2)') && lB.includes('驗收率 尚無驗收') && lB.endsWith('近期專案 repo'), 'BetaB:完成 2/2、尚無驗收、同一個專案 repo', lB);
    ok(lC.includes('完成率 50%(1/2)') && lC.includes('驗收率 尚無驗收') && lC.endsWith('近期專案 plain'), 'GammaC:完成 1/2(一次失敗)、尚無驗收、專案 plain', lC);
    ok(!first.includes('- 總管乙('), '總管自己不在統計裡');
    ok(first.indexOf('- AlphaA(') < first.indexOf('- BetaB(') && first.indexOf('- BetaB(') < first.indexOf('- GammaC('), '依最近交辦的時間排序:AlphaA、BetaB、GammaC');

    // 重新啟動 session(休眠再喚醒):守則本身就帶了最新的統計
    await window.nexus.sleep(D.id);
    await until('休眠', async () => (await snap()).agents.find(a => a.id === D.id)?.state === 'sleeping');
    const startNotes = (await notes(D.id)).length;
    await window.nexus.wake(D.id);
    const persona = await until('session 啟動的身分設定', async () => (await notes(D.id)).slice(startNotes).find(t => t.startsWith('persona:')), 20000);
    ok(persona.includes('你是這個主控台的「總管」節點') && lineOf(persona, 'GammaC').includes('完成率 50%(1/2)'), 'session 啟動時的身分設定帶有節點統計', persona.slice(-400));
    await idle(D.id);

    // ---- 通知頻率:統計有變、而且超過間隔才通知
    const t0 = Date.now();
    const a4 = await run(A.id, '〔測試執行:200〕甲任務三');
    const quick = await ask(D.id, '再看一下');
    ok(!quick.includes('主控台通知') && quick === '再看一下', '統計有變但離上次告知還沒超過間隔:不通知', quick.slice(0, 200));
    await wait(Math.max(0, 5600 - (Date.now() - t0)));
    const later = await ask(D.id, '第三次');
    const lA2 = lineOf(later, 'AlphaA');
    ok(later.includes('各節點的統計已更新') && lA2.includes(`完成率 ${Math.round((doneA + 1) / (finA + 1) * 100)}%(${doneA + 1}/${finA + 1})`), '超過間隔後通知,數字包含新完成的任務', lA2);
    // 清除任務面板的已結束任務:統計仍然算得到,而且沒有變化就不通知
    await window.nexus.clearFinishedTasks();
    ok((await snap()).tasks.filter(t => t.endedAt !== null && t.agentId !== D.id).length === 0, '任務面板已清除');
    await wait(5600);
    const same = await ask(D.id, '第四次');
    ok(same === '第四次', '統計沒有變化:不通知(清除任務面板不影響統計)', same.slice(0, 200));
    await shot('2-done');
  } catch (e) {
    bad++;
    log('不符 腳本中斷', e && e.stack ? e.stack : String(e));
  }
  log(bad ? `有 ${bad} 項不符` : '全部通過');
  log('主控台端結束');
  document.title = 'QUIT';
})();
