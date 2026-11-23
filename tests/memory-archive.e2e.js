// 驗收:長期記憶階段 4(假資料模式,由 tests/memory-archive.sh 啟動;需要 NEXUS_FAKE=1、NEXUS_ARCHIVE_TIMEOUT_MS)。
// 檢查:終止節點的確認畫面(三個選項、取消不會刪)、刪除時歸檔(節點自己寫總結、節點休眠改由總管代寫、只存統計、沒有總管時沒有總結)、
// 歸檔用的提示不算一般任務(來源標記)、封存索引、新增同名節點時找得到封存並接回。
// 封存檔與側寫的內容由外層腳本在結束後用 grep 檢查。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  let bad = 0;
  const ok = (cond, what, extra = '') => { if (!cond) bad++; log(cond ? '通過' : '不符', what, cond || !extra ? '' : `→ ${String(extra).slice(0, 600)}`); };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const snap = () => window.nexus.getSnapshot();
  const until = async (what, fn, timeout = 40000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await wait(200); }
    throw new Error(`等不到:${what}`);
  };
  const stateOf = async id => (await snap()).agents.find(a => a.id === id)?.state;
  const create = async (name, extra = {}) => {
    const a = await window.nexus.createAgent({ name, character: '', model: '', backend: 'claude', cwd: window.__TEST_CWD__, permissionMode: 'auto', ...extra });
    await until(`${name} 待命`, async () => (await stateOf(a.id)) === 'idle');
    return a;
  };
  const run = async (id, text) => {
    const before = (await snap()).tasks.filter(t => t.agentId === id).length;
    await window.nexus.send(id, text);
    await until('任務結束', async () => { const l = (await snap()).tasks.filter(t => t.agentId === id); return l.length > before && l.every(t => t.endedAt !== null); });
    await until('回到待命', async () => (await stateOf(id)) === 'idle');
  };
  const gone = async id => !(await snap()).agents.some(a => a.id === id);
  const archiveOf = async name => until(`${name} 的封存出現在索引`, async () => (await window.nexus.getMemoryVault()).entries.find(e => e.path.startsWith(`nodes/封存/${name}-`)), 15000);
  const click = el => { el.click(); return wait(250); };
  const btn = (root, text) => [...document.querySelectorAll(`${root} button`)].find(b => b.textContent.includes(text));

  try {
    await window.nexus.setAutopilot(false);
    const A = await create('AlphaA'), S = await create('SleepS'), D = await create('DirectD'), F = await create('FinalF');
    const C = await create('總管丙', { chief: true });
    for (const n of [A, S, D, F]) await run(n.id, '〔測試執行:200〕做一件事');

    // ---- 確認畫面:三個選項,取消不會刪除節點
    window.__nexusSelect('AlphaA');
    await until('對話視窗開啟', async () => document.querySelector('.dialog'));
    await click(document.querySelector('.dialog button.danger'));
    const panel = document.querySelector('.dlg-remove');
    ok(panel && btn('.dlg-remove', '先請它寫工作總結再刪除') && btn('.dlg-remove', '直接刪除(只存統計)') && btn('.dlg-remove', '取消'), '終止時出現確認:先寫總結再刪除、直接刪除(只存統計)、取消', panel?.textContent);
    await click(btn('.dlg-remove', '取消'));
    ok(!document.querySelector('.dlg-remove') && !(await gone(A.id)), '取消:確認消失、節點還在');

    // ---- 1. 節點自己寫總結(從畫面點「先請它寫工作總結再刪除」)
    await click(document.querySelector('.dialog button.danger'));
    await click(btn('.dlg-remove', '先請它寫工作總結再刪除'));
    // 第二個問題:要不要也寫回憶錄(回憶錄的流程在 tests/memoir.e2e.js 測,這裡選不用)
    ok(btn('.dlg-remove', '寫回憶錄再刪除') && btn('.dlg-remove', '不用寫回憶錄'), '選好總結方式後,再問一次要不要寫回憶錄', document.querySelector('.dlg-remove')?.textContent);
    await click(btn('.dlg-remove', '不用寫回憶錄'));
    await until('AlphaA 已刪除', () => gone(A.id), 30000);
    const ea = await archiveOf('AlphaA');
    ok(ea.status === '封存' && ea.kind === 'node', '節點自己寫總結:封存進索引,狀態是封存', JSON.stringify(ea));
    const tasks = (await snap()).tasks;
    ok(tasks.some(t => t.agentId === A.id && t.source === 'archive'), '歸檔提示的任務來源標記為 archive(不會觸發完成播報與判例候選)');

    // ---- 2. 節點休眠:改由總管代寫
    await window.nexus.sleep(S.id);
    await until('SleepS 休眠', async () => (await stateOf(S.id)) === 'sleeping');
    const r2 = await window.nexus.removeAgentArchived(S.id, 'summary');
    ok(/總管/.test(r2.note) && r2.archive && r2.archive.startsWith('nodes/封存/SleepS-'), '節點休眠:由總管代寫', JSON.stringify(r2));
    ok(await gone(S.id), '休眠節點照樣刪除');
    ok((await snap()).tasks.some(t => t.agentId === C.id && t.source === 'archive'), '總管收到的是歸檔來源的提示');

    // ---- 3. 直接刪除:只存統計
    const r3 = await window.nexus.removeAgentArchived(D.id, 'stats');
    ok(r3.archive && /沒有工作總結/.test(r3.note) && /只存統計/.test(r3.note), '直接刪除:只存統計,沒有工作總結', JSON.stringify(r3));
    ok(await gone(D.id), '直接刪除的節點已移除');

    // ---- 4. 沒有總管、節點又休眠:寫封存但沒有總結,並說明原因
    await window.nexus.removeAgent(C.id);
    await until('總管已移除', () => gone(C.id));
    await window.nexus.sleep(F.id);
    await until('FinalF 休眠', async () => (await stateOf(F.id)) === 'sleeping');
    const r4 = await window.nexus.removeAgentArchived(F.id, 'summary');
    ok(r4.archive && /沒有總管/.test(r4.note), '沒有總管:封存沒有工作總結,說明原因', JSON.stringify(r4));
    ok(await gone(F.id), '沒有總管時節點照樣刪除');

    // ---- 5. 新增同名節點:找得到封存並接回
    const hit = await window.nexus.findMemoryArchive(['AlphaA']);
    ok(hit && hit.path.startsWith('nodes/封存/AlphaA-') && /^\d{4}-\d{2}-\d{2}$/.test(hit.date), '找得到 AlphaA 的封存', JSON.stringify(hit));
    ok((await window.nexus.findMemoryArchive(['沒有這個人', ''])) === null, '名稱對不上就沒有封存');
    ok((await window.nexus.findMemoryArchive(['', 'SleepS'])) !== null, '也可以用第二個名稱(角色)比對');
    const A2 = await create('AlphaA');
    const attached = await window.nexus.attachMemoryArchive(A2.id, hit.path);
    ok(attached === 'nodes/AlphaA.md', '接回:寫進新節點的側寫', String(attached));
    try { await window.nexus.attachMemoryArchive(A2.id, '../evil.md'); ok(false, '不正確的封存路徑被拒絕'); } catch { ok(true, '不正確的封存路徑被拒絕'); }
  } catch (err) {
    bad++;
    log('不符', `執行中斷:${err.message}`);
  }
  log(bad ? `有 ${bad} 項不符` : '通過 全部完成');
  await wait(600);
  log('主控台端結束');
  document.title = 'QUIT';
})();
