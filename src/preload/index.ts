import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { NexusApi, SpeechNotice, Update, VoiceStatus } from '../shared/types';

// 畫面只能透過這組固定的函式與主行程溝通,拿不到 Node 或 ipcRenderer 本身
const api: NexusApi = {
  getSnapshot: () => ipcRenderer.invoke('nexus:snapshot'),
  getHistory: id => ipcRenderer.invoke('nexus:history', id),
  createAgent: input => ipcRenderer.invoke('nexus:create', input),
  removeAgent: id => ipcRenderer.invoke('nexus:remove', id),
  send: (id, text, images) => ipcRenderer.invoke('nexus:send', id, text, images),
  updateAgent: (id, patch) => ipcRenderer.invoke('nexus:updateAgent', id, patch),
  pickFiles: () => ipcRenderer.invoke('nexus:pickFiles'),
  savePastedImage: (mime, data) => ipcRenderer.invoke('nexus:savePastedImage', mime, data),
  attachmentPreview: path => ipcRenderer.invoke('nexus:attachmentPreview', path),
  // 拖放或貼上的檔案:路徑只能從使用者給的 File 物件取得,順便向主行程登記,之後才能讀縮圖
  pathForFile: file => { const p = webUtils.getPathForFile(file); if (p) ipcRenderer.send('nexus:allowAttachment', p); return p; },
  openTerminal: (id, cols, rows) => ipcRenderer.invoke('nexus:openTerminal', id, cols, rows),
  closeTerminal: id => ipcRenderer.invoke('nexus:closeTerminal', id),
  termAttach: id => ipcRenderer.invoke('nexus:termAttach', id),
  termWrite: (id, data) => ipcRenderer.invoke('nexus:termWrite', id, data),
  termResize: (id, cols, rows) => ipcRenderer.invoke('nexus:termResize', id, cols, rows),
  respondApproval: (id, requestId, decision) => ipcRenderer.invoke('nexus:approval', id, requestId, decision),
  interrupt: id => ipcRenderer.invoke('nexus:interrupt', id),
  enqueue: (id, text, images) => ipcRenderer.invoke('nexus:enqueue', id, text, images),
  cancelQueued: (id, queuedId) => ipcRenderer.invoke('nexus:cancelQueued', id, queuedId),
  editQueued: (id, queuedId, text) => ipcRenderer.invoke('nexus:editQueued', id, queuedId, text),
  resumeQueue: id => ipcRenderer.invoke('nexus:resumeQueue', id),
  answerQuestion: (id, requestId, answers) => ipcRenderer.invoke('nexus:answer', id, requestId, answers),
  sleep: id => ipcRenderer.invoke('nexus:sleep', id),
  wake: id => ipcRenderer.invoke('nexus:wake', id),
  setAutopilot: on => ipcRenderer.invoke('nexus:autopilot', on),
  setMaxActive: n => ipcRenderer.invoke('nexus:maxActive', n),
  openPortraitsFolder: () => ipcRenderer.invoke('nexus:openPortraits'),
  getAvatar: character => ipcRenderer.invoke('nexus:getAvatar', character),
  getPersona: character => ipcRenderer.invoke('nexus:getPersona', character),
  getAgyAllow: () => ipcRenderer.invoke('nexus:getAgyAllow'),
  setAgyAllow: rules => ipcRenderer.invoke('nexus:setAgyAllow', rules),
  setPersona: (character, text) => ipcRenderer.invoke('nexus:setPersona', character, text),
  setChief: id => ipcRenderer.invoke('nexus:setChief', id),
  clearFinishedTasks: () => ipcRenderer.invoke('nexus:clearTasks'),
  setTaskVerdict: (taskId, verdict) => ipcRenderer.invoke('nexus:taskVerdict', taskId, verdict),
  markCase: taskId => ipcRenderer.invoke('nexus:markCase', taskId),
  draftInfo: id => ipcRenderer.invoke('nexus:draftInfo', id),
  requestDraft: id => ipcRenderer.invoke('nexus:requestDraft', id),
  removeAgentArchived: (id, mode) => ipcRenderer.invoke('nexus:removeArchived', id, mode),
  findMemoryArchive: names => ipcRenderer.invoke('nexus:findMemoryArchive', names),
  attachMemoryArchive: (agentId, path) => ipcRenderer.invoke('nexus:attachMemoryArchive', agentId, path),
  getMemoryVault:() => ipcRenderer.invoke('nexus:memoryVault'),
  getTaskChanges: taskId => ipcRenderer.invoke('nexus:taskChanges', taskId),
  listOldSessions: () => ipcRenderer.invoke('nexus:oldSessions'),
  inspectDir: cwd => ipcRenderer.invoke('nexus:inspectDir', cwd),
  revertTask: (taskId, paths) => ipcRenderer.invoke('nexus:revertTask', taskId, paths),
  commitTask: (taskId, message) => ipcRenderer.invoke('nexus:commitTask', taskId, message),
  sendReviewComments: (taskId, comments) => ipcRenderer.invoke('nexus:sendReviewComments', taskId, comments),
  requestReview: (taskId, reviewerId, note) => ipcRenderer.invoke('nexus:requestReview', taskId, reviewerId, note),
  worktreeStatus: id => ipcRenderer.invoke('nexus:worktreeStatus', id),
  mergeWorktree: id => ipcRenderer.invoke('nexus:mergeWorktree', id),
  openPullRequest: id => ipcRenderer.invoke('nexus:openPr', id),
  setQuotaStop: n => ipcRenderer.invoke('nexus:quotaStop', n),
  setDailyBudget: (backend, percent) => ipcRenderer.invoke('nexus:setDailyBudget', backend, percent),
  remoteStatus: () => ipcRenderer.invoke('nexus:remoteStatus'),
  remoteSet: patch => ipcRenderer.invoke('nexus:remoteSet', patch),
  remoteNewCode: () => ipcRenderer.invoke('nexus:remoteNewCode'),
  remoteRevoke: id => ipcRenderer.invoke('nexus:remoteRevoke', id),
  remotePairAccess: access => ipcRenderer.invoke('nexus:remotePairAccess', access),
  remoteSetDevice: (id, access) => ipcRenderer.invoke('nexus:remoteSetDevice', id, access),
  remoteAudit: () => ipcRenderer.invoke('nexus:remoteAudit'),
  observeStatus: () => ipcRenderer.invoke('nexus:observeStatus'),
  observeInstall: () => ipcRenderer.invoke('nexus:observeInstall'),
  observeUninstall: () => ipcRenderer.invoke('nexus:observeUninstall'),
  observeNewToken: () => ipcRenderer.invoke('nexus:observeNewToken'),
  observeTakeover: (sessionId, name) => ipcRenderer.invoke('nexus:observeTakeover', sessionId, name),
  openOldSession: input => ipcRenderer.invoke('nexus:openOldSession', input),
  forkAgent: input => ipcRenderer.invoke('nexus:forkAgent', input),
  pickDirectory: () => ipcRenderer.invoke('nexus:pickDirectory'),
  canReveal: (agentId, text) => ipcRenderer.invoke('nexus:canReveal', agentId, text),
  revealPath: (agentId, text) => ipcRenderer.invoke('nexus:revealPath', agentId, text),
  voiceStatus: () => ipcRenderer.invoke('nexus:voiceStatus'),
  voiceSet: patch => ipcRenderer.invoke('nexus:voiceSet', patch),
  voiceTranscribe: wav => ipcRenderer.invoke('nexus:voiceTranscribe', wav),
  voiceTts: (target, text) => ipcRenderer.invoke('nexus:voiceTts', target, text),
  voiceCharacters: () => ipcRenderer.invoke('nexus:voiceCharacters'),
  voiceTtsPower: load => ipcRenderer.invoke('nexus:voiceTtsPower', load),
  speechRender: (notice, text) => ipcRenderer.invoke('nexus:speechRender', notice, text),
  speechSettings: () => ipcRenderer.invoke('nexus:speechSettings'),
  speechSet: patch => ipcRenderer.invoke('nexus:speechSet', patch),
  speechClip: (character, kind) => ipcRenderer.invoke('nexus:speechClip', character, kind),
  voiceProfile: character => ipcRenderer.invoke('nexus:voiceProfile', character),
  voiceProfileSave: (character, patch) => ipcRenderer.invoke('nexus:voiceProfileSave', character, patch),
  voiceProfileImport: character => ipcRenderer.invoke('nexus:voiceProfileImport', character),
  voiceProfileAudio: character => ipcRenderer.invoke('nexus:voiceProfileAudio', character),
  onVoice: cb => {
    const listener = (_e: unknown, s: VoiceStatus) => cb(s);
    ipcRenderer.on('nexus:voice', listener);
    return () => { ipcRenderer.removeListener('nexus:voice', listener); };
  },
  onSpeech: cb => {
    const listener = (_e: unknown, n: SpeechNotice) => cb(n);
    ipcRenderer.on('nexus:speech', listener);
    return () => { ipcRenderer.removeListener('nexus:speech', listener); };
  },
  onUpdate: cb => {
    const listener = (_e: unknown, u: Update) => cb(u);
    ipcRenderer.on('nexus:update', listener);
    return () => { ipcRenderer.removeListener('nexus:update', listener); };
  },
};

contextBridge.exposeInMainWorld('nexus', api);
