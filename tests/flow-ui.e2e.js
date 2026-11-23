// 協作流程 M4(介面)的驗收(假資料模式,主控台這一側;外層是 tests/flow-ui.sh)。
// 每個情境在 NEXUS_TEST_CWD 底下有自己的 git 版本庫(flow-ui.sh 建好),假資料節點照主題裡的〔測試流程:…〕腳本行動。
// 第一段:在畫面上用「套用流程」對話框啟動 ui 情境,一路看步驟條與卡片;第二段:其他情境用 API 啟動、同時進行,
// 畫面操作(打開流程詳情、按按鈕)一次只做一個(withDom 排隊);第三段:protected 單獨跑(寫入共用的 flows/)。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const ok = (cond, what, extra = '') => log(cond ? '通過' : '不符', what + (cond || !extra ? '' : ` → ${String(extra).slice(0, 300)}`));
  const N = window.nexus;
  const base = window.__TEST_CWD__;
  const repo = name => `${base}\\${name}`;
  const until = async (fn, ms = 60000, step = 200) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = await fn(); if (v) return v; } catch { /* 再試 */ } await wait(step); } return null; };
  const view = async id => (await N.flowList()).find(r => r.id === id);
  const waitRun = (id, pred, ms = 60000) => until(async () => { const r = await view(id); return r && pred(r) ? r : null; }, ms);
  const attempts = (r, step) => r.steps.find(s => s.id === step)?.attempts ?? [];
  const mk = (name, cwd, backend = 'claude') => N.createAgent({ name, character: '', model: '', backend, cwd, permissionMode: 'auto' });
  const brief = r => r ? `${r.status}/${r.phase ?? ''} 步驟=${r.stepId} 退回=${r.rejections} pending=${r.pending?.kind ?? ''} reason=${r.reason ?? ''}` : '(沒有流程)';

  // ---- DOM 小工具
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const el = (sel, ms = 15000) => until(() => $(sel), ms, 100);
  const text = node => (node?.textContent ?? '').replace(/\s+/g, ' ');
  /** React 受控欄位:用原生 setter 設值再送事件,React 才收得到。 */
  const setVal = (node, v) => {
    const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, v);
    node.dispatchEvent(new Event(node instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  };
  const click = async (sel, root = document) => { const n = typeof sel === 'string' ? await until(() => $(sel, root), 15000, 100) : sel; if (!n) throw new Error(`找不到 ${sel}`); n.click(); await wait(80); return n; };
  const shot = async name => { document.title = `SHOT:${name}`; await wait(700); document.title = 'Entropy Nexus'; await wait(100); };
  let lock = Promise.resolve();
  /** 畫面操作排隊:一次只打開一個流程詳情。 */
  const withDom = fn => { const p = lock.then(fn); lock = p.catch(() => {}); return p; };
  const closePanels = async () => { const x = $('.flow-panel .flow-head button.ghost'); if (x) { x.click(); await wait(100); } };
  /** 打開流程詳情:用測試掛勾(任務面板只列最近結束的 4 個,並行情境多時要點的卡可能被收起來)。 */
  const open = async id => {
    await closePanels();
    window.__nexusFlowOpen(id);
    const d = await el(`.flow-detail[data-flow="${id}"]`);
    if (!d) throw new Error(`流程詳情沒有打開 ${id}`);
    return d;
  };
  /** 按下要再確認一次的按鈕:先確認第一次按沒有送出,再按「確定」。 */
  const confirmClick = async (btn, root, before) => {
    btn.click();
    await wait(300);
    const yes = $('.flow-confirm-yes', root);
    ok(!!yes && (before ? await before() : true), `${btn.textContent.trim()}:要再按一次確認(第一次按不送出)`);
    if (yes) await click(yes);
  };
  const press = key => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  const lampAt = (id, step) => $(`.flow-detail[data-flow="${id}"] .flow-step[data-step="${step}"] .flow-lamp`)?.dataset.lamp ?? '';

  try {
    await N.setAutopilot(false);
    await N.setMaxActive(40);

    // =========== 第一段:套用流程對話框與 ui 情境 ===========
    const implUi = await mk('Impl-ui', repo('ui'), 'claude');
    const revUi = await mk('Rev-ui', repo('ui'), 'codex');
    const other = await mk('Other-outside', repo('other'), 'antigravity');
    await wait(800);
    const pc = await N.flowProjectConfig(repo('ui'));
    await N.flowSetProjectConfig({ projectId: pc.projectId, roles: { implementer: 'Impl-ui', reviewer: 'Rev-ui' }, allowDesktopVerify: false });

    ok(!!$('.flow-apply-btn'), '桌面畫面的任務面板有「套用流程」按鈕');
    await click('.flow-apply-btn');
    const dlg = await el('.flow-apply');
    ok(!!dlg, '按「套用流程」打開對話框');
    await until(() => $('.flow-tpl option[value="e2e-flow"]'), 10000);
    setVal($('.flow-tpl'), 'e2e-flow');
    await wait(150);
    ok(text($('.flow-tpl-sum')).includes('node check.js') && text($('.flow-tpl-sum')).includes('實作') && text($('.flow-tpl-sum')).includes('本地 commit'), '選範本後顯示步驟、核實指令與授權範圍', text($('.flow-tpl-sum')));
    const long = 'x'.repeat(140);
    const topic = `介面驗收 ui 很長的字串 ${long}〔測試流程:implement#1=wait:2500,write:src/a.txt:v1,write:notes.txt:outside,write:extra.txt:x,scope:notes.txt:記錄這次的決策,report;review#1=wait:2500,ok〕`;
    setVal($('.flow-topic-input'), topic);
    ok(!!$(`.flow-project option[value="${CSS.escape(repo('ui'))}"]`), '專案清單列出節點的工作目錄');
    setVal($('.flow-project'), repo('ui'));
    const pre = await until(() => $('.flow-role[data-role="implementer"]')?.value === implUi.id && $('.flow-role[data-role="reviewer"]')?.value === revUi.id, 10000);
    ok(!!pre, '角色依專案設定預填(節點名稱對照)', `${$('.flow-role[data-role="implementer"]')?.value} / ${$('.flow-role[data-role="reviewer"]')?.value}`);
    const desk = $('.flow-desktop');
    ok(desk && !desk.checked && !desk.disabled, '允許桌面核實預設不勾');
    await shot('flow-ui-apply');
    // 錯誤:寫入角色選了別的專案的節點
    setVal($('.flow-role[data-role="implementer"]'), other.id);
    await click('.flow-start');
    const err = await until(() => text($('.flow-start-error')), 15000);
    ok(!!err && err.includes('不在這個專案裡') && !!$('.flow-apply'), '啟動不成時對話框留著、錯誤訊息清楚', err);
    setVal($('.flow-role[data-role="implementer"]'), implUi.id);
    desk.click();
    await wait(100);
    ok($('.flow-desktop').checked, '可以勾選允許桌面核實');
    await click('.flow-start');
    const det = await el('.flow-detail', 20000);
    ok(!!det && !$('.flow-apply'), '開始後對話框關閉、打開流程詳情');
    const uiId = det?.dataset.flow;
    log('RUN', 'ui', uiId);
    const cfg = await N.flowProjectConfig(repo('ui'));
    ok(cfg.config?.allowDesktopVerify === true && cfg.config.roles.implementer === 'Impl-ui', '允許桌面核實寫回專案設定(角色對照保留)', JSON.stringify(cfg.config));
    ok(!!$(`.flow-card[data-flow="${uiId}"]`) && $$(`.flow-card[data-flow="${uiId}"] .flow-mini .flow-lamp`).length === 3, '任務面板出現流程卡,每一步一顆燈號');

    // 燈號隨進度變化
    const live = await until(async () => { const r = await view(uiId); return r?.status === 'running' && r.activeMs > 1500 ? r : null; }, 10000, 100);
    const shownMs = Number($('.flow-detail .flow-elapsed')?.dataset.ms ?? NaN);
    ok(!!live && Math.abs(shownMs - live.activeMs) < 2000, '已用時間和主行程一致(沒有重複計算 updatedAt 之後的時間)', `畫面 ${shownMs} / 主行程 ${live?.activeMs}`);
    const seen = { implement: [], review: [] };
    const push = (k, v) => { if (v && seen[k].at(-1) !== v) seen[k].push(v); };
    const done = await until(async () => {
      push('implement', lampAt(uiId, 'implement'));
      push('review', lampAt(uiId, 'review'));
      const r = await view(uiId);
      return r?.status === 'completed' ? r : null;
    }, 60000, 120);
    await wait(300);
    push('implement', lampAt(uiId, 'implement'));
    push('review', lampAt(uiId, 'review'));
    ok(!!done, 'ui 情境走完', brief(await view(uiId)));
    ok(seen.implement[0] === 'active' && seen.implement.includes('passed') && seen.review.includes('active') && seen.review.at(-1) === 'awaiting_approval',
      '步驟條燈號隨進度變化(實作 進行→通過;審查 進行→待授權)', JSON.stringify(seen));
    ok(text($(`.flow-card[data-flow="${uiId}"] .flow-attn`)).includes('授權卡待決'), '流程卡提示授權卡待決');
    const body = $('.flow-detail .flow-body');
    ok(body && body.scrollWidth <= body.clientWidth + 1 && $('.tasks-list').scrollWidth <= $('.tasks-list').clientWidth + 1, '很長的主題不撐出水平捲動', `${body?.scrollWidth}/${body?.clientWidth}`);
    ok($$('.flow-detail .flow-legend .flow-lamp').length === 7 && $$('.flow-detail .flow-step').every(b => b.tagName === 'BUTTON'), '圖例 7 種燈號;步驟是按鈕(鍵盤可操作)');

    // step_report 卡片與核實結果
    await click('.flow-detail .flow-step[data-step="implement"]');
    const att = await el('.flow-detail .flow-attempt[open]');
    const at = text(att);
    ok(text($('.flow-summary', att)).startsWith('假資料實作') && at.includes('node check.js') && at.includes('假資料節點沒有真的驗證') && at.includes('記錄這次的決策'),
      'step_report 卡片:summary、commands_run、not_verified、scope_exceptions', at.slice(0, 300));
    ok(!!$('.flow-verify .flow-outcome.o-pass', att) && text($('.flow-cmds', att)).includes('check'), '核實結果:各指令狀態', text($('.flow-verify', att)));
    att.scrollIntoView();
    await shot('flow-ui-report');
    ok($$('.flow-files li.unexplained', att).some(li => text(li).includes('extra.txt')) && /延續原 session|新 session/.test(at), '範圍外檔案標示未說明的;顯示延續 / 新 session', at.slice(0, 300));
    await click('.flow-detail .flow-step[data-step="review"]');
    const ratt = await el('.flow-detail .flow-attempt[open]');
    ok(text($('.flow-verdict', ratt)).includes('可合併'), '審查的 step_report 顯示結論(verdict)', text(ratt).slice(0, 200));
    ok(!!$('.flow-violations li[data-kind="out_of_scope"]'), '違規列表列出範圍外檔案');

    // 授權卡:勾選範圍外檔案後允許
    const card = $('.flow-approval.finish');
    ok(!!card && text($('.flow-card-tree', card)).includes(done.version.slice(0, 8)) && text($('.flow-cover .no', card)).includes('push'), '授權卡顯示版本(tree 前 8 碼)與不涵蓋的事', text(card).slice(0, 300));
    const notesRow = $('.flow-check[data-path="notes.txt"]', card), extraRow = $('.flow-check[data-path="extra.txt"]', card);
    ok(notesRow && text(notesRow).includes('記錄這次的決策') && !notesRow.classList.contains('is-warn') && extraRow && extraRow.classList.contains('is-warn') && text(extraRow).includes('未說明'),
      '範圍外檔案:顯示節點寫的原因,沒寫原因的特別標示', text(card).slice(0, 300));
    await shot('flow-ui-detail');
    $('.flow-out', notesRow).click();
    await wait(100);
    setVal($('.flow-commit-msg', card), '介面測試提交');
    ok(text($('.flow-approve', card)).includes('含範圍外 1 個'), '允許按鈕寫明含幾個範圍外檔案');
    await click($('.flow-approve', card));
    const ap = await waitRun(uiId, r => r.approvals[0]?.status === 'approved', 20000);
    ok(!!ap && JSON.stringify(ap.approvals[0].included) === '["notes.txt"]', '允許時只把勾選的範圍外檔案傳給 flowApprove', JSON.stringify((await view(uiId)).approvals[0]));
    ok(!!(await until(() => text($('.flow-approval .flow-card-result')).includes('已提交'), 10000)), '授權卡顯示提交結果');
    await closePanels();
    const opener = $(`.flow-card[data-flow="${uiId}"] .flow-card-open`);
    opener.focus();
    opener.click();
    await el('.flow-detail');
    ok(document.activeElement === $('.flow-detail'), '打開詳情時焦點移進面板');
    press('Escape');
    await wait(200);
    ok(!$('.flow-detail') && document.activeElement === opener, 'Esc 關閉詳情後焦點還給流程卡');
    ok(getComputedStyle($('.tasks-title')).flexWrap === 'wrap' && $('.flow-cards')?.getAttribute('role') === 'region', '任務標題列可以換行;流程區有 role');

    // =========== 第二段:其他情境同時進行 ===========
    const start = async (name, script, tpl = 'e2e-flow') => {
      const impl = await mk(`Impl-${name}`, repo(name), 'claude');
      const rev = await mk(`Rev-${name}`, repo(name), 'codex');
      await wait(800);
      const r = await N.flowStart({ templateId: tpl, topic: `情境 ${name}〔測試流程:${script}〕`, cwd: repo(name), roles: { implementer: impl.id, reviewer: rev.id } });
      log('RUN', name, r.id);
      return { id: r.id, impl, rev, name };
    };
    const scenarios = [];
    const scenario = (name, fn) => scenarios.push((async () => {
      try { await fn(); } catch (e) { log('失敗', `${name}:`, e.stack ?? e.message); }
    })());

    scenario('gate', async () => {
      const s = await start('gate', 'implement#1=write:src/a.txt:v1,report', 'e2e-gate');
      ok(!!(await waitRun(s.id, r => r.pending?.kind === 'step_approval', 30000)), 'gate:交辦前跳卡', brief(await view(s.id)));
      await withDom(async () => {
        const d = await open(s.id);
        const c = $('.flow-approval.gate', d);
        ok(!!c && !$('.flow-out', c) && !!$('.flow-approve', c) && !!$('.flow-deny', c) && $$('button', c).length === 2 && text(c).includes('不涵蓋'), 'gate:交辦前的卡只有允許 / 拒絕(沒有檔案勾選)', text(c).slice(0, 200));
        ok(lampAt(s.id, 'implement') === 'awaiting_approval' && !!$('[data-kind="step_approval"]', d), 'gate:步驟燈號待授權、待決卡指向授權卡', lampAt(s.id, 'implement'));
        await confirmClick($('.flow-deny', c), c, async () => (await view(s.id)).status === 'awaiting_user');
        ok(!!(await waitRun(s.id, r => r.status === 'halted', 20000)), 'gate:拒絕後停機', brief(await view(s.id)));
        const h = await until(() => $(`.flow-detail[data-flow="${s.id}"] .flow-halt-card`), 10000);
        ok(!!h && text(h).includes('拒絕') && text($('.flow-run-status')).includes('已停機') && !$(`.flow-detail[data-flow="${s.id}"] .flow-stop`), 'gate:顯示停機卡與原因,不再有停止鈕', text(h));
        await closePanels();
      });
    });

    scenario('ruling', async () => {
      const s = await start('ruling', 'implement#1=write:src/a.txt:v1,report;review#1=ruling:要不要改檔名');
      ok(!!(await waitRun(s.id, r => r.pending?.kind === 'needs_ruling', 40000)), 'ruling:需裁示交給使用者', brief(await view(s.id)));
      await withDom(async () => {
        const d = await open(s.id);
        const c = $('[data-kind="needs_ruling"]', d);
        ok(!!c && text(c).includes('要不要改檔名') && text($('[data-choice="continue"]', c)).includes('填入裁示') && text($('[data-choice="halt"]', c)).includes('手動接手') && text($('[data-choice="stop"]', c)).includes('中止'),
          'ruling:停機卡提供「填入裁示並繼續 / 手動接手 / 中止」', text(c));
        ok(lampAt(s.id, 'review') === 'awaiting_user', 'ruling:審查步驟燈號需裁示', lampAt(s.id, 'review'));
        setVal($('.flow-ruling', c), '照原名');
        await click($('[data-choice="continue"]', c));
        ok(!!(await waitRun(s.id, r => r.status === 'completed', 30000)), 'ruling:填入裁示後走完', brief(await view(s.id)));
        await closePanels();
      });
    });

    scenario('unreported', async () => {
      const s = await start('unreported', 'implement#1=write:src/a.txt:v1,none;implement#1~r=none;review#1=ok');
      ok(!!(await waitRun(s.id, r => r.pending?.kind === 'unreported', 30000)), 'unreported:未回報交給使用者', brief(await view(s.id)));
      await withDom(async () => {
        const d = await open(s.id);
        await click('[data-choice="manual_report"]', d);
        const form = await el('.flow-manual');
        ok(!!form && !$('.flow-m-verdict', form) && !!$('.flow-m-summary', form), 'unreported:手動補報表單(寫入步驟沒有審查欄位)');
        ok($('.flow-m-submit', form).disabled, 'unreported:沒填摘要不能送出');
        setVal($('.flow-m-summary', form), '使用者手動補報:畫面測試');
        setVal($('.flow-m-commands', form), 'node check.js => 通過');
        press('Escape');
        await wait(200);
        ok(!!$(`.flow-detail[data-flow="${s.id}"] .flow-manual`), 'unreported:補報表單有內容時 Esc 不關閉詳情');
        setVal($('.flow-m-scope', form), 'notes.txt');
        await click($('.flow-m-submit', form));
        await wait(500);
        ok(text($('.flow-error', form)).includes('路徑 => 原因') && (await view(s.id)).pending?.kind === 'unreported', 'unreported:範圍外說明沒寫原因時在畫面擋下、顯示錯誤,流程不動', text($('.flow-error', form)));
        setVal($('.flow-m-scope', form), 'notes.txt => 測試用');
        await click($('.flow-m-submit', form));
        const r = await waitRun(s.id, x => x.status === 'completed', 40000);
        ok(!!r && attempts(r, 'implement')[0].report?.manual === true && attempts(r, 'implement')[0].report.commandsRun[0]?.result === '通過', 'unreported:手動補報送出後走完', brief(r ?? await view(s.id)));
        await click(`.flow-detail[data-flow="${s.id}"] .flow-step[data-step="implement"]`);
        const a = await el('.flow-detail .flow-attempt[open]');
        ok(text(a).includes('手動補報'), 'unreported:紀錄標示手動補報', text(a).slice(0, 200));
        await closePanels();
      });
    });

    scenario('stuck', async () => {
      const s = await start('stuck', 'implement#1=write:src/a.txt:v1,stubborn,wait:15000,report');
      ok(!!(await waitRun(s.id, r => attempts(r, 'implement')[0]?.status === 'running', 20000)), 'stuck:實作開始');
      await withDom(async () => {
        await closePanels();
        const cardSel = `.flow-card[data-flow="${s.id}"]`;
        await click(`${cardSel} .flow-stop`);
        ok(!!$(`${cardSel} .flow-stop-yes`), 'stuck:停止要再確認一次');
        await click(`${cardSel} .flow-stop-yes`);
      });
      ok(!!(await waitRun(s.id, r => r.pending?.kind === 'not_ended', 20000)), 'stuck:停不下來交給使用者', brief(await view(s.id)));
      await withDom(async () => {
        const d = await open(s.id);
        await click('[data-choice="force_ended"]', d);
        const f = await el('.flow-force');
        ok(!!f && text(f).includes('節點可能仍在寫檔') && text(f).includes('後果由你負責') && $('.flow-force-yes', f).disabled, 'stuck:強制視為結束有警語,勾選了解前不能按', text(f));
        $('.flow-force-sure', f).click();
        await wait(100);
        await click($('.flow-force-yes', f));
        ok(!!(await waitRun(s.id, r => r.status === 'stopped', 15000)), 'stuck:強制視為結束後停止', brief(await view(s.id)));
        ok(!!(await until(() => text($(`.flow-detail[data-flow="${s.id}"] .flow-end-card`)).includes('流程已停止'), 10000)), 'stuck:顯示流程已停止');
        await closePanels();
      });
    });

    scenario('blocked', async () => {
      const s = await start('blocked', 'implement#1=write:src/a.txt:v1,report;review#1=ok');
      ok(!!(await waitRun(s.id, r => r.pending?.kind === 'verify_blocked', 40000)), 'blocked:核實被環境擋住', brief(await view(s.id)));
      await withDom(async () => {
        const d = await open(s.id);
        ok(lampAt(s.id, 'implement') === 'blocked' && text($('.flow-step[data-step="implement"] .flow-lamp', d)).includes('環境擋住'), 'blocked:燈號「⊘ 環境擋住」', lampAt(s.id, 'implement'));
        ok(!!$('.flow-attempt[open] .flow-verify .flow-outcome.o-blocked', d), 'blocked:核實結果顯示環境擋住');
        await click('[data-choice="rerun"]', d);
        ok(!!(await waitRun(s.id, r => r.status === 'completed', 40000)), 'blocked:重跑核實後走完', brief(await view(s.id)));
        await closePanels();
      });
    });

    scenario('timeout', async () => {
      const s = await start('timeout', 'implement#1=write:src/a.txt:v1,report;review#1=ok', 'e2e-timeout');
      ok(!!(await waitRun(s.id, r => r.pending?.kind === 'verify_timeout', 40000)), 'timeout:核實逾時', brief(await view(s.id)));
      await withDom(async () => {
        const d = await open(s.id);
        ok(lampAt(s.id, 'implement') === 'timeout' && text($('.flow-step[data-step="implement"] .flow-lamp', d)).includes('逾時'), 'timeout:燈號「⧗ 逾時」', lampAt(s.id, 'implement'));
        ok(text($('.flow-attempt[open] .flow-verify', d)).includes('卡在'), 'timeout:核實結果寫明卡在哪條指令', text($('.flow-attempt[open] .flow-verify', d)));
        await confirmClick($('[data-choice="stop"]', d), d, async () => (await view(s.id)).status === 'awaiting_user');
        ok(!!(await waitRun(s.id, r => r.status === 'stopped', 20000)), 'timeout:中止流程', brief(await view(s.id)));
        await closePanels();
      });
    });

    scenario('reject2', async () => {
      const s = await start('reject2', 'implement#1=write:src/a.txt:v1,report;review=fix:還是不行;fix#1=write:src/a.txt:v2,report;fix#2=write:src/a.txt:v3,report');
      ok(!!(await waitRun(s.id, r => r.status === 'halted', 60000)), 'reject2:退回兩輪停機', brief(await view(s.id)));
      await withDom(async () => {
        const d = await open(s.id);
        const h = $('.flow-halt-card', d);
        ok(!!h && text(h).includes('還是不行') && text(h).includes('上限'), 'reject2:停機卡列出原因與待處理的必修', text(h));
        await shot('flow-ui-halt');
        ok(lampAt(s.id, 'implement') === 'passed' && ['rejected', 'halted'].includes(lampAt(s.id, 'review')) && text($('.flow-rejections', d)).includes('2 / 2'), 'reject2:燈號(實作通過、審查退回或停機)與輪數', `${lampAt(s.id, 'implement')} ${lampAt(s.id, 'review')} ${lampAt(s.id, 'fix')}`);
        ok(!$('button', h), 'reject2:停機後沒有重開的按鈕(後端不支援)');
        await closePanels();
      });
    });

    scenario('reassign', async () => {
      const s = await start('reassign', 'implement#1=write:src/a.txt:v1,report;review#1=wait:4000,fix:補測試;fix#1=write:src/a.txt:v2,report;review#2=ok');
      ok(!!(await waitRun(s.id, r => attempts(r, 'review')[0]?.status === 'running', 30000)), 'reassign:審查開始');
      const spare = await mk('Spare-reassign', repo('reassign'), 'codex');
      await N.removeAgent(s.impl.id);
      ok(!!(await waitRun(s.id, r => r.pending?.kind === 'need_agent', 30000)), 'reassign:原節點不在 → 請使用者指定', brief(await view(s.id)));
      await withDom(async () => {
        const d = await open(s.id);
        await click('[data-choice="reassign"]', d);
        const sel = await el('.flow-reassign-agent');
        ok(!!sel && !!$(`option[value="${spare.id}"]`, sel) && $('.flow-reassign-yes').disabled, 'reassign:改派時選節點(沒選不能按)');
        setVal(sel, other.id);
        await click('.flow-reassign-yes');
        const e1 = await until(() => text($(`.flow-detail[data-flow="${s.id}"] [data-kind="need_agent"] .flow-error`)), 10000);
        ok(!!e1 && e1.includes('不在這個專案裡') && (await view(s.id)).pending?.kind === 'need_agent', 'reassign:改派給別的專案的節點 → 顯示錯誤,仍在等你指定', e1);
        setVal(sel, spare.id);
        await click('.flow-reassign-yes');
        const r = await waitRun(s.id, x => x.status === 'completed', 40000);
        ok(!!r && attempts(r, 'fix')[0]?.agentId === spare.id, 'reassign:改派後走完', brief(r ?? await view(s.id)));
        await click(`.flow-detail[data-flow="${s.id}"] .flow-step[data-step="fix"]`);
        const a = await el('.flow-detail .flow-attempt[open]');
        ok(!!$('.flow-cont.c-new', a) && text(a).includes('Spare-reassign'), 'reassign:紀錄標示新 session 與接手的節點', text(a).slice(0, 200));
        await closePanels();
      });
    });

    scenario('pause', async () => {
      const s = await start('pause', 'implement#1=wait:5000,write:src/a.txt:v1,report;review#1=ok');
      ok(!!(await waitRun(s.id, r => attempts(r, 'implement')[0]?.status === 'running', 20000)), 'pause:實作開始');
      await withDom(async () => {
        await closePanels();
        const sel = `.flow-card[data-flow="${s.id}"]`;
        await click(`${sel} .flow-pause`);
        ok(!!(await waitRun(s.id, r => r.status === 'paused', 10000)), 'pause:按暫停後暫停', brief(await view(s.id)));
        ok(!!(await until(() => text($(`${sel} .flow-status`)).includes('已暫停') && $(`${sel} .flow-resume`), 5000)), 'pause:流程卡顯示已暫停與繼續鈕');
        await click(`${sel} .flow-resume`);
      });
      ok(!!(await waitRun(s.id, r => r.status === 'completed', 40000)), 'pause:按繼續後走完', brief(await view(s.id)));
    });

    scenario('expire', async () => {
      const s = await start('expire', 'implement#1=write:src/a.txt:v1,report;review#1=ok');
      const r = await waitRun(s.id, x => x.status === 'completed', 40000);
      ok(!!r && r.approvals[0]?.status === 'pending', 'expire:走完、授權卡待決', brief(r ?? await view(s.id)));
      const w = await mk('Writer-expire', repo('expire'), 'antigravity');
      await wait(600);
      await N.send(w.id, '〔測試寫檔:src/a.txt=changed-after-review〕');
      await wait(2500);
      await withDom(async () => {
        const d = await open(s.id);
        const c = $('.flow-approval.finish', d);
        await click($('.flow-approve', c));
        const x = await waitRun(s.id, y => y.approvals[0]?.status === 'expired', 15000);
        ok(!!x, 'expire:正本改變後按允許 → 授權卡失效(不提交)', JSON.stringify((await view(s.id)).approvals[0]));
        const c2 = await until(() => { const n = $(`.flow-detail[data-flow="${s.id}"] .flow-approval.st-expired`); return n && text(n).includes('失效原因') ? n : null; }, 10000);
        ok(!!c2 && !$('.flow-approve', c2) && !$('.flow-deny', c2) && !$('.flow-out:not(:disabled)', c2), 'expire:失效的卡顯示原因,沒有允許 / 拒絕鈕', text(c2));
        await closePanels();
      });
    });

    scenario('viol', async () => {
      const s = await start('viol', 'implement#1=ask:git push origin main,write:src/a.txt:v1,write:dist/app.js:x,report;review#1=ok');
      ok(!!(await waitRun(s.id, r => r.status === 'halted', 40000)), 'viol:打包產出改動 → 停機', brief(await view(s.id)));
      await withDom(async () => {
        const d = await open(s.id);
        const f = $('.flow-violations li[data-kind="forbidden_action"]', d), a = $('.flow-violations li[data-kind="artifact_changed"]', d);
        ok(!!f && text(f).includes('已擋下') && text(f).includes('push 到遠端') && text(f).includes('git push origin main'), 'viol:禁止動作(已擋下、動作、證據)', text(f));
        ok(!!a && text(a).includes('打包產出') && text(a).includes('未擋下') && text(a).includes('dist'), 'viol:打包產出改動(未擋下、證據)', text(a));
        await closePanels();
      });
    });

    await Promise.all(scenarios);

    // =========== 第三段:寫入受保護的流程定義資料夾(單獨跑) ===========
    try {
      const s = await start('protected', 'implement#1=writedata:flows/evil.yaml:id- evil,write:src/a.txt:v1,report;review#1=ok');
      ok(!!(await waitRun(s.id, r => r.status === 'halted', 40000)), 'protected:寫入 flows/ → 停機', brief(await view(s.id)));
      await withDom(async () => {
        const d = await open(s.id);
        const p = $('.flow-violations li[data-kind="protected_write"]', d);
        ok(!!p && text(p).includes('受保護') && text(p).includes('flows/evil.yaml'), 'protected:違規列表顯示寫入受保護的資料夾', text(p));
        await closePanels();
      });
    } catch (e) { log('失敗', 'protected:', e.stack ?? e.message); }

    // 低動態:樣式表裡有 prefers-reduced-motion 的規則關掉流程燈號的動畫
    const reduced = [...document.styleSheets].some(sh => { try { return [...sh.cssRules].some(r => r.media && /prefers-reduced-motion/.test(r.media.mediaText) && /flow-lamp/.test(r.cssText)); } catch { return false; } });
    ok(reduced, '低動態時關掉流程的動畫(prefers-reduced-motion)');
    log('主控台端結束');
  } catch (e) {
    log('失敗', e.stack ?? e.message);
  }
  await wait(600);
  document.title = 'QUIT';
})();
