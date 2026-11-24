// 工作區轉移的真實驗證(W4,真正的 CLI,會用到一點額度)。由 tests/workspace-move-real.sh 啟動。
// window.__TEST_IMAGE__ 是「模式,後台,模型,暗號,目的資料夾」。
// move:在資料夾 A 建立節點、記住暗號 → 轉移到資料夾 B → 問暗號並在工作目錄建立 moved.txt(由 sh 檢查檔案落在 B)。
// rebuild:在 git 版本庫建立獨立工作區節點、記住暗號 → 終止(乾淨的工作區會被移除)→ 開啟舊 session:先被要求確認重建 →
//          同意後在原位置重建並接回 → 問暗號(Claude、Codex 另外建立 rebuilt.txt,由 sh 檢查檔案落在重建的工作區)。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const until = async (what, fn, timeout = 180000) => { const t0 = Date.now(); while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await wait(500); } throw new Error(`等不到:${what}`); };
  let bad = 0;
  const expect = (label, ok, detail = '') => { if (!ok) bad++; log(`${ok ? '通過' : '不符'}:${label}${detail ? ` → ${String(detail).slice(0, 400)}` : ''}`); };
  const snapOf = async id => (await window.nexus.getSnapshot()).agents.find(x => x.id === id);
  const idle = id => async () => (await snapOf(id))?.state === 'idle';
  const settled = id => async () => ['idle', 'error', 'lost'].includes((await snapOf(id))?.state);
  const lastReply = async id => (await window.nexus.getHistory(id)).filter(e => e.type === 'message' && e.role === 'agent').map(e => e.text).pop() ?? '';
  const turn = async (id, text) => { await window.nexus.send(id, text); await wait(3000); await until('回合結束', settled(id), 300000); return lastReply(id); };
  const clean = e => String(e?.message ?? e);
  try {
    const [mode, backend, model = '', code, dest = ''] = String(window.__TEST_IMAGE__).split(',');
    const cwd = window.__TEST_CWD__;
    const name = `轉移測試-${backend}`;
    if (mode === 'move') {
      const a = await window.nexus.createAgent({ name, character: '', model, backend, cwd, permissionMode: 'auto' });
      await until('節點待命', idle(a.id), 120000);
      const r1 = await turn(a.id, `這是一個測試。請記住這個暗號:${code}。不需要使用任何工具,只要回覆「記住了」。`);
      expect('第一回合正常結束', (await snapOf(a.id)).state === 'idle', r1);
      const before = (await snapOf(a.id)).sessionId;
      const mv = await window.nexus.moveWorkspace(a.id, { kind: 'folder', path: dest });
      expect('轉移成功,工作目錄換成目的資料夾', mv.agent.cwd.toLowerCase() === dest.toLowerCase(), mv.note);
      await until('轉移後待命', idle(a.id), 120000);
      const r2 = await turn(a.id, '剛才請你記住的暗號是什麼?請在你目前的工作目錄建立一個檔案 moved.txt,內容只寫暗號;完成後回覆暗號,以及你目前的工作目錄完整路徑。');
      const s = await snapOf(a.id);
      expect('同一個 session 續接', s.sessionId === before, `${before} → ${s.sessionId}`);
      expect('記得原本對話裡的暗號', r2.includes(code), `${s.state} ${r2}`);
      const hist = await window.nexus.getHistory(a.id);
      // 工作目錄通知只加在送給 CLI 的文字前面(歷史紀錄存原本的指令),改看節點回報的工作目錄
      // 模型不一定會照做回報路徑(實際寫檔位置由 sh 檢查 moved.txt),只記錄
      log('節點回報', r2.slice(0, 200));
      const errs = hist.filter(e => e.type === 'error').map(e => String(e.message).slice(0, 160));
      expect('沒有錯誤', errs.length === 0, JSON.stringify(errs));
      const rm = await window.nexus.removeAgentArchived(a.id, 'stats', false);
      log('RESULT', JSON.stringify({ sessionId: s.sessionId, note: rm.note.slice(0, 200) }));
    } else {
      const a = await window.nexus.createAgent({ name, character: '', model, backend, cwd, permissionMode: 'auto', isolate: true });
      await until('節點待命', idle(a.id), 120000);
      const wt = (await snapOf(a.id)).worktree;
      expect('建立了獨立工作區', !!wt?.path, JSON.stringify(wt));
      const r1 = await turn(a.id, `這是一個測試。請記住這個暗號:${code}。不需要使用任何工具,只要回覆「記住了」。`);
      expect('第一回合正常結束', (await snapOf(a.id)).state === 'idle', r1);
      const sid = (await snapOf(a.id)).sessionId;
      const rm1 = await window.nexus.removeAgentArchived(a.id, 'stats', false);
      log('終止', rm1.note.slice(0, 200));
      const s0 = (await window.nexus.listOldSessions()).find(x => x.source === 'nexus' && x.name === name);
      expect('「開啟舊 session」列得出,工作目錄已不存在', !!s0 && s0.cwdExists === false, JSON.stringify(s0 && { cwdExists: s0.cwdExists }));
      const input = { backend: s0.backend, sessionId: s0.sessionId, cwd: s0.cwd, agentId: s0.agentId, name: s0.name, character: s0.character, model: s0.model };
      let asked = '';
      try { await window.nexus.openOldSession(input); } catch (e) { asked = clean(e); }
      expect('先要求確認重建工作區(沒有自動重建)', asked.includes('NEXUS_NEEDS_RELOCATE:') && asked.includes('"kind":"worktree"'), asked);
      const b = await window.nexus.openOldSession({ ...input, rebuildWorktree: true });
      await until('重建後待命', idle(b.id), 180000);
      const ask = backend === 'antigravity'
        ? '剛才請你記住的暗號是什麼?請只回覆暗號本身,不需要使用任何工具。'
        : '剛才請你記住的暗號是什麼?請在你目前的工作目錄建立一個檔案 rebuilt.txt,內容只寫暗號;完成後回覆暗號。';
      const r2 = await turn(b.id, ask);
      const s = await snapOf(b.id);
      expect('同一個 session 續接', s.sessionId === sid, `${sid} → ${s.sessionId}`);
      expect('記得原本對話裡的暗號', r2.includes(code), `${s.state} ${r2}`);
      expect('工作目錄回到原本的工作區路徑', s.cwd === wt.path || s.cwd.startsWith(wt.path), s.cwd);
      const errs = (await window.nexus.getHistory(b.id)).filter(e => e.type === 'error').map(e => String(e.message).slice(0, 160));
      expect('沒有錯誤', errs.length === 0, JSON.stringify(errs));
      const rm2 = await window.nexus.removeAgentArchived(b.id, 'stats', false);
      log('RESULT', JSON.stringify({ sessionId: s.sessionId, worktree: wt.path, note: rm2.note.slice(0, 200) }));
    }
    log(bad ? `有 ${bad} 項不符` : '全部通過');
  } catch (err) {
    log('失敗', err.message);
    try { const s = await window.nexus.getSnapshot(); for (const a of s.agents) { const h = await window.nexus.getHistory(a.id); log(a.name, a.state, a.detail, JSON.stringify(h.filter(e => ['error', 'message', 'note'].includes(e.type)).slice(-6).map(e => `${e.type}:${String(e.message ?? e.text).slice(0, 160)}`))); } } catch { /* 略過 */ }
  }
  document.title = 'QUIT';
})();
