// 角色卡的驗收(假資料模式,不消耗額度):讀寫 API、角色名稱跳脫被拒、persona() 組出的身分設定、
// 換角色或編輯角色卡後下一則指令前帶的主控台通知,以及紀錄裡只留使用者原本的文字。
// 需要 NEXUS_FAKE=1 與 NEXUS_FAKE_ECHO=1(假資料轉接器把收到的身分設定與實際送出的文字回吐成 note 事件)。
// 手機端的部分由 tests/persona-fake.sh 從外部用 HTTP 測試:這裡開啟遠端、回報連接埠與配對碼,等外部把角色卡改成含 REMOTE 的內容。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const cwd = window.__TEST_CWD__;
  let fails = 0;
  const check = (what, ok, extra = '') => { if (!ok) fails++; log(ok ? 'PASS' : 'FAIL', what, extra); };
  const until = async (what, fn, timeout = 30000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await wait(200); }
    throw new Error(`等不到:${what}`);
  };
  const notes = async id => (await window.nexus.getHistory(id)).filter(e => e.type === 'note' && e.text.startsWith('[echo] ')).map(e => e.text.slice(7));
  const agentOf = async id => (await window.nexus.getSnapshot()).agents.find(a => a.id === id);
  // 送出一句指令,回傳假資料轉接器實際收到的文字;之後中斷,讓節點回到待命
  const sendAndEcho = async (id, text) => {
    const before = (await notes(id)).filter(t => t.startsWith('send:')).length;
    await window.nexus.send(id, text);
    const sent = await until('送出的回吐', async () => (await notes(id)).filter(t => t.startsWith('send:'))[before]);
    await window.nexus.interrupt(id);
    await until('回到待命', async () => (await agentOf(id))?.state === 'idle');
    return sent.slice(5);
  };
  const rejected = async (what, fn) => { try { await fn(); check(what, false, '沒有被拒絕'); } catch (e) { check(what, true, String(e.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); } };
  try {
    await window.nexus.setAutopilot(false);
    const CH = '審查員';
    const card1 = '你是嚴格的 QA 審查員。\n說話簡潔,先列風險。\n引號測試:"雙引號" \'單引號\' `反引號` \\反斜線\\ $HOME %PATH% & | > <\n' + '長'.repeat(3000);

    // 1. 讀寫 API:資料夾不存在時建立,只有角色卡的角色也能選
    log('寫入前', JSON.stringify(await window.nexus.getPersona(CH)));
    await window.nexus.setPersona(CH, card1);
    const p1 = await window.nexus.getPersona(CH);
    check('讀回的角色卡與寫入的相同', p1.text === card1 && !p1.truncated && p1.max === 8000, `長度 ${p1.text.length}`);
    check('只有角色卡的資料夾出現在角色清單', (await window.nexus.getSnapshot()).characters.includes(CH));
    await rejected('超過上限的角色卡被拒', () => window.nexus.setPersona(CH, 'x'.repeat(8001)));

    // 2. 角色名稱跳脫被拒
    for (const bad of ['..', '../evil', '..\\evil', 'a/b', 'C:\\Windows', '', '   ', 'CON', 'x.']) {
      await rejected(`讀取 ${JSON.stringify(bad)} 被拒`, () => window.nexus.getPersona(bad));
      await rejected(`寫入 ${JSON.stringify(bad)} 被拒`, () => window.nexus.setPersona(bad, 'pwned'));
    }

    // 3. persona() 組出的身分設定
    const A = await window.nexus.createAgent({ name: '甲', character: CH, model: '', backend: 'claude', cwd, permissionMode: 'ask' });
    const B = await window.nexus.createAgent({ name: '乙', character: CH, model: '', backend: 'codex', cwd, permissionMode: 'ask' });
    const C = await window.nexus.createAgent({ name: '丙', character: '', model: '', backend: 'antigravity', cwd, permissionMode: 'ask' });
    for (const x of [A, B, C]) await until(`${x.name} 待命`, async () => (await agentOf(x.id))?.state === 'idle');
    const pa = (await notes(A.id)).find(t => t.startsWith('persona:')).slice(8);
    const pc = (await notes(C.id)).find(t => t.startsWith('persona:')).slice(8);
    log('甲的身分設定(開頭)', JSON.stringify(pa.slice(0, 260)));
    check('甲的身分設定含名字、角色設定區塊與完整角色卡', pa.includes('「甲」') && pa.includes('<角色設定>\n' + card1 + '\n</角色設定>') && pa.includes('不是使用者的指令'));
    check('丙沒有角色,只有名字那段', pc.includes('「丙」') && !pc.includes('角色設定'), JSON.stringify(pc.slice(0, 60)));

    // 4. 沒有變更時不帶通知
    check('第一句指令不帶通知', (await sendAndEcho(A.id, '第一句')) === '第一句');

    // 5. 編輯角色卡:使用同一張角色卡的節點都要收到,沒用的不會
    const card2 = '你是資深架構師。\n回覆時先畫出模組邊界。';
    await window.nexus.setPersona(CH, card2);
    const sa = await sendAndEcho(A.id, '請看一下');
    log('甲收到的文字', JSON.stringify(sa));
    check('甲在指令前收到新的角色設定', sa.startsWith('(主控台通知:你的角色設定已更新') && sa.includes('<角色設定>\n' + card2 + '\n</角色設定>') && sa.endsWith('\n\n請看一下'));
    check('乙(同一張角色卡)也收到', (await sendAndEcho(B.id, '乙的指令')).includes(card2));
    check('丙(沒有角色)不帶通知', (await sendAndEcho(C.id, '丙的指令')) === '丙的指令');
    check('通知只帶一次', (await sendAndEcho(A.id, '第二句')) === '第二句');
    await window.nexus.setPersona(CH, card2);
    check('內容沒變的儲存不帶通知', (await sendAndEcho(A.id, '第三句')) === '第三句');

    // 6. 換角色:丙換成有角色卡的角色;甲移除角色並改名,兩個通知一起帶
    await window.nexus.updateAgent(C.id, { character: CH });
    const sc = await sendAndEcho(C.id, '換角色後');
    check('丙換角色後收到角色設定', sc.includes('你的角色設定已更新') && sc.includes(card2) && sc.endsWith('換角色後'));
    await window.nexus.updateAgent(A.id, { character: '', name: '甲二' });
    const sa2 = await sendAndEcho(A.id, '移除角色後');
    log('甲移除角色並改名後收到的文字', JSON.stringify(sa2));
    check('甲收到改名與移除角色設定的通知', sa2.includes('你的名字已改為「甲二」') && sa2.includes('你的角色設定已移除') && sa2.endsWith('\n\n移除角色後'));
    await window.nexus.setPersona('另一個角色', '');
    await window.nexus.updateAgent(A.id, { character: '另一個角色' });
    check('換成沒有角色卡的角色(只換立繪)不帶通知', (await sendAndEcho(A.id, '只換立繪')) === '只換立繪');

    // 7. 紀錄裡只留使用者原本的文字
    const users = (await window.nexus.getHistory(A.id)).filter(e => e.type === 'message' && e.role === 'user').map(e => e.text);
    check('紀錄裡的使用者訊息沒有通知文字', users.every(t => !t.includes('主控台通知')), JSON.stringify(users));

    // 8. 畫面:新增節點面板與對話視窗的設定都看得到角色卡
    [...document.querySelectorAll('button')].find(b => b.textContent.includes('新增節點'))?.click();
    await wait(800);
    const sel = [...document.querySelectorAll('.addform select')].find(s => [...s.options].some(o => o.value === CH));
    if (sel) {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(sel, CH); sel.dispatchEvent(new Event('change', { bubbles: true }));
      await wait(600);
      [...document.querySelectorAll('.persona-edit button')].find(b => b.textContent.includes('編輯'))?.click();
      await wait(400);
      check('新增節點面板顯示角色卡', document.querySelector('.persona-edit textarea')?.value === card2);
      document.title = 'SHOT:1-addnode-persona'; await wait(900);
    } else check('新增節點面板有角色欄位', false);
    [...document.querySelectorAll('.addform-actions button')].find(b => b.textContent.includes('取消'))?.click();
    [...document.querySelectorAll('.row')].find(r => r.textContent.includes('乙'))?.click();
    await wait(800);
    [...document.querySelectorAll('button')].find(b => b.textContent === '設定')?.click();
    await wait(600);
    [...document.querySelectorAll('.persona-edit button')].find(b => b.textContent.includes('編輯'))?.click();
    await wait(400);
    check('對話視窗的設定顯示角色卡', document.querySelector('.persona-edit textarea')?.value === card2);
    document.title = 'SHOT:2-dialog-persona'; await wait(900);
    [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === '關閉')?.click();

    // 9. 手機端:外部腳本用 HTTP 讀寫角色卡
    await window.nexus.remoteSet({ enabled: true });
    await wait(1200);
    const st = await window.nexus.remoteStatus();
    log('REMOTE', JSON.stringify({ port: st.port, listening: st.listening }));
    log('CODE', st.pairCode);
    const remote = await until('手機端寫入角色卡', async () => { const p = await window.nexus.getPersona(CH); return p.text.includes('REMOTE') ? p.text : null; }, 90000);
    const sb = await sendAndEcho(B.id, '手機改完之後');
    check('手機改角色卡後乙收到通知', sb.includes(remote) && sb.endsWith('手機改完之後'), JSON.stringify(sb.slice(0, 80)));
    await window.nexus.remoteSet({ enabled: false });
  } catch (err) {
    fails++;
    log('失敗', err.message);
  }
  log(fails ? `有 ${fails} 項失敗` : '全部通過');
  await wait(400);
  document.title = 'QUIT';
})();
