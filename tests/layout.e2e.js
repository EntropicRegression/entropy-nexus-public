// 桌面版的版面檢查(假資料模式,由 tests/layout.sh 啟動;前面會接上 tests/layout-audit-lib.js)。
// 在幾種視窗大小下逐一打開主要的畫面(情境見 layout-audit-lib.js 的 __LAYOUT_SCENES),
// 檢查點不到的按鈕與超出區塊的節點,並截圖。
// LAYOUT_WEB=1 時改成:開啟遠端、印出配對碼,讓 tests/layout-browser.cjs 用瀏覽器檢查瀏覽器版,桌面這邊只等它回報。
// 視窗大小是畫面內容區的 CSS 像素;Windows 開了顯示縮放時,可用的 CSS 像素會變小:
//   1366×768 螢幕 125% → 約 1090×540;1920×1080 螢幕 150% → 約 1280×650。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const shot = async name => { document.title = `SHOT:${name}`; await wait(700); };
  const SIZES = [[1440, 900, '大螢幕'], [1100, 700, '最小視窗'], [1280, 650, '1080p-150%'], [1090, 540, '768p-125%'], [960, 540, '最小視窗-小螢幕']];
  let total = 0;
  try {
    await window.nexus.setAutopilot(false);
    const cwd = window.__TEST_CWD__;
    const backends = ['claude', 'codex', 'antigravity'];
    const ids = [];
    for (let i = 0; i < 14; i++) ids.push((await window.nexus.createAgent({ name: `節點${String(i + 1).padStart(2, '0')}`, character: i === 0 ? 'Layout' : '', model: '', backend: backends[i % 3], cwd, permissionMode: 'ask' })).id);
    await window.nexus.setChief(ids[13]);
    await wait(2500);
    // 總覽儀表要在「內容最多」的情況下檢查:三家後台都有兩個額度視窗,其中一個快滿了(多一行提醒)
    const soon = Math.round(Date.now() / 1000) + 3 * 86400;
    for (let i = 0; i < 3; i++) await window.nexus.send(ids[i], `〔測試用量:${JSON.stringify({ windows: [{ label: '5 小時', used: i === 0 ? 0.93 : 0.4, resetsAt: soon }, { label: '每週', used: 0.3 + i * 0.1, resetsAt: soon }], spent: { tokens: 12000 * (i + 1), usd: i === 0 ? 0.05 : 0 } })}〕`);
    await wait(2500);

    if (window.__LAYOUT_WEB__) {
      await window.nexus.remoteSet({ enabled: true });
      await wait(1200);
      const st = await window.nexus.remoteStatus();
      log('PAIR', st.pairCode, ids[0], st.port);
      const t0 = Date.now();
      let done = false;
      while (!done && Date.now() - t0 < 280000) {
        done = (await window.nexus.getHistory(ids[0])).some(e => e.type === 'message' && e.role === 'user' && e.text.startsWith('瀏覽器檢查完成'));
        await wait(1000);
      }
      log(done ? '瀏覽器已回報' : '等不到瀏覽器回報');
      log('主控台端結束');
      document.title = 'QUIT';
      return;
    }

    for (const [w, h, label] of SIZES) {
      const size = `${label} ${w}×${h}`;
      document.title = `SIZE:${w},${h}`;
      await wait(1800);
      log(`=== ${size}:畫面 ${innerWidth}×${innerHeight}`);
      await window.__layoutClose();
      for (const [key, title] of window.__LAYOUT_SCENES) {
        const issues = await window.__layoutScene(key);
        total += issues.length;
        log(issues.length ? '不符' : '通過', `[${size}] ${title}`, issues.length ? `${issues.length} 項` : '');
        for (const i of issues.slice(0, 12)) log('   -', i);
        if (issues.length > 12) log(`   …另外 ${issues.length - 12} 項`);
        await shot(`${label}-${key}`);
        await window.__layoutClose();
      }
    }
    // ---- 第二輪:30 個節點,分散在待命、待授權、總管三個區塊(另有幾個休眠),只檢查主面板和對話視窗。
    // 小視窗一定排不下:要出現「另外 N 個」,點下去列出被收起來的節點,選一個會打開它的對話視窗,而且都不能超出區塊。
    const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await wait(200); } return null; };
    const click = async (x, y) => { document.title = `INPUT:${Date.now()}|${JSON.stringify({ type: 'click', x: Math.round(x), y: Math.round(y) })}`; await wait(500); };
    const check = (cond, what, extra = '') => { if (!cond) total++; log(cond ? '通過' : '不符', what + (cond || !extra ? '' : ` → ${String(extra).slice(0, 240)}`)); };
    const report = (size, title, issues) => {
      total += issues.length;
      log(issues.length ? '不符' : '通過', `[${size}] ${title}`, issues.length ? `${issues.length} 項` : '');
      for (const i of issues.slice(0, 12)) log('   -', i);
    };
    // 這一輪只看主面板:頂部列與新增節點表單的問題第一輪已經列過
    const boardOnly = () => window.__boardIssues();
    const board = window.__nexusBoard;
    const rectOf = () => document.querySelector('.board canvas').getBoundingClientRect();
    await window.nexus.setMaxActive(32);
    for (let i = 14; i < 30; i++) ids.push((await window.nexus.createAgent({ name: `節點${String(i + 1).padStart(2, '0')}`, character: '', model: '', backend: backends[i % 3], cwd, permissionMode: 'ask' })).id);
    await wait(2500);
    // 8 個節點停在「等你回答」(待授權區),4 個休眠(留在待命區)
    const asking = ids.slice(14, 22);
    for (const id of asking) await window.nexus.send(id, '提問');
    for (const id of ids.slice(22, 26)) await window.nexus.sleep(id);
    const states = async () => { const c = {}; for (const a of (await window.nexus.getSnapshot()).agents) c[a.state] = (c[a.state] ?? 0) + 1; return c; };
    const settled = await until(async () => { const s = await states(); return s.awaiting === 8 && !s.planning && !s.working ? s : null; }, 20000);
    check(!!settled, '第二輪:30 個節點,8 個待授權、其餘待命或休眠', JSON.stringify(await states()));
    let sawMore = 0;
    for (const [w, h, label] of SIZES) {
      const size = `30 個節點 ${label} ${w}×${h}`;
      document.title = `SIZE:${w},${h}`;
      await wait(1800);
      await window.__layoutClose();
      await wait(1200);
      log(`=== ${size}:面板 ${JSON.stringify(board.size())} ${JSON.stringify(board.mode())}`);
      report(size, '主畫面', boardOnly());
      const scales = board.positions().map(p => p.scale);
      log(`   畫出 ${scales.length} 個節點,縮放 ${Math.min(...scales).toFixed(2)}–${Math.max(...scales).toFixed(2)};收起來:${JSON.stringify(board.hidden().map(x => [x.zone, x.count]))}`);
      await shot(`30-${label}-board`);
      const more = board.more()[0];
      if (more) {
        sawMore++;
        // 點「另外 N 個」:列出被收起來的節點
        const c = rectOf();
        await click(c.left + more.x, c.top + more.y);
        const pop = await until(() => document.querySelector('.board-more'), 3000);
        const hiddenIds = board.hidden().find(x => x.zone === more.zone)?.ids ?? [];
        const rows = [...(pop?.querySelectorAll('.bm-row') ?? [])];
        check(!!pop && rows.length === hiddenIds.length && rows.length === more.count, `[${size}] 點「另外 ${more.count} 個」列出被收起來的節點`, JSON.stringify({ pop: !!pop, rows: rows.length, hidden: hiddenIds.length }));
        if (pop) {
          const pr = pop.getBoundingClientRect(), stage = document.querySelector('.stage').getBoundingClientRect();
          check(pr.left >= stage.left - 1 && pr.right <= stage.right + 1 && pr.top >= stage.top - 1 && pr.bottom <= stage.bottom + 1 && pr.height >= 90, `[${size}] 清單在主面板區裡`, JSON.stringify({ pop: [pr.left, pr.top, pr.right, pr.bottom], stage: [stage.left, stage.top, stage.right, stage.bottom] }));
          report(size, '「另外 N 個」清單(按鈕點得到)', window.__layoutAudit().filter(i => i.includes('bm-row') || i.includes('關閉清單')));
          await shot(`30-${label}-more`);
          // 選清單裡最後一個節點:打開它的對話視窗,而且它會被換到看得到的位置
          const targetId = hiddenIds[hiddenIds.length - 1];
          const name = rows[rows.length - 1].querySelector('.bm-name').textContent;
          const r = rows[rows.length - 1].getBoundingClientRect();
          rows[rows.length - 1].scrollIntoView({ block: 'nearest' });
          await wait(200);
          const r2 = rows[rows.length - 1].getBoundingClientRect();
          await click(r2.left + r2.width / 2, r2.top + r2.height / 2);
          const dlg = await until(() => document.querySelector('.dialog'), 3000);
          await wait(1500);
          check(!!dlg && dlg.textContent.includes(name) && !document.querySelector('.board-more'), `[${size}] 從清單選「${name}」會打開它的對話視窗,清單關閉`, JSON.stringify({ dlg: !!dlg, r: [r.left, r.top] }));
          check(board.positions().some(p => p.id === targetId), `[${size}] 選取的節點換到看得到的位置`);
          report(size, '對話視窗(從清單打開)', boardOnly());
          await shot(`30-${label}-more-dialog`);
          await window.__layoutClose();
          await wait(600);
        }
      }
      // 對話視窗:主面板只剩上方一條
      window.__nexusSelect('節點01');
      await wait(1800);
      const dlg = document.querySelector('.dialog')?.getBoundingClientRect();
      const cv = rectOf();
      check(!!dlg && cv.bottom <= dlg.top + 1, `[${size}] 主面板的底邊在對話視窗上方,不重疊`, JSON.stringify({ board: cv.bottom, dialog: dlg?.top }));
      const portrait = document.querySelector('.dlg-portrait')?.getBoundingClientRect();
      check(!!portrait && portrait.top >= cv.bottom - 1, `[${size}] 立繪不蓋到主面板`, JSON.stringify({ portrait: portrait?.top, board: cv.bottom }));
      log(`   對話視窗打開:面板 ${JSON.stringify(board.size())} ${JSON.stringify(board.mode())},畫出 ${board.positions().length} 個,收起來:${JSON.stringify(board.hidden().map(x => [x.zone, x.count]))}`);
      report(size, '對話視窗', boardOnly());
      await shot(`30-${label}-dialog`);
      await window.__layoutClose();
    }
    check(sawMore >= 2, `30 個節點時,至少兩種視窗大小出現「另外 N 個」(實際 ${sawMore} 種)`);

    // ---- 第三輪:節點在區塊之間移動(規劃 → 執行 → 待命)時,區塊大小跟著調整,任何時候都不能跑出面板
    document.title = 'SIZE:1100,700';
    await wait(1800);
    for (const id of asking) { const q = (await window.nexus.getSnapshot()).agents.find(a => a.id === id)?.pendingQuestion; if (q) await window.nexus.answerQuestion(id, q.requestId, { q1: ['紅色'] }); }
    const autos = [];
    for (let i = 0; i < 6; i++) autos.push((await window.nexus.createAgent({ name: `自動${i + 1}`, character: '', model: '', backend: backends[i % 3], cwd, permissionMode: 'auto' })).id);
    await wait(2000);
    for (const id of autos) await window.nexus.send(id, '跑一輪');
    const zonesSeen = new Set();
    let outside = 0, settledChecks = 0, settledIssues = [];
    const t0 = Date.now();
    let shotTaken = false;
    while (Date.now() - t0 < 30000) {
      await wait(350);
      const sz = board.size();
      const ps = board.positions();
      // 移動途中:節點(含文字)至少要在面板裡,不會跑到事件紀錄或側欄上
      outside += ps.filter(p => p.x - 56 * p.scale < -1 || p.x + 56 * p.scale > sz.w + 1 || p.y - 34 * p.scale < -1 || p.y + 64 * p.scale > sz.h + 1).length;
      const snap = (await window.nexus.getSnapshot()).agents;
      for (const a of snap) zonesSeen.add({ idle: 'standby', sleeping: 'standby', planning: 'planning', working: 'active', awaiting: 'auth', error: 'fault', lost: 'fault' }[a.state]);
      // 節點都滑到定位時做完整檢查(同一個時間點取狀態和檢查,中間不能等待,否則版面可能又變了)
      if (board.settled()) { settledChecks++; const issues = boardOnly(); if (issues.length) settledIssues = issues; if (!shotTaken && snap.some(a => a.state === 'working')) { shotTaken = true; await shot('30-移動中'); } }
      if (Date.now() - t0 > 6000 && snap.every(a => a.state === 'idle' || a.state === 'sleeping')) break;
    }
    check(zonesSeen.has('planning') && zonesSeen.has('active'), `第三輪:節點經過規劃區與執行區(看到 ${[...zonesSeen].join('、')})`);
    check(outside === 0, '節點移動途中沒有跑出面板', `${outside} 次`);
    check(settledChecks >= 3 && settledIssues.length === 0, `動畫停下來時的完整檢查都通過(檢查了 ${settledChecks} 次)`, settledIssues.join(';'));
    await wait(1500);
    report('36 個節點 最小視窗 1100×700', '全部回到待命後的主畫面', boardOnly());
    await shot('30-結束');
    log(total ? `有 ${total} 項不符` : '全部通過');
    log('主控台端結束');
  } catch (err) {
    log('失敗', err.stack ?? err.message);
  }
  document.title = 'QUIT';
})();
