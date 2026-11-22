import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dump, JSON_SCHEMA, load } from 'js-yaml';
import {
  ALWAYS_FORBIDDEN, DONE, FORBIDDEN_ACTIONS, HALT, HIGH_RISK_ACTIONS, NEVER_ALLOWED_ACTIONS, STEP_MODES, VERIFY_TIMEOUT_MAX,
  type FlowDefinition, type FlowLimits, type FlowParseResult, type FlowRoleDef, type FlowSource, type FlowStepDef,
  type ForbiddenAction, type HighRiskAction, type ProjectFlowConfig, type ProjectsFileResult, type StepMode, type VerifyCommandDef,
} from '../../shared/flow.ts';

/**
 * 流程定義:解析與驗證 YAML、合併專案覆寫、載入使用者自訂範本。格式見 docs/協作流程實作計畫.md §2。
 * YAML 一律用 JSON_SCHEMA 解析:不接受自訂型別、不會執行任何東西,日期之類的值也只當字串。
 * 驗證失敗回傳 errors(flow 為 null);不認得的欄位只記 warnings。
 */

const ID_RE = /^[a-z0-9-]+$/;
const STEP_ID_RE = /^[a-z0-9_-]+$/;
const PROJECTS_FILE = 'projects.yaml';

const DEFAULT_LIMITS: FlowLimits = { maxRejections: 2, maxMinutes: 180, stepMinutes: 45, reminderMinutes: 10, maxDispatches: 12 };
const LIMIT_KEYS: Record<string, keyof FlowLimits> = {
  max_rejections: 'maxRejections', max_minutes: 'maxMinutes', step_minutes: 'stepMinutes', reminder_minutes: 'reminderMinutes', max_dispatches: 'maxDispatches',
};

const TOP_KEYS = ['id', 'name', 'version', 'description', 'roles', 'limits', 'scope', 'verify', 'steps', 'finish'];
const STEP_KEYS = ['id', 'label', 'role', 'mode', 'verify', 'on_reject', 'next', 'continue_session', 'requires_approval', 'inputs', 'outputs'];
const COMMAND_KEYS = ['id', 'run', 'timeout', 'needs', 'desktop'];
/** 看起來想把高風險動作設成免授權的欄位:一律拒絕(規格 §7:流程定義不能繞過授權卡)。 */
const BYPASS_KEYS = ['auto_approve', 'skip_approval', 'no_approval', 'allowed_actions', 'approved_actions', 'pre_approved'];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 一次解析的收集器:錯誤與警告都帶上位置,方便使用者找到寫錯的地方。 */
interface Ctx { errors: string[]; warnings: string[] }

function unknownKeys(ctx: Ctx, where: string, o: Obj, known: string[]): void {
  for (const k of Object.keys(o)) {
    if (BYPASS_KEYS.includes(k)) ctx.errors.push(`${where}.${k}:高風險動作一律要使用者在授權卡上確認,流程定義不能設成免授權(請改用 requires_approval)`);
    else if (!known.includes(k)) ctx.warnings.push(`${where}:不認得的欄位「${k}」,已忽略`);
  }
}

function str(ctx: Ctx, where: string, v: unknown, required: boolean): string {
  if (v === undefined || v === null) { if (required) ctx.errors.push(`${where}:必填`); return ''; }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v !== 'string') { ctx.errors.push(`${where}:必須是文字`); return ''; }
  if (required && !v.trim()) ctx.errors.push(`${where}:必填`);
  return v.trim();
}

function strList(ctx: Ctx, where: string, v: unknown): string[] {
  if (v === undefined || v === null) return [];
  const list = typeof v === 'string' ? [v] : v;
  if (!Array.isArray(list)) { ctx.errors.push(`${where}:必須是清單`); return []; }
  const out: string[] = [];
  for (const [i, x] of list.entries()) {
    if (typeof x !== 'string' && typeof x !== 'number') { ctx.errors.push(`${where}[${i}]:必須是文字`); continue; }
    const s = String(x).trim();
    if (s) out.push(s);
  }
  return out;
}

function bool(ctx: Ctx, where: string, v: unknown, fallback: boolean): boolean {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'boolean') { ctx.errors.push(`${where}:必須是 true 或 false`); return fallback; }
  return v;
}

function positive(ctx: Ctx, where: string, v: unknown, fallback: number): number {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) { ctx.errors.push(`${where}:必須是大於 0 的數字`); return fallback; }
  return v;
}

function mode(ctx: Ctx, where: string, v: unknown): StepMode {
  if (typeof v === 'string' && (STEP_MODES as readonly string[]).includes(v)) return v as StepMode;
  ctx.errors.push(v === undefined || v === null ? `${where}:必填(write 或 review)` : `${where}:只能是 write 或 review,收到「${String(v)}」`);
  return 'write';
}

function actions<T extends string>(ctx: Ctx, where: string, v: unknown, allowed: readonly T[], what: string): T[] {
  const out: T[] = [];
  for (const a of strList(ctx, where, v)) {
    if ((NEVER_ALLOWED_ACTIONS as readonly string[]).includes(a) && !(allowed as readonly string[]).includes(a)) ctx.errors.push(`${where}:「${a}」永遠禁止(合併 PR、核准 PR、force push、刪分支),流程定義不能開放`);
    else if (!(allowed as readonly string[]).includes(a)) ctx.errors.push(`${where}:「${a}」不是${what}(可用:${allowed.join('、')})`);
    else if (!out.includes(a as T)) out.push(a as T);
  }
  return out;
}

/**
 * 解析核實指令清單並檢查 id 唯一、逾時、一層 needs。
 * partial 為 true 時(專案設定的 append)needs 可以指向範本裡的指令,所以只檢查重複與自我依賴,其餘留給 applyProject 合併後檢查。
 */
function parseCommands(ctx: Ctx, where: string, v: unknown, partial = false): VerifyCommandDef[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) { ctx.errors.push(`${where}:必須是清單`); return []; }
  const out: VerifyCommandDef[] = [];
  for (const [i, raw] of v.entries()) {
    const at = `${where}[${i}]`;
    if (!isObj(raw)) { ctx.errors.push(`${at}:必須是物件(id、run、timeout)`); continue; }
    unknownKeys(ctx, at, raw, COMMAND_KEYS);
    const id = str(ctx, `${at}.id`, raw.id, true);
    if (id && !STEP_ID_RE.test(id)) ctx.errors.push(`${at}.id:只能用小寫英文、數字、- 與 _`);
    const run = str(ctx, `${at}.run`, raw.run, true);
    let timeout = 0;
    if (raw.timeout === undefined || raw.timeout === null) ctx.errors.push(`${at}.timeout:每條核實指令都必須有逾時(秒)`);
    else if (typeof raw.timeout !== 'number' || !Number.isFinite(raw.timeout) || raw.timeout <= 0) ctx.errors.push(`${at}.timeout:必須是大於 0 的秒數`);
    else if (raw.timeout > VERIFY_TIMEOUT_MAX) ctx.errors.push(`${at}.timeout:上限 ${VERIFY_TIMEOUT_MAX} 秒`);
    else timeout = raw.timeout;
    out.push({ id, run, timeout, needs: strList(ctx, `${at}.needs`, raw.needs), desktop: bool(ctx, `${at}.desktop`, raw.desktop, false) });
  }
  checkCommandGraph(ctx, where, out, partial);
  return out;
}

function checkCommandGraph(ctx: Ctx, where: string, cmds: VerifyCommandDef[], partial = false): void {
  const ids = new Map<string, VerifyCommandDef>();
  for (const c of cmds) {
    if (!c.id) continue;
    if (ids.has(c.id)) ctx.errors.push(`${where}:指令 id「${c.id}」重複`);
    ids.set(c.id, c);
  }
  for (const c of cmds) {
    for (const n of c.needs) {
      if (n === c.id) ctx.errors.push(`${where}:指令「${c.id}」不能依賴自己`);
      else if (partial) continue;
      else if (!ids.has(n)) ctx.errors.push(`${where}:指令「${c.id}」的 needs 指向不存在的「${n}」`);
      else if (ids.get(n)!.needs.length) ctx.errors.push(`${where}:needs 只支援一層,「${c.id}」依賴的「${n}」本身又有 needs`);
    }
  }
}

function parseRoles(ctx: Ctx, v: unknown): Record<string, FlowRoleDef> {
  const roles: Record<string, FlowRoleDef> = {};
  if (v === undefined || v === null) { ctx.errors.push('roles:必填'); return roles; }
  if (!isObj(v)) { ctx.errors.push('roles:必須是「角色名稱: { mode, description }」的對照'); return roles; }
  for (const [name, raw] of Object.entries(v)) {
    const at = `roles.${name}`;
    if (!STEP_ID_RE.test(name)) ctx.errors.push(`${at}:角色名稱只能用小寫英文、數字、- 與 _`);
    if (!isObj(raw)) { ctx.errors.push(`${at}:必須是物件(mode、description)`); continue; }
    unknownKeys(ctx, at, raw, ['mode', 'description']);
    roles[name] = { mode: mode(ctx, `${at}.mode`, raw.mode), description: str(ctx, `${at}.description`, raw.description, false) };
  }
  if (!Object.keys(roles).length) ctx.errors.push('roles:至少要有一個角色');
  return roles;
}

function parseSteps(ctx: Ctx, v: unknown, roles: Record<string, FlowRoleDef>): FlowStepDef[] {
  if (!Array.isArray(v) || !v.length) { ctx.errors.push(v === undefined || v === null ? 'steps:必填' : 'steps:必須是非空的清單'); return []; }
  const steps: FlowStepDef[] = [];
  for (const [i, raw] of v.entries()) {
    const at = `steps[${i}]`;
    if (!isObj(raw)) { ctx.errors.push(`${at}:必須是物件`); continue; }
    unknownKeys(ctx, at, raw, STEP_KEYS);
    const id = str(ctx, `${at}.id`, raw.id, true);
    if (id && !STEP_ID_RE.test(id)) ctx.errors.push(`${at}.id:只能用小寫英文、數字、- 與 _`);
    if (id === HALT || id === DONE) ctx.errors.push(`${at}.id:「${id}」是保留字`);
    const role = str(ctx, `${at}.role`, raw.role, true);
    if (role && !roles[role]) ctx.errors.push(`${at}.role:「${role}」不在 roles 裡`);
    const m = mode(ctx, `${at}.mode`, raw.mode);
    if (role && roles[role] && roles[role].mode !== m) ctx.warnings.push(`${at}:步驟的 mode(${m})和角色「${role}」的 mode(${roles[role].mode})不同,以步驟為準`);
    if (raw.requires_approval === true) ctx.errors.push(`${at}.requires_approval:請列出需要授權的動作(例如 [commit])`);
    const verify = bool(ctx, `${at}.verify`, raw.verify, false);
    if (verify && m === 'review') ctx.warnings.push(`${at}:review 步驟不會改檔,verify: true 沒有作用`);
    steps.push({
      id,
      label: str(ctx, `${at}.label`, raw.label, false) || id,
      role,
      mode: m,
      verify,
      onReject: raw.on_reject === undefined || raw.on_reject === null ? undefined : str(ctx, `${at}.on_reject`, raw.on_reject, true),
      next: raw.next === undefined || raw.next === null ? undefined : str(ctx, `${at}.next`, raw.next, true),
      continueSession: bool(ctx, `${at}.continue_session`, raw.continue_session, false),
      requiresApproval: raw.requires_approval === true ? [] : actions(ctx, `${at}.requires_approval`, raw.requires_approval, HIGH_RISK_ACTIONS, '高風險動作'),
      inputs: strList(ctx, `${at}.inputs`, raw.inputs),
      outputs: strList(ctx, `${at}.outputs`, raw.outputs),
    });
  }
  const ids = new Set<string>();
  for (const s of steps) {
    if (s.id && ids.has(s.id)) ctx.errors.push(`steps:步驟 id「${s.id}」重複`);
    ids.add(s.id);
  }
  for (const s of steps) {
    if (s.onReject !== undefined && s.onReject !== HALT && !ids.has(s.onReject)) ctx.errors.push(`steps.${s.id}.on_reject:指向不存在的步驟「${s.onReject}」(或用 ${HALT})`);
    if (s.next !== undefined && s.next !== HALT && s.next !== DONE && !ids.has(s.next)) ctx.errors.push(`steps.${s.id}.next:指向不存在的步驟「${s.next}」(或用 ${DONE}、${HALT})`);
  }
  return steps;
}

/** 解析一份流程 YAML。source、file 只是標記來源,不影響驗證。 */
export function parseFlow(text: string, source: FlowSource = 'user', file?: string): FlowParseResult {
  const ctx: Ctx = { errors: [], warnings: [] };
  let doc: unknown;
  try { doc = load(text, { schema: JSON_SCHEMA, filename: file }); } catch (e) {
    return { flow: null, errors: [`YAML 格式錯誤:${(e as Error).message.split('\n')[0]}`], warnings: [] };
  }
  if (!isObj(doc)) return { flow: null, errors: ['流程定義必須是 YAML 物件'], warnings: [] };
  unknownKeys(ctx, '流程', doc, TOP_KEYS);

  const id = str(ctx, 'id', doc.id, true);
  if (id && !ID_RE.test(id)) ctx.errors.push('id:只能用小寫英文、數字與 -');
  const name = str(ctx, 'name', doc.name, true);
  const version = doc.version === undefined ? 1 : positive(ctx, 'version', doc.version, 1);
  const roles = parseRoles(ctx, doc.roles);

  const limits = { ...DEFAULT_LIMITS };
  if (doc.limits !== undefined && doc.limits !== null) {
    if (!isObj(doc.limits)) ctx.errors.push('limits:必須是物件');
    else {
      unknownKeys(ctx, 'limits', doc.limits, Object.keys(LIMIT_KEYS));
      for (const [k, key] of Object.entries(LIMIT_KEYS)) {
        // 退回 0 輪也合理(第一次有必修就停機),其他上限都要大於 0
        if (key === 'maxRejections' && doc.limits[k] === 0) limits.maxRejections = 0;
        else limits[key] = positive(ctx, `limits.${k}`, doc.limits[k], DEFAULT_LIMITS[key]);
      }
      if (!Number.isInteger(limits.maxRejections) || !Number.isInteger(limits.maxDispatches)) ctx.errors.push('limits:max_rejections、max_dispatches 必須是整數');
    }
  }

  let allowedPaths: string[] = [];
  let forbidden: ForbiddenAction[] = [];
  if (doc.scope !== undefined && doc.scope !== null) {
    if (!isObj(doc.scope)) ctx.errors.push('scope:必須是物件');
    else {
      unknownKeys(ctx, 'scope', doc.scope, ['allowed_paths', 'forbidden_actions']);
      allowedPaths = strList(ctx, 'scope.allowed_paths', doc.scope.allowed_paths);
      forbidden = actions(ctx, 'scope.forbidden_actions', doc.scope.forbidden_actions, FORBIDDEN_ACTIONS, '可禁止的動作');
    }
  }
  // commit、push、dist 一律禁止(節點不能自己做,要經授權卡由主控台執行)
  for (const a of ALWAYS_FORBIDDEN) if (!forbidden.includes(a)) forbidden.push(a);

  let commands: VerifyCommandDef[] = [];
  if (doc.verify !== undefined && doc.verify !== null) {
    if (!isObj(doc.verify)) ctx.errors.push('verify:必須是物件(commands)');
    else { unknownKeys(ctx, 'verify', doc.verify, ['commands']); commands = parseCommands(ctx, 'verify.commands', doc.verify.commands); }
  }

  const steps = parseSteps(ctx, doc.steps, roles);

  let offer: HighRiskAction[] = [];
  if (doc.finish !== undefined && doc.finish !== null) {
    if (!isObj(doc.finish)) ctx.errors.push('finish:必須是物件(offer)');
    else { unknownKeys(ctx, 'finish', doc.finish, ['offer']); offer = actions(ctx, 'finish.offer', doc.finish.offer, HIGH_RISK_ACTIONS, '高風險動作'); }
  }

  if (ctx.errors.length) return { flow: null, errors: ctx.errors, warnings: ctx.warnings };
  return {
    flow: {
      id, name, version, description: str(ctx, 'description', doc.description, false), roles, limits,
      scope: { allowedPaths, forbiddenActions: forbidden }, verify: { commands, in: 'copy' }, steps, finish: { offer }, source, file,
    },
    errors: [],
    warnings: ctx.warnings,
  };
}

/**
 * 套用專案覆寫:核實指令 replace(整組取代)或 append(接在範本後面)、allowed_paths 取代。
 * 不修改傳入的 flow。合併後的指令 id 重複或 needs 指不到時回傳 errors。
 */
export function applyProject(flow: FlowDefinition, cfg?: ProjectFlowConfig | null): FlowParseResult {
  if (!cfg) return { flow, errors: [], warnings: [] };
  const ctx: Ctx = { errors: [], warnings: [] };
  let commands = flow.verify.commands;
  if (cfg.verify) commands = cfg.verify.mode === 'replace' ? cfg.verify.commands : [...commands, ...cfg.verify.commands];
  checkCommandGraph(ctx, '專案覆寫後的 verify.commands', commands);
  for (const role of Object.keys(cfg.roles)) if (!flow.roles[role]) ctx.warnings.push(`專案設定的角色「${role}」不在流程「${flow.id}」裡,已忽略`);
  if (ctx.errors.length) return { flow: null, errors: ctx.errors, warnings: ctx.warnings };
  return {
    flow: {
      ...flow,
      scope: { ...flow.scope, allowedPaths: cfg.allowedPaths ? [...cfg.allowedPaths] : [...flow.scope.allowedPaths] },
      verify: { commands: commands.map(c => ({ ...c, needs: [...c.needs] })), in: cfg.verifyIn ?? flow.verify.in },
    },
    errors: [],
    warnings: ctx.warnings,
  };
}

/**
 * 載入使用者自訂範本:<flowsDir>/*.yaml(projects.yaml 除外)。
 * 解析失敗的也回傳(flow 為 null),讓介面能告訴使用者哪個檔案寫錯。
 */
export function loadUserTemplates(flowsDir: string): (FlowParseResult & { file: string })[] {
  if (!existsSync(flowsDir)) return [];
  let names: string[];
  try { names = readdirSync(flowsDir).filter(n => /\.ya?ml$/i.test(n) && n.toLowerCase() !== PROJECTS_FILE).sort(); } catch { return []; }
  return names.map(n => {
    const file = join(flowsDir, n);
    let text: string;
    try { text = readFileSync(file, 'utf8'); } catch (e) { return { file, flow: null, errors: [`讀不到檔案:${(e as Error).message}`], warnings: [] }; }
    return { file, ...parseFlow(text, 'user', file) };
  });
}

/**
 * projects.yaml 的格式:projects: { <專案 id>: { roles, verify: { mode, commands }, verify_in, allowed_paths, allow_desktop_verify } }
 * 一個專案寫錯不影響其他專案:寫錯的專案不放進 projects,改放進 invalid(附原始內容),
 * dumpProjectsFile 寫回時把它原樣保留,不會洗掉使用者的設定。
 */
export function parseProjectsFile(text: string): ProjectsFileResult {
  const ctx: Ctx = { errors: [], warnings: [] };
  const projects: Record<string, ProjectFlowConfig> = {};
  const invalid: ProjectsFileResult['invalid'] = {};
  const done = () => ({ projects, invalid, errors: ctx.errors, warnings: ctx.warnings });
  if (!text.trim()) return done();
  let doc: unknown;
  try { doc = load(text, { schema: JSON_SCHEMA }); } catch (e) {
    ctx.errors.push(`YAML 格式錯誤:${(e as Error).message.split('\n')[0]}`);
    return done();
  }
  if (doc === null || doc === undefined) return done();
  if (!isObj(doc)) { ctx.errors.push('projects.yaml 必須是 YAML 物件'); return done(); }
  unknownKeys(ctx, 'projects.yaml', doc, ['projects']);
  if (doc.projects === undefined || doc.projects === null) return done();
  if (!isObj(doc.projects)) { ctx.errors.push('projects:必須是「專案 id: 設定」的對照'); return done(); }
  for (const [projectId, raw] of Object.entries(doc.projects)) {
    const at = `projects.${projectId}`;
    // 每個專案用自己的收集器,寫錯的只影響自己
    const p: Ctx = { errors: [], warnings: [] };
    const cfg = parseProject(p, at, projectId, raw);
    ctx.warnings.push(...p.warnings);
    if (p.errors.length || !cfg) { ctx.errors.push(...p.errors); invalid[projectId] = { errors: p.errors, raw }; } else projects[projectId] = cfg;
  }
  return done();
}

function parseProject(ctx: Ctx, at: string, projectId: string, raw: unknown): ProjectFlowConfig | null {
  if (!isObj(raw)) { ctx.errors.push(`${at}:必須是物件`); return null; }
  unknownKeys(ctx, at, raw, ['roles', 'verify', 'verify_in', 'allowed_paths', 'allow_desktop_verify']);
  const roles: Record<string, string> = {};
  if (raw.roles !== undefined && raw.roles !== null) {
    if (!isObj(raw.roles)) ctx.errors.push(`${at}.roles:必須是「角色: 節點」的對照`);
    else for (const [role, agent] of Object.entries(raw.roles)) { const s = str(ctx, `${at}.roles.${role}`, agent, true); if (s) roles[role] = s; }
  }
  const cfg: ProjectFlowConfig = { projectId, roles, allowDesktopVerify: bool(ctx, `${at}.allow_desktop_verify`, raw.allow_desktop_verify, false) };
  if (raw.allowed_paths !== undefined && raw.allowed_paths !== null) cfg.allowedPaths = strList(ctx, `${at}.allowed_paths`, raw.allowed_paths);
  if (raw.verify_in !== undefined && raw.verify_in !== null) {
    if (raw.verify_in === 'copy' || raw.verify_in === 'worktree') cfg.verifyIn = raw.verify_in;
    else ctx.errors.push(`${at}.verify_in:只能是 copy 或 worktree`);
  }
  if (raw.verify !== undefined && raw.verify !== null) {
    if (!isObj(raw.verify)) ctx.errors.push(`${at}.verify:必須是物件(mode、commands)`);
    else {
      unknownKeys(ctx, `${at}.verify`, raw.verify, ['mode', 'commands']);
      const m = raw.verify.mode ?? 'append';
      if (m !== 'replace' && m !== 'append') ctx.errors.push(`${at}.verify.mode:只能是 replace 或 append`);
      const mode = m === 'replace' ? 'replace' : 'append';
      // append 的 needs 可以指向範本裡的指令,合併後由 applyProject 檢查
      cfg.verify = { mode, commands: parseCommands(ctx, `${at}.verify.commands`, raw.verify.commands, mode === 'append') };
    }
  }
  return cfg;
}

/**
 * 把專案設定寫回 projects.yaml 的文字(parseProjectsFile 讀得回來)。
 * invalid(parseProjectsFile 回傳的寫錯的專案)原樣保留,除非 projects 裡有同一個專案的新設定。
 */
export function dumpProjectsFile(projects: Record<string, ProjectFlowConfig>, invalid: ProjectsFileResult['invalid'] = {}): string {
  const out: Obj = {};
  for (const [id, bad] of Object.entries(invalid)) if (!projects[id]) out[id] = bad.raw;
  for (const [id, p] of Object.entries(projects)) {
    const o: Obj = {};
    if (Object.keys(p.roles).length) o.roles = { ...p.roles };
    if (p.verify) {
      o.verify = {
        mode: p.verify.mode,
        commands: p.verify.commands.map(c => {
          const cmd: Obj = { id: c.id, run: c.run, timeout: c.timeout };
          if (c.needs.length) cmd.needs = [...c.needs];
          if (c.desktop) cmd.desktop = true;
          return cmd;
        }),
      };
    }
    if (p.verifyIn) o.verify_in = p.verifyIn;
    if (p.allowedPaths) o.allowed_paths = [...p.allowedPaths];
    o.allow_desktop_verify = p.allowDesktopVerify;
    out[id] = o;
  }
  return `# Entropy Nexus 協作流程的專案設定(由主控台寫入,也可以手動編輯)\n${dump({ projects: out }, { schema: JSON_SCHEMA, lineWidth: -1, noRefs: true })}`;
}
