// 協作流程 M3(範圍合約與授權完整版)的驗收(假資料模式,主控台這一側;外層是 tests/flow-scope.sh)。
// 每個情境在 NEXUS_TEST_CWD 底下有自己的 git 版本庫(flow-scope.sh 建好),假資料節點照主題裡的〔測試流程:…〕腳本行動
// (見 src/main/adapters/fake.ts 的 flowTurn:ask、tool、writedata、scope 是 M3 加的動作)。
// flowswrite 會寫入共用的流程定義資料夾,其他情境的交辦也會看到這個改動,所以等其他情境都結束才單獨跑;quit 最後跑,跑到核實中就結束程式。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const ok = (cond, what, extra = '') => log(cond ? '通過' : '不符', what + (cond || !extra ? '' : ` → ${String(extra).slice(0, 300)}`));
  const N = window.nexus;
  const base = window.__TEST_CWD__;
  const repo = name => `${base}\\${name}`;
  const until = async (fn, ms = 60000, step = 250) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = await fn(); if (v) return v; } catch { /* 再試 */ } await wait(step); } return null; };
  const view = async id => (await N.flowList()).find(r => r.id === id);
  const waitRun = (id, pred, ms = 60000) => until(async () => { const r = await view(id); return r && pred(r) ? r : null; }, ms);
  const attempts = (r, step) => r.steps.find(s => s.id === step)?.attempts ?? [];
  const hist = async id => await N.getHistory(id);
  const users = async id => (await hist(id)).filter(e => e.type === 'message' && e.role === 'user').map(e => e.text);
  const notes = async id => (await hist(id)).filter(e => e.type === 'note').map(e => e.text);
  const mk = (name, cwd, backend = 'claude') => N.createAgent({ name, character: '', model: '', backend, cwd, permissionMode: 'auto' });
  const brief = r => r ? `${r.status}/${r.phase ?? ''} 步驟=${r.stepId} pending=${r.pending?.kind ?? ''} reason=${r.reason ?? ''} 違規=${JSON.stringify(r.violations.map(v => v.kind))}` : '(沒有流程)';

  try {
    await N.setAutopilot(false);
    await N.setMaxActive(40);
    const tpls = await N.flowTemplates();
    ok(tpls.some(t => t.id === 'e2e-flow' && !t.errors.length) && tpls.some(t => t.id === 'e2e-gate' && !t.errors.length), '範本清單有兩個測試範本', JSON.stringify(tpls.map(t => [t.id, t.errors])));

    const start = async (name, script, tpl = 'e2e-flow') => {
      const impl = await mk(`Impl-${name}`, repo(name), 'claude');
      const rev = await mk(`Rev-${name}`, repo(name), 'codex');
      await wait(800);
      const r = await N.flowStart({ templateId: tpl, topic: `情境 ${name}〔測試流程:${script}〕`, cwd: repo(name), roles: { implementer: impl.id, reviewer: rev.id } });
      log('RUN', name, r.id);
      return { id: r.id, impl, rev, name };
    };
    const scenarios = [];
    const scenario = (name, fn) => scenarios.push((async () => {
      try { await fn(); } catch (err) { log('失敗', `${name}:`, err.stack ?? err.message); }
    })());

    // ---- 1. L1:節點要求執行 git push → 自動拒絕、留說明、記違規,流程繼續
    scenario('askpush', async () => {
      const s = await start('askpush', 'implement#1=ask:git push origin main,write:src/a.txt:v1,report;review#1=ok');
      const r = await waitRun(s.id, x => x.status === 'completed' || x.status === 'halted');
      ok(!!r && r.status === 'completed', 'L1:被拒絕後節點繼續工作,流程走完(沒有停機)', brief(r ?? await view(s.id)));
      if (!r) return;
      const v = r.violations.find(x => x.kind === 'forbidden_action');
      ok(!!v && v.blocked === true && v.items.some(i => i.includes('git push origin main')) && (v.actions ?? []).includes('push'), 'L1:記一筆違規(已擋下、命中 push)', JSON.stringify(r.violations));
      const ns = await notes(s.impl.id);
      ok(ns.some(t => t.includes('已自動拒絕') && t.includes('git push origin main')), 'L1:在節點的對話留下說明', JSON.stringify(ns.slice(-4)));
      ok(ns.some(t => t.includes('ask:git push origin main') && t.includes('授權結果 deny')), 'L1:節點收到的授權結果是拒絕', JSON.stringify(ns.filter(t => t.startsWith('[flow]'))));
      ok(!r.violations.some(x => x.kind === 'forbidden_action' && !x.blocked), 'L1:同一個動作的工具啟動事件沒有再觸發中斷(L2)', JSON.stringify(r.violations));
    });

    // ---- 2. L2:節點直接執行 git commit → 中斷交辦、記違規、停機
    scenario('toolcommit', async () => {
      const s = await start('toolcommit', 'implement#1=write:src/a.txt:v1,tool:git commit -am wip,report;review#1=ok');
      const r = await waitRun(s.id, x => x.status === 'halted' || x.status === 'completed', 40000);
      ok(!!r && r.status === 'halted', 'L2:停機交給使用者', brief(r ?? await view(s.id)));
      if (!r) return;
      const v = r.violations.find(x => x.kind === 'forbidden_action');
      ok(!!v && v.blocked === false && (v.actions ?? []).includes('commit') && v.items.some(i => i.includes('git commit -am wip')), 'L2:記一筆違規(命中 commit)', JSON.stringify(r.violations));
      const a = attempts(r, 'implement')[0];
      ok(a && a.status === 'interrupted' && !a.report && attempts(r, 'review').length === 0, 'L2:交辦被中斷,沒有回報、沒有往下審查', JSON.stringify(a));
      const ns = await notes(s.impl.id);
      ok(ns.some(t => t.includes('已中斷這個交辦')) && !ns.some(t => t.includes('tool:git commit -am wip →')), 'L2:對話留下說明,節點在工具結束前就被中斷', JSON.stringify(ns.slice(-5)));
      ok(/L2/.test(r.reason ?? ''), 'L2:停機原因寫明', r.reason);
    });

    // ---- 2b. 只是提到 Program Files、.msi 的一般指令不攔(審查回歸):流程照常走完、沒有違規
    scenario('harmless', async () => {
      const s = await start('harmless', 'implement#1=tool:ls "/c/Program Files/nodejs",tool:cat src/foo.msi.json,write:src/a.txt:v1,report;review#1=ok');
      const r = await waitRun(s.id, x => x.status === 'completed' || x.status === 'halted', 60000);
      ok(!!r && r.status === 'completed' && !r.violations.some(v => v.kind === 'forbidden_action' || v.kind === 'protected_write'), '一般指令(ls Program Files、讀 .msi.json)不被當成安裝而停機', brief(r ?? await view(s.id)));
    });

    // ---- 3、4. 範圍外檔案:授權卡列出說明與沒寫原因的檔案;沒勾選不提交、勾選才提交
    const outside = async (name, include) => {
      const s = await start(name, 'implement#1=write:src/a.txt:v1,write:notes.txt:outside,write:extra.txt:x,scope:notes.txt:記錄這次的決策,report;review#1=ok');
      const r = await waitRun(s.id, x => x.status === 'completed' || x.status === 'halted');
      ok(!!r && r.status === 'completed', `${name}:流程走完`, brief(r ?? await view(s.id)));
      if (!r) return;
      const card = r.approvals[0];
      ok(card && card.paths.join() === 'src/a.txt' && card.outOfScope.join() === 'extra.txt,notes.txt' && JSON.stringify(card.scopeNotes) === JSON.stringify([{ path: 'notes.txt', reason: '記錄這次的決策' }]) && card.unexplained?.join() === 'extra.txt',
        `${name}:授權卡列出範圍外檔案、節點的說明,沒寫原因的另外標示`, JSON.stringify(card));
      const after = await N.flowApprove(s.id, card.id, { include });
      const c = after.approvals[0];
      // 不在卡片範圍外清單裡的路徑(not-on-card.txt)不會被納入
      const expected = include.filter(p => card.outOfScope.includes(p));
      ok(c.status === 'approved' && JSON.stringify(c.included ?? []) === JSON.stringify(expected) && (include.length ? c.result.includes('含範圍外 1 個') : !c.result.includes('含範圍外')), `${name}:允許後提交,記下勾選納入的範圍外檔案`, JSON.stringify(c));
    };
    scenario('outno', () => outside('outno', []));
    scenario('outyes', () => outside('outyes', ['notes.txt', 'not-on-card.txt']));

    // ---- 5. requires_approval:交辦前跳卡,拒絕就不交辦
    scenario('gatedeny', async () => {
      const s = await start('gatedeny', 'implement#1=write:src/a.txt:v1,report', 'e2e-gate');
      const r1 = await waitRun(s.id, x => x.status === 'awaiting_user', 30000);
      ok(!!r1 && r1.pending?.kind === 'step_approval' && attempts(r1, 'implement').length === 0, 'requires_approval:交辦前先跳卡,還沒交辦', brief(r1 ?? await view(s.id)));
      if (!r1) return;
      const card = r1.approvals[0];
      ok(card && card.action === 'push' && card.stepId === 'implement' && card.status === 'pending' && /^[0-9a-f]{40}$/.test(card.version) && card.covers.some(c => c.includes('push')) && card.excludes.some(x => x.includes('force push')), 'requires_approval:卡片寫明涵蓋、不涵蓋與版本 tree', JSON.stringify(card));
      ok(r1.steps[0].lamp === 'awaiting_approval', 'requires_approval:步驟燈號是待授權', r1.steps[0].lamp);
      await N.flowApprove(s.id, card.id, { deny: true });
      const r = await waitRun(s.id, x => x.status === 'halted', 20000);
      ok(!!r && attempts(r, 'implement').length === 0 && /拒絕/.test(r.reason ?? ''), 'requires_approval:拒絕後停機、不交辦', brief(r ?? await view(s.id)));
      await wait(1500);
      ok((await users(s.impl.id)).length === 0, 'requires_approval:實作節點沒有收到任何交辦');
    });

    // ---- 6. requires_approval:允許才交辦;這一步可以做被授權的動作(git push 不被攔),流程走完
    scenario('gateallow', async () => {
      const s = await start('gateallow', 'implement#1=tool:git push origin main,write:src/a.txt:v1,report;review#1=ok', 'e2e-gate');
      const r1 = await waitRun(s.id, x => x.status === 'awaiting_user' && x.pending?.kind === 'step_approval', 30000);
      ok(!!r1, 'requires_approval(允許):先跳卡', brief(await view(s.id)));
      if (!r1) return;
      const after = await N.flowApprove(s.id, r1.approvals[0].id, {});
      ok(after.approvals[0].status === 'approved', 'requires_approval(允許):授權卡允許(版本相同)', JSON.stringify(after.approvals[0]));
      const r = await waitRun(s.id, x => x.status === 'completed' || x.status === 'halted', 40000);
      ok(!!r && r.status === 'completed' && !r.violations.some(v => v.kind === 'forbidden_action'), 'requires_approval(允許):交辦後這一步的 git push 不被攔,流程走完', brief(r ?? await view(s.id)));
      if (!r) return;
      ok(r.approvals.some(c => c.action === 'commit' && c.status === 'pending' && !c.stepId), 'requires_approval(允許):收尾仍產生 commit 授權卡', JSON.stringify(r.approvals));
    });

    await Promise.all(scenarios);

    // ---- 7. 節點寫入流程定義資料夾 flows/ → 事後比對偵測、停機(單獨跑:flows/ 是共用的)
    try {
      const s = await start('flowswrite', 'implement#1=write:src/a.txt:v1,writedata:flows/evil.yaml:id- evil,report;review#1=ok');
      const r = await waitRun(s.id, x => x.status === 'halted' || x.status === 'completed', 40000);
      ok(!!r && r.status === 'halted', '寫入 flows/:停機交給使用者', brief(r ?? await view(s.id)));
      if (r) {
        const v = r.violations.find(x => x.kind === 'protected_write');
        ok(!!v && v.items.includes('flows/evil.yaml') && attempts(r, 'review').length === 0 && /受保護的資料夾/.test(r.reason ?? ''), '寫入 flows/:記一筆受保護資料夾的違規,不往下審查', JSON.stringify(r.violations));
      }
    } catch (err) { log('失敗', 'flowswrite:', err.stack ?? err.message); }

    // ---- 8. 核實進行中關閉主控台(外層檢查子程序被終止、臨時資料夾與副本清掉)
    try {
      const s = await start('quit', 'implement#1=write:src/a.txt:v1,report');
      const r = await waitRun(s.id, x => x.phase === 'verifying', 40000);
      ok(!!r, '關閉主控台:核實開始跑', brief(await view(s.id)));
      await wait(2500);
    } catch (err) { log('失敗', 'quit:', err.stack ?? err.message); }

    log('主控台端結束');
  } catch (err) {
    log('失敗', err.stack ?? err.message);
  }
  await wait(500);
  document.title = 'QUIT';
})();
