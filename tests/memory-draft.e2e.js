// 驗收:長期記憶階段 4.5 對話草稿(假資料模式,由 tests/memory-draft.sh 啟動;需要 NEXUS_FAKE=1、NEXUS_FAKE_ECHO=1、NEXUS_FAKE_DRAFT=1、NEXUS_DRAFT_THRESHOLD=300)。
// 檢查:累積字數不夠時不能儲存、對話視窗的「儲存這段記憶」按鈕只在累積夠了才出現、按下後請節點提交草稿(來源 draft 的任務)、
// 草稿寫進記憶庫且狀態是未確認、重複提交被擋、按鈕按下後消失、草稿請求不算判例候選。
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
  let n = 0;
  const input = async a => { document.title = `INPUT:${++n}|${JSON.stringify(a)}`; await wait(140); };
  const errText = e => String(e.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const tasksOf = async id => (await snap()).tasks.filter(t => t.agentId === id).sort((a, b) => a.startedAt - b.startedAt);
  const idle = id => until('回到待命', async () => ['idle', 'error'].includes((await snap()).agents.find(a => a.id === id)?.state));
  const run = async (id, text) => {
    const before = (await tasksOf(id)).length;
    await window.nexus.send(id, text);
    await until('任務結束', async () => { const l = await tasksOf(id); return l.length > before && l[before].endedAt !== null; });
    await idle(id);
  };
  const notes = async id => (await window.nexus.getHistory(id)).filter(e => e.type === 'note').map(e => e.text);
  const draftTasks = async id => (await tasksOf(id)).filter(t => t.source === 'draft');
  const entries = async () => (await window.nexus.getMemoryVault()).entries;
  const filler = len => '這是一段用來湊字數的對話內容,討論部署流程與設定。'.repeat(Math.ceil(len / 20)).slice(0, len);
  const button = () => [...document.querySelectorAll('.dlg-draft button')].find(b => b.textContent === '儲存這段記憶');

  try {
    await window.nexus.setAutopilot(false);
    const a = await window.nexus.createAgent({ name: '甲號', character: '', model: '', backend: 'claude', cwd: window.__TEST_CWD__, permissionMode: 'auto' });
    await until('甲號待命', async () => (await snap()).agents.find(x => x.id === a.id)?.state === 'idle');

    const info0 = await window.nexus.draftInfo(a.id);
    ok(info0.lastSeq === 0 && info0.threshold === 300, '預設資訊:尚未儲存過、門檻是環境變數的 300', JSON.stringify(info0));
    try { await window.nexus.requestDraft(a.id); ok(false, '累積不夠不能儲存'); } catch (e) { ok(/累積到 300 字/.test(errText(e)), '累積不夠不能儲存', errText(e)); }

    // ---- 第一輪:專案知識(對話片段含〔測試知識〕),並測重複提交
    await run(a.id, `〔測試知識〕〔測試重複提交〕${filler(400)}`);
    const msg = await window.nexus.requestDraft(a.id);
    ok(/已請「甲號」整理/.test(msg), '按下儲存後回覆說明', msg);
    await until('草稿請求任務結束', async () => (await draftTasks(a.id))[0]?.endedAt !== null);
    await idle(a.id);
    const dt = await draftTasks(a.id);
    ok(dt.length === 1 && dt[0].agentId === a.id, '請求是排給這個節點本人的(來源 draft 的任務一筆)', JSON.stringify(dt.map(t => [t.agentId, t.source])));
    const n1 = await notes(a.id);
    ok(n1.some(t => t.startsWith('[draft] OK') && t.includes('未確認')), '節點提交成功,回覆說明狀態未確認', n1.join(' | '));
    ok(n1.some(t => t.startsWith('[draft] ERROR') && t.includes('沒有請你')), '同一個請求第二次提交被擋', n1.join(' | '));
    const kn = (await entries()).find(e => e.path.startsWith('knowledge/') && e.title === '測試草稿知識');
    ok(kn && kn.status === '未確認' && kn.subtype === '決策' && kn.kind === 'knowledge', '專案知識草稿進了索引:未確認、子類決策', JSON.stringify(kn));
    const info2 = await window.nexus.draftInfo(a.id);
    ok(info2.lastSeq > 0, '儲存位置往前推進', JSON.stringify(info2));
    try { await window.nexus.requestDraft(a.id); ok(false, '剛儲存完不能立刻再儲存'); } catch (e) { ok(/累積到 300 字/.test(errText(e)), '剛儲存完不能立刻再儲存', errText(e)); }
    ok((await tasksOf(a.id)).every(t => t.source !== 'case'), '草稿請求不會被當成判例候選');

    // ---- 對話視窗的按鈕:先在主面板點節點開啟對話視窗,累積不夠時沒有按鈕,累積夠了才出現
    await wait(900);
    const canvas = document.querySelector('.board canvas').getBoundingClientRect();
    const pos = window.__nexusBoard.positions().find(p => p.id === a.id);
    await input({ type: 'click', x: Math.round(canvas.left + pos.x), y: Math.round(canvas.top + pos.y) });
    await until('對話視窗開啟', () => document.querySelector('.dlg-id b')?.textContent === '甲號', 8000);
    ok(!button(), '儲存過之後累積不夠,對話視窗沒有按鈕');
    await run(a.id, filler(400));
    const shown = await until('按鈕出現', () => button(), 8000).catch(() => null);
    ok(Boolean(shown), '累積夠了,對話視窗出現「儲存這段記憶」按鈕');
    if (shown) {
      document.title = 'SHOT:draft-button';
      await wait(800);
      shown.click();
      ok(await until('按鈕消失', () => !button(), 8000).catch(() => false), '按下後按鈕消失');
      await until('第二份草稿任務結束', async () => { const l = await draftTasks(a.id); return l.length === 2 && l[1].endedAt !== null; });
      await idle(a.id);
      const pref = (await entries()).find(e => e.path.startsWith('preferences/') && e.title === '測試草稿偏好');
      ok(pref && pref.status === '未確認' && pref.kind === 'preference', '使用者偏好草稿進了索引:未確認', JSON.stringify(pref));
    }
  } catch (e) {
    bad++;
    log('不符 腳本中斷', e && e.stack ? e.stack : String(e));
  }
  log(bad ? `有 ${bad} 項不符` : '全部通過');
  log('主控台端結束');
  document.title = 'QUIT';
})();
