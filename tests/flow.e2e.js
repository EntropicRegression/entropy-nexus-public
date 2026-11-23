// 協作流程 M2 的驗收(假資料模式,主控台這一側;外層是 tests/flow.sh)。
// 每個情境在 NEXUS_TEST_CWD 底下有自己的 git 版本庫(flow.sh 建好),建立實作與審查節點後用 flowStart 啟動 e2e-flow 範本,
// 假資料節點照主題裡的〔測試流程:…〕腳本行動(見 src/main/adapters/fake.ts 的 flowTurn)。情境同時進行,各自檢查結果。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const ok = (cond, what, extra = '') => log(cond ? '通過' : '不符', what + (cond || !extra ? '' : ` → ${String(extra).slice(0, 300)}`));
  const N = window.nexus;
  const base = window.__TEST_CWD__;
  const repo = name => `${base}\\${name}`;
  const TPL = 'e2e-flow';
  const until = async (fn, ms = 60000, step = 250) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = await fn(); if (v) return v; } catch { /* 再試 */ } await wait(step); } return null; };
  const view = async id => (await N.flowList()).find(r => r.id === id);
  const waitRun = (id, pred, ms = 60000) => until(async () => { const r = await view(id); return r && pred(r) ? r : null; }, ms);
  const attempts = (r, step) => r.steps.find(s => s.id === step)?.attempts ?? [];
  const hist = async id => await N.getHistory(id);
  const users = async id => (await hist(id)).filter(e => e.type === 'message' && e.role === 'user').map(e => e.text);
  const notes = async id => (await hist(id)).filter(e => e.type === 'note').map(e => e.text);
  const mk = (name, cwd, backend = 'claude') => N.createAgent({ name, character: '', model: '', backend, cwd, permissionMode: 'auto' });
  const brief = r => r ? `${r.status}/${r.phase ?? ''} 步驟=${r.stepId} 退回=${r.rejections} pending=${r.pending?.kind ?? ''} reason=${r.reason ?? ''}` : '(沒有流程)';

  try {
    await N.setAutopilot(false);
    await N.setMaxActive(40);
    const chief = await mk('Chief', repo('pass'));
    await N.setChief(chief.id);
    const tpls = await N.flowTemplates();
    ok(tpls.some(t => t.id === TPL && !t.errors.length) && tpls.some(t => t.id === 'implement-review'), '範本清單有內建範本與使用者範本', JSON.stringify(tpls.map(t => t.id)));

    /** 建立一個情境的節點並啟動流程,回傳 { id, impl, rev }。 */
    const start = async (name, script, backends = ['claude', 'codex']) => {
      const impl = await mk(`Impl-${name}`, repo(name), backends[0]);
      const rev = await mk(`Rev-${name}`, repo(name), backends[1]);
      await wait(800);
      const r = await N.flowStart({ templateId: TPL, topic: `情境 ${name}〔測試流程:${script}〕`, cwd: repo(name), roles: { implementer: impl.id, reviewer: rev.id } });
      log('RUN', name, r.id);
      return { id: r.id, impl, rev, name };
    };

    const scenarios = [];
    const scenario = (name, fn) => scenarios.push((async () => {
      try { await fn(); } catch (err) { log('失敗', `${name}:`, err.stack ?? err.message); }
    })());

    // ---- 1. 一次通過(含一份驗證不過的回報不算數、範圍外檔案、授權卡)
    scenario('pass', async () => {
      const s = await start('pass', 'implement#1=write:src/a.txt:v1,write:notes.txt:outside,bad,report;review#1=ok');
      const r = await waitRun(s.id, x => x.status === 'completed');
      ok(!!r, '一次通過:流程走完', brief(await view(s.id)));
      if (!r) return;
      ok(r.rejections === 0 && attempts(r, 'implement').length === 1 && attempts(r, 'review').length === 1 && attempts(r, 'fix').length === 0, '一次通過:實作與審查各一次、沒有退回', brief(r));
      const impl = attempts(r, 'implement')[0];
      ok(impl.report?.summary?.startsWith('假資料實作') && impl.verify?.outcome === 'pass', '一次通過:實作有回報,主控台自己重跑核實通過', JSON.stringify(impl.verify?.outcome));
      ok((await notes(s.impl.id)).some(t => t.includes('bad → ERROR') && t.includes('不算數')), '驗證不過的回報被拒收(不算數),節點可以重送');
      ok(impl.files.some(f => f.endsWith('.md')) && impl.files.some(f => f.endsWith('check.log')), '一次通過:回報 md 與核實 log 都記在嘗試的檔案裡', JSON.stringify(impl.files));
      const revA = attempts(r, 'review')[0];
      ok(revA.report?.verdict === 'mergeable' && revA.version === impl.version, '一次通過:審查的是實作交出的版本', `${revA.version} vs ${impl.version}`);
      const reviewPrompt = (await users(s.rev.id)).find(t => t.includes('審查副本:'));
      ok(!!reviewPrompt && /copies\\r-[0-9a-f]{8}/.test(reviewPrompt) && reviewPrompt.includes('假資料實作'), '審查交辦附上副本路徑與實作者的回報(從檔案讀回)', reviewPrompt?.slice(0, 200));
      ok(r.violations.some(v => v.kind === 'out_of_scope' && v.items.includes('notes.txt')), '改到範圍外的檔案只標示、不擋', JSON.stringify(r.violations));
      const card = r.approvals[0];
      ok(card && card.action === 'commit' && card.status === 'pending' && card.paths.join() === 'src/a.txt' && card.outOfScope.join() === 'notes.txt' && card.version === r.version && card.excludes.includes('push'), '授權卡:版本、範圍內預設納入、範圍外要勾選、寫明不含 push', JSON.stringify(card));
      const after = await N.flowApprove(s.id, card.id, {});
      ok(after.approvals[0].status === 'approved' && /已提交 [0-9a-f]+/.test(after.approvals[0].result ?? ''), '授權卡允許後主控台提交(版本相同)', JSON.stringify(after.approvals[0]));
    });

    // ---- 2. 退回一輪後通過
    scenario('reject1', async () => {
      const s = await start('reject1', 'implement#1=write:src/a.txt:v1,report;review#1=fix:補上第二行;fix#1=write:src/a.txt:v2,report;review#2=ok', ['codex', 'antigravity']);
      const r = await waitRun(s.id, x => x.status === 'completed');
      ok(!!r, '退回一輪:流程走完', brief(await view(s.id)));
      if (!r) return;
      const fix = attempts(r, 'fix');
      ok(r.rejections === 1 && fix.length === 1 && attempts(r, 'review').length === 2, '退回一輪:退回 1 輪、修正 1 次、複審 1 次', brief(r));
      ok(fix[0]?.agentId === s.impl.id && fix[0]?.continuation === 'continued', '退回一輪:修正送回原 session(延續)', JSON.stringify(fix[0]));
      const p = (await users(s.impl.id)).find(t => t.includes('流程步驟:fix'));
      ok(!!p && p.includes('補上第二行') && !p.includes('交審版本的 diff'), '修正交辦附上必修(延續原 session 不附 diff)', p?.slice(0, 300));
    });

    // ---- 3. 退回兩輪後停機
    scenario('reject2', async () => {
      const s = await start('reject2', 'implement#1=write:src/a.txt:v1,report;review=fix:還是不行;fix#1=write:src/a.txt:v2,report;fix#2=write:src/a.txt:v3,report');
      const r = await waitRun(s.id, x => x.status === 'halted');
      ok(!!r, '退回兩輪:停機', brief(await view(s.id)));
      if (!r) return;
      ok(r.rejections === 2 && attempts(r, 'review').length === 3 && attempts(r, 'fix').length === 2 && /上限/.test(r.reason ?? ''), '退回兩輪:第 3 輪還有必修就停機,不再交辦', brief(r));
      ok(r.approvals.length === 0, '停機不產生授權卡');
    });

    // ---- 4. 遲到回報不推進:第一次沒回報(提醒後仍沒有)→ 重跑;舊交辦的回報在第二次交辦進行中才到
    scenario('late', async () => {
      const s = await start('late', 'implement#1=write:src/a.txt:v1,none,late:6000;implement#1~r=none;implement#2=write:src/a.txt:v2,wait:9000,report;review#1=ok');
      const r1 = await waitRun(s.id, x => x.status === 'awaiting_user' && x.pending?.kind === 'unreported', 30000);
      ok(!!r1, '遲到回報:第一次交辦提醒後仍沒回報 → 交給使用者', brief(await view(s.id)));
      if (!r1) return;
      await N.flowDecide(s.id, r1.pending.id, 'rerun');
      const mid = await until(async () => (await N.flowLateFiles(s.id)).length > 0 ? view(s.id) : null, 20000);
      ok(!!mid, '遲到回報:舊交辦的回報寫進 late/');
      if (mid) {
        const a = attempts(mid, 'implement');
        ok(a.length === 2 && !a[0].report && a[1].status === 'running' && mid.stepId === 'implement' && attempts(mid, 'review').length === 0, '遲到回報:不推進流程(第二次交辦仍在進行、沒有進入審查)', brief(mid) + JSON.stringify(a.map(x => x.status)));
      }
      ok((await notes(s.impl.id)).some(t => t.includes('late → OK') && t.includes('不會推進流程')), '遲到回報:節點收到「不會推進流程」的回覆');
      const r = await waitRun(s.id, x => x.status === 'completed', 40000);
      ok(!!r && attempts(r, 'implement')[0].status === 'unreported' && !attempts(r, 'implement')[0].report && !!attempts(r, 'implement')[1].report, '遲到回報:第二次交辦完成後流程走完,第一次仍記為未回報', brief(r ?? await view(s.id)));
    });

    // ---- 5. 中途停止後不復活(含同一工作樹只允許一個流程)
    scenario('stop', async () => {
      const s = await start('stop', 'implement#1=write:src/a.txt:v1,late:3000,wait:12000,report');
      const running = await waitRun(s.id, x => attempts(x, 'implement')[0]?.status === 'running', 20000);
      ok(!!running, '停止:實作交辦開始執行', brief(await view(s.id)));
      let err = '';
      try { await N.flowStart({ templateId: TPL, topic: '同一個工作樹的第二個流程', cwd: repo('stop'), roles: { implementer: s.impl.id, reviewer: s.rev.id } }); } catch (e) { err = String(e.message ?? e); }
      ok(err.includes('同時只允許一個流程'), '同一個工作樹同時只允許一個流程寫入', err);
      await N.flowStop(s.id);
      const r = await waitRun(s.id, x => x.status === 'stopped', 40000);
      ok(!!r && attempts(r, 'implement')[0].status === 'stopped', '停止:先確認交辦結束(中斷節點)再變成已停止', brief(r ?? await view(s.id)));
      const snapAgent = (await N.getSnapshot()).agents.find(a => a.id === s.impl.id);
      ok(snapAgent && snapAgent.state === 'idle', '停止:節點已被中斷回到待命', snapAgent?.state);
      ok(!!(await until(async () => (await N.flowLateFiles(s.id)).length > 0, 10000)), '停止:停止後才到的回報只寫進 late/');
      let resumeErr = '';
      try { await N.flowResume(s.id); } catch (e) { resumeErr = String(e.message ?? e); }
      await wait(1500);
      const after = await view(s.id);
      ok(after.status === 'stopped' && !!resumeErr && attempts(after, 'implement').length === 1 && attempts(after, 'review').length === 0 && !attempts(after, 'implement')[0].report, '停止:不會復活(回報、繼續都不推進)', brief(after) + resumeErr);
      // 停止後可以在同一個工作樹再開流程(鎖已釋放):只驗證啟動,馬上停掉
      const again = await N.flowStart({ templateId: TPL, topic: '停止後再開〔測試流程:implement#1=wait:20000〕', cwd: repo('stop'), roles: { implementer: s.impl.id, reviewer: s.rev.id } });
      ok(!!again?.id, '停止後鎖已釋放,同一個工作樹可以再開流程');
      await N.flowStop(again.id);
      ok(!!(await waitRun(again.id, x => x.status === 'stopped', 30000)), '第二個流程也停掉了');
    });

    // ---- 6. 被環境擋住不計入退回輪數
    scenario('blocked', async () => {
      const s = await start('blocked', 'implement#1=write:src/a.txt:v1,report;review#1=ok');
      const r1 = await waitRun(s.id, x => x.status === 'awaiting_user', 40000);
      ok(!!r1 && r1.pending?.kind === 'verify_blocked' && r1.rejections === 0 && attempts(r1, 'fix').length === 0, '被環境擋住:交給使用者、不計入退回輪數、不退回實作者', brief(r1 ?? await view(s.id)));
      if (!r1) return;
      const v = attempts(r1, 'implement')[0].verify;
      ok(v?.outcome === 'blocked' && v.stuckAt === 'check', '被環境擋住:核實結果標明卡在哪條指令', JSON.stringify(v?.commands?.[0]));
      await N.flowDecide(s.id, r1.pending.id, 'rerun');
      const r = await waitRun(s.id, x => x.status === 'completed', 40000);
      ok(!!r && r.rejections === 0, '被環境擋住:重跑核實通過後走完,仍是 0 輪', brief(r ?? await view(s.id)));
    });

    // ---- 7. 審查期間同一個檔案又被改(版本失效)
    scenario('version', async () => {
      const other = await mk('Other-version', repo('version'), 'antigravity');
      const s = await start('version', 'implement#1=write:src/a.txt:v1,report;review#1=wait:5000,ok;review#2=ok');
      const reviewing = await waitRun(s.id, x => attempts(x, 'review')[0]?.status === 'running', 30000);
      ok(!!reviewing, '版本失效:審查開始', brief(await view(s.id)));
      await N.send(other.id, '〔測試寫檔:src/a.txt=changed-by-other〕');
      const r1 = await waitRun(s.id, x => x.status === 'awaiting_user', 30000);
      ok(!!r1 && r1.pending?.kind === 'version_changed' && r1.rejections === 0 && r1.approvals.length === 0, '版本失效:審查後正本變了 → 審查失效、交給使用者', brief(r1 ?? await view(s.id)));
      if (!r1) return;
      const reviewed = attempts(r1, 'review')[0].version;
      await N.flowDecide(s.id, r1.pending.id, 'continue');
      const r = await waitRun(s.id, x => x.status === 'completed', 40000);
      ok(!!r && attempts(r, 'review').length === 2 && attempts(r, 'review')[1].version !== reviewed && r.approvals[0]?.version === attempts(r, 'review')[1].version, '版本失效:選繼續後以新版本重新核實、重新審查,授權卡是新版本', brief(r ?? await view(s.id)));
    });

    // ---- 8. 原 session 不在了:改派新 session 後仍能完成
    scenario('session', async () => {
      const s = await start('session', 'implement#1=write:src/a.txt:v1,report;review#1=wait:4000,fix:補測試;fix#1=write:src/a.txt:v2,report;review#2=ok');
      const reviewing = await waitRun(s.id, x => attempts(x, 'review')[0]?.status === 'running', 30000);
      ok(!!reviewing, '原 session 不在:審查開始', brief(await view(s.id)));
      await N.removeAgent(s.impl.id);
      const fresh = await mk(`Impl-session`, repo('session'), 'codex');
      const r = await waitRun(s.id, x => x.status === 'completed', 40000);
      ok(!!r, '原 session 不在:流程仍然走完', brief(await view(s.id)));
      if (!r) return;
      const fix = attempts(r, 'fix')[0];
      ok(fix?.agentId === fresh.id && fix.continuation === 'new', '原 session 不在:修正交給同名的新節點,紀錄標為新 session', JSON.stringify(fix));
      const p = (await users(fresh.id)).find(t => t.includes('流程步驟:fix'));
      ok(!!p && p.includes('這是新的交辦') && p.includes('補測試') && p.includes('假資料實作') && p.includes('交審版本的 diff') && p.includes('src/a.txt'), '新 session 的交辦附上 step_report、必修與 diff', p?.slice(0, 400));
    });

    // ---- 9. 未回報:提醒一次後交給使用者,手動補報
    scenario('unreported', async () => {
      const s = await start('unreported', 'implement#1=write:src/a.txt:v1,none;implement#1~r=none;review#1=ok');
      const r1 = await waitRun(s.id, x => x.status === 'awaiting_user', 30000);
      ok(!!r1 && r1.pending?.kind === 'unreported' && r1.rejections === 0 && attempts(r1, 'implement')[0].status === 'unreported', '未回報:記為未回報、交給使用者、不計輪數', brief(r1 ?? await view(s.id)));
      if (!r1) return;
      const reminders = (await users(s.impl.id)).filter(t => t.startsWith('(主控台:step_report 提醒。'));
      ok(reminders.length === 1, '未回報:只提醒一次', String(reminders.length));
      ok(JSON.stringify(r1.pending.options) === JSON.stringify(['manual_report', 'rerun', 'halt', 'stop']), '未回報:使用者可選手動補報或重跑', JSON.stringify(r1.pending.options));
      await N.flowManualReport(s.id, { summary: '使用者手動補報:實作已完成' });
      const r = await waitRun(s.id, x => x.status === 'completed', 40000);
      ok(!!r && attempts(r, 'implement')[0].report?.manual === true, '未回報:手動補報後繼續走完', brief(r ?? await view(s.id)));
    });

    // ---- 10. 需裁示不計入退回輪數(也通知總管,但不讓總管自動跑回合)
    scenario('ruling', async () => {
      const s = await start('ruling', 'implement#1=write:src/a.txt:v1,report;review#1=ruling:要不要改檔名');
      const r1 = await waitRun(s.id, x => x.status === 'awaiting_user', 30000);
      ok(!!r1 && r1.pending?.kind === 'needs_ruling' && r1.rejections === 0 && r1.pending.message.includes('要不要改檔名'), '需裁示:交給使用者、不計入退回輪數', brief(r1 ?? await view(s.id)));
      if (!r1) return;
      const chiefNotes = await until(async () => (await notes(chief.id)).some(t => t.includes('(主控台通知)') && t.includes('要不要改檔名')), 10000);
      ok(!!chiefNotes, '需裁示:總管的對話裡收到通知');
      ok((await users(chief.id)).length === 0 && (await N.getSnapshot()).agents.find(a => a.id === chief.id)?.state === 'idle', '總管沒有被自動派去跑回合');
      await N.flowDecide(s.id, r1.pending.id, 'continue', { note: '照原名' });
      const r = await waitRun(s.id, x => x.status === 'completed', 40000);
      ok(!!r && r.rejections === 0, '需裁示:選繼續後走完,仍是 0 輪', brief(r ?? await view(s.id)));
    });

    // ---- 11. 節點自己 commit:偵測為違規並停機
    scenario('commit', async () => {
      const s = await start('commit', 'implement#1=write:src/a.txt:v1,commit,report;review#1=ok');
      const r = await waitRun(s.id, x => x.status === 'halted', 40000);
      ok(!!r && r.violations.some(v => v.kind === 'refs_changed' && v.items.includes('HEAD')) && /commit 或 push/.test(r.reason ?? '') && attempts(r, 'review').length === 0, '節點自己 commit:refs 改變 → 標違規、停機交使用者', brief(r ?? await view(s.id)) + JSON.stringify(r?.violations ?? []));
    });

    // ---- 12. 停止時節點停不下來(中斷無效):不默認已結束,交給使用者;確認前工作樹不釋放
    scenario('stuck', async () => {
      const s = await start('stuck', 'implement#1=write:src/a.txt:v1,stubborn,wait:15000,report');
      ok(!!(await waitRun(s.id, x => attempts(x, 'implement')[0]?.status === 'running', 20000)), '停不下來:實作交辦開始執行');
      await N.flowStop(s.id);
      const r1 = await waitRun(s.id, x => x.status === 'awaiting_user' && x.pending?.kind === 'not_ended', 20000);
      ok(!!r1 && JSON.stringify(r1.pending.options) === JSON.stringify(['wait', 'force_ended']) && attempts(r1, 'implement')[0].status === 'running', '停不下來:確認逾時後交給使用者(再等或強制視為結束),不默認已結束', brief(r1 ?? await view(s.id)));
      if (!r1) return;
      let err = '';
      try { await N.flowStart({ templateId: TPL, topic: '同一個工作樹', cwd: repo('stuck'), roles: { implementer: s.impl.id, reviewer: s.rev.id } }); } catch (e) { err = String(e.message ?? e); }
      ok(err.includes('同時只允許一個流程'), '停不下來:確認結束前工作樹鎖不釋放', err);
      await N.flowDecide(s.id, r1.pending.id, 'wait');
      const r2 = await waitRun(s.id, x => x.status === 'awaiting_user' && x.pending?.kind === 'not_ended' && x.pending.id !== r1.pending.id, 20000);
      ok(!!r2, '停不下來:選再等,仍停不下來就再問一次', brief(await view(s.id)));
      if (!r2) return;
      await N.flowDecide(s.id, r2.pending.id, 'force_ended');
      const r = await waitRun(s.id, x => x.status === 'stopped', 10000);
      ok(!!r, '停不下來:使用者強制視為結束後才變成已停止', brief(await view(s.id)));
      ok(!!(await until(async () => (await N.flowLateFiles(s.id)).length > 0, 25000)), '停不下來:節點最後交來的回報只寫進 late/');
      ok((await view(s.id)).status === 'stopped', '停不下來:流程沒有復活');
    });

    await Promise.all(scenarios);
    const snap = await N.getSnapshot();
    ok(Array.isArray(snap.flows) && snap.flows.length >= 13, '桌面快照附上流程清單', String(snap.flows?.length));
    log('主控台端結束');
  } catch (err) {
    log('失敗', err.stack ?? err.message);
  }
  await wait(800);
  document.title = 'QUIT';
})();
