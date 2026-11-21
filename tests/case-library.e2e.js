// 驗收:長期記憶階段 3 判例庫(假資料模式,由 tests/case-library.sh 啟動;需要 NEXUS_FAKE=1、NEXUS_FAKE_ECHO=1、NEXUS_FAKE_CASE=1、NEXUS_CASE_MIN_MINUTES=0.03)。
// 外層腳本先在記憶庫放一份「已確認」的判例(案號年份-0001),跑完後再檢查判例檔案本身。
// 檢查:候選偵測(快速任務不算、中途失敗後成功、耗時超過門檻)、請承辦節點撰寫並提交、案號連號、請求提示詞列出先例、重複提交被擋、
// 判例請求本身不會變成候選、每天自動 3 份的上限、手動標記不受上限限制、任務卡上的案號標籤與「記下這個解法」按鈕。
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
  const errText = e => String(e.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const tasksOf = async id => (await snap()).tasks.filter(t => t.agentId === id).sort((a, b) => a.startedAt - b.startedAt);
  const task = async id => (await snap()).tasks.find(t => t.id === id);
  const idle = id => until('回到待命', async () => ['idle', 'error'].includes((await snap()).agents.find(a => a.id === id)?.state));
  const run = async (id, text) => {
    const before = (await tasksOf(id)).length;
    await window.nexus.send(id, text);
    const t = await until('任務結束', async () => { const l = await tasksOf(id); return l.length > before && l[before].endedAt !== null ? l[before] : null; });
    await idle(id);
    return t;
  };
  const create = async (name, cwd) => {
    const a = await window.nexus.createAgent({ name, character: '', model: '', backend: 'claude', cwd, permissionMode: 'auto' });
    await until(`${name} 待命`, async () => (await snap()).agents.find(x => x.id === a.id)?.state === 'idle');
    return a;
  };
  const history = async id => (await window.nexus.getHistory(id)).filter(e => e.type === 'note').map(e => e.text);
  const caseTasks = async id => (await tasksOf(id)).filter(t => t.source === 'case');
  const Y = String(new Date().getFullYear());
  const caseId = n => `${Y}-${String(n).padStart(4, '0')}`;
  const withCase = id => until('判例寫好', async () => { const t = await task(id); return t.caseId ? t : null; }, 40000);

  try {
    await window.nexus.setAutopilot(false);
    const cwd = window.__TEST_CWD__;
    const A = await create('甲號', cwd), B = await create('乙號', cwd), C = await create('丙號', cwd);

    // ---- 快速、正常完成的任務不是候選
    const q = await run(A.id, '〔測試執行:300〕快速任務');
    await wait(2500);
    const q2 = await task(q.id);
    ok(q.status === 'done' && !q2.caseId && !q2.casePending && (await caseTasks(A.id)).length === 0, '快速完成的任務不是候選,沒有請節點寫判例', JSON.stringify(q2));

    // ---- 中途失敗後才成功:請承辦節點寫,節點用 case_submit 提交
    const t1 = await run(A.id, '〔測試中途出錯〕登入逾時問題 〔測試重複提交〕');
    ok(t1.status === 'done', '中途出錯的任務最後是完成', t1.status);
    const t1c = await withCase(t1.id);
    ok(t1c.caseId === caseId(2) && !t1c.casePending, '判例的案號接在已有的 0001 後面(0002),等待旗標已清除', JSON.stringify(t1c));
    const ct = await caseTasks(A.id);
    ok(ct.length === 1 && ct[0].agentId === A.id, '請求是排給承辦節點本人的(來源 case 的任務一筆)', JSON.stringify(ct.map(t => [t.agentId, t.title.slice(0, 20)])));
    await until('判例請求任務結束', async () => (await caseTasks(A.id))[0]?.endedAt !== null);
    await idle(A.id);
    const notesA = await history(A.id);
    const sent = notesA.find(t => t.startsWith('[echo] send:') && t.includes('判例撰寫請求'));
    ok(sent && sent.includes(`任務編號:${t1.id}`) && sent.includes('case_submit') && ['事實經過', '爭點', '處理經過', '結論', '理由', '適用範圍', '參照先例'].every(k => sent.includes(k)), '請求提示詞含任務編號、工具名稱與固定章節', sent);
    ok(sent && sent.includes(`[[${caseId(1)}]] 登入逾時的處理`), '請求提示詞列出相關的已確認先例', sent);
    const results = notesA.filter(t => t.startsWith('[case] '));
    ok(results.length === 2 && results[0].startsWith('[case] OK ') && results[0].includes(caseId(2)), '第一次提交成功', JSON.stringify(results));
    ok(results[1] && results[1].startsWith('[case] ERROR ') && results[1].includes('已經有判例'), '同一個任務重複提交被擋下', JSON.stringify(results));
    const v1 = (await window.nexus.getMemoryVault()).entries.find(e => e.path.startsWith(`cases/work/${caseId(2)}-`));
    ok(v1 && v1.kind === 'case' && v1.status === '未確認' && v1.title.startsWith('測試判例'), '記憶庫索引裡有這份判例,狀態是未確認', JSON.stringify(v1));
    const afterCase = (await caseTasks(A.id))[0];
    ok(!afterCase.caseId && !afterCase.casePending, '判例請求本身不會變成候選(沒有再請求第二次)', JSON.stringify(afterCase));
    ok((await caseTasks(A.id)).length === 1, '沒有連鎖的判例請求');

    // ---- 耗時超過門檻
    const t2 = await run(A.id, '〔測試執行:2500〕長時間任務');
    ok((await withCase(t2.id)).caseId === caseId(3), '耗時超過門檻的任務也請節點寫判例(0003)');
    await until('第二份判例請求結束', async () => (await caseTasks(A.id)).length === 2 && (await caseTasks(A.id))[1].endedAt !== null);
    await idle(A.id);

    // ---- 上限:自動撰寫一天最多 3 份
    const t3 = await run(B.id, '〔測試中途出錯〕第三件');
    ok((await withCase(t3.id)).caseId === caseId(4), '第三份自動判例(0004,別的節點)');
    await until('乙號的判例請求結束', async () => (await caseTasks(B.id)).length === 1 && (await caseTasks(B.id))[0].endedAt !== null);
    await idle(B.id);
    const t4 = await run(C.id, '〔測試中途出錯〕第四件');
    await wait(4000);
    const t4b = await task(t4.id);
    ok(!t4b.caseId && !t4b.casePending && (await caseTasks(C.id)).length === 0, '今天已經自動寫了 3 份,第四個候選不再請求', JSON.stringify(t4b));

    // ---- 手動標記:不受上限限制
    const msg = await window.nexus.markCase(t4.id);
    ok(/已請「丙號」/.test(msg), '「記下這個解法」回傳說明', msg);
    const t4c = await withCase(t4.id);
    ok(t4c.caseId === caseId(5), '手動標記的判例照樣寫成(0005)', t4c.caseId);
    await until('丙號的判例請求結束', async () => (await caseTasks(C.id)).length === 1 && (await caseTasks(C.id))[0].endedAt !== null);
    await idle(C.id);
    try { await window.nexus.markCase(t4.id); ok(false, '已有判例的任務不能再標記'); } catch (e) { ok(/已經有判例/.test(errText(e)), '已有判例的任務不能再標記', errText(e)); }
    try { await window.nexus.markCase((await caseTasks(C.id))[0].id); ok(false, '判例請求本身不能標記'); } catch (e) { ok(/撰寫判例的請求/.test(errText(e)), '判例請求本身不能標記', errText(e)); }
    try { await window.nexus.markCase('no-such-task'); ok(false, '找不到的任務被拒絕'); } catch (e) { ok(/找不到/.test(errText(e)), '找不到的任務被拒絕', errText(e)); }
    await window.nexus.send(C.id, '〔測試執行:3000〕還在跑');
    const running = await until('還在跑的任務', async () => (await tasksOf(C.id)).find(t => t.endedAt === null && t.source !== 'case'));
    try { await window.nexus.markCase(running.id); ok(false, '執行中的任務不能標記'); } catch (e) { ok(/還沒結束/.test(errText(e)), '執行中的任務不能標記', errText(e)); }
    await until('還在跑的任務結束', async () => (await task(running.id)).endedAt !== null);
    await idle(C.id);
    await wait(1500);
    ok(!(await task(running.id)).casePending, '超過上限後耗時的任務也沒有自動請求');

    // ---- 任務面板:案號標籤與按鈕
    const card = title => [...document.querySelectorAll('.tasks-list .task')].find(el => el.querySelector('.task-title')?.textContent.startsWith(title));
    ok(await until('任務卡出現案號標籤', () => card('登入逾時問題')?.querySelector('.task-case')?.textContent.includes(`判例 ${caseId(2)}`), 10000), '任務卡顯示「判例 案號」標籤', card('登入逾時問題')?.textContent);
    ok(/未確認/.test(card('登入逾時問題')?.querySelector('.task-case')?.textContent ?? ''), '標籤顯示狀態未確認');
    ok(Boolean(card('快速任務')?.querySelector('.task-case-btn')) && !card('登入逾時問題')?.querySelector('.task-case-btn'), '沒有判例的已結束任務有「記下這個解法」按鈕,有判例的沒有');
    ok(card('快速任務')?.querySelector('.task-case-btn')?.textContent === '記下這個解法', '按鈕文字');
    card('快速任務').querySelector('.task-case-btn').click();
    const q3 = await withCase(q.id);
    ok(q3.caseId === caseId(6), '點擊按鈕後寫成判例(0006)', q3.caseId);
    document.title = 'SHOT:case-tasks';
    await wait(1200);
  } catch (e) {
    bad++;
    log('不符 腳本中斷', e && e.stack ? e.stack : String(e));
  }
  log(bad ? `有 ${bad} 項不符` : '全部通過');
  log('主控台端結束');
  document.title = 'QUIT';
})();
