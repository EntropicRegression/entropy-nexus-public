// 會議功能的驗收(假資料模式,主控台這一側):建立一批節點,印出它們的 id(JSON),之後由 tests/meeting-client.mjs 當成各節點的 CLI 連到工具服務。
// 這裡負責:
//   - 回應授權:「召開會議」「呼叫節點」依摘要決定(含「請拒絕」就拒絕,其餘允許);假資料節點自己的授權一律允許。
//   - 依事件觸發的動作(用戶端不能直接操作主控台):
//       Brk(忙碌略過)召開的會議一開始,就讓參與者 BP2 進入「等使用者回答」的忙碌狀態,會議結束後再放它走;
//       Dis(散會)召開的會議一開始,就對 Dis 送一句短指令,讓它跑一個回合再回到待命(模擬召開者的回合結束)。
//   - 全部做完後(用戶端用 ask_node 傳來「會議檢查完成」)檢查各節點的對話紀錄。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const ok = (cond, what, extra = '') => log(cond ? '通過' : '不符', what + (cond || !extra ? '' : ` → ${String(extra).slice(0, 300)}`));
  try {
    await window.nexus.setAutopilot(false);
    const cwd = window.__TEST_CWD__;
    const mk = (name, backend, permissionMode) => window.nexus.createAgent({ name, character: '', model: '', backend, cwd, permissionMode });
    const spec = [
      ['Host', 'claude', 'auto'], ['Ask', 'claude', 'ask'],
      ['P1', 'codex', 'auto'], ['P2', 'antigravity', 'auto'],
      ['N1', 'codex', 'auto'], ['N2', 'antigravity', 'auto'],
      ['Q1', 'codex', 'auto'], ['Q2', 'antigravity', 'auto'], ['R1', 'codex', 'auto'],
      ['T1', 'codex', 'auto'], ['T2', 'antigravity', 'auto'],
      ['Dis', 'claude', 'auto'], ['DP1', 'codex', 'auto'], ['DP2', 'antigravity', 'auto'],
      ['Brk', 'claude', 'auto'], ['BP1', 'codex', 'auto'], ['BP2', 'antigravity', 'auto'],
    ];
    const id = {};
    for (const [n, b, m] of spec) id[n] = (await mk(n, b, m)).id;
    await wait(2500);
    log('READY', JSON.stringify(id));

    const hist = async n => await window.nexus.getHistory(id[n]);
    const users = async n => (await hist(n)).filter(e => e.type === 'message' && e.role === 'user').map(e => e.text);
    const notes = async n => (await hist(n)).filter(e => e.type === 'note').map(e => e.text);
    const MEET = '(主控台:這是一場由節點「';
    const meetPrompts = async n => (await users(n)).filter(t => t.startsWith(MEET));

    const approvals = [];       // { name, tool, deny }
    let disTriggered = false, brkTriggered = false, brkReleased = false;
    let done = false;
    const t0 = Date.now();
    while (!done && Date.now() - t0 < 330000) {
      const snap = await window.nexus.getSnapshot();
      for (const a of snap.agents) {
        const p = a.pendingApproval;
        if (!p) continue;
        if (p.tool === '召開會議' || p.tool === '呼叫節點') {
          const deny = p.summary.includes('請拒絕');
          approvals.push({ name: a.name, tool: p.tool, deny });
          await window.nexus.respondApproval(a.id, p.requestId, deny ? 'deny' : 'allow');
        } else await window.nexus.respondApproval(a.id, p.requestId, 'allow');
      }
      if (!disTriggered && (await notes('Dis')).some(t => t.includes('會議開始('))) {
        disTriggered = true;
        await window.nexus.send(id.Dis, '請輸出一段程式碼範例');
      }
      if (!brkTriggered && (await notes('Brk')).some(t => t.includes('會議開始('))) {
        brkTriggered = true;
        await window.nexus.send(id.BP2, '提問測試:讓它停在等使用者回答');
      }
      if (brkTriggered && !brkReleased && (await notes('Brk')).some(t => t.includes('會議結束('))) {
        const q = (snap.agents.find(a => a.id === id.BP2) ?? {}).pendingQuestion;
        if (q) { brkReleased = true; await window.nexus.answerQuestion(id.BP2, q.requestId, { q1: ['紅色'] }); }
      }
      done = (await users('Host')).some(t => t.includes('會議檢查完成'));
      await wait(250);
    }
    log('主控台回應的授權', JSON.stringify(approvals));
    ok(done, '用戶端有回報完成');

    // ---- 3. 參與者實際收到的指令(P1、P2 只參加過那一場 3 輪的會議)
    const p1 = await meetPrompts('P1'), p2 = await meetPrompts('P2');
    ok(p1.length === 3 && p2.length === 3, '3 輪會議每位參與者各收到 3 次指令', `P1=${p1.length} P2=${p2.length}`);
    const head = t => t.startsWith(MEET + 'Host(Claude Code)」召開的會議');
    ok([...p1, ...p2].every(head), '參與者的指令開頭是會議說明的那一行', p1[0]);
    ok(p1[0]?.includes('現在是第 1 輪') && p1[0].includes('【主題】') && p1[0].includes('MEETING-TOPIC-ONE'), '第一輪的指令含【主題】與主題內容', p1[0]);
    ok(p1[0] && !p1[0].includes('◆') && p1[0].includes('【目前還沒有人發言,由你先開始】'), '第一位參與者第一輪看到「還沒有人發言」', p1[0]);
    ok(p2[0]?.includes('◆ P1(第 1 輪):\nSAY-P1-R1'), '第二位參與者第一輪就看得到第一位的發言', p2[0]);
    ok(p1[1]?.includes('現在是第 2 輪') && p1[1].includes('◆ P2(第 1 輪):\nSAY-P2-R1') && !p1[1].includes('SAY-P1-R1') && !p1[1].includes('【主題】'), '第二輪 P1 只收到 P2 的新發言(不含自己的、不重複主題)', p1[1]);
    ok(p2[1]?.includes('◆ P1(第 2 輪):\nSAY-P1-R2') && !p2[1].includes('SAY-P1-R1') && !p2[1].includes('SAY-P2-R1'), '第二輪 P2 只收到 P1 第二輪的發言(不含舊的、不含自己的)', p2[1]);
    ok(p1[2]?.includes('SAY-P2-R2') && !p1[2].includes('SAY-P2-R1') && !p1[2].includes('SAY-P1-R2'), '第三輪 P1 只收到 P2 第二輪的發言', p1[2]);
    ok(p2[2]?.includes('SAY-P1-R3') && !p2[2].includes('SAY-P1-R2') && !p2[2].includes('SAY-P2-R2'), '第三輪 P2 只收到 P1 第三輪的發言', p2[2]);

    // ---- 4. 召開者對話裡的 note
    const hn = await notes('Host');
    ok(hn.some(t => /^會議開始.m\w+..參與者 P1.Codex.、P2.Antigravity..最多 3 輪/.test(t)), '召開者對話有「會議開始」', hn.join(' / '));
    ok(hn.some(t => /^【會議 m\w+\|第 1 輪\|P1】\nSAY-P1-R1$/.test(t)) && hn.some(t => /^【會議 m\w+\|第 3 輪\|P2】\nSAY-P2-R3$/.test(t)), '召開者對話有每則發言的「【會議 …|第 N 輪|名稱】」', hn.join(' / '));
    ok(hn.some(t => /^會議結束.m\w+.,?.?共 6 則發言/.test(t)), '召開者對話有「會議結束」', hn.join(' / '));

    // ---- 6. 每次詢問模式的召開者
    const askSeen = approvals.filter(a => a.name === 'Ask').map(a => `${a.tool}:${a.deny ? '拒絕' : '允許'}`);
    ok(askSeen.join() === '召開會議:允許,召開會議:拒絕', '每次詢問的召開者:每場開會前只跳一次「召開會議」授權(允許後整場不再跳)', askSeen.join());
    ok(!approvals.some(a => a.tool === '呼叫節點'), '整個過程沒有跳「呼叫節點」授權', JSON.stringify(approvals));
    ok((await meetPrompts('R1')).length === 0, '拒絕召開後沒有任何參與者收到指令');
    ok((await meetPrompts('Q1')).length === 2 && (await meetPrompts('Q2')).length === 2, '允許召開後 2 輪各發言 2 次');

    // ---- 9. 散會
    const dp1 = await meetPrompts('DP1'), dp2 = await meetPrompts('DP2');
    ok(dp1.length === 1 && dp2.length === 0, '召開者回合結束散會後,沒有再送新一輪指令', `DP1=${dp1.length} DP2=${dp2.length}`);
    ok((await hist('DP1')).some(e => e.type === 'message' && e.role === 'agent' && e.text === '已中斷。'), '散會時正在發言的參與者被中斷');
    ok((await notes('Dis')).some(t => /^會議中止.m\w+..召開會議的節點已經停下來/.test(t)), '召開者對話有「會議中止」', (await notes('Dis')).join(' / '));

    // ---- 10. 忙碌略過
    ok((await meetPrompts('BP2')).length === 0, '忙碌的參與者沒有收到會議指令');
    ok((await notes('Brk')).some(t => t.includes('BP2') && t.includes('略過')), '召開者對話記了「略過」', (await notes('Brk')).join(' / '));
    log(done ? '主控台端結束' : '等不到用戶端回報');
  } catch (err) {
    log('失敗', err.stack ?? err.message);
  }
  document.title = 'QUIT';
})();
