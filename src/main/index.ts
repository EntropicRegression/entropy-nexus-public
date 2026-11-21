import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, screen, session, shell } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BACKEND_LABEL, type ApprovalDecision, type Backend, type CreateAgentInput, type ForkAgentInput, type OpenOldSessionInput, type RemoteAccess, type ReviewComment, type SpeechSource, type TaskVerdict, type Update } from '../shared/types';
import { allowAttachments, attachmentPreview, initAttachments, savePastedImage } from './attachments';
import { Core } from './core';
import { avatarDataUrl, handlePortraitRequests, initPortraits, portraitsDir, registerPortraitScheme, saveVoice, voiceProfile, voiceWav } from './portraits';
import { FILE_SCHEME, handleFileRequests, initMedia } from './media';
import { Interop } from './interop';
import { initProcs, reapStale } from './procs';
import { resolveLocal, revealLocal } from './reveal';
import { windowSizes } from './window-size';
import { initRemote, remoteAudit, remoteNewCode, remotePairAccess, remotePush, remotePushFull, remoteRevoke, remoteSet, remoteSetDevice, remoteStatus, stopRemote } from './remote';
import { initObserver, observedList, observeInstall, observeNewToken, observerSawAgent, observeStatus, observeTakeover, observeUninstall, stopObserver } from './hooks-observer';
import { initWorktrees, inspectDir } from './worktree';
import { Store } from './store';
import { MemoryVault } from './memory-vault';
import { safeName, writeMemory } from './memory-write';
import { CaseService } from './cases';
import { DraftService } from './memory-draft';
import { CASE_DAILY_CAP, detectCandidate } from '../shared/case-candidates';
import { attachArchive, findArchive } from './memory-archive';
import { flushHeat } from './vault-sidecar';
import { initVoice, stopVoice, voiceCharacters, voiceSet, voiceStatus, voiceTranscribe, voiceTts, voiceTtsPower } from './voice';
import { atomicWriteJson, buildVaultStats, StatsWriter, STATS_FILE } from './vault-stats';
import { findWakeUrl, parseWakeUrl, WAKE_PROTOCOL } from './wake';
import { initSpeechEngines, speechClip, speechRender, speechSet, speechSettings } from './speech';

// 資料固定放在 %APPDATA%\entropy-nexus,開發模式與安裝版共用同一份;測試時可用 NEXUS_DATA_DIR 指到別處
app.setPath('userData', process.env.NEXUS_DATA_DIR || join(app.getPath('appData'), 'entropy-nexus'));

// 自我檢查時視窗常被其他視窗蓋住;關掉遮蔽偵測與背景節流,截圖才會是最新畫面
const testMode = Boolean(process.env.NEXUS_TEST_SCRIPT);
if (testMode) {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
}

registerPortraitScheme([FILE_SCHEME]);

const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
let win: BrowserWindow | null = null;
let core: Core | null = null;
let store: Store | null = null;
let vault: MemoryVault | null = null;
let cases: CaseService | null = null;
let drafts: DraftService | null = null;
let quitting = false;
let interopRef: Interop | null = null;
let statsWriter: StatsWriter | null = null;
/** 視窗與核心還沒準備好時收到的喚醒網址,準備好後再處理。 */
let pendingWake: string | null = null;

/**
 * 跨 app 喚醒(entropy-nexus://wake?node=<節點ID>):把視窗帶到前面,一定先跳確認,同意後走「開啟舊 session」接回原本的節點。
 * 節點已經在面板上就只提示;找不到或網址不正確也提示,不做任何事。
 */
async function handleWake(raw: string): Promise<void> {
  if (!core || !win) { pendingWake = raw; return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  const parsed = parseWakeUrl(raw);
  const notice = (message: string, type: 'info' | 'error' = 'info') => dialog.showMessageBox(win!, { type, title: '喚醒節點', message, buttons: ['確定'], noLink: true });
  if (!parsed.ok) { await notice(`無法處理這個喚醒網址:${parsed.reason}。`, 'error'); return; }
  const target = core.wakeTarget(parsed.node);
  if (!target) { await notice('找不到這個節點,或它已經沒有可以接回的對話。', 'error'); return; }
  if (target.kind === 'board') { await notice(`「${target.name}」已經在面板上了。`); return; }
  const r = await dialog.showMessageBox(win, { type: 'question', title: '喚醒節點', message: `要接回 ${target.name} 的舊對話嗎?`, detail: '會把這個已封存的節點放回面板,繼續原本的對話。', buttons: ['接回', '取消'], defaultId: 1, cancelId: 1, noLink: true });
  if (r.response !== 0) return;
  try { await core.openOldSession(target.input); }
  catch (e) { await notice(`接回失敗:${String((e as Error)?.message ?? e)}`, 'error'); }
}

/**
 * 註冊自訂網址。測試模式與指定了 NEXUS_DATA_DIR 的獨立資料夾不註冊;開發模式(未打包)預設也不註冊,
 * 否則會把系統的 entropy-nexus:// 指到 electron.exe 開發版,蓋掉安裝版的註冊。要在開發模式測試時設 NEXUS_REGISTER_PROTOCOL=1。
 */
function registerProtocol(): void {
  if (testMode || process.env.NEXUS_DATA_DIR) return;
  if (app.isPackaged) { app.setAsDefaultProtocolClient(WAKE_PROTOCOL); return; }
  if (process.env.NEXUS_REGISTER_PROTOCOL === '1' && process.argv[1]) app.setAsDefaultProtocolClient(WAKE_PROTOCOL, process.execPath, [resolve(process.argv[1])]);
}

function createWindow(): void {
  // 初始大小與最小尺寸不超過螢幕的可用範圍(1366×768 開 125% 縮放時只有約 1093×580),視窗才不會比螢幕大。
  // 測試模式不看螢幕:驗收腳本需要固定的 1440×900,大小由 SIZE: 自己調整。
  const size = windowSizes(testMode ? null : screen.getPrimaryDisplay().workAreaSize);
  win = new BrowserWindow({
    ...size,
    backgroundColor: '#060a12',
    autoHideMenuBar: true,
    title: 'Entropy Nexus',
    icon: app.isPackaged ? undefined : join(__dirname, '../../build/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: !testMode,
    },
  });
  // 不允許畫面開新視窗或離開本機頁面
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.on('closed', () => { win = null; });
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
}

/**
 * 畫面可以呼叫的函式,以頻道名稱為鍵。桌面畫面經 IPC 呼叫;瀏覽器版(手機遠端的完整介面)經 /api/rpc 呼叫同一份。
 * 需要原生視窗的功能(選檔案、選資料夾、開啟立繪資料夾)不在這裡,只註冊給桌面畫面。
 */
type Methods = Record<string, (...args: any[]) => unknown>;

/** source:這份方法表給誰用(桌面畫面或遠端),送出的指令記下來源,語音播報只念桌面發起的回合。 */
function apiMethods(c: Core, source: SpeechSource): Methods {
  return {
    snapshot: () => ({ ...c.snapshot(), observed: observedList() }),
    history: (id: string) => c.history(id),
    create: (input: CreateAgentInput) => c.createAgent(input),
    remove: (id: string) => c.removeAgent(id),
    // 長期記憶階段 4:刪除節點時歸檔、新增節點時接回封存;沒有列在 access.ts 的方法表,所以只有完整角色呼叫得到
    removeArchived: (id: string, mode: string) => c.removeWithArchive(String(id), mode === 'stats' ? 'stats' : 'summary'),
    findMemoryArchive: (names: string[]) => (Array.isArray(names) ? findArchive(vault?.list() ?? [], names.map(String)) : null),
    attachMemoryArchive: (agentId: string, archivePath: string) => {
      const a = c.snapshot().agents.find(x => x.id === agentId);
      if (!a || !vault) throw new Error('找不到這個節點');
      const r = attachArchive(vault.dir, String(archivePath), { id: a.id, name: a.name, backendLabel: BACKEND_LABEL[a.backend], model: a.model });
      vault.rescan();
      return r ? r.path : null;
    },
    send: (id: string, text: string, images?: string[]) => c.send(id, text, Array.isArray(images) ? images : [], 'user', source),
    updateAgent: (id: string, patch: { name?: string; character?: string; model?: string }) => c.updateAgent(id, patch),
    savePastedImage: (mime: string, data: ArrayBuffer) => savePastedImage(mime, data),
    attachmentPreview: (path: string) => attachmentPreview(path),
    openTerminal: (id: string, cols: number, rows: number) => c.openTerminal(id, cols, rows),
    closeTerminal: (id: string) => c.closeTerminal(id),
    termAttach: (id: string) => c.termAttach(id),
    termWrite: (id: string, data: string) => c.termWrite(id, data),
    termResize: (id: string, cols: number, rows: number) => c.termResize(id, cols, rows),
    approval: (id: string, requestId: string, decision: ApprovalDecision) => c.respondApproval(id, requestId, decision),
    interrupt: (id: string) => c.interrupt(id),
    enqueue: (id: string, text: string, images?: string[]) => c.enqueue(id, text, Array.isArray(images) ? images : [], source),
    cancelQueued: (id: string, queuedId: string) => c.cancelQueued(id, queuedId),
    editQueued: (id: string, queuedId: string, text: string) => c.editQueued(id, queuedId, text),
    resumeQueue: (id: string) => c.resumeQueue(id),
    answer: (id: string, requestId: string, answers: Record<string, string[]> | null) => c.answerQuestion(id, requestId, answers),
    sleep: (id: string) => c.sleep(id),
    wake: (id: string) => c.wake(id),
    autopilot: (on: boolean) => c.setAutopilot(on),
    maxActive: (n: number) => c.setMaxActive(n),
    clearTasks: () => c.clearFinishedTasks(),
    taskVerdict: (taskId: string, verdict: TaskVerdict) => c.setTaskVerdict(String(taskId), verdict ?? null),
    markCase: async (taskId: string) => { if (!cases) throw new Error('判例功能沒有啟用'); return cases.mark(String(taskId)); },
    draftInfo: async (id: string) => { if (!drafts) throw new Error('記憶功能沒有啟用'); return drafts.info(String(id)); },
    requestDraft: async (id: string) => { if (!drafts) throw new Error('記憶功能沒有啟用'); return drafts.request(String(id)); },
    memoryVault: () => ({ dir: vault?.dir ?? '', entries: vault?.list() ?? [] }),
    taskChanges: (taskId: string) => c.taskChanges(taskId),
    oldSessions: () => c.listOldSessions(),
    inspectDir: (cwd: string) => inspectDir(cwd),
    revertTask: (taskId: string, paths: string[] | null) => c.revertTask(taskId, paths),
    commitTask: (taskId: string, message: string) => c.commitTask(taskId, message),
    sendReviewComments: (taskId: string, comments: ReviewComment[]) => c.sendReviewComments(taskId, Array.isArray(comments) ? comments : [], source),
    requestReview: (taskId: string, reviewerId: string, note?: string) => c.requestReview(taskId, reviewerId, typeof note === 'string' ? note : '', source),
    worktreeStatus: (id: string) => c.worktreeStatus(id),
    mergeWorktree: (id: string) => c.mergeWorktree(id),
    openPr: (id: string) => c.openPullRequest(id),
    quotaStop: (n: number) => c.setQuotaStop(n),
    setDailyBudget: (backend: Backend, percent: number | null) => c.setDailyBudget(backend, percent),
    remoteStatus: () => remoteStatus(),
    remoteSet: (patch: { enabled?: boolean; lan?: boolean }) => remoteSet(patch),
    remoteNewCode: () => remoteNewCode(),
    remoteRevoke: (id: string) => remoteRevoke(id),
    remotePairAccess: (access: RemoteAccess) => remotePairAccess(access),
    remoteSetDevice: (id: string, access: RemoteAccess) => remoteSetDevice(String(id), access),
    remoteAudit: () => remoteAudit(),
    observeStatus: () => observeStatus(),
    observeInstall: () => observeInstall(),
    observeUninstall: () => observeUninstall(),
    observeNewToken: () => observeNewToken(),
    observeTakeover: (sessionId: string, name: string) => observeTakeover(String(sessionId), String(name ?? '')),
    openOldSession: (input: OpenOldSessionInput) => c.openOldSession(input),
    forkAgent: (input: ForkAgentInput) => c.forkAgent(input),
    getAvatar: (character: string) => avatarDataUrl(String(character ?? '')),
    getPersona: (character: string) => c.getPersona(String(character ?? '')),
    getAgyAllow: () => c.getAgyAllow(),
    setAgyAllow: (rules: unknown) => c.setAgyAllow(rules).rules,
    setPersona: (character: string, text: string) => c.setPersona(String(character ?? ''), String(text ?? '')),
    setChief: (id: string | null) => c.setChief(typeof id === 'string' && id ? id : null),
  };
}

function registerIpc(methods: Methods): void {
  for (const [name, fn] of Object.entries(methods)) ipcMain.handle(`nexus:${name}`, (_e, ...args) => fn(...args));
  // 回覆裡的路徑:在檔案總管中顯示。只給桌面畫面,瀏覽器版在另一台電腦上,不該打開這台的檔案總管
  ipcMain.handle('nexus:canReveal', (_e, agentId: string, text: string) => resolveLocal(core?.agentCwd(String(agentId)) ?? null, text) !== null);
  ipcMain.handle('nexus:revealPath', (_e, agentId: string, text: string) => revealLocal(core?.agentCwd(String(agentId)) ?? null, text));
  ipcMain.handle('nexus:pickFiles', async () => {
    if (!win) return [];
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
    if (!r.canceled) allowAttachments(r.filePaths);
    return r.canceled ? [] : r.filePaths;
  });
  // 拖放或貼上的檔案路徑由 preload 從 File 物件取得後登記,畫面本身不能指定任意路徑
  ipcMain.on('nexus:allowAttachment', (_e, path: string) => allowAttachments([path]));
  ipcMain.handle('nexus:openPortraits', async () => { await shell.openPath(portraitsDir()); });
  // 語音模式:只給桌面畫面(不放進方法表,遠端的完整介面與手機都呼叫不到)
  ipcMain.handle('nexus:voiceStatus', () => voiceStatus());
  ipcMain.handle('nexus:voiceSet', (_e, patch) => voiceSet(patch && typeof patch === 'object' ? patch : {}));
  ipcMain.handle('nexus:voiceTranscribe', (_e, wav: ArrayBuffer) => voiceTranscribe(wav));
  ipcMain.handle('nexus:voiceTts', (_e, target: string | { character: string }, text: string) => voiceTts(target, String(text ?? '')));
  ipcMain.handle('nexus:voiceCharacters', () => voiceCharacters());
  ipcMain.handle('nexus:voiceTtsPower', (_e, load: boolean) => voiceTtsPower(load === true));
  ipcMain.handle('nexus:speechRender', (_e, notice, text: string) => speechRender(notice, String(text ?? '')));
  ipcMain.handle('nexus:speechSettings', () => speechSettings());
  ipcMain.handle('nexus:speechSet', (_e, patch) => speechSet(patch && typeof patch === 'object' ? patch : {}));
  ipcMain.handle('nexus:speechClip', (_e, character: string, kind) => speechClip(String(character ?? ''), kind));
  // 角色的聲音:檔案都在主行程讀寫,畫面只送錄好的內容;選檔用主行程的對話框,畫面不能指定任意路徑
  ipcMain.handle('nexus:voiceProfile', (_e, character: string) => voiceProfile(String(character ?? '')));
  ipcMain.handle('nexus:voiceProfileSave', (_e, character: string, patch: { wav?: ArrayBuffer | null; promptText?: string; style?: string }) => {
    const p = patch && typeof patch === 'object' ? patch : {};
    saveVoice(String(character ?? ''), {
      ...(p.wav === null ? { wav: null } : p.wav instanceof ArrayBuffer ? { wav: Buffer.from(p.wav) } : {}),
      ...(typeof p.promptText === 'string' ? { promptText: p.promptText } : {}),
      ...(typeof p.style === 'string' ? { style: p.style } : {}),
    });
    return voiceProfile(String(character ?? ''));
  });
  ipcMain.handle('nexus:voiceProfileImport', async (_e, character: string) => {
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, { title: '選擇參考錄音', properties: ['openFile'], filters: [{ name: 'WAV 錄音', extensions: ['wav'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    saveVoice(String(character ?? ''), { wav: readFileSync(r.filePaths[0]) });
    return voiceProfile(String(character ?? ''));
  });
  ipcMain.handle('nexus:voiceProfileAudio', (_e, character: string) => { const b = voiceWav(String(character ?? '')); return b ? b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) : null; });
  ipcMain.handle('nexus:pickDirectory', async () => {
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0] ?? null;
  });
}

/**
 * 瀏覽器權限:Electron 預設全部放行,這裡改成只給需要的。
 * 麥克風只給主視窗,而且只能要音訊(語音模式的按住說話);攝影機與其他權限一律拒絕。
 * 複製到剪貼簿(程式碼區塊的複製按鈕)與全螢幕照常允許。
 */
function restrictPermissions(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    if (permission === 'media') {
      const types = (details as { mediaTypes?: string[] }).mediaTypes ?? [];
      cb(!!win && wc === win.webContents && types.length > 0 && types.every(t => t === 'audio'));
      return;
    }
    cb(permission === 'clipboard-sanitized-write' || permission === 'fullscreen');
  });
  ses.setPermissionCheckHandler((wc, permission, _origin, details) => {
    if (permission !== 'media') return true;
    return !!win && wc === win.webContents && (details as { mediaType?: string }).mediaType !== 'video';
  });
}

/** 視窗不在前景時,節點需要你處理就跳系統通知並閃爍工作列。 */
function notify(u: Update): void {
  const e = u.event;
  if (!e || !u.agent || !win || win.isFocused() || (testMode && process.env.NEXUS_TEST_NOTIFY !== '1')) return;
  let body = '';
  if (e.type === 'approval_request') body = `要求授權:${e.tool} · ${e.summary}`;
  else if (e.type === 'question') body = `有問題要問你:${e.questions[0]?.question ?? ''}`;
  else if (e.type === 'state' && (e.state === 'error' || e.state === 'lost')) body = `${e.state === 'error' ? '出錯' : '失聯'}${e.detail ? `:${e.detail}` : ''}`;
  if (!body) return;
  win.flashFrame(true);
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: `${u.agent.name} 需要你`, body, silent: true });
  n.on('click', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  if (testMode) n.on('show', () => console.log('[test] 系統通知已顯示:', body));
  n.show();
}

/** 自我檢查用:NEXUS_SHOT 指定路徑時,等一段時間後把視窗畫面存成 PNG 再結束。 */
function scheduleScreenshot(): void {
  // 腳本化自我檢查:NEXUS_TEST_SCRIPT 指向一個在畫面裡執行的腳本檔。
  // 腳本把 document.title 設成 "SHOT:名稱" 會截圖到 NEXUS_TEST_DIR,設成 "QUIT" 會結束程式。
  const testScript = process.env.NEXUS_TEST_SCRIPT;
  const testDir = process.env.NEXUS_TEST_DIR;
  if (testScript && testDir && win) {
    const w = win;
    w.webContents.on('console-message', (_e, _level, message) => { if (message.startsWith('[test]')) console.log(message); });
    w.on('page-title-updated', (e, title) => {
      e.preventDefault();
      if (title === 'QUIT') { app.quit(); return; }
      // INPUT:<json>:送出真正的滑鼠或鍵盤輸入事件(走瀏覽器的輸入管線,不是直接呼叫畫面上的函式)
      if (title.startsWith('INPUT:')) {
        try {
          const a = JSON.parse(title.slice(title.indexOf('|') + 1));
          const wc = w.webContents;
          if (a.type === 'move' || a.type === 'click') wc.sendInputEvent({ type: 'mouseMove', x: a.x, y: a.y });
          if (a.type === 'click') {
            wc.sendInputEvent({ type: 'mouseDown', x: a.x, y: a.y, button: 'left', clickCount: 1 });
            wc.sendInputEvent({ type: 'mouseUp', x: a.x, y: a.y, button: 'left', clickCount: 1 });
          }
          if (a.type === 'text') for (const ch of String(a.text)) wc.sendInputEvent({ type: 'char', keyCode: ch });
          if (a.type === 'key' && a.modifiers) { wc.sendInputEvent({ type: 'keyDown', keyCode: a.key, modifiers: a.modifiers }); wc.sendInputEvent({ type: 'keyUp', keyCode: a.key, modifiers: a.modifiers }); }
          else if (a.type === 'key') { wc.sendInputEvent({ type: 'keyDown', keyCode: a.key }); if (a.key === 'Enter') wc.sendInputEvent({ type: 'char', keyCode: String.fromCharCode(13) }); wc.sendInputEvent({ type: 'keyUp', keyCode: a.key }); }
        } catch (err) { console.error('[test] 輸入事件失敗', err); }
        return;
      }
      // FILES:<json 路徑陣列>:把真實檔案放進畫面上的 #test-files 檔案欄位(走 DevTools 協定),用來模擬拖放有路徑的檔案
      if (title.startsWith('FILES:')) {
        const dbg = w.webContents.debugger;
        void (async () => {
          if (!dbg.isAttached()) dbg.attach('1.3');
          const { root } = await dbg.sendCommand('DOM.getDocument', {});
          const { nodeId } = await dbg.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: '#test-files' });
          await dbg.sendCommand('DOM.setFileInputFiles', { nodeId, files: JSON.parse(title.slice(6)) });
          dbg.detach();
        })().catch(err => console.error('[test] 設定檔案失敗', err));
        return;
      }
      // SIZE:寬,高:調整視窗內容區的大小(測試小視窗的版面;會暫時放寬最小尺寸);ZOOM:倍率:模擬 Windows 的顯示縮放
      if (title.startsWith('SIZE:')) {
        const [cw, ch] = title.slice(5).split(',').map(Number);
        w.setMinimumSize(400, 300);
        w.setContentSize(cw, ch);
        return;
      }
      if (title.startsWith('ZOOM:')) { w.webContents.setZoomFactor(Number(title.slice(5)) || 1); return; }
      if (title.startsWith('SHOT:')) void w.webContents.capturePage().then(img => writeFileSync(join(testDir, `${title.slice(5)}.png`), img.toPNG()));
    });
    w.webContents.once('did-finish-load', () => {
      setTimeout(() => { void w.webContents.executeJavaScript(`window.__TEST_CWD__ = ${JSON.stringify(process.env.NEXUS_TEST_CWD ?? '')}; window.__TEST_IMAGE__ = ${JSON.stringify(process.env.NEXUS_TEST_IMAGE ?? '')};\n` + readFileSync(testScript, 'utf8'), true).catch(err => { console.error('[test] 腳本失敗', err); app.quit(); }); }, 1200);
    });
    return;
  }

  const out = process.env.NEXUS_SHOT;
  if (!out) return;
  const delay = Number(process.env.NEXUS_SHOT_DELAY ?? 8000);
  setTimeout(async () => {
    if (win) writeFileSync(out, (await win.webContents.capturePage()).toPNG());
    app.quit();
  }, delay);
}

if (!app.requestSingleInstanceLock() && !process.env.NEXUS_DATA_DIR) {
  app.quit();
} else {
  registerProtocol();
  pendingWake = findWakeUrl(process.argv);
  app.on('second-instance', (_e, argv) => {
    const url = findWakeUrl(argv);
    if (url) void handleWake(url);
    else if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  // macOS:網址由系統事件傳入(要在 ready 之前註冊)
  app.on('open-url', (e, url) => { e.preventDefault(); void handleWake(url); });

  void app.whenReady().then(async () => {
    const dir = app.getPath('userData');
    mkdirSync(dir, { recursive: true });
    // 上次若被強制關閉,先清掉可能還留著的 CLI 子行程
    initProcs(dir);
    const reaped = await reapStale();
    if (reaped) console.log(`已清除上次留下的 ${reaped} 個 CLI 子行程`);
    initPortraits(dir);
    initWorktrees(dir);
    initAttachments(dir);
    handlePortraitRequests();
    initMedia(dir);
    store = new Store(join(dir, 'nexus.db'));
    // 記憶庫:啟動時完整掃描一次建立索引,之後監看資料夾,外部修改會自動重新讀取
    vault = new MemoryVault(join(dir, 'memory-vault'), store);
    vault.init();
    vault.watch(() => statsWriter?.request());
    // 節點互相呼叫:主控台提供給各家 CLI 的工具服務;要在節點的 session 啟動之前設定好
    const interop = new Interop(dir);
    interopRef = interop;
    core = new Core(store, (u: Update) => { if (u.agent) observerSawAgent(u.agent); win?.webContents.send('nexus:update', u); notify(u); remotePush(u); interop.onUpdate(u); if (u.agent || u.removedId || u.task || u.tasks || u.dispatches) statsWriter?.request(); });
    core.setMemoryVault(vault);
    core.setInterop(id => interop.optionsFor(id));
    interop.attach(core);
    if (interop.error) console.error(interop.error);
    // 判例庫:困難任務完成時請承辦節點寫判例(客觀欄位由主控台填),節點用 case_submit 提交
    const c = core, v = vault, s = store;
    cases = new CaseService({
      vaultDir: v.dir,
      getSetting: k => s.getSetting(k),
      setSetting: (k, val) => s.setSetting(k, val),
      entries: () => v.list(),
      rescan: () => { v.rescan(); },
      task: id => c.taskById(id),
      agent: id => c.agentById(id),
      changedFiles: async id => (await c.taskChanges(id)).files.map(f => f.path),
      facts: t => c.caseFacts(t),
      request: (agentId, text) => c.enqueue(agentId, text, [], 'case'),
      patchTask: (id, patch) => c.patchTaskCase(id, patch),
      detect: detectCandidate,
      write: writeMemory,
      safeName,
      backendLabel: b => BACKEND_LABEL[b],
      // 測試用:NEXUS_CASE_MIN_MINUTES 可把「耗時超過幾分鐘」縮短(可以是小數)
      ...(Number(process.env.NEXUS_CASE_MIN_MINUTES) > 0 ? { minMinutes: Number(process.env.NEXUS_CASE_MIN_MINUTES) } : {}),
      participants: t => c.caseParticipants(t),
      dailyCap: Number(process.env.NEXUS_CASE_DAILY_CAP) >= 0 && process.env.NEXUS_CASE_DAILY_CAP ? Number(process.env.NEXUS_CASE_DAILY_CAP) : CASE_DAILY_CAP,
    });
    const caseSvc = cases;
    core.attachCases(caseSvc);
    interop.caseSubmit = (callerId, args) => caseSvc.submit(callerId, args);
    // 對話草稿:使用者在對話視窗按「儲存這段記憶」,請節點整理成草稿(未確認),節點用 memory_draft 提交
    drafts = new DraftService({
      vaultDir: v.dir,
      getSetting: k => s.getSetting(k),
      setSetting: (k, val) => s.setSetting(k, val),
      history: id => c.history(id),
      agent: id => c.agentById(id),
      project: async id => { const p = await c.memoryDeps()!.project(c.agentCwd(id) ?? ''); return { id: p.id, name: p.name }; },
      request: (agentId, text) => c.enqueue(agentId, text, [], 'draft'),
      rescan: () => { v.rescan(); },
      write: writeMemory,
      safeName,
      backendLabel: b => BACKEND_LABEL[b],
    });
    const draftSvc = drafts;
    interop.memoryDraft = (callerId, args) => draftSvc.submit(callerId, args);
    handleFileRequests(id => core?.agentCwd(id) ?? null);
    await core.init();
    // 記憶庫統計(.nexus-stats.json,給管理 app 讀):啟動時寫一次,之後有變動最多每 5 秒寫一次
    const statsFile = join(v.dir, STATS_FILE);
    statsWriter = new StatsWriter(() => { const i = c.statsInput(); return i ? buildVaultStats(i) : null; }, data => (data ? atomicWriteJson(statsFile, data) : Promise.resolve(true)));
    c.onStatsDirty = () => statsWriter?.request();
    void statsWriter.flush();
    if (core.isEmpty() && process.env.NEXUS_NO_SEED !== '1') core.seedDemo(app.getPath('home'));
    registerIpc(apiMethods(core, 'desktop'));
    initRemote(core, store, dir, apiMethods(core, 'remote'));
    // 語音播報(Phase 2a)只推給桌面畫面,不經 nexus:update(那條也會送到遠端與節點互相呼叫的服務)
    core.setSpeech(n => win?.webContents.send('nexus:speech', n));
    // 外部觀察只推給桌面畫面;設定檔要等使用者在面板上按「安裝」才會修改
    initObserver(core, store, {
      push: u => { win?.webContents.send('nexus:update', u); remotePushFull(u); },
      notify: (title, body) => {
        if (!win || win.isFocused() || (testMode && process.env.NEXUS_TEST_NOTIFY !== '1')) return;
        win.flashFrame(true);
        if (Notification.isSupported()) new Notification({ title, body, silent: true }).show();
      },
    });
    // 語音模式(實驗性):狀態只推給桌面畫面;辨識時把節點名稱當提示詞,幫助辨識專有名詞
    initVoice(store, s => win?.webContents.send('nexus:voice', s), () => {
      const names = core?.snapshot().agents.filter(a => !a.parentId).map(a => a.name) ?? [];
      return names.length ? `節點名稱:${names.join('、')}。` : '';
    }, id => core?.snapshot().agents.find(a => a.id === id)?.character || null);
    // 播報用哪個角色的聲音:節點自己的角色;沒有角色的節點(以及不屬於節點的通知,例如每日預算)改用總管的角色
    initSpeechEngines(store, id => {
      const s = core?.snapshot();
      if (!s) return null;
      return s.agents.find(a => a.id === id)?.character || s.agents.find(a => a.id === s.chiefId)?.character || null;
    });
    restrictPermissions();
    // 拿掉預設選單:否則按 Alt 會跳出選單列,和快捷鍵衝突。開發模式保留,方便重新整理與開發者工具
    if (!devUrl) Menu.setApplicationMenu(null);
    createWindow();
    if (pendingWake) { const w = pendingWake; pendingWake = null; win?.webContents.once('did-finish-load', () => { void handleWake(w); }); }
    win?.on('focus', () => win?.flashFrame(false));
    scheduleScreenshot();
  });

  app.on('window-all-closed', () => app.quit());

  // 結束前先停掉所有 session,不留下子行程
  app.on('before-quit', e => {
    if (quitting || !core) return;
    e.preventDefault();
    quitting = true;
    stopRemote();
    vault?.unwatch();
    statsWriter?.stop();
    stopObserver();
    interopRef?.stop();
    flushHeat();
    void Promise.allSettled([stopVoice(), core.shutdown()]).finally(() => { store?.close(); app.quit(); });
  });
}
