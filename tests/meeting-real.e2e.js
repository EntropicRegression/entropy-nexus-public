// 會議功能(真正的 CLI,會用到一點額度)。由 tests/meeting-real.sh 啟動。
// window.__TEST_IMAGE__ 是「主持人後台:模型,參與者後台:模型,參與者後台:模型…」。
// 主持人(自動模式)用 start_meeting 召開一場兩輪的會議,參與者輪流發言;檢查每個人收到的內容、會議紀錄與主持人的結論。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const until = async (what, fn, timeout = 180000) => { const t0 = Date.now(); while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await wait(500); } throw new Error(`等不到:${what}`); };
  let bad = 0;
  const expect = (label, ok, detail = '') => { if (!ok) bad++; log(`${ok ? '通過' : '不符'}:${label}${detail ? ` → ${String(detail).slice(0, 500)}` : ''}`); };
  const snap = () => window.nexus.getSnapshot();
  try {
    const spec = String(window.__TEST_IMAGE__).split(',').map(x => x.split(':'));
    const cwd = window.__TEST_CWD__;
    const names = ['Host', 'Mika', 'Rin', 'Sora'];
    const nodes = [];
    for (let i = 0; i < spec.length; i++) nodes.push(await window.nexus.createAgent({ name: names[i], character: '', model: spec[i][1] ?? '', backend: spec[i][0], cwd, permissionMode: 'auto' }));
    const [host, ...parts] = nodes;
    for (const n of nodes) await until(`${n.name} 待命`, async () => (await snap()).agents.find(x => x.id === n.id && x.state === 'idle'), 90000);
    const who = parts.map(p => p.name).join('、');
    await window.nexus.send(host.id, `請用 start_meeting 工具召開一場會議,參與者是 ${who},rounds 設為 2。主題請原樣使用這段文字:「我們要為一個每日筆記 App 取名字,最後只能選一個。第一輪請每個人提出一個自己想的候選名稱(兩到四個字)並用一句話說明理由;第二輪請對其他人的提案表態,並明確說出你最後支持哪一個名字。發言請控制在三句話以內。」會議需要幾分鐘,請用 wait_reply 一直等到會議結束,然後告訴我:每位參與者各提了什麼名字、最後各自支持哪一個、有沒有達成共識。不要用其他方式取得答案,也不要執行指令或讀寫檔案。`);
    await wait(4000);
    await until('主持人回合結束', async () => (await snap()).agents.find(x => x.id === host.id && ['idle', 'error', 'lost'].includes(x.state)), 480000);
    const hh = await window.nexus.getHistory(host.id);
    const tools = hh.filter(e => e.type === 'tool' && e.phase === 'start').map(e => `${e.name} ${e.summary}`.slice(0, 60));
    const notes = hh.filter(e => e.type === 'note').map(e => e.text);
    const reply = hh.filter(e => e.type === 'message' && e.role === 'agent').map(e => e.text).join(' ');
    // 會議在 start_meeting 等候的時間內就開完時,不需要再呼叫 wait_reply
    expect('主持人用了 start_meeting', tools.some(t => /start_meeting/.test(t)), JSON.stringify(tools));
    log('有沒有用到 wait_reply', tools.some(t => /wait_reply/.test(t)));
    expect('主持人的對話有會議開始與結束', notes.some(n => n.startsWith('會議開始')) && notes.some(n => n.startsWith('會議結束')), JSON.stringify(notes.map(n => n.slice(0, 40))));
    for (const p of parts) {
      const h = await window.nexus.getHistory(p.id);
      const prompts = h.filter(e => e.type === 'message' && e.role === 'user').map(e => e.text);
      const said = h.filter(e => e.type === 'message' && e.role === 'agent').map(e => e.text);
      const others = parts.filter(x => x.id !== p.id).map(x => x.name);
      expect(`${p.name}:收到兩輪會議指令,開頭註明是誰召開的`, prompts.length === 2 && prompts.every(t => t.startsWith('(主控台:這是一場由節點「Host(')) && prompts[0].includes('【主題】') && prompts[0].includes('每日筆記 App'), JSON.stringify(prompts.map(t => t.slice(0, 70))));
      // 第二輪只會收到「自己上次發言之後」的新發言:排在自己前面的人是第 2 輪的發言,排在後面的是第 1 輪的
      const idx = parts.indexOf(p);
      const want = parts.filter(x => x.id !== p.id).map(x => `◆ ${x.name}(第 ${parts.indexOf(x) < idx ? 2 : 1} 輪)`);
      expect(`${p.name}:第二輪收到其他人的新發言,不含自己的`, want.every(w => prompts[1]?.includes(w)) && !prompts[1]?.includes(`◆ ${p.name}(`) && !prompts[1]?.includes('【主題】'), JSON.stringify({ want, got: (prompts[1] ?? '').split('\n').filter(l => l.startsWith('◆')) }));
      expect(`${p.name}:兩輪都有發言,且記在主持人的對話裡`, said.length >= 2 && [1, 2].every(r => notes.some(n => n.includes(`第 ${r} 輪|${p.name}】`))), JSON.stringify(said.map(t => t.slice(0, 60))));
      const errs = h.filter(e => e.type === 'error').map(e => e.message.slice(0, 100));
      expect(`${p.name}:沒有錯誤`, errs.length === 0, JSON.stringify(errs));
    }
    expect('主持人的結論提到每位參與者', parts.every(p => reply.includes(p.name)) && reply.length > 40, reply);
    expect('過程沒有授權請求(自動模式)', !hh.some(e => e.type === 'approval_request'));
    expect('主持人沒有錯誤', hh.filter(e => e.type === 'error').length === 0, JSON.stringify(hh.filter(e => e.type === 'error').map(e => e.message.slice(0, 100))));
    log('會議紀錄(節錄)', JSON.stringify(notes.filter(n => n.startsWith('【會議')).map(n => n.replace(/\s+/g, ' ').slice(0, 110))));
    log('主持人的結論', reply.replace(/\s+/g, ' ').slice(0, 600));
    log(bad ? `有 ${bad} 項不符` : '全部通過');
    for (const n of nodes) await window.nexus.removeAgent(n.id);
  } catch (err) {
    log('失敗', err.message);
    try { const s = await snap(); for (const a of s.agents) { const h = await window.nexus.getHistory(a.id); log(a.name, a.state, a.detail, JSON.stringify(h.filter(e => ['error', 'tool', 'message', 'note'].includes(e.type)).slice(-6).map(e => `${e.type}:${String(e.name ?? e.message ?? e.text).replace(/\s+/g, ' ').slice(0, 90)}`))); } } catch { /* 略過 */ }
  }
  document.title = 'QUIT';
})();
