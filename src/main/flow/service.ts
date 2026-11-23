import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  DEFAULT_ARTIFACT_DIRS, TERMINAL_STATUSES,
  type DecisionChoice, type FlowDefinition, type FlowParseResult, type FlowRunView, type FlowStartInput, type FlowTemplateInfo, type ProjectFlowConfig, type ScopeException, type StepReport,
} from '../../shared/flow.ts';
import type { ApprovalDecision, AgentInfo, NexusEvent, TaskFrom, TaskInfo, Update } from '../../shared/types';
import { changedPaths, commitChanges, diffTrees } from '../changes.ts';
import { applyProject, dumpProjectsFile, loadUserTemplates, parseProjectsFile } from './definition.ts';
import {
  createRun, isActive, nextDeadline, reduce, restoreAfterRestart, stepOf, toView,
  type AgentLite, type FlowEffect, type FlowEvent, type FlowRun, type RunAssignment, type SnapResult,
} from './machine.ts';
import { reminderPrompt, stepPrompt, type PrevReport } from './prompts.ts';
import { canonicalArgs, normalizeReport, renderReportMd } from './report.ts';
import { atomicWrite, RunStore } from './run-store.ts';
import { actionKey, artifactPaths, dirFingerprint, effectiveForbidden, fingerprintDiff, guardFingerprint, isBlocking, scanAction, splitGuardDiff, type GuardContext, type GuardScan } from './guard.ts';
import { outOfScope, protectedHits, realUserDataDir, unexplained } from './scope.ts';
import { runVerify } from './verify.ts';
import { addDetachedWorktree, copyChanges, COPY_NAME_RE, diffRefs, exportTree, ignoredList, linkDeps, newIgnored, refsState, removeCopy, removeDetachedWorktree, snapshot } from './version.ts';

/**
 * FlowService:協作流程的執行器(docs/協作流程實作計畫.md §1.1)。
 * 狀態轉移都在 machine.ts 的純 reducer;這裡負責解譯 reducer 吐出的 effect(交辦、快照、核實、匯出副本、確認交辦結束…)、
 * 計時器、工作樹鎖、持久化(runs/<id>/)與對外 API。
 * 依賴一律由建構時的 deps 注入(照 cases.ts 的寫法),index.ts 接上 Core;這個檔案不 import Electron。
 *
 * 對外方法:start、pause、resume、stop、decide、manualReport、approve、submitReport(step_report 工具)、onUpdate、views、shutdown。
 * 範圍合約(M3):onUpdate 也看流程交辦中節點的授權請求(L1 自動拒絕)與工具啟動(L2 中斷並停機),判斷在 guard.ts;
 * 每一步交辦前後比對資料夾指紋與被忽略的產出(L4),交辦前的授權卡(requires_approval)由狀態機發出 gate effect。
 */

export interface FlowDeps {
  /** 主控台資料夾:runs/ 與 flows/ 都放在這裡。 */
  dataDir: string;
  /** 面板上的最上層節點。 */
  agents(): AgentInfo[];
  agent(id: string): AgentInfo | undefined;
  /** 依 id 取任務(確認交辦結束用;不必每次建完整快照)。 */
  task(id: string): TaskInfo | undefined;
  /** 節點目前在跑的任務 id。 */
  currentTaskId(agentId: string): string | undefined;
  /** 把交辦排進節點的佇列(節點待命時自動送出),回傳佇列項目的 id。 */
  enqueue(agentId: string, text: string, from: TaskFrom): string;
  cancelQueued(agentId: string, queuedId: string): void;
  interrupt(agentId: string): void;
  wake(agentId: string): Promise<void>;
  /** 停機或需裁示時通知總管(只留言,不自動跑回合)。 */
  notifyChief(text: string): void;
  /** 通知使用者(系統通知)。 */
  notifyUser(title: string, body: string): void;
  /** 推送單筆流程更新給畫面。 */
  broadcast(u: Update): void;
  /** 內建範本(builtin.ts 用 ?raw 載入,單元測試不載入它,所以由呼叫端注入)。 */
  builtin(): (FlowParseResult & { file: string })[];
  projectOf(cwd: string): Promise<{ id: string; name: string } | null>;
  now?(): number;
  /** 確認交辦結束的逾時(毫秒),預設 30 秒;逾時交給使用者決定,不默認已結束。 */
  ensureTimeoutMs?: number;
  /** 確認期間重發中斷的間隔(毫秒),預設 3 秒。 */
  reinterruptMs?: number;
  /** 交辦在佇列裡排超過這麼久就提示使用者(毫秒),預設 60 秒。 */
  queueWarnMs?: number;
  /** 回應節點的授權請求(L1 自動拒絕命中禁止動作的請求用)。 */
  respondApproval?(agentId: string, requestId: string, decision: ApprovalDecision): void;
  /** 在節點的對話裡留一則說明(自動拒絕、中斷的原因)。 */
  note?(agentId: string, text: string): void;
  /** 設定中的記憶庫資料夾(real_vault 的比對路徑)。 */
  vaultDir?(): string;
  /**
   * 工具啟動事件命中禁止動作後,等這麼久再中斷(毫秒),預設 1 秒:Claude Code 會先送工具啟動、再詢問授權,
   * 這段時間內同一個動作的授權請求被自動拒絕(L1)就不中斷,動作沒有真的執行。
   */
  guardGraceMs?: number;
  /** 關閉主控台時等核實子程序結束的上限(毫秒),預設 10 秒。 */
  shutdownWaitMs?: number;
}

const WIN = process.platform === 'win32';
/** 實際路徑:展開 Windows 的 8.3 短名稱(例如 CI 的 C:\Users\RUNNER~1\…;git 回報的一律是長名稱),不存在時展開最近一層存在的上層。 */
const longPath = (p: string): string => {
  const abs = resolve(p);
  try { return realpathSync.native(abs); } catch { /* 不存在:往上找 */ }
  const parent = dirname(abs);
  return parent === abs ? abs : join(longPath(parent), basename(abs));
};
const lockKey = (p: string) => { const s = longPath(p).replace(/\\/g, '/').replace(/\/+$/, ''); return WIN ? s.toLowerCase() : s; };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** 資料夾指紋的版本標記(第 2 版起才有主控台設定資料夾頂層與建置產出的深層摘要)。 */
const FP_VERSION_KEY = '#v';

function gitTop(cwd: string): Promise<string | null> {
  return new Promise(res => {
    execFile('git', ['rev-parse', '--show-toplevel'], { cwd, windowsHide: true, timeout: 15000 }, (err, out) => res(err ? null : resolve(String(out).trim())));
  });
}

export class FlowService {
  private d: FlowDeps;
  private store: RunStore;
  private runs = new Map<string, FlowRun>();
  private timers = new Map<string, NodeJS.Timeout>();
  /** 每個流程進行中的 effect(清理副本前要等它們結束)。 */
  private busy = new Map<string, Set<Promise<unknown>>>();
  /** 已處理過的任務事件(onUpdate 會收到同一個任務的多次更新)。 */
  private seenTask = new Set<string>();
  /** 每個流程進行中的核實(停止、停機、關閉主控台時中止,終止整個程序樹)。 */
  private aborts = new Map<string, Set<AbortController>>();
  /** 正在執行的授權卡(避免連按)。 */
  private approving = new Set<string>();
  /** 進行中的核實(關閉主控台時等它們結束)。 */
  private verifying = new Set<Promise<unknown>>();
  /** 核實用的臨時主控台資料夾(nexus-flow-data-*):核實結束就刪,關閉主控台時刪掉還留著的。只刪自己建的。 */
  private verifyData = new Set<string>();
  /** L2:工具啟動命中禁止動作、等著中斷的計時器(節點 id → 計時器與命中的動作)。 */
  private l2 = new Map<string, { timer: NodeJS.Timeout; keys: string[] }[]>();
  private closed = false;

  constructor(deps: FlowDeps) {
    this.d = deps;
    this.store = new RunStore(join(deps.dataDir, 'runs'));
  }

  private now(): number { return this.d.now?.() ?? Date.now(); }
  private flowsDir(): string { return join(this.d.dataDir, 'flows'); }

  /**
   * 啟動時讀回所有流程:執行中或停止中的改成暫停(restoreAfterRestart),清掉殘留的副本,取消上次留在節點佇列裡的交辦。
   */
  init(): void {
    const { runs, errors } = this.store.loadAll();
    for (const e of errors) console.error(`[flow] ${e}`);
    for (const r of runs) {
      const before = r.status;
      const run = restoreAfterRestart(r, this.now());
      for (const a of r.assignments) if (a.queuedId) { try { this.d.cancelQueued(a.agentId, a.queuedId); } catch { /* 節點不在了 */ } }
      this.runs.set(run.id, run);
      if (before !== run.status || JSON.stringify(r) !== JSON.stringify(run)) this.store.save(run);
      // 上次留下的核實 worktree 要用 removeDetachedWorktree 清(removeCopy 不刪有 .git 的資料夾),清完再刪其他副本
      void this.removeWorktrees(run.id).finally(() => { const cur = this.runs.get(run.id); if (cur) this.removeCopies(cur); });
    }
  }

  /** 清掉 run.worktrees 記下的核實 worktree(只處理那幾個,不跑全域 prune)。 */
  private async removeWorktrees(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    for (const w of [...(run?.worktrees ?? [])]) {
      const r = await removeDetachedWorktree(run!.repoRoot, w.path, w.commit).catch(e => ({ removed: false, error: String((e as Error).message) }));
      if (r.removed) this.patch(runId, x => { x.worktrees = (x.worktrees ?? []).filter(y => y.path !== w.path); });
      else console.error(`[flow] 核實 worktree 沒有移除:${(r as { error?: string }).error}`);
    }
  }

  // ---- 範本與專案設定 ----

  private allTemplates(): (FlowParseResult & { file: string })[] {
    return [...this.d.builtin(), ...loadUserTemplates(this.flowsDir())];
  }

  templates(): FlowTemplateInfo[] {
    return this.allTemplates().map(t => ({
      id: t.flow?.id ?? '', name: t.flow?.name ?? t.file, description: t.flow?.description ?? '', source: t.flow?.source ?? 'user', file: t.file,
      errors: t.errors, warnings: t.warnings,
      ...(t.flow ? {
        roles: t.flow.roles,
        steps: t.flow.steps.map(s => ({ id: s.id, label: s.label, role: s.role, mode: s.mode, requiresApproval: [...s.requiresApproval] })),
        verify: t.flow.verify.commands, allowedPaths: t.flow.scope.allowedPaths, forbiddenActions: t.flow.scope.forbiddenActions,
        offer: t.flow.finish.offer, limits: t.flow.limits,
      } : {}),
    }));
  }

  private projectsFile(): string { return join(this.flowsDir(), 'projects.yaml'); }

  private readProjects() {
    try { return parseProjectsFile(readFileSync(this.projectsFile(), 'utf8')); } catch { return parseProjectsFile(''); }
  }

  async projectConfig(cwd: string): Promise<{ projectId: string; projectName: string; config: ProjectFlowConfig | null; errors: string[] }> {
    const p = await this.d.projectOf(cwd);
    if (!p) throw new Error('找不到這個資料夾所屬的專案');
    const file = this.readProjects();
    return { projectId: p.id, projectName: p.name, config: file.projects[p.id] ?? null, errors: file.invalid[p.id]?.errors ?? [] };
  }

  setProjectConfig(cfg: ProjectFlowConfig): void {
    if (!cfg || typeof cfg.projectId !== 'string' || !cfg.projectId) throw new Error('缺少專案 id');
    const file = this.readProjects();
    const projects = { ...file.projects, [cfg.projectId]: { ...cfg, roles: { ...(cfg.roles ?? {}) }, allowDesktopVerify: cfg.allowDesktopVerify === true } };
    // 先確認寫出去的內容讀得回來,才寫檔
    const text = dumpProjectsFile(projects, file.invalid);
    const check = parseProjectsFile(text);
    if (check.invalid[cfg.projectId]) throw new Error(`專案設定有誤:${check.invalid[cfg.projectId].errors.join(';')}`);
    mkdirSync(this.flowsDir(), { recursive: true });
    atomicWrite(this.projectsFile(), text);
    // 主控台自己寫的 projects.yaml 不算節點寫入流程定義資料夾:更新進行中交辦的指紋基準
    const key = 'flows/projects.yaml';
    const now = dirFingerprint(this.flowsDir(), 'flows/', 1)[key];
    for (const r of this.runs.values()) {
      if (TERMINAL_STATUSES.includes(r.status)) continue;
      const a = r.assignments.find(x => x.id === r.current);
      if (!a?.guardBefore) continue;
      this.patch(r.id, x => { const y = x.assignments.find(z => z.id === a.id); if (y?.guardBefore) { if (now) y.guardBefore[key] = now; else delete y.guardBefore[key]; } });
    }
  }

  // ---- 啟動與控制 ----

  /** 同一個工作樹,同時只允許一個流程寫入(未結束的流程都算,包含暫停與等待使用者的)。 */
  private lockedBy(repoRoot: string): FlowRun | undefined {
    const k = lockKey(repoRoot);
    return [...this.runs.values()].find(r => !TERMINAL_STATUSES.includes(r.status) && lockKey(r.repoRoot) === k);
  }

  async start(input: FlowStartInput): Promise<FlowRunView> {
    if (this.closed) throw new Error('主控台正在關閉');
    const topic = String(input?.topic ?? '').trim();
    const cwd = String(input?.cwd ?? '').trim();
    if (!topic) throw new Error('請填寫主題');
    if (!cwd || !isAbsolute(cwd) || !existsSync(cwd)) throw new Error('工作目錄不存在');
    const tpl = this.allTemplates().reverse().find(t => t.flow?.id === input.templateId);
    if (!tpl?.flow) throw new Error(`找不到流程範本「${String(input.templateId)}」`);
    const project = await this.d.projectOf(cwd);
    if (!project) throw new Error('找不到這個資料夾所屬的專案');
    const projects = this.readProjects();
    const cfg = projects.projects[project.id] ?? null;
    const applied = applyProject(tpl.flow, cfg);
    if (!applied.flow) throw new Error(`專案設定套用失敗:${applied.errors.join(';')}`);
    const flow: FlowDefinition = applied.flow;
    const repoRoot = await gitTop(cwd);
    if (!repoRoot) throw new Error('協作流程需要 git 版本庫(版本用 git tree 表示)');
    const holder = this.lockedBy(repoRoot);
    if (holder) throw new Error(`這個工作樹已經有一個流程在進行(「${holder.flow.name}」:${holder.topic.split('\n')[0].slice(0, 40)}),同一個工作樹同時只允許一個流程寫入`);

    // 角色 → 節點:明確指定的優先,其次是專案設定(節點名稱或 id)
    const agents = this.d.agents().filter(a => !a.parentId);
    const roles: FlowRun['roles'] = {};
    for (const [role, def] of Object.entries(flow.roles)) {
      const want = input.roles?.[role] ?? cfg?.roles[role];
      const a = want ? agents.find(x => x.id === want) ?? agents.find(x => x.name === want) : undefined;
      if (!a) throw new Error(want ? `角色「${role}」指定的節點「${want}」不在面板上` : `角色「${role}」(${def.description || def.mode})還沒有指定節點`);
      // 寫入的節點必須在這個工作樹裡工作,否則它改的不是這份正本
      if (def.mode === 'write' && lockKey(a.cwd) !== lockKey(repoRoot) && !lockKey(a.cwd).startsWith(`${lockKey(repoRoot)}/`)) throw new Error(`角色「${role}」的節點「${a.name}」的工作目錄(${a.cwd})不在這個專案裡`);
      roles[role] = { agentId: a.id, name: a.name };
    }
    const base = await snapshot(cwd);
    if (!base) throw new Error('無法拍下工作目錄的快照(不是 git 版本庫,或整個資料夾被 .gitignore 排除)');
    const ignored = await ignoredList(cwd).catch(() => []);
    const id = `${new Date(this.now()).toISOString().slice(0, 10).replace(/-/g, '')}-${randomUUID().slice(0, 8)}`;
    // 再檢查一次鎖(上面的 await 期間可能有另一個流程搶先啟動)
    if (this.lockedBy(repoRoot)) throw new Error('這個工作樹已經有一個流程在進行');
    const run = createRun({
      id, flow, topic, projectId: project.id, projectName: project.name, cwd: resolve(cwd), repoRoot, roles,
      roleHints: cfg?.roles ?? {}, allowDesktop: cfg?.allowDesktopVerify ?? false, baseVersion: base, ignoredBase: ignored,
    }, this.now());
    for (const w of applied.warnings) run.audit.push({ at: this.now(), text: `警告:${w}` });
    this.runs.set(id, run);
    this.apply(id, { type: 'start' });
    return this.view(this.runs.get(id)!);
  }

  private must(runId: string): FlowRun {
    const r = this.runs.get(String(runId));
    if (!r) throw new Error('找不到這個流程');
    return r;
  }

  pause(runId: string): FlowRunView { const r = this.must(runId); if (r.status !== 'running') throw new Error('只有執行中的流程能暫停'); this.apply(r.id, { type: 'pause' }); return this.view(this.must(runId)); }
  resume(runId: string): FlowRunView { const r = this.must(runId); if (r.status !== 'paused') throw new Error('只有暫停中的流程能繼續'); this.apply(r.id, { type: 'resume' }); return this.view(this.must(runId)); }

  stop(runId: string): FlowRunView {
    const r = this.must(runId);
    if (TERMINAL_STATUSES.includes(r.status)) throw new Error('這個流程已經結束了');
    this.apply(r.id, { type: 'stop', reason: '使用者停止' });
    return this.view(this.must(runId));
  }

  decide(runId: string, decisionId: string, choice: DecisionChoice, payload: { agentId?: string; note?: string } = {}): FlowRunView {
    const r = this.must(runId);
    const p = r.pending;
    if (r.status !== 'awaiting_user' || !p || p.id !== decisionId) throw new Error('這個決定已經過期了');
    if (!p.options.includes(choice)) throw new Error(`這個狀況不能選「${choice}」`);
    if (choice === 'manual_report') throw new Error('手動補報請用 manualReport');
    let agentName: string | undefined;
    if (choice === 'reassign') {
      const a = payload.agentId ? this.d.agent(payload.agentId) : undefined;
      if (!a || a.parentId) throw new Error('請指定面板上的節點');
      const step = stepOf(r, r.stepId);
      if (step && r.flow.roles[step.role]?.mode === 'write' && lockKey(a.cwd) !== lockKey(r.repoRoot) && !lockKey(a.cwd).startsWith(`${lockKey(r.repoRoot)}/`)) throw new Error(`「${a.name}」的工作目錄不在這個專案裡`);
      agentName = a.name;
    }
    this.apply(r.id, { type: 'decide', decisionId, choice, ...(payload.agentId ? { agentId: payload.agentId } : {}), ...(agentName ? { agentName } : {}), ...(payload.note ? { note: String(payload.note).slice(0, 2000) } : {}) });
    return this.view(this.must(runId));
  }

  /** 使用者手動補報(交辦記成未回報時)。args 和 step_report 工具的參數相同,assignment_id 可以省略。 */
  manualReport(runId: string, args: Record<string, unknown>): FlowRunView {
    const r = this.must(runId);
    const p = r.pending;
    if (r.status !== 'awaiting_user' || p?.kind !== 'unreported' || !p.assignmentId) throw new Error('現在不需要手動補報');
    const a = r.assignments.find(x => x.id === p.assignmentId)!;
    const n = normalizeReport({ ...(args ?? {}), assignment_id: p.assignmentId }, { mode: stepOf(r, a.stepId)?.mode ?? 'write', repoRoot: r.repoRoot, now: this.now(), manual: true });
    if (!n.report) throw new Error(`補報的內容有誤:${n.errors.join(';')}`);
    this.apply(r.id, { type: 'decide', decisionId: p.id, choice: 'manual_report', report: n.report });
    return this.view(this.must(runId));
  }

  /**
   * 授權卡。允許時一律重拍一次快照,必須和卡片上的版本相同,否則卡片失效(版本綁定)。
   * - 交辦前的卡(步驟的 requires_approval):允許後狀態機才交辦這一步;拒絕就停機、不交辦。主控台不執行動作本身。
   * - 收尾的 commit 卡:只提交卡片上的檔案;範圍外的檔案預設不納入,只有 include 列出(而且在卡片的範圍外清單裡)的才納入。
   * - 收尾的其他動作(push 等):第一版不支援執行(新流程不會再產生這種卡;舊紀錄裡的可以拒絕)。
   */
  async approve(runId: string, cardId: string, opts: { deny?: boolean; include?: string[]; message?: string } = {}): Promise<FlowRunView> {
    const r = this.must(runId);
    const card = r.approvals.find(c => c.id === cardId);
    if (!card || card.status !== 'pending') throw new Error('這張授權卡已經處理過或失效了');
    if (opts.deny) { this.apply(r.id, { type: 'approval_card', cardId, status: 'denied' }); return this.view(this.must(runId)); }
    if (card.stepId) return this.approveGate(r, card.id, card.version);
    if (card.action !== 'commit') throw new Error(`收尾的「${card.action}」授權卡第一版不支援執行(只支援 commit)。請在流程結束後自行處理,這張卡可以按拒絕關掉;需要讓流程裡的步驟做這個動作,請在步驟加上 requires_approval。`);
    // 同一個工作樹有進行中的流程時不提交:提交會改 refs,那個流程會誤判成節點自己 commit
    const live = this.lockedBy(r.repoRoot);
    if (live && live.id !== r.id) throw new Error(`這個工作樹現在有另一個流程在進行(「${live.flow.name}」),等它結束或停止後再允許這張授權卡`);
    const key = `${r.id}:${cardId}`;
    if (this.approving.has(key)) throw new Error('這張授權卡正在執行中');
    this.approving.add(key);
    try { return await this.approveCommit(r, card.id, card.version, card.paths, card.outOfScope, opts); } finally { this.approving.delete(key); }
  }

  /** 交辦前的授權卡:正本的版本仍和卡片相同才算允許;不同就失效(狀態機會重新拍版本、開新卡)。 */
  private async approveGate(r: FlowRun, cardId: string, version: string): Promise<FlowRunView> {
    if (TERMINAL_STATUSES.includes(r.status)) throw new Error('這個流程已經結束了');
    const key = `${r.id}:${cardId}`;
    if (this.approving.has(key)) throw new Error('這張授權卡正在處理中');
    this.approving.add(key);
    try {
      const now = await snapshot(r.cwd);
      const cur = this.runs.get(r.id)?.approvals.find(c => c.id === cardId);
      if (!cur || cur.status !== 'pending') throw new Error('這張授權卡已經處理過或失效了');
      if (now !== version) this.apply(r.id, { type: 'approval_card', cardId, status: 'expired', result: `版本已改變(${version.slice(0, 8)} → ${now ? now.slice(0, 8) : '讀不到'}),授權失效,會重新產生授權卡` });
      else this.apply(r.id, { type: 'approval_card', cardId, status: 'approved', result: `已允許(版本 ${version.slice(0, 8)})` });
    } finally { this.approving.delete(key); }
    return this.view(this.must(r.id));
  }

  private async approveCommit(r: FlowRun, cardId: string, version: string, cardPaths: string[], outside: string[], opts: { include?: string[]; message?: string }): Promise<FlowRunView> {
    const runId = r.id;
    const card = { version, paths: cardPaths, outOfScope: outside };
    const now = await snapshot(r.cwd);
    if (now !== card.version) {
      this.apply(r.id, { type: 'approval_card', cardId, status: 'expired', result: `版本已改變(${card.version.slice(0, 8)} → ${now ? now.slice(0, 8) : '讀不到'}),授權失效` });
      return this.view(this.must(runId));
    }
    const include = (Array.isArray(opts.include) ? opts.include : []).map(String).filter(p => card.outOfScope.includes(p));
    let paths = [...card.paths, ...include];
    // 已經在 HEAD 裡的修改(節點經授權自己 commit 過,或使用者手動提交過)不用再提交;全都在的話說明清楚,不當成提交失敗
    const pending = await this.pendingVsHead(r.cwd, card.version);
    if (pending) {
      paths = paths.filter(p => pending.has(p));
      if (!paths.length) {
        this.apply(r.id, { type: 'approval_card', cardId, status: 'expired', result: '這張卡上的修改已經都在 HEAD 裡(可能是節點經授權自己 commit 過,或已經手動提交),沒有東西要提交' });
        return this.view(this.must(runId));
      }
    }
    const message = (typeof opts.message === 'string' && opts.message.trim()) || `${r.flow.name}:${r.topic.split(/\r?\n/)[0].replace(/〔[^〕]*〕/g, '').trim().slice(0, 72) || r.id}`;
    try {
      const hash = await commitChanges(r.cwd, r.baseVersion, card.version, message, paths);
      this.apply(r.id, { type: 'approval_card', cardId, status: 'approved', included: include, result: `已提交 ${hash}(${paths.length} 個檔案${include.length ? `,含範圍外 ${include.length} 個:${include.join('、')}` : ''}${card.outOfScope.length > include.length ? `;沒有勾選的範圍外檔案 ${card.outOfScope.length - include.length} 個留在工作區` : ''})` });
    } catch (e) {
      throw new Error(`提交失敗:${(e as Error).message}`);
    }
    return this.view(this.must(runId));
  }

  /** 版本裡和 HEAD 不同的檔案;讀不到 HEAD(還沒有提交)時回傳 null(不過濾)。 */
  private async pendingVsHead(cwd: string, version: string): Promise<Set<string> | null> {
    const head = await new Promise<string | null>(res => {
      execFile('git', ['rev-parse', 'HEAD^{tree}'], { cwd, windowsHide: true, timeout: 15000 }, (err, out) => res(err ? null : String(out).trim()));
    });
    if (!head) return null;
    try { return new Set((await changedPaths(cwd, head, version)).map(p => p.path)); } catch { return null; }
  }

  /** 還沒結束的流程有用到這個節點(任何角色)時回傳流程名稱;轉移工作區時用來擋下。 */
  holding(agentId: string): string | null {
    for (const r of this.runs.values()) {
      if (TERMINAL_STATUSES.includes(r.status)) continue;
      if (Object.values(r.roles).some(x => x.agentId === agentId)) return r.flow.name;
    }
    return null;
  }

  views(): FlowRunView[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt).map(r => this.view(r));
  }

  /** 流程的 late/ 檔案(畫面與驗收用)。 */
  lateFiles(runId: string): string[] { return this.store.lateFiles(this.must(runId).id); }

  private view(r: FlowRun): FlowRunView {
    return toView(r, this.store.dir(r.id), id => this.d.agent(id)?.name, this.now());
  }

  /**
   * 關閉主控台:中止進行中的核實(終止整個程序樹),等核實真的結束(上限 shutdownWaitMs,預設 10 秒,讓副本與 worktree 也清掉)
   * 再寫回狀態;最後刪掉這次建的核實臨時資料夾(nexus-flow-data-*,只刪自己建的,不碰其他主控台的)。
   * 關閉後不再執行新的 effect(重開時 restoreAfterRestart 會接著處理)。
   */
  async shutdown(): Promise<void> {
    this.closed = true;
    for (const set of this.aborts.values()) for (const ac of set) ac.abort();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const list of this.l2.values()) for (const x of list) clearTimeout(x.timer);
    this.l2.clear();
    if (this.verifying.size) {
      let timer: NodeJS.Timeout | undefined;
      const limit = new Promise<void>(res => { timer = setTimeout(res, this.d.shutdownWaitMs ?? 10000); });
      await Promise.race([Promise.allSettled([...this.verifying]), limit]);
      clearTimeout(timer);
    }
    for (const r of this.runs.values()) { try { this.store.save(r); } catch { /* 關閉時盡力而為 */ } }
    for (const dir of [...this.verifyData]) {
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); this.verifyData.delete(dir); } catch (e) { console.error(`[flow] 核實臨時資料夾沒有刪掉:${dir}`, e); }
    }
  }

  // ---- step_report 工具 ----

  /** step_report 工具(interop 呼叫);callerId 是權杖對應的節點。回傳給節點看的文字;不接受時丟出錯誤(工具回傳 isError)。 */
  async submitReport(callerId: string, args: Record<string, unknown>): Promise<string> {
    const aid = String(canonicalArgs(args ?? {}).args.assignment_id ?? '').trim();
    if (!aid) throw new Error('step_report 需要 assignment_id(主控台交辦裡給的交辦編號)。');
    let run: FlowRun | undefined, a: RunAssignment | undefined;
    for (const r of this.runs.values()) { const x = r.assignments.find(y => y.id === aid); if (x) { run = r; a = x; break; } }
    if (!run || !a) throw new Error(`找不到交辦「${aid}」。請確認 assignment_id 是主控台這次交辦裡給的編號。`);
    if (a.agentId !== callerId) throw new Error('這個交辦不是交給你的,不能由你回報。');
    const mode = stepOf(run, a.stepId)?.mode ?? 'write';
    const n = normalizeReport(args, { mode, repoRoot: run.repoRoot, now: this.now() });
    if (!n.report) throw new Error(`回報沒有被接受(不算數),請修正後重送:${n.errors.join(';')}`);
    const fx = this.apply(run.id, { type: 'report', assignmentId: aid, report: n.report });
    const ignored = fx.find(e => e.type === 'report_ignored') as Extract<FlowEffect, { type: 'report_ignored' }> | undefined;
    if (ignored) return `這份回報沒有記錄:${ignored.reason}。`;
    const late = fx.find(e => e.type === 'write_late') as Extract<FlowEffect, { type: 'write_late' }> | undefined;
    if (late) return `已收到,但${late.reason},這份回報只存檔備查,不會推進流程。`;
    return `已收到 step_report(${mode === 'review' ? `結論:${n.report.verdict === 'mergeable' ? '可合併' : '需修正'}` : '實作'})。主控台會在這個回合結束後收尾${mode === 'write' ? '並自己重跑核實指令' : ''};你現在可以結束這個回合。${n.ignored.length ? `(不認得、已忽略的參數:${n.ignored.join('、')})` : ''}`;
  }

  // ---- 核心事件 ----

  // ---- 範圍合約的攔截(L1、L2) ----

  /** 節點(或它的子代理)目前在做的是不是某個流程交辦的任務;是的話回傳流程、交辦與頂層節點 id。 */
  private flowTaskOf(agentId: string): { run: FlowRun; a: RunAssignment; top: string } | null {
    const top = this.d.agent(agentId)?.parentId ?? agentId;
    const taskId = this.d.currentTaskId(top);
    const task = taskId ? this.d.task(taskId) : undefined;
    const f = task?.from?.flow;
    if (!task || !f || task.endedAt !== null) return null;
    const run = this.runs.get(f.runId);
    if (!run || TERMINAL_STATUSES.includes(run.status)) return null;
    const a = run.assignments.find(x => x.id === f.assignmentId);
    if (!a || a.agentId !== top || !isActive(a)) return null;
    return { run, a, top };
  }

  /** 攔截判斷的範圍:禁止動作扣掉這一步已授權的;受保護的資料夾與豁免(這個流程自己的 runs/<id>/、審查副本、授權後的記憶庫)。 */
  private guardContext(run: FlowRun, a: RunAssignment): GuardContext {
    const approved = a.approved ?? [];
    const vault = this.d.vaultDir?.() ?? '';
    const vaultOpen = approved.includes('real_vault');
    // 路徑同時列出原樣與展開 8.3 短名稱後的長路徑,指令裡寫哪一種都比得到
    const both = (xs: string[]) => [...new Set(xs.filter(Boolean).flatMap(x => [resolve(x), longPath(x)]))];
    const env = process.env;
    return {
      forbidden: effectiveForbidden(run.flow, approved),
      protectedRoots: both([this.flowsDir(), this.d.dataDir, realUserDataDir()]),
      vaultRoots: both([vault]),
      readExempt: both([this.store.dir(run.id), ...(vaultOpen ? [vault] : [])]),
      writeExempt: both([...(a.copyDir ? [a.copyDir] : []), ...(vaultOpen ? [vault] : [])]),
      cwd: run.cwd,
      env: { APPDATA: env.APPDATA, LOCALAPPDATA: env.LOCALAPPDATA, USERPROFILE: env.USERPROFILE, HOME: env.HOME },
    };
  }

  private hitText(hit: GuardScan): string {
    const parts = [...hit.actions, ...(hit.protected.length ? [`寫入受保護的資料夾(${hit.protected.slice(0, 2).join('、')})`] : [])];
    return `${parts.join('、')}:${hit.items.slice(0, 3).join(';')}`;
  }

  /** 已記過的「讀取受保護資料夾」紀錄(同一個交辦、同一個資料夾只記一次)。 */
  private readNoted = new Set<string>();
  /** L1 自動拒絕、還在等轉接器回報結果(approval_resolved)的授權請求。 */
  private pendingDeny = new Map<string, { top: string; runId: string; assignmentId: string; keys: string[]; hit: GuardScan; kind: 'forbidden_action' | 'protected_write'; at: number }>();

  /**
   * 節點事件(onUpdate 轉進來):
   * - L1 授權請求命中禁止動作或寫入受保護的資料夾 → 自動拒絕、在對話留說明。等轉接器回報這個請求的結果:
   *   拒絕了 → 記一筆違規(blocked),取消同一個指令的 L2,流程繼續;使用者搶先允許了 → 記違規(沒擋下),L2 照樣中斷並停機。
   * - L2 工具啟動命中 → 等 guardGraceMs(同一個指令的授權請求被 L1 拒絕就取消;拒絕還沒確認就再等一下),再中斷交辦、記違規並停機。
   * - 只是提到(讀取)受保護的資料夾 → 只記紀錄,不擋。
   * 只處理「目前在做這個流程交辦的任務」的節點;主控台自己發出的授權(nexus:…,節點互相呼叫)不算 CLI 動作,不比對。
   */
  private onAgentEvent(e: NexusEvent): void {
    if (this.closed) return;
    if (e.type === 'approval_resolved') { this.onDenyResolved(e.requestId, e.decision); return; }
    if (e.type !== 'approval_request' && !(e.type === 'tool' && e.phase === 'start')) return;
    if (e.type === 'approval_request' && e.requestId.startsWith('nexus:')) return;
    const found = this.flowTaskOf(e.agentId);
    if (!found) return;
    const { run, a, top } = found;
    const tool = e.type === 'approval_request' ? e.tool : e.name;
    const hit = scanAction({ tool, summary: e.summary, detail: e.detail, ...(e.paths ? { paths: e.paths } : {}) }, this.guardContext(run, a));
    if (!hit) return;
    if (!isBlocking(hit)) {
      const fresh = hit.reads.filter(r => !this.readNoted.has(`${a.id}|${r.toLowerCase()}`));
      for (const r of fresh) this.readNoted.add(`${a.id}|${r.toLowerCase()}`);
      if (fresh.length) this.apply(run.id, { type: 'note', text: `「${a.agentName}」的指令提到受保護的資料夾(只記紀錄,讀取不擋):${fresh.join('、')};${e.summary.slice(0, 120)}` });
      return;
    }
    const step = stepOf(run, a.stepId);
    const kind = hit.actions.length ? 'forbidden_action' : 'protected_write';
    const keys = hit.items.map(actionKey);
    if (e.type === 'approval_request') {
      // L1:拒絕這個授權請求;等轉接器回報結果再記違規、取消同一個指令的 L2(使用者可能搶先按了允許)
      const requestId = e.requestId;
      this.pendingDeny.set(requestId, { top, runId: run.id, assignmentId: a.id, keys, hit, kind, at: this.now() });
      setImmediate(() => {
        try { this.d.respondApproval?.(top, requestId, 'deny'); } catch (err) { console.error('[flow] 自動拒絕授權請求失敗', err); }
        this.d.note?.(top, `(主控台)協作流程「${run.flow.name}」的範圍合約禁止這個動作,已自動拒絕:${this.hitText(hit)}。commit、push、打包、合併或核准 PR、刪分支、安裝、寫入記憶庫與主控台設定資料夾,一律由使用者在授權卡上處理;請在 step_report 說明需要什麼。`);
      });
      return;
    }
    // L2:等一下,看同一個指令會不會先走授權請求(被 L1 拒絕就不中斷)
    const entry = { timer: undefined as unknown as NodeJS.Timeout, keys, tries: 0 };
    const fire = () => {
      if (this.closed) return;
      // 同一個指令的自動拒絕還沒確認(轉接器還沒回報結果):再等一下,最多約 5 秒
      const waiting = [...this.pendingDeny.values()].some(p => p.top === top && p.keys.some(k => keys.includes(k)) && this.now() - p.at < 5000);
      if (waiting && entry.tries++ < 20) { entry.timer = setTimeout(fire, 250); entry.timer.unref?.(); return; }
      const list = (this.l2.get(top) ?? []).filter(x => x !== entry);
      if (list.length) this.l2.set(top, list); else this.l2.delete(top);
      const r = this.runs.get(run.id);
      if (!r || TERMINAL_STATUSES.includes(r.status) || !r.assignments.some(x => x.id === a.id)) return;
      // 確認節點還在做這個交辦的任務才中斷(回合已經結束就只記違規並停機)
      const still = this.flowTaskOf(top);
      const mine = !!still && still.a.id === a.id;
      if (mine) { try { this.d.interrupt(top); } catch { /* 節點不在了 */ } }
      this.d.note?.(top, `(主控台)協作流程「${run.flow.name}」偵測到禁止的動作${mine ? ',已中斷這個交辦' : ''}並停機,交給使用者處理:${this.hitText(hit)}`);
      this.apply(run.id, { type: 'violation', halt: r.status !== 'stopping', violation: { kind, stepId: a.stepId, assignmentId: a.id, detail: `「${a.agentName}」在步驟「${step?.label ?? a.stepId}」執行禁止的動作(L2:${mine ? '已中斷交辦' : '回合已結束'}),依範圍合約停機`, items: hit.items, actions: [...hit.actions, ...(hit.protected.length ? ['protected'] : [])], blocked: false, at: this.now() } });
    };
    entry.timer = setTimeout(fire, this.d.guardGraceMs ?? 1000);
    entry.timer.unref?.();
    this.l2.set(top, [...(this.l2.get(top) ?? []), entry]);
  }

  /** L1 自動拒絕的結果回來了:拒絕成功 → 記違規(擋下)並取消同一個指令的 L2;使用者搶先允許 → 記違規(沒擋下),L2 照樣處理。 */
  private onDenyResolved(requestId: string, decision: string): void {
    const p = this.pendingDeny.get(requestId);
    if (!p) return;
    this.pendingDeny.delete(requestId);
    const run = this.runs.get(p.runId);
    const a = run?.assignments.find(x => x.id === p.assignmentId);
    if (!run || !a) return;
    const step = stepOf(run, a.stepId);
    const denied = decision === 'deny';
    if (denied) {
      const list = this.l2.get(p.top) ?? [];
      const keep = list.filter(x => { const same = x.keys.some(k => p.keys.includes(k)); if (same) clearTimeout(x.timer); return !same; });
      if (keep.length) this.l2.set(p.top, keep); else this.l2.delete(p.top);
    }
    this.apply(run.id, { type: 'violation', halt: false, violation: {
      kind: p.kind, stepId: a.stepId, assignmentId: a.id,
      detail: denied ? `「${a.agentName}」在步驟「${step?.label ?? a.stepId}」要求執行禁止的動作,已自動拒絕(L1)` : `「${a.agentName}」在步驟「${step?.label ?? a.stepId}」要求執行禁止的動作,自動拒絕前已被允許(L1 沒擋下,交給 L2 與事後比對)`,
      items: p.hit.items, actions: [...p.hit.actions, ...(p.hit.protected.length ? ['protected'] : [])], blocked: denied, at: this.now(),
    } });
  }

  /** Core 的每一筆更新都會轉進來;這裡只看流程交辦產生的任務(task.from.flow)與流程交辦中的節點事件(範圍合約的攔截)。 */
  onUpdate(u: Update): void {
    if (u.event) { try { this.onAgentEvent(u.event); } catch (err) { console.error('[flow] 範圍合約的攔截失敗', err); } }
    const t = u.task;
    const f = t?.from?.flow;
    if (!t || !f) return;
    if (!this.runs.has(f.runId)) return;
    // 只記最近的任務事件(Set 依加入順序,超過上限就丟掉最舊的一半)
    if (this.seenTask.size > 4000) { let n = 0; for (const k of this.seenTask) { if (n++ >= 2000) break; this.seenTask.delete(k); } }
    if (t.endedAt === null) {
      const k = `${t.id}:start`;
      if (this.seenTask.has(k)) return;
      this.seenTask.add(k);
      this.apply(f.runId, { type: 'task_started', assignmentId: f.assignmentId, taskId: t.id });
    } else {
      const k = `${t.id}:end`;
      if (this.seenTask.has(k)) return;
      this.seenTask.add(k);
      if (!this.seenTask.has(`${t.id}:start`)) { this.seenTask.add(`${t.id}:start`); this.apply(f.runId, { type: 'task_started', assignmentId: f.assignmentId, taskId: t.id }); }
      const outcome = t.status === 'done' ? 'done' : t.status === 'interrupted' ? 'interrupted' : 'failed';
      this.apply(f.runId, { type: 'turn_ended', assignmentId: f.assignmentId, taskId: t.id, outcome, sessionId: this.d.agent(t.agentId)?.sessionId ?? null });
    }
  }

  // ---- reducer 與 effect ----

  /** 把事件交給 reducer,存檔、推送、排計時器,再執行 effects。回傳這次的 effects。 */
  private apply(runId: string, event: FlowEvent): FlowEffect[] {
    const cur = this.runs.get(runId);
    if (!cur) return [];
    const { run, effects } = reduce(cur, event, this.now());
    this.runs.set(runId, run);
    // 停止中或已結束:中止還在跑的核實(終止整個程序樹)
    if (run.status === 'stopping' || TERMINAL_STATUSES.includes(run.status)) for (const ac of this.aborts.get(runId) ?? []) ac.abort();
    this.persist(run);
    this.schedule(run);
    // 主控台關閉中:不再執行新的 effect(交辦、核實…),重開時 restoreAfterRestart 會接著處理
    if (this.closed) return effects;
    // cleanup 不列入進行中的 effect:它自己要等其他 effect(例如核實)結束才清副本
    for (const e of effects) {
      const p = this.exec(run.id, e);
      if (e.type !== 'cleanup') this.track(run.id, p);
      if (e.type === 'verify') { this.verifying.add(p); void p.finally(() => this.verifying.delete(p)); }
    }
    return effects;
  }

  private persist(run: FlowRun): void {
    try { this.store.save(run); } catch (e) { console.error('[flow] 存檔失敗', e); }
    // 關閉主控台時視窗可能已經不在
    try { this.d.broadcast({ flow: this.view(run) }); } catch { /* 推送失敗不影響流程 */ }
  }

  private schedule(run: FlowRun): void {
    const old = this.timers.get(run.id);
    if (old) { clearTimeout(old); this.timers.delete(run.id); }
    if (this.closed) return;
    const at = nextDeadline(run, this.now());
    if (at === null) return;
    const t = setTimeout(() => { this.timers.delete(run.id); this.apply(run.id, { type: 'tick' }); }, Math.min(2 ** 31 - 1, Math.max(50, at - this.now() + 20)));
    t.unref?.();
    this.timers.set(run.id, t);
  }

  private track(runId: string, p: Promise<unknown>): void {
    let set = this.busy.get(runId);
    if (!set) { set = new Set(); this.busy.set(runId, set); }
    set.add(p);
    void p.finally(() => set!.delete(p));
  }

  private patch(runId: string, fn: (r: FlowRun) => void): void {
    const r = this.runs.get(runId);
    if (!r) return;
    fn(r);
    this.persist(r);
  }

  private async exec(runId: string, e: FlowEffect): Promise<void> {
    // effect 一律在目前這輪事件處理完之後才執行,避免重入
    await Promise.resolve();
    try {
      switch (e.type) {
        case 'pick_agent': {
          const agents: AgentLite[] = this.d.agents().filter(a => !a.parentId).map(a => ({ id: a.id, name: a.name, sessionId: a.sessionId, state: a.state }));
          this.apply(runId, { type: 'agents', token: e.token, agents });
          return;
        }
        case 'dispatch': return await this.dispatch(runId, e.assignmentId, e.agentId, e.wake);
        case 'remind': {
          const run = this.runs.get(runId); const a = run?.assignments.find(x => x.id === e.assignmentId); const step = run && a ? stepOf(run, a.stepId) : undefined;
          if (!run || !a || !step) return;
          try {
            const q = this.d.enqueue(a.agentId, reminderPrompt({ flowName: run.flow.name, step, attempt: a.attempt, assignmentId: a.id, topic: run.topic }), this.from(run, a));
            this.apply(runId, { type: 'dispatched', assignmentId: a.id, queuedId: q });
          } catch (err) { this.apply(runId, { type: 'dispatched', assignmentId: a.id, error: (err as Error).message }); }
          return;
        }
        case 'snapshot': return await this.snapshotStep(runId, e.token, e.assignmentId);
        case 'verify': return await this.verifyStep(runId, e.token, e.assignmentId, e.version);
        case 'export_copy': return await this.exportCopy(runId, e.token, e.version);
        case 'finish': return await this.finish(runId, e.token);
        case 'gate': {
          // 交辦前的授權卡綁定目前正本的版本
          const run = this.runs.get(runId);
          if (!run) return;
          this.apply(runId, { type: 'gate_ready', token: e.token, canonical: await snapshot(run.cwd) });
          return;
        }
        case 'ensure_ended': return await this.ensureEnded(runId, e.token, e.assignmentIds);
        case 'write_report': {
          const run = this.runs.get(runId); const a = run?.assignments.find(x => x.id === e.assignmentId);
          if (!run || !a?.report) return;
          const step = stepOf(run, a.stepId);
          const md = renderReportMd(a.report, { flowName: run.flow.name, topic: run.topic, stepLabel: step?.label ?? a.stepId, stepId: a.stepId, mode: step?.mode ?? 'write', attempt: a.attempt, agentName: a.agentName, continuation: a.continuation, version: a.version || a.reviewedVersion || '' });
          const files = this.store.writeReport(runId, a.id, a.report, md);
          this.patch(runId, r => { const x = r.assignments.find(y => y.id === a.id); if (x) x.files = [...new Set([...x.files, ...files])]; });
          return;
        }
        case 'write_late': {
          const file = this.store.writeLate(runId, e.assignmentId, { assignmentId: e.assignmentId, reason: e.reason, report: e.report, at: this.now() });
          this.patch(runId, r => { const x = r.assignments.find(y => y.id === e.assignmentId); if (x) x.files = [...new Set([...x.files, file])]; });
          return;
        }
        case 'report_ignored': return;
        case 'cleanup': {
          // 等進行中的 effect(例如核實)結束才清副本,免得刪到正在用的資料夾
          // (停止與停機時核實已被中止,很快就會結束;不設逾時,免得刪到還在用的資料夾)
          await Promise.allSettled([...(this.busy.get(runId) ?? [])]);
          await this.removeWorktrees(runId);
          const run = this.runs.get(runId);
          if (run) this.removeCopies(run);
          return;
        }
        case 'notify': {
          const run = this.runs.get(runId);
          if (e.kind === 'halted' || e.kind === 'needs_user') this.d.notifyChief(`(主控台通知)${e.message}${run ? `\n流程紀錄:${this.store.dir(run.id)}` : ''}`);
          this.d.notifyUser(e.kind === 'completed' ? '協作流程已走完' : e.kind === 'halted' ? '協作流程停機' : e.kind === 'stopped' ? '協作流程已停止' : '協作流程需要你處理', e.message);
          return;
        }
      }
    } catch (err) {
      console.error(`[flow] effect ${e.type} 失敗`, err);
      const msg = String((err as Error)?.message ?? err).slice(0, 500);
      // 非同步工作失敗也要回到狀態機,流程才不會卡住
      if (e.type === 'snapshot') this.apply(runId, { type: 'snapshot_done', token: e.token, snap: { version: null, refsChanged: [], ignored: [], changed: [], outOfScope: [], unexplained: [], copyWritten: [], error: msg } });
      else if (e.type === 'verify') { if (!this.closed) this.apply(runId, { type: 'verify_done', token: e.token, canonical: null, error: msg }); }
      else if (e.type === 'export_copy') this.apply(runId, { type: 'copy_ready', token: e.token, canonical: null, error: msg });
      else if (e.type === 'finish') this.apply(runId, { type: 'finish_done', token: e.token, canonical: null, paths: [], outOfScope: [], error: msg });
      else if (e.type === 'gate') this.apply(runId, { type: 'gate_ready', token: e.token, canonical: null, error: msg });
      else if (e.type === 'ensure_ended') this.apply(runId, { type: 'ended', token: e.token });
      else if (e.type === 'dispatch') this.apply(runId, { type: 'dispatched', assignmentId: e.assignmentId, error: msg });
    }
  }

  private from(run: FlowRun, a: RunAssignment): TaskFrom {
    return { id: `flow:${run.id}`, name: `流程「${run.flow.name}」`, flow: { runId: run.id, assignmentId: a.id, stepId: a.stepId } };
  }

  /** 副本在 copies/ 底下對應工作目錄的那一層(副本的根目錄對應 repo 根目錄)。 */
  private sub(run: FlowRun): string {
    const rel = relative(run.repoRoot, run.cwd);
    return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : '';
  }

  private removeCopies(run: FlowRun): void {
    const root = this.store.copiesDir(run.id);
    if (!existsSync(root)) return;
    let names: string[] = [];
    try { names = readdirSync(root); } catch { return; }
    for (const n of names) {
      if (!COPY_NAME_RE.test(n)) continue;
      const r = removeCopy(root, join(root, n));
      if (!r.removed) console.error(`[flow] 副本沒有刪掉:${r.error}`);
    }
  }

  private async buildPrompt(run: FlowRun, a: RunAssignment): Promise<string> {
    const step = stepOf(run, a.stepId)!;
    const read = (aid?: string): PrevReport | undefined => {
      if (!aid) return undefined;
      const src = run.assignments.find(x => x.id === aid);
      const r = this.store.readReport(run.id, aid);
      if (!src || !r) return undefined;
      return { label: stepOf(run, src.stepId)?.label ?? src.stepId, agentName: src.agentName, report: r.report, file: r.file };
    };
    const ctx = a.context;
    const prevSrc = ctx.reportFrom ? run.assignments.find(x => x.id === ctx.reportFrom) : undefined;
    let diff: string | undefined;
    if (ctx.diff) {
      try {
        const set = await diffTrees(run.cwd, ctx.diff.base, ctx.diff.end);
        diff = set.files.map(f => `--- ${f.path}(${f.status})\n${f.patch}`).join('\n') + (set.truncated ? '\n…(檔案太多,已截斷)' : '');
      } catch { diff = undefined; }
    }
    const verifySrc = ctx.verifyFrom ? run.assignments.find(x => x.id === ctx.verifyFrom) : undefined;
    const mustFix = read(ctx.mustFixFrom);
    return stepPrompt({
      flowName: run.flow.name, topic: run.topic, step, attempt: a.attempt, assignmentId: a.id, continuation: a.continuation, cwd: run.cwd,
      allowedPaths: run.flow.scope.allowedPaths, verifyCommands: run.flow.verify.commands.map(c => c.run),
      ...(step.mode === 'review' ? { copyDir: a.copyDir ? join(a.copyDir, this.sub(run)) : undefined, version: a.reviewedVersion, changed: prevSrc?.snap?.changed ?? [] } : {}),
      ...(read(ctx.reportFrom) ? { prev: read(ctx.reportFrom) } : {}),
      ...(mustFix ? { mustFix: { from: mustFix } } : {}),
      ...(verifySrc?.verify ? { verify: verifySrc.verify } : {}),
      ...(diff ? { diff } : {}),
      ...(ctx.rulings?.length ? { rulings: ctx.rulings } : {}),
    });
  }

  private async dispatch(runId: string, assignmentId: string, agentId: string, wake: boolean): Promise<void> {
    const run = this.runs.get(runId);
    const a = run?.assignments.find(x => x.id === assignmentId);
    if (!run || !a) return;
    const agent = this.d.agent(agentId);
    if (!agent) { this.apply(runId, { type: 'dispatched', assignmentId, error: '節點已經不在面板上' }); return; }
    const refsBefore = await refsState(run.repoRoot).catch(() => undefined);
    const prompt = await this.buildPrompt(run, a);
    // 交辦前狀態可能已經變了(停止、暫停後重開)
    const now = this.runs.get(runId);
    if (!now || now.current !== assignmentId || !isActive(now.assignments.find(x => x.id === assignmentId)!)) return;
    if (wake || agent.state === 'sleeping') await this.d.wake(agentId).catch(() => {});
    // 喚醒期間狀態可能又變了(停止、改派、暫停後重開):enqueue 前再確認一次
    const again = this.runs.get(runId);
    const still = again?.assignments.find(x => x.id === assignmentId);
    if (!again || again.current !== assignmentId || !still || !isActive(still) || again.ensuring || (again.status !== 'running' && again.status !== 'paused')) return;
    // 交辦前的授權卡綁定版本:允許之後(含改派、重開後繼續)正本變了就作廢,重新開卡
    if (still.approved?.length && still.approvedVersion) {
      const canon = await snapshot(run.cwd).catch(() => null);
      if (canon !== still.approvedVersion) { this.apply(runId, { type: 'gate_stale', assignmentId, canonical: canon }); return; }
      const again2 = this.runs.get(runId);
      const still2 = again2?.assignments.find(x => x.id === assignmentId);
      if (!again2 || again2.current !== assignmentId || !still2 || !isActive(still2) || again2.ensuring || (again2.status !== 'running' && again2.status !== 'paused')) return;
    }
    if (!this.d.agent(agentId)) { this.apply(runId, { type: 'dispatched', assignmentId, error: '節點已經不在面板上' }); return; }
    // 事後比對用的資料夾指紋(流程定義資料夾、主控台設定資料夾頂層、建置產出資料夾):交辦送出前拍
    let guardBefore: Record<string, string> | undefined;
    try { guardBefore = this.fingerprint(run); } catch { guardBefore = undefined; }
    const queuedId = this.d.enqueue(agentId, prompt, this.from(run, a));
    this.apply(runId, { type: 'dispatched', assignmentId, queuedId, ...(refsBefore ? { refsBefore } : {}), ...(guardBefore ? { guardBefore } : {}) });
    this.watchQueue(runId, assignmentId, queuedId);
  }

  /** 交辦排在佇列裡太久(佇列暫停、同時執行上限、節點在忙)時提示使用者。 */
  private watchQueue(runId: string, assignmentId: string, queuedId: string): void {
    const t = setTimeout(() => {
      const run = this.runs.get(runId);
      const a = run?.assignments.find(x => x.id === assignmentId);
      if (!run || !a || a.status !== 'queued' || a.queuedId !== queuedId || TERMINAL_STATUSES.includes(run.status)) return;
      const agent = this.d.agent(a.agentId);
      if (!agent?.queued.some(q => q.id === queuedId)) return;
      const why = agent.queuePaused ? `節點的佇列已暫停(${agent.queuePaused})` : ['planning', 'working', 'awaiting'].includes(agent.state) ? '節點正在做別的工作' : agent.state === 'sleeping' ? '節點在休眠' : '可能達到同時執行上限';
      const text = `交辦還在「${a.agentName}」的佇列裡排隊:${why}。單步時間從節點開始執行才算。`;
      this.apply(runId, { type: 'note', text });
      this.d.notifyUser('協作流程的交辦還在排隊', text);
    }, this.d.queueWarnMs ?? 60000);
    t.unref?.();
  }

  private async snapshotStep(runId: string, token: number, assignmentId: string): Promise<void> {
    const run = this.runs.get(runId);
    const a = run?.assignments.find(x => x.id === assignmentId);
    if (!run || !a) return;
    const mode = stepOf(run, a.stepId)?.mode ?? 'write';
    const version = await snapshot(run.cwd);
    let refsChanged: string[] = [];
    if (a.refsBefore) { try { refsChanged = diffRefs(a.refsBefore, await refsState(run.repoRoot)); } catch { /* 讀不到 refs 就不比 */ } }
    const snap: SnapResult = { version, refsChanged, ignored: [], changed: [], outOfScope: [], unexplained: [], copyWritten: [] };
    if (mode === 'review') {
      if (!a.copyDir || !a.reviewedVersion || !existsSync(a.copyDir)) snap.copyError = '審查副本已經不在(可能是主控台重開時清掉了)';
      else {
        // 比不了不等於被寫入:記成 copyError,由使用者決定重新審查或照用
        try { snap.copyWritten = await copyChanges(run.repoRoot, a.copyDir, a.reviewedVersion); } catch (e) { snap.copyError = `無法比對副本:${(e as Error).message}`; }
        const rm = removeCopy(this.store.copiesDir(run.id), a.copyDir);
        if (!rm.removed) console.error(`[flow] 審查副本沒有刪掉:${rm.error}`);
      }
    } else if (version) {
      snap.changed = (await changedPaths(run.cwd, a.baseVersion || run.baseVersion, version)).map(p => p.path);
      snap.outOfScope = outOfScope(snap.changed, run.flow.scope.allowedPaths);
      snap.unexplained = unexplained(snap.outOfScope, a.report?.scopeExceptions ?? []);
      try { snap.ignored = newIgnored(run.ignoredBase, await ignoredList(run.cwd)); } catch { /* 列不出來就不列 */ }
    }
    this.guardAfter(run, a, snap, mode === 'review' ? await ignoredList(run.cwd).then(l => newIgnored(run.ignoredBase, l)).catch(() => []) : snap.ignored);
    this.apply(runId, { type: 'snapshot_done', token, snap });
  }

  /**
   * 事後比對(L4 與受保護的資料夾):
   * - 打包產出:這次新增的被忽略產出裡的 dist/、release/(newIgnored),加上交辦前後 dist/、release/ 的指紋差異(原本就有的資料夾被改寫)。
   * - 受保護的資料夾:流程定義資料夾 flows/ 的指紋差異(工作樹外的寫入),以及版本 diff 裡落在受保護資料夾的檔案(資料夾在工作樹裡時)。
   * 已經在 L4 之前的交辦算過的產出不會重複算:ignored 是和流程開始時比;指紋是和這次交辦開始時比。
   * 主控台設定資料夾頂層的設定檔(data/…)與建置產出的深層摘要(…/**)是指紋第 2 版才有的,舊紀錄沒有就不比(免得誤判成新增)。
   */
  private guardAfter(run: FlowRun, a: RunAssignment, snap: SnapResult, ignored: string[]): void {
    const artifacts = new Set(artifactPaths(ignored, this.artifactDirs(run)));
    const prot = new Set<string>();
    if (a.guardBefore) {
      try {
        let after = this.fingerprint(run);
        if (a.guardBefore[FP_VERSION_KEY] !== after[FP_VERSION_KEY]) after = Object.fromEntries(Object.entries(after).filter(([k]) => k.startsWith('flows/') || (/^repo\d*\//.test(k) && !k.endsWith('/**'))));
        const diff = splitGuardDiff(fingerprintDiff(a.guardBefore[FP_VERSION_KEY] === after[FP_VERSION_KEY] ? a.guardBefore : Object.fromEntries(Object.entries(a.guardBefore).filter(([k]) => k !== FP_VERSION_KEY)), after));
        for (const p of diff.artifacts) artifacts.add(p);
        for (const p of diff.flows) prot.add(p);
        for (const p of diff.data) prot.add(p);
      } catch { /* 讀不到就不比 */ }
    }
    if (snap.changed.length) {
      const ctx = this.guardContext(run, a);
      const roots = [...ctx.protectedRoots, ...(ctx.forbidden.includes('real_vault') ? ctx.vaultRoots : [])];
      for (const p of protectedHits(snap.changed, roots, run.repoRoot)) prot.add(p);
    }
    if (artifacts.size) snap.artifacts = [...artifacts].sort();
    if (prot.size) snap.protectedWrites = [...prot].sort();
  }

  /** L4 的建置產出資料夾:專案設定的 artifact_dirs,沒設定時用預設的 dist、release。 */
  private artifactDirs(run: FlowRun): readonly string[] {
    return run.flow.scope.artifactDirs ?? DEFAULT_ARTIFACT_DIRS;
  }

  /** 交辦前後比對用的資料夾指紋(guard.ts 的 guardFingerprint),加上版本標記。 */
  private fingerprint(run: FlowRun): Record<string, string> {
    return { [FP_VERSION_KEY]: '2', ...guardFingerprint({ flowsDir: this.flowsDir(), repoDirs: [run.repoRoot, run.cwd], artifactDirs: this.artifactDirs(run), dataDir: this.d.dataDir }) };
  }

  private async exportCopy(runId: string, token: number, version: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    const canonical = await snapshot(run.cwd);
    if (canonical !== version) { this.apply(runId, { type: 'copy_ready', token, canonical }); return; }
    const root = this.store.copiesDir(run.id);
    mkdirSync(root, { recursive: true });
    const dir = join(root, `r-${version.slice(0, 8)}-${token}`);
    await exportTree(run.repoRoot, version, dir);
    this.apply(runId, { type: 'copy_ready', token, dir, canonical });
  }

  /**
   * 核實:從版本匯出核實副本(或 verify_in: worktree 時建獨立 worktree)、接上 node_modules,跑核實指令,
   * 每條指令跑完比對有沒有改到檔案;最後清掉副本,並再拍一次正本(核實期間版本有沒有變)。
   * runVerify 一律把 NEXUS_DATA_DIR 指到臨時資料夾,被測的主控台碰不到真實資料。
   */
  private async verifyStep(runId: string, token: number, assignmentId: string, version: string): Promise<void> {
    const run = this.runs.get(runId);
    const a = run?.assignments.find(x => x.id === assignmentId);
    if (!run || !a) return;
    const root = this.store.copiesDir(run.id);
    mkdirSync(root, { recursive: true });
    const dir = join(root, `v-${version.slice(0, 8)}-${token}`);
    const sub = this.sub(run);
    const useWorktree = run.flow.verify.in === 'worktree';
    let wt: { path: string; commit: string } | null = null;
    let desk: { path: string; commit: string } | null = null;
    let exclude: string[] = [];
    const ac = new AbortController();
    let set = this.aborts.get(runId);
    if (!set) { set = new Set(); this.aborts.set(runId, set); }
    set.add(ac);
    const remember = (w: { path: string; commit: string }) => this.patch(runId, x => { x.worktrees = [...(x.worktrees ?? []).filter(y => y.path !== w.path), { path: w.path, commit: w.commit }]; });
    const forget = (path: string) => this.patch(runId, x => { x.worktrees = (x.worktrees ?? []).filter(y => y.path !== path); });
    // 隔離用的主控台資料夾(核實指令的 NEXUS_DATA_DIR,使用者裁示第 3 點):自己建、自己刪,關閉主控台時還在的由 shutdown 刪
    let dataDir = '';
    try {
      dataDir = mkdtempSync(join(tmpdir(), 'nexus-flow-data-'));
      this.verifyData.add(dataDir);
      if (useWorktree) { const w = await addDetachedWorktree(run.repoRoot, version, dir); wt = w; exclude = w.linked; remember(w); }
      else { await exportTree(run.repoRoot, version, dir); exclude = linkDeps(run.repoRoot, dir).linked; }
      const needDesktop = run.allowDesktop && run.flow.verify.commands.some(c => c.desktop);
      if (needDesktop) {
        try { const w = await addDetachedWorktree(run.repoRoot, version, join(root, `w-${version.slice(0, 8)}-${token}`)); desk = w; remember(w); } catch (e) { console.error('[flow] 建立桌面核實的 worktree 失敗', e); }
      }
      const result = await runVerify({
        cwd: join(dir, sub), location: useWorktree ? 'worktree' : 'copy', commands: run.flow.verify.commands, version,
        allowDesktop: run.allowDesktop, ...(desk ? { desktopCwd: join(desk.path, sub) } : {}),
        logDir: this.store.logsDir(run.id, a.id), signal: ac.signal, dataDir,
        detectChanges: async (cwd: string) => copyChanges(run.repoRoot, cwd.startsWith(dir) ? dir : desk?.path ?? dir, version, exclude),
      });
      const logs = result.commands.map(c => c.logFile).filter(Boolean);
      this.patch(runId, r => { const x = r.assignments.find(y => y.id === a.id); if (x) x.files = [...new Set([...x.files, ...logs])]; });
      // 被中止的核實(停止、停機、關閉主控台)沒有跑完,不能當成結果(被略過的指令不算通過);重開後會重新核實
      if (ac.signal.aborted) return;
      const canonical = await snapshot(run.cwd);
      this.apply(runId, { type: 'verify_done', token, result, canonical });
    } catch (e) {
      // 已中止(停止、停機)或主控台關閉中:不再送核實失敗給狀態機,重開後會重新核實
      if (ac.signal.aborted || this.closed) { console.error('[flow] 核實中止時出錯(已忽略)', e); return; }
      throw e;
    } finally {
      set.delete(ac);
      if (dataDir) { try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); this.verifyData.delete(dataDir); } catch (e) { console.error(`[flow] 核實臨時資料夾沒有刪掉:${dataDir}`, e); } }
      if (wt) { const r = await removeDetachedWorktree(run.repoRoot, wt.path, wt.commit); if (r.removed) forget(wt.path); else console.error(`[flow] 核實 worktree 沒有移除:${r.error}`); }
      else { const r = removeCopy(root, dir); if (!r.removed && existsSync(dir)) console.error(`[flow] 核實副本沒有刪掉:${r.error}`); }
      if (desk) { const r = await removeDetachedWorktree(run.repoRoot, desk.path, desk.commit); if (r.removed) forget(desk.path); else console.error(`[flow] 桌面核實 worktree 沒有移除:${r.error}`); }
    }
  }

  private async finish(runId: string, token: number): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    const canonical = await snapshot(run.cwd);
    let paths = canonical ? (await changedPaths(run.cwd, run.baseVersion, canonical)).map(p => p.path) : [];
    // 已經在 HEAD 裡的修改(節點經授權自己 commit 過)不放進 commit 授權卡;全都在就不產生卡片並說明
    let note: string | undefined;
    if (canonical && paths.length) {
      const pending = await this.pendingVsHead(run.cwd, canonical);
      if (pending) {
        const left = paths.filter(p => pending.has(p));
        if (!left.length) note = '流程走完;這次的修改已經都在 HEAD 裡(可能是節點經授權自己 commit 過),沒有東西要提交,不產生 commit 授權卡';
        paths = left;
      }
    }
    const outside = outOfScope(paths, run.flow.scope.allowedPaths);
    // 授權卡列出範圍外檔案的說明:各寫入步驟回報的 scope_exceptions(同一個檔案取最後一次),沒寫原因的另外標示
    const exceptions = run.assignments.filter(a => a.report && stepOf(run, a.stepId)?.mode === 'write').flatMap(a => a.report!.scopeExceptions);
    const fold = (p: string) => { const s = p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, ''); return WIN ? s.toLowerCase() : s; };
    const reasons = new Map<string, string>();
    for (const e of exceptions) if (e.reason.trim()) reasons.set(fold(e.path), e.reason.trim());
    const scopeNotes: ScopeException[] = outside.filter(p => reasons.has(fold(p))).map(p => ({ path: p, reason: reasons.get(fold(p))! }));
    this.apply(runId, { type: 'finish_done', token, canonical, paths, outOfScope: outside, scopeNotes, unexplained: unexplained(outside, exceptions), ...(note ? { note } : {}) });
  }

  /**
   * 停止、改派、重跑前確認原交辦已經結束(計畫 §3.2 第 5 點):
   * 還在佇列 → 取消那一筆;任務還在跑而且是節點目前的任務 → 中斷,沒結束就每隔幾秒重發(送出前在拍快照時中斷可能無效);
   * 佇列已取出、任務還沒建立的空檔 → 等任務出現;節點正在做別人的任務 → 不中斷。
   * 逾時(預設 30 秒)不默認已結束:回報 ok: false,由狀態機交給使用者(再等、強制視為結束、停止流程)。
   */
  private async ensureEnded(runId: string, token: number, assignmentIds: string[]): Promise<void> {
    const limit = this.now() + (this.d.ensureTimeoutMs ?? 30000);
    const every = this.d.reinterruptMs ?? 3000;
    const lastInterrupt = new Map<string, number>();
    let stuck: string[] = [];
    for (;;) {
      const run = this.runs.get(runId);
      if (!run || run.ensuring?.token !== token) return; // 已經被別的決定取代
      stuck = [];
      for (const aid of assignmentIds) {
        const a = run.assignments.find(x => x.id === aid);
        if (!a) continue;
        const agent = this.d.agent(a.agentId);
        if (!agent) continue; // 節點不在了,行程也不在了
        // 還在佇列:取消
        if (a.queuedId && agent.queued.some(q => q.id === a.queuedId)) { this.d.cancelQueued(a.agentId, a.queuedId); continue; }
        const tasks = a.taskIds.map(id => this.d.task(id)).filter((t): t is TaskInfo => !!t);
        let running = false;
        for (const t of tasks) {
          if (t.endedAt !== null) continue;
          if (this.d.currentTaskId(t.agentId) !== t.id) continue; // 節點在做別人的任務:不中斷
          running = true;
          const last = lastInterrupt.get(t.id) ?? 0;
          if (this.now() - last >= every) { lastInterrupt.set(t.id, this.now()); this.d.interrupt(t.agentId); }
        }
        // 佇列已經取出、任務還沒建立(送出前在拍快照):等任務出現再中斷
        const gap = !!a.queuedId && !tasks.some(t => t.endedAt === null) && a.status === 'queued';
        if (running || gap) stuck.push(a.agentName);
      }
      if (!stuck.length) break;
      if (this.now() > limit) { this.apply(runId, { type: 'ended', token, ok: false, stuck: [...new Set(stuck)] }); return; }
      await sleep(200);
    }
    this.apply(runId, { type: 'ended', token, ok: true });
  }
}
