// 驗收:轉移工作區(假資料模式,由 tests/workspace-move.sh 啟動)。window.__TEST_IMAGE__ 是「舊資料夾,同一個資料夾的另一條路徑(junction),另一個資料夾」。
// 重點是 2026-11-24 發現的問題:資料夾改名後留 junction,轉移到新名稱時被當成「目的地相同」擋下。
// - Claude Code:換成 junction 的路徑(同一個資料夾)要成功,登記的工作目錄更新、同一個 session;換到一模一樣的路徑要拒絕。
// - Antigravity:同一個資料夾的另一條路徑可以;真正的別的資料夾要拒絕;新的獨立工作區要拒絕。
// - Codex:換到真正別的資料夾可以。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const until = async (what, fn, timeout = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await wait(200); } throw new Error(`等不到:${what}`); };
  let bad = 0;
  const expect = (label, ok, detail = '') => { if (!ok) bad++; log(`${ok ? '通過' : '不符'}:${label}${detail ? ` → ${String(detail).slice(0, 300)}` : ''}`); };
  const clean = e => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const snapOf = async id => (await window.nexus.getSnapshot()).agents.find(x => x.id === id);
  const idle = id => async () => (await snapOf(id))?.state === 'idle';
  const tryMove = async (id, target) => { try { return { ok: true, r: await window.nexus.moveWorkspace(id, target) }; } catch (e) { return { ok: false, err: clean(e) }; } };
  try {
    await window.nexus.setAutopilot(false);
    const [oldDir, alias, other] = String(window.__TEST_IMAGE__).split('|');
    const mk = async (name, backend) => { const a = await window.nexus.createAgent({ name, character: '', model: '', backend, cwd: oldDir, permissionMode: 'ask' }); await until(`${name} 待命`, idle(a.id)); return a; };

    const c = await mk('轉移-claude', 'claude');
    const sid = (await snapOf(c.id)).sessionId;
    const same = await tryMove(c.id, { kind: 'folder', path: oldDir });
    expect('一模一樣的路徑要拒絕', !same.ok && /相同/.test(same.err), same.err);
    const viaJunction = await tryMove(c.id, { kind: 'folder', path: alias });
    expect('改名後的 junction 路徑(同一個資料夾)可以轉移', viaJunction.ok, viaJunction.err);
    await until('轉移後待命', idle(c.id));
    const sc = await snapOf(c.id);
    expect('登記的工作目錄更新成新路徑', sc.cwd.toLowerCase() === alias.toLowerCase(), sc.cwd);
    expect('同一個 session', sc.sessionId === sid, `${sid} → ${sc.sessionId}`);
    expect('說明寫明是同一個資料夾', /同一個資料夾/.test(viaJunction.r?.note ?? ''), viaJunction.r?.note);
    // 反方向(使用者的情況:節點登記的是舊名稱的 junction,換成資料夾的新名稱)
    const back = await tryMove(c.id, { kind: 'folder', path: oldDir });
    expect('從 junction 路徑換回實際資料夾的路徑也可以', back.ok, back.err);
    await until('換回後待命', idle(c.id));
    expect('登記的工作目錄換回實際路徑', (await snapOf(c.id)).cwd.toLowerCase() === oldDir.toLowerCase());

    const g = await mk('轉移-agy', 'antigravity');
    const gOther = await tryMove(g.id, { kind: 'folder', path: other });
    expect('Antigravity 換到真正別的資料夾要拒絕', !gOther.ok && /Antigravity/.test(gOther.err), gOther.err);
    const gWt = await tryMove(g.id, { kind: 'worktree', repo: oldDir });
    expect('Antigravity 換到新的獨立工作區要拒絕', !gWt.ok && /Antigravity/.test(gWt.err), gWt.err);
    expect('被拒絕時工作目錄沒變', (await snapOf(g.id)).cwd.toLowerCase() === oldDir.toLowerCase());
    const gAlias = await tryMove(g.id, { kind: 'folder', path: alias });
    expect('Antigravity 換成同一個資料夾的另一條路徑可以', gAlias.ok, gAlias.err);
    await until('Antigravity 轉移後待命', idle(g.id));
    expect('Antigravity 登記的工作目錄更新', (await snapOf(g.id)).cwd.toLowerCase() === alias.toLowerCase());

    const x = await mk('轉移-codex', 'codex');
    const xOther = await tryMove(x.id, { kind: 'folder', path: other });
    expect('Codex 換到別的資料夾可以', xOther.ok, xOther.err);
    await until('Codex 轉移後待命', idle(x.id));
    expect('Codex 登記的工作目錄更新', (await snapOf(x.id)).cwd.toLowerCase() === other.toLowerCase());

    log(bad ? `有 ${bad} 項不符` : '全部通過');
  } catch (err) {
    log('失敗', err.message);
  }
  document.title = 'QUIT';
})();
