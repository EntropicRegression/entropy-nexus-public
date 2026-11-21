// 協作過程可視化的驗收(假資料模式,主控台這一側):建立 Alpha(總管)、Beta、Gamma 三個自動模式的節點,印出它們的 id,
// 之後由 tests/collab-client.mjs 當成各節點的 CLI 連到工具服務(Alpha 呼叫 Beta、Beta 呼叫 Gamma、Alpha 召開會議、Beta 最後呼叫 Alpha 通知結束)。
// 這裡在整個過程中不斷取樣面板上畫出的連線(window.__nexusBoard.links())與節點位置,結束後檢查:
//   連線出現的時機與端點(對得上節點在畫面上的位置)、會議連線與發言者、全部結束後連線消失、
//   任務卡的來源標籤、分派紀錄(快照與總覽的完整內容),以及點分派紀錄的列會打開被呼叫節點的對話視窗。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const ok = (cond, what, extra = '') => log(cond ? '通過' : '不符', what + (cond || !extra ? '' : ` → ${String(typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 320)}`));
  const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await wait(150); } return null; };
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const text = el => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  try {
    await window.nexus.setAutopilot(false);
    const cwd = window.__TEST_CWD__;
    const mk = (name, backend) => window.nexus.createAgent({ name, character: '', model: '', backend, cwd, permissionMode: 'auto' });
    const A = await mk('Alpha', 'claude'), B = await mk('Beta', 'codex'), C = await mk('Gamma', 'antigravity');
    await window.nexus.setChief(A.id);
    await wait(2500);
    log('READY', A.id, B.id, C.id);
    const board = window.__nexusBoard;
    ok(typeof board?.links === 'function' && board.links().length === 0, '一開始面板上沒有協作連線');

    // 取樣:連線與節點位置在同一個瞬間讀出,端點才對得上
    const samples = [];
    const t0 = Date.now();
    let done = false;
    while (!done && Date.now() - t0 < 200000) {
      const links = board.links();
      if (links.length) samples.push({ links, pos: Object.fromEntries(board.positions().map(p => [p.id, p])) });
      done = (await window.nexus.getHistory(A.id)).some(e => e.type === 'message' && e.role === 'user' && e.text.includes('協作檢查完成'));
      await wait(100);
    }
    ok(done, '用戶端全部做完');

    const find = (kind, from, to) => samples.filter(s => s.links.some(l => l.kind === kind && l.from === from && (to === undefined || l.segments.some(g => g.to === to))));
    const near = (a, b) => Math.abs(a - b) < 1.5;
    const ends = (s, from, to) => {
      const l = s.links.find(x => x.from === from && x.segments.some(g => g.to === to));
      const g = l.segments.find(x => x.to === to);
      return !g.fromBadge && !g.toBadge && s.pos[from] && s.pos[to] && near(g.x1, s.pos[from].x) && near(g.y1, s.pos[from].y) && near(g.x2, s.pos[to].x) && near(g.y2, s.pos[to].y);
    };
    const ab = find('ask', A.id, B.id), bc = find('ask', B.id, C.id);
    ok(ab.length > 3, 'Alpha 呼叫 Beta 期間面板上有一條 Alpha → Beta 的連線', ab.length);
    ok(ab.length > 0 && ab.every(s => ends(s, A.id, B.id)), '連線兩端落在 Alpha 與 Beta 在畫面上的位置');
    ok(bc.length > 3 && bc.every(s => ends(s, B.id, C.id)), 'Beta 呼叫 Gamma 期間有一條 Beta → Gamma 的連線,端點正確', bc.length);
    ok(!samples.some(s => s.links.some(l => l.kind === 'ask' && l.from === C.id)), '沒有不該出現的連線(Gamma 沒呼叫過別人)');
    const meet = find('meeting', A.id);
    ok(meet.length > 0 && meet.some(s => s.links.some(l => l.kind === 'meeting' && l.segments.length === 2)), '會議期間主持人 Alpha 連到兩位參與者', meet.length);
    ok(meet.every(s => ends(s, A.id, B.id) || ends(s, A.id, C.id)), '會議連線端點對得上節點位置');
    const speakers = new Set(meet.flatMap(s => s.links.flatMap(l => l.segments.filter(g => g.speaking).map(g => g.to))));
    ok(speakers.has(B.id) && speakers.has(C.id), '會議中輪到誰發言就標出誰', [...speakers]);
    ok(await until(() => board.links().length === 0, 15000), '全部結束後連線都消失了', JSON.stringify(board.links()));
    { const left = (await window.nexus.getSnapshot()).links; ok(!left.length, '快照裡也沒有進行中的連線', JSON.stringify(left)); }

    // 任務卡的來源標籤
    const snap = await window.nexus.getSnapshot();
    const tasksOf = id => snap.tasks.filter(t => t.agentId === id);
    ok(tasksOf(B.id).some(t => t.source === 'interop' && t.from?.id === A.id && !t.from.meeting), 'Beta 的任務記著是 Alpha 交辦的', tasksOf(B.id).map(t => [t.source, t.from]));
    ok(tasksOf(C.id).some(t => t.from?.id === B.id && !t.from.meeting), 'Gamma 的任務記著是 Beta 交辦的');
    ok(tasksOf(B.id).some(t => t.from?.meeting) && tasksOf(C.id).some(t => t.from?.meeting), '會議裡的發言回合標成會議');
    const froms = $$('.tasks .task-from').map(text);
    ok(froms.includes('由總管交辦'), '任務卡顯示「由總管交辦」', froms);
    ok(froms.includes('由 Beta 交辦'), '任務卡顯示「由 Beta 交辦」', froms);
    ok(froms.includes('會議'), '任務卡顯示「會議」', froms);
    const alphaCards = $$('.tasks .task').filter(e => text(e.querySelector('.task-who')).startsWith('Alpha'));
    ok(!alphaCards.some(e => e.querySelector('.task-from') && !text(e.querySelector('.task-from')).startsWith('由 Beta')), 'Alpha 的任務卡只有 Beta 交辦的那一筆有來源標籤');

    // 分派紀錄:快照
    const d = snap.dispatches;
    const row = (from, to) => d.find(x => x.fromName === from && x.toName === to);
    ok(row('Alpha', 'Beta')?.status === 'done' && row('Alpha', 'Beta').endedAt >= row('Alpha', 'Beta').startedAt, '分派紀錄:Alpha → Beta 完成', d);
    ok(row('Beta', 'Gamma')?.status === 'done', '分派紀錄:Beta → Gamma 完成');
    ok(row('Alpha', 'Beta')?.fromChief === true && row('Beta', 'Gamma')?.fromChief === undefined, '分派紀錄在建立當下標記「由總管發出」(Alpha 是總管,Beta 不是)', d);
    ok(row('Alpha', 'Beta')?.title.includes('請 Beta 看一下設計') && snap.tasks.some(t => t.id === row('Alpha', 'Beta').taskId), '分派紀錄有簡短標題,且對得到被呼叫節點的任務');
    ok(d.length === 3 && d[0].startedAt >= d[1].startedAt && d[1].startedAt >= d[2].startedAt, '分派紀錄新的在前;會議不列入', d.map(x => `${x.fromName}→${x.toName}`));

    // 總覽的完整內容
    $('.dash .dash-expand').click();
    const full = await until(() => $('.dash-full'), 3000);
    ok(!!full, '展開總覽的完整內容');
    const rows = $$('.dash-full .df-dispatch tr[data-row^="dispatch:"]');
    ok(rows.length === 3, '分派紀錄列出 3 列', rows.length);
    const ra = rows.find(r => text(r).includes('Alpha → Beta'));
    ok(!!ra && text(ra).includes('完成') && text(ra).includes('請 Beta 看一下設計') && /\d+ (秒|分)/.test(text(ra)), '列上有誰 → 誰、內容、狀態與耗時', text(ra));
    ra?.click();
    const dlg = await until(() => $('.dialog'), 3000);
    ok(!!dlg && text(dlg).includes('Beta'), '點分派紀錄的列會打開被呼叫節點(Beta)的對話視窗');
    log('主控台端結束');
  } catch (err) {
    log('失敗', err.stack ?? err.message);
  }
  document.title = 'QUIT';
})();
