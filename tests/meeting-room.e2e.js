// 會議室虛擬節點(任務清單 2-7)的驗收(假資料模式,主控台這一側):建立節點、印出 id 給 tests/meeting-room-client.mjs,
// 由用戶端開兩場會;這裡檢查主面板(window.__nexusBoard 的 rooms、inMeeting、tapRoom)與會議室的旁聽視窗(DOM)。
// 每個階段檢查完印出「GO n」,用戶端才進行下一步(主持人發言、散會)。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const ok = (cond, what, extra = '') => log(cond ? '通過' : '不符', what + (cond || !extra ? '' : ` → ${String(extra).slice(0, 300)}`));
  // 截圖前等面板上的節點與會議室滑到定位
  const shot = async name => { const t0 = Date.now(); while (!window.__nexusBoard.settled() && Date.now() - t0 < 3000) await wait(100); document.title = `SHOT:${name}`; await wait(600); document.title = 'Entropy Nexus'; };
  try {
    await window.nexus.setAutopilot(false);
    const cwd = window.__TEST_CWD__;
    const mk = (name, backend, character = '') => window.nexus.createAgent({ name, character, model: '', backend, cwd, permissionMode: 'auto' });
    const spec = [['Host', 'claude', 'RoomHost'], ['P1', 'codex', 'RoomP1'], ['P2', 'antigravity'], ['Host2', 'claude'], ['Q1', 'codex'], ['Idle', 'codex']];
    const id = {};
    for (const [n, b, c] of spec) id[n] = (await mk(n, b, c)).id;
    await wait(2500);
    log('READY', JSON.stringify(id));

    const B = () => window.__nexusBoard;
    const nameOf = Object.fromEntries(Object.entries(id).map(([n, v]) => [v, n]));
    const names = ids => ids.map(x => nameOf[x] ?? x).sort().join(',');
    // 假資料節點自己的授權一律允許(這裡的節點都是自動模式,通常不會有)
    const allow = async () => { for (const a of (await window.nexus.getSnapshot()).agents) if (a.pendingApproval) await window.nexus.respondApproval(a.id, a.pendingApproval.requestId, 'allow'); };
    const until = async (cond, ms, step = 120) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await cond()) return true; await wait(step); } return false; };
    const inside = (r, p) => !!r && p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
    const dlg = () => document.querySelector('.meeting-dialog');
    const transcript = () => [...(dlg()?.querySelectorAll('.meeting-msg') ?? [])].map(e => ({ node: nameOf[e.dataset.node] ?? e.dataset.node, round: Number(e.dataset.round), meta: e.querySelector('.mm-meta')?.textContent ?? '', text: e.querySelector('.md')?.textContent ?? '' }));
    const portrait = () => {
      const p = dlg()?.querySelector('.meeting-portrait');
      const img = p?.querySelector('img');
      return { speaker: nameOf[p?.dataset.speaker] ?? p?.dataset.speaker, img: img ? decodeURIComponent(img.getAttribute('src') ?? '') : null, svg: !!p?.querySelector('svg.portrait'), role: p?.querySelector('.mp-role')?.textContent ?? '' };
    };
    const prog = () => dlg()?.querySelector('.meeting-progress')?.textContent ?? '';

    // ---- 1. 兩場會議都停在「輪到主持人」
    const atHost = () => { const rs = B().rooms(); return rs.length === 2 && rs.every(r => r.round >= 1 && r.speakerId === r.hostId); };
    ok(await until(async () => { await allow(); return atHost(); }, 90000, 250), '兩場會議同時進行,面板上有兩個會議室', JSON.stringify(B().rooms()));
    const snap = await window.nexus.getSnapshot();
    const mA = (snap.meetings ?? []).find(m => m.hostId === id.Host), mB = (snap.meetings ?? []).find(m => m.hostId === id.Host2);
    ok(!!mA && !!mB, '快照裡有兩場進行中的會議', JSON.stringify(snap.meetings));
    ok(snap.agents.length === 6 && B().total() === 6, '會議室不是節點(agents 與面板的節點數不變)', `agents=${snap.agents.length} total=${B().total()}`);
    await until(() => B().settled(), 5000);
    const roomA = () => B().rooms().find(r => r.id === mA.id), roomB = () => B().rooms().find(r => r.id === mB.id);
    const active = B().rect('active');
    ok(B().rooms().every(r => r.visible && inside(active, r)), '會議室都在執行區裡', JSON.stringify({ active, rooms: B().rooms().map(r => ({ x: r.x, y: r.y })) }));
    ok(!B().positions().some(p => p.id === mA.id || p.id === mB.id), '會議室不在節點清單裡');
    await until(() => roomA().avatarOf === 'RoomHost', 5000);
    ok(roomA().avatarOf === 'RoomHost', '第一間會議室的頭像是主持人 Host 的頭像', roomA().avatarOf);
    ok(roomB().avatarOf === null && roomB().hostId === id.Host2, '主持人沒有頭像時不借用別人的(第二間)', JSON.stringify(roomB()));
    ok(roomA().members.map(x => nameOf[x]).join() === 'Host,P1,P2' && roomB().members.map(x => nameOf[x]).join() === 'Host2,Q1', '會議室下緣的與會節點:主持人在前', `${roomA().members} / ${roomB().members}`);
    ok(roomA().name.startsWith('會議室驗收') && roomA().readout === '第 1/3 輪 · Host', '會議室的名稱是主題、狀態是「第 N/M 輪 · 發言者」', JSON.stringify(roomA()));
    await wait(300);
    const dim = B().inMeeting();
    ok(names(dim.map(x => x.id)) === 'Host,Host2,P1,P2,Q1', '主持人與參與者都標成開會中,沒參加的 Idle 不受影響', names(dim.map(x => x.id)));
    ok(dim.every(x => x.alpha < 0.7 && x.label === '開會中'), '開會中的節點淡化並顯示「開會中」', JSON.stringify(dim));
    // 待授權與異常需要使用者處理:開會中也不淡化(判斷規則,以及一個真的停在等回答的參與者)
    const rule = ['idle', 'planning', 'working', 'awaiting', 'error', 'lost'].map(s => `${s}:${B().dimInMeeting(s) ? '淡化' : '照常'}`).join();
    ok(rule === 'idle:淡化,planning:淡化,working:淡化,awaiting:照常,error:照常,lost:照常', '開會中的節點只有待授權與異常(error、lost)不淡化', rule);
    await window.nexus.send(id.Q1, '提問測試:讓它停在等使用者回答');
    const q1 = () => B().inMeeting().find(x => x.id === id.Q1);
    await until(() => q1()?.state === 'awaiting', 8000);
    await wait(300);
    ok(q1()?.state === 'awaiting' && !q1().dimmed && q1().alpha > 0.95 && q1().label !== '開會中', '開會中的參與者停在等你回答時不淡化,照常顯示狀態', JSON.stringify(q1()));
    const pq = (await window.nexus.getSnapshot()).agents.find(a => a.id === id.Q1)?.pendingQuestion;
    if (pq) await window.nexus.answerQuestion(id.Q1, pq.requestId, { q1: ['紅色'] });
    await until(() => q1()?.state === 'idle', 15000);
    await wait(300);
    ok(q1()?.dimmed && q1().alpha < 0.7 && q1().label === '開會中', '回答完回到待命後又淡化成「開會中」', JSON.stringify(q1()));

    // ---- 打開第一間會議室的旁聽視窗
    ok(B().tapRoom(mA.id), '點會議室');
    await until(() => !!dlg(), 3000);
    ok(!!dlg() && dlg().dataset.meeting === mA.id, '打開的是這場會議的旁聽視窗');
    ok(!document.querySelector('.dialog:not(.meeting-dialog)'), '點會議室不會打開任何節點的對話視窗');
    await until(() => roomA().selected, 2000);
    ok(roomA().selected && !roomB().selected, '面板上標出打開的會議室');
    ok(prog() === '第 1/3 輪 · 正在發言:Host', '標題列顯示「第 N/M 輪 · 正在發言:某某」', prog());
    const t1 = transcript();
    ok(t1.map(x => `${x.node}${x.round}`).join() === 'P11,P21' && t1[0].text.includes('SAY-P1-R1') && t1[1].text.includes('SAY-P2-R1') && t1.every(x => x.meta.startsWith('第 1 輪')), '逐字發言依序出現,標明發言者與第幾輪', JSON.stringify(t1));
    const ta = dlg().querySelector('textarea');
    ok(ta?.disabled && ta.placeholder.includes('只能旁聽'), '輸入列停用並提示只能旁聽', ta?.placeholder);
    const buttons = [...dlg().querySelectorAll('button')].map(b => b.textContent.trim());
    ok(dlg().querySelector('.meeting-readonly button')?.disabled && !buttons.some(t => /設定|終止|休眠|中斷|結束會議|排隊/.test(t)), '旁聽視窗沒有任何節點操作或結束會議的按鈕', buttons.join(','));
    const p1 = portrait();
    ok(p1.speaker === 'Host' && !!p1.img?.includes('RoomHost') && p1.role === '主持人', '輪到主持人時立繪是主持人的', JSON.stringify(p1));
    ok(!!dlg().querySelector('.meeting-typing')?.textContent.includes('Host 正在發言'), '對話串最後顯示「Host 正在發言…」');
    await shot('room-host-turn');
    log('GO 1');

    // ---- 2. 第 2 輪:發言者與立繪跟著切換(用戶端讓主持人發言)
    const seen = [];
    let last = '';
    await until(() => {
      const r = roomA();
      if (!r) return true;
      const key = `${r.round}|${r.speakerId}`;
      if (key !== last) { last = key; seen.push({ round: r.round, speaker: nameOf[r.speakerId] ?? r.speakerId, readout: r.readout }); }
      // 立繪與標題列是 React 畫的,比面板晚一點:每次都更新這個發言者最後看到的樣子
      const cur = seen[seen.length - 1];
      cur.progress = prog();
      (cur.progressSeen ??= new Set()).add(cur.progress);
      cur.portrait = portrait();
      return r.round === 2 && r.speakerId === r.hostId;
    }, 60000, 60);
    const order = seen.map(s => `${s.round}${s.speaker}`).join();
    const at = n => seen.find(s => s.round === 2 && s.speaker === n);
    ok(/2P1,(2null,)?2P2,(2null,)?2Host$/.test(order), '發言者依序切換:P1 → P2 → 主持人', order);
    ok(at('P1')?.portrait.speaker === 'P1' && !!at('P1').portrait.img?.includes('RoomP1') && at('P1').portrait.role === '與會節點', 'P1 發言時立繪換成 P1 的', JSON.stringify(at('P1')?.portrait));
    ok(at('P2')?.portrait.speaker === 'P2' && at('P2').portrait.svg && !at('P2').portrait.img, 'P2 沒有立繪:改用預設圖', JSON.stringify(at('P2')?.portrait));
    ok(!!at('P1')?.progressSeen?.has('第 2/3 輪 · 正在發言:P1') && at('P1')?.readout === '第 2/3 輪 · P1', '標題列與會議室都顯示目前發言者', JSON.stringify({ ...at('P1'), progressSeen: [...(at('P1')?.progressSeen ?? [])] }));
    await wait(300);
    const t2 = transcript();
    ok(t2.map(x => `${x.node}${x.round}`).join() === 'P11,P21,Host1,P12,P22' && t2[2].meta.includes('主持人') && t2[2].text.includes('HOST-R1') && dlg().querySelectorAll('.meeting-msg .who')[2]?.textContent === 'Host', '第 2 輪的發言接在後面(主持人的發言標「主持人」)', JSON.stringify(t2.map(x => `${x.node}${x.round}:${x.meta}`)));
    ok(portrait().speaker === 'Host', '又輪到主持人時立繪換回主持人', JSON.stringify(portrait()));
    await shot('room-round2');
    log('GO 2');

    // ---- 3. 第一場散會:會議室立刻消失,旁聽視窗顯示「會議已結束」後關閉;參與者恢復,第二場不受影響
    ok(await until(() => !roomA(), 30000, 50), '散會後會議室從面板上消失');
    const gone = Date.now();
    const shown = await until(() => !!dlg()?.querySelector('.meeting-ended'), 1000, 30);
    const endedText = dlg()?.querySelector('.meeting-ended')?.textContent ?? '';
    ok(shown && endedText.includes('紀錄已存進記憶庫'), '開著的旁聽視窗顯示「會議已結束,紀錄已存進記憶庫」', endedText);
    ok(!!dlg()?.querySelector('textarea')?.disabled, '結束後輸入列仍是停用的');
    await shot('room-ended');
    ok(await until(() => !dlg(), 4000, 50), '旁聽視窗隨後自動關閉', `${Date.now() - gone}ms`);
    await wait(400);
    const dim2 = B().inMeeting();
    ok(names(dim2.map(x => x.id)) === 'Host2,Q1', '第一場的節點恢復原樣,第二場的仍是開會中', names(dim2.map(x => x.id)));
    ok(B().rooms().length === 1 && !!roomB(), '第二間會議室還在');
    ok([id.Host, id.P1, id.P2].every(x => B().positions().some(p => p.id === x)), '第一場的節點都還在面板上');
    log('GO 3');

    // ---- 4. 第二場也散會
    ok(await until(() => B().rooms().length === 0, 30000, 100), '兩場都散會後沒有會議室');
    await wait(400);
    ok(B().inMeeting().length === 0, '沒有開會中的節點');
    ok(((await window.nexus.getSnapshot()).meetings ?? []).length === 0, '快照裡沒有進行中的會議');
    log('主控台端結束');
  } catch (err) {
    log('失敗', err.stack ?? err.message);
  }
  await wait(500);
  document.title = 'QUIT';
})();
