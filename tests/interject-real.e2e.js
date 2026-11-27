// 回合中插話的真實觀察(真正的 CLI,會用到一點額度)。由 tests/interject-real.sh 啟動。window.__TEST_IMAGE__ 是「後台,模型,暗號」。
// 先給節點一個會跑一陣子的工作(執行約 20 秒的指令再回報),在它執行中送出第二句(插話,帶暗號),
// 記錄:狀態變化、任務筆數、錯誤、最後的回覆有沒有回應插話,以及第一句的工作有沒有被打斷。只觀察,不判定成敗以外的對錯。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const until = async (what, fn, timeout = 180000) => { const t0 = Date.now(); while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await wait(300); } throw new Error(`等不到:${what}`); };
  const snapOf = async id => (await window.nexus.getSnapshot()).agents.find(x => x.id === id);
  const t0 = Date.now();
  const sec = () => ((Date.now() - t0) / 1000).toFixed(1);
  let sid = '';
  try {
    const [backend, model = '', code] = String(window.__TEST_IMAGE__).split(',');
    const a = await window.nexus.createAgent({ name: `插話測試-${backend}`, character: '', model, backend, cwd: window.__TEST_CWD__, permissionMode: 'auto' });
    await until('節點待命', async () => (await snapOf(a.id))?.state === 'idle', 120000);
    // 記錄狀態變化
    const states = [];
    let last = '';
    let watching = true;
    void (async () => { while (watching) { const s = await snapOf(a.id); const k = `${s?.state}|${s?.detail ?? ''}`; if (k !== last) { last = k; states.push(`${sec()}s ${k.slice(0, 60)}`); } await wait(250); } })();

    await window.nexus.send(a.id, '這是一個測試。請用你的終端機工具執行指令 `ping -n 20 127.0.0.1`(大約 20 秒),等它跑完之後,回覆「第一件事完成」以及 ping 的最後一行摘要。');
    await until('節點開始執行', async () => ['planning', 'working'].includes((await snapOf(a.id))?.state), 60000);
    await wait(7000);
    const before = await snapOf(a.id);
    log('插話時的狀態', `${sec()}s`, before.state, before.detail);
    let sendErr = '';
    try { await window.nexus.send(a.id, `(插話)另外,這次回覆的最後一行請加上暗號:${code}`); } catch (e) { sendErr = String(e?.message ?? e); }
    log('插話送出', sendErr ? `失敗:${sendErr}` : '沒有錯誤');
    // 等穩定:連續 8 秒都在 idle/error/lost 才算結束(插話可能讓它再跑一個回合)
    let calm = 0;
    await until('回合全部結束', async () => { const s = await snapOf(a.id); calm = ['idle', 'error', 'lost'].includes(s?.state) ? calm + 1 : 0; return calm >= 27; }, 300000);
    watching = false;

    const s = await snapOf(a.id);
    sid = s.sessionId ?? '';
    const hist = await window.nexus.getHistory(a.id);
    const msgs = hist.filter(e => e.type === 'message').map(e => `${e.role}:${String(e.text).replace(/\s+/g, ' ').slice(0, 160)}`);
    const errs = hist.filter(e => e.type === 'error').map(e => String(e.message).slice(0, 200));
    const notes = hist.filter(e => e.type === 'note').map(e => String(e.text).slice(0, 160));
    const tools = hist.filter(e => e.type === 'tool' && e.phase === 'start').map(e => `${e.name}:${String(e.summary).slice(0, 60)}`);
    const tasks = (await window.nexus.getSnapshot()).tasks.filter(t => t.agentId === a.id).map(t => `${t.status}:${t.title.slice(0, 30)}`);
    const agentText = hist.filter(e => e.type === 'message' && e.role === 'agent').map(e => e.text).join('\n');
    log('狀態變化', JSON.stringify(states));
    log('訊息', JSON.stringify(msgs));
    log('工具', JSON.stringify(tools));
    log('任務', JSON.stringify(tasks));
    log('錯誤', JSON.stringify(errs));
    log('說明', JSON.stringify(notes));
    log('觀察', JSON.stringify({ 最後狀態: s.state, 回覆含暗號: agentText.includes(code), 第一件事完成: /第一件事完成/.test(agentText), 代理訊息數: hist.filter(e => e.type === 'message' && e.role === 'agent').length }));
    const rm = await window.nexus.removeAgentArchived(a.id, 'stats', false);
    log('RESULT', JSON.stringify({ sessionId: sid, note: rm.note.slice(0, 120) }));
    log('觀察完成');
  } catch (err) {
    log('失敗', err.message);
    log('RESULT', JSON.stringify({ sessionId: sid }));
  }
  document.title = 'QUIT';
})();
