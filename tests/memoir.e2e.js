// 驗收:回憶錄(記憶設計第六輪,假資料模式,由 tests/memoir.sh 啟動;需要 NEXUS_FAKE=1、NEXUS_FAKE_MEMOIR=1、NEXUS_ARCHIVE_TIMEOUT_MS)。
// 檢查:對話視窗的「寫回憶錄」按鈕(不看累積字數)→ 主控台送出回憶錄請求(來源 draft 的任務)→ 假節點提交:缺章節、起日晚於迄日被拒收,
// 合格的一份寫進 memoirs/ 且未確認、身分是提交者本人,同一個請求第二次提交被擋;刪除節點時選好總結方式後再問一次要不要寫回憶錄。
// 回憶錄檔案的內容由外層腳本在結束後檢查。
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
  const create = async name => {
    const a = await window.nexus.createAgent({ name, character: '', model: '', backend: 'claude', cwd: window.__TEST_CWD__, permissionMode: 'auto' });
    await until(`${name} 待命`, async () => (await stateOf(a.id)) === 'idle');
    return a;
  };
  const tasksOf = async id => (await snap()).tasks.filter(t => t.agentId === id).sort((a, b) => a.startedAt - b.startedAt);
  const notes = async id => (await window.nexus.getHistory(id)).filter(e => e.type === 'note' && e.text.startsWith('[memoir]')).map(e => e.text);
  const entries = async () => (await window.nexus.getMemoryVault()).entries;
  const gone = async id => !(await snap()).agents.some(a => a.id === id);
  const click = el => { el.click(); return wait(250); };
  const btn = (root, text) => [...document.querySelectorAll(`${root} button`)].find(b => b.textContent.includes(text));
  const open = async name => {
    window.__nexusSelect(name);
    await until(`${name} 的對話視窗開啟`, () => document.querySelector('.dlg-id b')?.textContent === name, 8000);
  };
  const errText = e => String(e.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  try {
    await window.nexus.setAutopilot(false);
    const a = await create('獵戶');
    log('ID 獵戶', a.id);

    // ---- 對話視窗:剛建立、沒有對話也有「寫回憶錄」;「儲存這段記憶」要累積夠了才出現
    await open('獵戶');
    const mb = await until('寫回憶錄按鈕', () => btn('.dlg-draft', '寫回憶錄'), 8000).catch(() => null);
    ok(Boolean(mb), '對話視窗有「寫回憶錄」按鈕(不看累積字數)');
    ok(!btn('.dlg-draft', '儲存這段記憶'), '沒有累積對話時沒有「儲存這段記憶」按鈕');
    if (mb) {
      document.title = 'SHOT:memoir-button';
      await wait(600);
      await click(mb);
      const msg = await until('按下後的說明', () => [...document.querySelectorAll('.dlg-draft .muted')].map(e => e.textContent).find(t => t.includes('回憶錄')), 8000).catch(() => '');
      ok(/已請「獵戶」寫一章回憶錄/.test(msg), '按下後顯示已請節點寫回憶錄', msg);
      await until('回憶錄請求任務結束', async () => { const l = (await tasksOf(a.id)).filter(t => t.source === 'draft'); return l.length === 1 && l[0].endedAt !== null; });
      await until('獵戶回到待命', async () => (await stateOf(a.id)) === 'idle');
      const tl = await tasksOf(a.id);
      ok(tl.length === 1 && tl[0].source === 'draft', '請求排給這個節點本人(來源 draft 的任務一筆,不算判例候選)', JSON.stringify(tl.map(t => [t.source, t.title.slice(0, 30)])));
      ok(tl[0] && tl[0].title.startsWith('(主控台:回憶錄請求。'), '送出的是回憶錄請求(和一般記憶草稿請求不同)', tl[0]?.title);
      const n = await notes(a.id);
      ok(n[0]?.startsWith('[memoir] ERROR') && n[0].includes('缺少固定章節') && n[0].includes('不確定之處'), '缺「## 不確定之處」被拒收,錯誤訊息請節點補上', n[0]);
      ok(n[1]?.startsWith('[memoir] ERROR') && n[1].includes('起日晚於迄日'), '起日晚於迄日被拒收', n[1]);
      ok(n[2]?.startsWith('[memoir] OK') && n[2].includes('未確認') && n[2].includes('memoirs/獵戶-'), '補上後合格的那份寫入,狀態未確認', n[2]);
      ok(n[3]?.startsWith('[memoir] ERROR') && n[3].includes('沒有請你寫回憶錄'), '同一個請求第二次提交被擋', n[3]);
      const me = (await entries()).filter(e => e.kind === 'memoir');
      ok(me.length === 1 && me[0].path.startsWith(`memoirs/獵戶-${a.id.slice(0, 8)}/`) && me[0].status === '未確認' && me[0].nodeId === a.id && me[0].scope === '全域' && me[0].title === '測試回憶錄',
        '回憶錄進了索引:種類回憶錄、全域、未確認、節點ID 是提交者本人', JSON.stringify(me));
    }
    // 子代理與終端機模式不提供(API 也擋);沒有請求時節點不能自己交
    try { await window.nexus.requestMemoir('no-such-node'); ok(false, '找不到的節點不能寫回憶錄'); } catch (e) { ok(/找不到/.test(errText(e)), '找不到的節點不能寫回憶錄', errText(e)); }

    // ---- 刪除節點:選好總結方式後,再問一次要不要寫回憶錄
    const v = await create('織女');
    await open('織女');
    await click(document.querySelector('.dialog button.danger'));
    await click(btn('.dlg-remove', '直接刪除(只存統計)'));
    ok(btn('.dlg-remove', '寫回憶錄再刪除') && btn('.dlg-remove', '不用寫回憶錄') && /回憶錄/.test(document.querySelector('.dlg-remove')?.textContent ?? ''), '選好總結方式後,再問一次要不要寫回憶錄', document.querySelector('.dlg-remove')?.textContent);
    ok(!(await gone(v.id)), '還沒回答前節點還在');
    await click(btn('.dlg-remove', '寫回憶錄再刪除'));
    await until('織女已刪除', () => gone(v.id), 40000);
    const ve = await until('織女的回憶錄出現在索引', async () => (await entries()).find(e => e.kind === 'memoir' && e.path.startsWith('memoirs/織女-')), 15000).catch(() => null);
    ok(ve && ve.status === '未確認' && ve.nodeId === v.id, '刪除前寫的回憶錄進了索引,未確認', JSON.stringify(ve));
    ok((await snap()).tasks.some(t => t.agentId === v.id && t.source === 'draft' && t.title.includes('即將刪除')), '刪除前的回憶錄請求是「最後一章」的提示', '');
    const arch = await until('織女的封存', async () => (await entries()).find(e => e.path.startsWith('nodes/封存/織女-')), 15000).catch(() => null);
    ok(Boolean(arch), '寫完回憶錄後照常歸檔統計', '');

    // ---- 已有回憶錄請求在佇列(使用者先按過按鈕、節點還在忙)時刪除:選「工作總結 + 回憶錄」,等那一份寫完再寫總結,不重發也不丟掉
    const h = await create('北河');
    await window.nexus.send(h.id, '〔測試執行:2500〕先忙一陣子');
    await until('北河忙碌', async () => ['working', 'planning'].includes(await stateOf(h.id)), 8000);
    const pre = await window.nexus.requestMemoir(h.id);
    ok(/已請「北河」/.test(pre), '節點忙碌時按「寫回憶錄」,請求排進佇列', pre);
    ok((await snap()).agents.find(x => x.id === h.id)?.queued.some(q => q.text.startsWith('(主控台:回憶錄請求。')), '回憶錄提示在佇列裡');
    try { await window.nexus.requestMemoir(h.id); ok(false, '請求還在進行時不能重複請求'); } catch (e) { ok(/已經請這個節點寫回憶錄/.test(errText(e)), '請求還在進行時不能重複請求', errText(e)); }
    await open('北河');
    await click(document.querySelector('.dialog button.danger'));
    await click(btn('.dlg-remove', '先請它寫工作總結再刪除'));
    await click(btn('.dlg-remove', '寫回憶錄再刪除'));
    ok(btn('.dlg-draft', '寫回憶錄')?.disabled === true, '刪除等待期間「寫回憶錄」停用');
    await until('北河已刪除', () => gone(h.id), 60000);
    const hm = (await snap()).tasks.filter(t => t.agentId === h.id && t.title.startsWith('(主控台:回憶錄請求。'));
    ok(hm.length === 1 && !hm[0].title.includes('即將刪除'), '沒有重發:只有使用者先按的那一份回憶錄請求', JSON.stringify(hm.map(t => t.title.slice(0, 60))));
    const he = await until('北河的回憶錄出現在索引', async () => (await entries()).find(e => e.kind === 'memoir' && e.path.startsWith('memoirs/北河-')), 15000).catch(() => null);
    ok(he && he.status === '未確認' && he.nodeId === h.id, '等到的那份回憶錄寫進記憶庫', JSON.stringify(he));
    ok((await snap()).tasks.some(t => t.agentId === h.id && t.source === 'archive'), '回憶錄寫完後接著請節點自己寫工作總結');
    const ha = await until('北河的封存', async () => (await entries()).find(e => e.path.startsWith('nodes/封存/北河-')), 15000).catch(() => null);
    ok(Boolean(ha), '北河封存進記憶庫(總結來源由外層腳本檢查)', '');

    const l = await create('天琴');
    await open('天琴');
    await click(document.querySelector('.dialog button.danger'));
    await click(btn('.dlg-remove', '直接刪除(只存統計)'));
    await click(btn('.dlg-remove', '不用寫回憶錄'));
    await until('天琴已刪除', () => gone(l.id), 30000);
    ok(!(await snap()).tasks.some(t => t.agentId === l.id && t.source === 'draft'), '選「不用寫回憶錄」就不送回憶錄請求');
  } catch (e) {
    bad++;
    log('不符 腳本中斷', e && e.stack ? e.stack : String(e));
  }
  log(bad ? `有 ${bad} 項不符` : '全部通過');
  log('主控台端結束');
  document.title = 'QUIT';
})();
