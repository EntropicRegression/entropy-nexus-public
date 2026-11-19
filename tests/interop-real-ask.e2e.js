// 節點互相呼叫:「每次詢問」模式的授權(真正的 CLI,會用到一點額度)。由 tests/interop-real.sh 以 ask 模式啟動。
// Caller 是每次詢問模式。第一句請它問 Helper 一個暗號:主控台要先在 Caller 上跳「呼叫節點」授權,
// 允許之前 Helper 不能收到任何東西;允許後 Caller 拿到答覆。第二句再問一次,這次拒絕:Helper 不能收到,Caller 要回報被拒。
// CLI 自己發出的授權(例如它想先跑指令)一律拒絕並記下來,看除了「呼叫節點」以外還會不會跳別的。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  let bad = 0;
  const expect = (label, ok, detail = '') => { if (!ok) bad++; log(`${ok ? '通過' : '不符'}:${label}${detail ? ` → ${String(detail).slice(0, 500)}` : ''}`); };
  const snap = () => window.nexus.getSnapshot();
  const agent = async id => (await snap()).agents.find(x => x.id === id);
  const until = async (what, fn, timeout = 180000) => { const t0 = Date.now(); while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await wait(400); } throw new Error(`等不到:${what}`); };
  try {
    const [callerBackend, helperBackend, callerModel = '', helperModel = ''] = String(window.__TEST_IMAGE__).split(',');
    const cwd = window.__TEST_CWD__;
    const caller = await window.nexus.createAgent({ name: 'Caller', character: '', model: callerModel, backend: callerBackend, cwd, permissionMode: 'ask' });
    const helper = await window.nexus.createAgent({ name: 'Helper', character: '', model: helperModel, backend: helperBackend, cwd, permissionMode: 'auto' });
    await until('Caller 待命', async () => (await agent(caller.id))?.state === 'idle', 60000);
    await until('Helper 待命', async () => (await agent(helper.id))?.state === 'idle', 60000);
    const helperGot = async code => (await window.nexus.getHistory(helper.id)).some(e => e.type === 'message' && e.role === 'user' && e.text.includes(code));

    /** 送一句指令,回合中遇到授權就依 decide 回應;回傳這個回合看到的授權。 */
    const turn = async (text, code, decision) => {
      const seen = [];
      const before = (await window.nexus.getHistory(caller.id)).length;
      await window.nexus.send(caller.id, text);
      await wait(2500);
      const t0 = Date.now();
      for (;;) {
        const a = await agent(caller.id);
        if (!a || ['idle', 'error', 'lost'].includes(a.state)) break;
        if (Date.now() - t0 > 240000) throw new Error('回合太久');
        const p = a.pendingApproval;
        if (p) {
          const ours = p.tool === '呼叫節點';
          seen.push({ tool: p.tool, summary: p.summary.slice(0, 70), state: a.state, helperGotBefore: ours ? await helperGot(code) : null, detailHasPrompt: ours ? p.detail.includes(code) : null, canAllowSession: p.canAllowSession });
          await window.nexus.respondApproval(caller.id, p.requestId, ours ? decision : 'deny');
          await wait(800);
        }
        await wait(400);
      }
      const h = (await window.nexus.getHistory(caller.id)).slice(before);
      return { seen, reply: h.filter(e => e.type === 'message' && e.role === 'agent').map(e => e.text).join(' '), errors: h.filter(e => e.type === 'error').map(e => e.message.slice(0, 120)), state: (await agent(caller.id))?.state };
    };

    // ---------- 允許
    const ask = code => `請用 ask_node 工具請節點 Helper 回答這個問題:「請只回覆這串暗號,不要加任何其他字:${code}」,然後把 Helper 回覆的暗號原樣告訴我。只用這個工具,不要執行指令或讀寫檔案;如果工具回報失敗或被拒絕,請直接告訴我原因,不要重試。`;
    const r1 = await turn(ask('PEACH-3306'), 'PEACH-3306', 'allow');
    const mine1 = r1.seen.filter(s => s.tool === '呼叫節點');
    expect('跳出「呼叫節點」授權', mine1.length === 1, JSON.stringify(r1.seen));
    expect('授權時節點在待授權、Helper 還沒收到指令', mine1.every(s => s.state === 'awaiting' && s.helperGotBefore === false), JSON.stringify(mine1));
    expect('授權內容看得到對象與指令全文', mine1.every(s => s.summary.includes('Helper') && s.detailHasPrompt === true && s.canAllowSession === false), JSON.stringify(mine1));
    expect('允許後 Helper 收到並回覆', (await helperGot('PEACH-3306')) && (await window.nexus.getHistory(helper.id)).some(e => e.type === 'message' && e.role === 'agent' && e.text.includes('PEACH-3306')));
    expect('允許後 Caller 拿到答覆', r1.reply.includes('PEACH-3306') && r1.state === 'idle', JSON.stringify({ reply: r1.reply.slice(0, 200), state: r1.state, errors: r1.errors }));
    log('CLI 自己另外發出的授權(第一句)', JSON.stringify(r1.seen.filter(s => s.tool !== '呼叫節點').map(s => `${s.tool}:${s.summary}`)));

    // ---------- 拒絕
    const r2 = await turn(ask('GRAPE-9054'), 'GRAPE-9054', 'deny');
    const mine2 = r2.seen.filter(s => s.tool === '呼叫節點');
    expect('第二次同樣要授權(不會記住上次的允許)', mine2.length >= 1, JSON.stringify(r2.seen));
    expect('拒絕後 Helper 沒有收到指令', !(await helperGot('GRAPE-9054')));
    expect('拒絕後 Caller 回報被拒、沒有拿到暗號以外的答案', /拒絕|被拒|declin|denied|reject/i.test(r2.reply) && r2.state === 'idle', JSON.stringify({ reply: r2.reply.slice(0, 300), state: r2.state, errors: r2.errors }));
    log('CLI 自己另外發出的授權(第二句)', JSON.stringify(r2.seen.filter(s => s.tool !== '呼叫節點').map(s => `${s.tool}:${s.summary}`)));
    const audit = (await window.nexus.getHistory(caller.id)).filter(e => e.type === 'approval_resolved').map(e => e.decision);
    expect('對話紀錄留下允許與拒絕', audit.includes('allow') && audit.includes('deny'), JSON.stringify(audit));
    log(bad ? `有 ${bad} 項不符` : '全部通過');
    await window.nexus.removeAgent(caller.id); await window.nexus.removeAgent(helper.id);
  } catch (err) {
    log('失敗', err.message);
    try { const s = await snap(); for (const a of s.agents) { const h = await window.nexus.getHistory(a.id); log(a.name, a.state, a.detail, JSON.stringify(h.filter(e => ['error', 'tool', 'message', 'approval_request'].includes(e.type)).slice(-8).map(e => `${e.type}:${String(e.name ?? e.tool ?? e.message ?? e.text).slice(0, 80)}`))); } } catch { /* 略過 */ }
  }
  document.title = 'QUIT';
})();
