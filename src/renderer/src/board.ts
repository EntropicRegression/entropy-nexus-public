import 'pixi.js/unsafe-eval';
import { Application, Circle, Container, Graphics, Matrix, Text, Texture } from 'pixi.js';
import { STATE_LABEL, STATE_ZONE, type AgentInfo, type Zone } from '../../shared/types';
import { BACKEND_COLOR, COLOR, STATE_COLOR, ZONE_COLOR, ZONE_TITLE } from './theme';

const FONT = '"Segoe UI", "Microsoft JhengHei", sans-serif';
const CELL_W = 124;
const CELL_H = 96;
const HEADER = 44;
const ZONES: Zone[] = ['planning', 'active', 'chief', 'standby', 'auth', 'fault'];

interface Rect { x: number; y: number; w: number; h: number }

const hexPoints = (r: number): number[] => {
  const pts: number[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i;
    pts.push(Math.cos(a) * r, Math.sin(a) * r);
  }
  return pts;
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** 一個節點的圖形:六角形(有 Q 版頭像時把頭像畫在裡面)、名稱、一行狀態讀數。 */
class NodeView {
  readonly root = new Container();
  private glow = new Graphics();
  private body = new Graphics();
  private ring = new Graphics();
  /**
   * Q 版頭像:直接把圖片當成六角形的填色來畫(Graphics 的貼圖填色),外框與右下角的狀態點畫在它上面。
   * 不用 Sprite 加遮罩:遮罩要靠模板緩衝區,節點增減、透明度變化時曾經出現整塊白色多邊形的破圖。
   */
  private avatar = new Graphics();
  private frame = new Graphics();
  private tex: Texture | null = null;
  private name = new Text({ text: '', style: { fontFamily: FONT, fontSize: 13, fontWeight: '600', fill: COLOR.text } });
  private readout = new Text({ text: '', style: { fontFamily: FONT, fontSize: 11, fill: COLOR.dim } });
  private auto = new Text({ text: 'AUTO', style: { fontFamily: FONT, fontSize: 9, fontWeight: '700', fill: COLOR.warn, letterSpacing: 1 } });
  private state: AgentInfo['state'] = 'idle';
  private key = '';
  tx = 0;
  ty = 0;
  /** 區塊排不下時由版面設定的縮放。 */
  zoom = 1;
  private subScale = 1;
  placed = false;

  constructor(readonly id: string, onTap: (id: string) => void, onHover: (id: string | null) => void) {
    this.name.anchor.set(0.5, 0);
    this.readout.anchor.set(0.5, 0);
    this.name.y = 30;
    this.readout.y = 48;
    // AUTO 標記放在六角形的右上角(放正上方會和上一列節點的狀態文字重疊)
    this.auto.anchor.set(0, 0.5);
    this.root.addChild(this.glow, this.ring, this.body, this.avatar, this.frame, this.name, this.readout, this.auto);
    this.root.eventMode = 'static';
    this.root.cursor = 'pointer';
    this.root.hitArea = new Circle(0, 8, 44);
    this.root.on('pointertap', e => { e.stopPropagation(); onTap(id); });
    this.root.on('pointerover', () => onHover(id));
    this.root.on('pointerout', () => onHover(null));
  }

  /** 設定(或拿掉)頭像;下一次 apply 會重畫。 */
  setAvatar(tex: Texture | null): void {
    if (tex === this.tex) return;
    this.tex = tex;
    this.key = '';
  }

  apply(a: AgentInfo, selected: boolean): void {
    const key = `${a.name}|${a.backend}|${a.state}|${a.detail}|${selected}|${a.permissionMode}|${a.parentId}`;
    if (key === this.key) return;
    this.key = key;
    this.state = a.state;
    const frame = BACKEND_COLOR[a.backend];
    const core = STATE_COLOR[a.state];
    // 有頭像時六角形畫大一點,臉才看得清楚。圖片尺寸不正常(還沒載入完、已被釋放)就當成沒有頭像
    const tex = this.tex && this.tex.width > 1 && this.tex.height > 1 && !this.tex.destroyed ? this.tex : null;
    const R = tex ? 34 : 24;
    this.name.y = tex ? 32 : 30;
    this.readout.y = tex ? 50 : 48;

    this.glow.clear().poly(hexPoints(R + 10)).fill({ color: core, alpha: 0.1 });
    if (selected) this.glow.poly(hexPoints(R + 14)).stroke({ width: 1.5, color: COLOR.text, alpha: 0.9 });

    this.body.clear().poly(hexPoints(R)).fill({ color: COLOR.bg, alpha: 0.9 });
    this.frame.clear();
    this.avatar.clear();
    if (tex) {
      // 頭像蓋滿六角形(寬 2R、高約 1.73R):等比例縮放,水平置中、垂直略偏上(臉通常在圖的中間偏上);
      // 外框用後台的顏色,狀態改用右下角的小圓點表示
      const k = Math.max((2 * R) / tex.width, (1.74 * R) / tex.height);
      this.avatar.poly(hexPoints(R - 1)).fill({ texture: tex, textureSpace: 'global', matrix: new Matrix(k, 0, 0, k, (-tex.width * k) / 2, -tex.height * k * 0.46) });
      this.frame.poly(hexPoints(R)).stroke({ width: 2, color: frame })
        .circle(R * 0.7, R * 0.6, 7).fill({ color: COLOR.bg })
        .circle(R * 0.7, R * 0.6, 5).fill({ color: core, alpha: a.state === 'sleeping' ? 0.5 : 1 });
    } else {
      this.body.stroke({ width: 2, color: frame }).poly(hexPoints(11)).fill({ color: core, alpha: a.state === 'sleeping' ? 0.35 : 0.95 });
    }

    this.ring.clear();
    if (a.state === 'working') {
      this.ring.arc(0, 0, R + 6, 0, Math.PI * 0.55).stroke({ width: 2, color: core, alpha: 0.9 });
      this.ring.arc(0, 0, R + 6, Math.PI, Math.PI * 1.55).stroke({ width: 2, color: core, alpha: 0.5 });
    }

    this.auto.visible = a.permissionMode === 'auto';
    this.auto.position.set(R * 0.62, -R * 0.86);
    // 子代理節點畫得比較小,名稱前加上箭頭
    this.subScale = a.parentId ? 0.78 : 1;
    this.name.text = a.parentId ? `↳ ${clip(a.name, 12)}` : clip(a.name, 12);
    this.readout.text = clip(a.detail || STATE_LABEL[a.state], 18);
    this.readout.style.fill = a.state === 'awaiting' ? COLOR.warn : a.state === 'error' || a.state === 'lost' ? COLOR.bad : COLOR.dim;
  }

  tick(dt: number, t: number): void {
    if (!this.placed) { this.root.position.set(this.tx, this.ty); this.placed = true; }
    const k = 1 - Math.exp(-dt / 160);
    const target = this.zoom * this.subScale;
    this.root.scale.set(this.root.scale.x + (target - this.root.scale.x) * k);
    this.root.x += (this.tx - this.root.x) * k;
    this.root.y += (this.ty - this.root.y) * k;

    // 醒目的閃爍只留給待授權;其他狀態保持低調
    let alpha = 1;
    let glow = 1;
    if (this.state === 'sleeping') alpha = 0.4;
    else if (this.state === 'planning') glow = 0.5 + 0.5 * Math.sin(t / 420);
    else if (this.state === 'awaiting') glow = 0.4 + 1.6 * (0.5 + 0.5 * Math.sin(t / 150));
    else if (this.state === 'error' || this.state === 'lost') glow = 1.6;
    this.root.alpha = alpha;
    this.glow.alpha = glow;
    if (this.state === 'working') this.ring.rotation += dt / 380;
  }
}

/** 主面板:固定的格線圖,五個區塊,節點依狀態滑移到對應區塊。 */
export class BoardScene {
  private app = new Application();
  private grid = new Graphics();
  private frames = new Graphics();
  private titles = new Map<Zone, Text>();
  private counts = new Map<Zone, Text>();
  private nodeLayer = new Container();
  private nodes = new Map<string, NodeView>();
  private rects = new Map<Zone, Rect>();
  private agents: AgentInfo[] = [];
  private selectedId: string | null = null;
  private time = 0;
  private ready = false;
  private observer: ResizeObserver | null = null;
  private hoverId: string | null = null;
  private hoverPos = { x: 0, y: 0 };
  /** 各角色的頭像:null 表示查過了沒有;還沒查到的不在這裡。 */
  private avatars = new Map<string, Texture | null>();
  private avatarLoading = new Set<string>();
  private showAvatars = true;
  /** 總管節點;沒有指定時總管區塊顯示「+」六角形。 */
  private chiefId: string | null = null;
  private addChief = new Container();

  constructor(private onSelect: (id: string | null) => void, private onHover: (hover: { id: string; x: number; y: number } | null) => void = () => {}, private onAddChief: () => void = () => {}) {}

  /** 總管區塊裡的「+」六角形:按下去開啟新增(或指定)總管節點。 */
  private buildAddChief(): void {
    const g = new Graphics();
    g.poly(hexPoints(30)).fill({ color: COLOR.chief, alpha: 0.06 }).stroke({ width: 1.5, color: COLOR.chief, alpha: 0.7 });
    g.moveTo(-10, 0).lineTo(10, 0).moveTo(0, -10).lineTo(0, 10).stroke({ width: 2.5, color: COLOR.chief, alpha: 0.9, cap: 'round' });
    const label = new Text({ text: '指定總管', style: { fontFamily: FONT, fontSize: 12, fontWeight: '600', fill: COLOR.chief } });
    label.anchor.set(0.5, 0);
    label.position.set(0, 38);
    this.addChief.addChild(g, label);
    this.addChief.eventMode = 'static';
    this.addChief.cursor = 'pointer';
    this.addChief.hitArea = new Circle(0, 8, 44);
    this.addChief.on('pointertap', e => { e.stopPropagation(); this.onAddChief(); });
    this.addChief.on('pointerover', () => { g.alpha = 1; label.alpha = 1; this.addChief.scale.set(1.06); });
    this.addChief.on('pointerout', () => { this.addChief.scale.set(1); });
  }

  async init(host: HTMLElement): Promise<void> {
    await this.app.init({
      resizeTo: host,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
    });
    host.appendChild(this.app.canvas);
    this.app.stage.addChild(this.grid, this.frames);
    for (const z of ZONES) {
      const title = new Text({ text: ZONE_TITLE[z], style: { fontFamily: FONT, fontSize: 13, fontWeight: '600', fill: ZONE_COLOR[z], letterSpacing: 1 } });
      const count = new Text({ text: '0', style: { fontFamily: FONT, fontSize: 12, fill: COLOR.dim } });
      count.anchor.set(1, 0);
      this.titles.set(z, title);
      this.counts.set(z, count);
      this.app.stage.addChild(title, count);
    }
    this.buildAddChief();
    this.app.stage.addChild(this.addChief, this.nodeLayer);
    this.app.stage.eventMode = 'static';
    this.app.stage.on('pointertap', () => this.onSelect(null));
    this.app.renderer.on('resize', () => this.layout());
    // 對話視窗開關時面板的高度會變;視窗大小沒變,所以要自己偵測容器尺寸
    this.observer = new ResizeObserver(() => { if (this.ready) this.app.resize(); });
    this.observer.observe(host);
    this.app.ticker.add(tk => {
      this.time += tk.deltaMS;
      for (const n of this.nodes.values()) n.tick(tk.deltaMS, this.time);
      this.checkHover();
    });
    this.ready = true;
    this.layout();
    // 自我檢查用:回報各節點在畫面上的位置
    (window as unknown as Record<string, unknown>).__nexusBoard = { positions: () => [...this.nodes.values()].map(n => ({ id: n.id, x: n.root.x, y: n.root.y })), avatars: () => [...this.avatars].map(([c, t]) => [c, t !== null]), chiefPlus: () => ({ x: this.addChief.x, y: this.addChief.y, visible: this.addChief.visible }), rect: (z: Zone) => this.rects.get(z) };
  }

  destroy(): void {
    this.observer?.disconnect();
    if (this.ready) this.app.destroy(true, { children: true });
    this.ready = false;
  }

  /** 開關「在六角形裡顯示 Q 版頭像」。打開時重新查一次先前沒有頭像的角色(可能剛放進資料夾)。 */
  setAvatars(on: boolean): void {
    if (on && !this.showAvatars) for (const [c, t] of this.avatars) if (!t) this.avatars.delete(c);
    this.showAvatars = on;
    this.sync(this.agents, this.selectedId);
  }

  /** 角色的頭像;還沒讀過就先回傳 null 並在背景讀取,讀到後重畫。 */
  private avatarOf(character: string): Texture | null {
    if (!this.showAvatars || !character) return null;
    const hit = this.avatars.get(character);
    if (hit !== undefined) return hit;
    if (this.avatarLoading.has(character)) return null;
    this.avatarLoading.add(character);
    const done = (tex: Texture | null) => { this.avatarLoading.delete(character); this.avatars.set(character, tex); if (tex && this.ready) this.sync(this.agents, this.selectedId); };
    window.nexus.getAvatar(character).then(url => {
      if (!url) { done(null); return; }
      const img = new Image();
      img.onload = () => done(this.ready ? Texture.from(img) : null);
      img.onerror = () => done(null);
      img.src = url;
    }, () => done(null));
    return null;
  }

  sync(agents: AgentInfo[], selectedId: string | null, chiefId: string | null = this.chiefId): void {
    this.agents = agents;
    this.selectedId = selectedId;
    this.chiefId = chiefId;
    if (!this.ready) return;
    const alive = new Set(agents.map(a => a.id));
    for (const [id, view] of this.nodes) {
      if (!alive.has(id)) { view.root.destroy({ children: true }); this.nodes.delete(id); }
    }
    for (const a of agents) {
      let view = this.nodes.get(a.id);
      if (!view) {
        const created = new NodeView(a.id, id => this.onSelect(id), id => this.setHover(id));
        view = created;
        this.nodes.set(a.id, view);
        this.nodeLayer.addChild(view.root);
      }
      view.setAvatar(this.avatarOf(a.character));
      view.apply(a, a.id === selectedId);
    }
    this.place();
  }

  private layout(): void {
    const { width: w, height: h } = this.app.screen;
    this.app.stage.hitArea = this.app.screen;
    const pad = 16, gap = 14;
    const topH = Math.round((h - pad * 2 - gap) * 0.48);
    const botH = h - pad * 2 - gap - topH;
    const leftW = Math.round((w - pad * 2 - gap) * 0.26);
    const restW = w - pad * 2 - gap - leftW;
    const authW = Math.round((restW - gap) * 0.5);
    const y2 = pad + topH + gap;
    // 總管放在執行那一列的最右側,寬度約一個半節點
    const chiefW = Math.max(170, Math.round(restW * 0.2));
    this.rects.set('planning', { x: pad, y: pad, w: leftW, h: topH });
    this.rects.set('active', { x: pad + leftW + gap, y: pad, w: restW - gap - chiefW, h: topH });
    this.rects.set('chief', { x: pad + leftW + gap + restW - chiefW, y: pad, w: chiefW, h: topH });
    this.rects.set('standby', { x: pad, y: y2, w: leftW, h: botH });
    this.rects.set('auth', { x: pad + leftW + gap, y: y2, w: authW, h: botH });
    this.rects.set('fault', { x: pad + leftW + gap + authW + gap, y: y2, w: restW - gap - authW, h: botH });

    this.grid.clear();
    for (let x = 0; x <= w; x += 32) this.grid.moveTo(x, 0).lineTo(x, h);
    for (let y = 0; y <= h; y += 32) this.grid.moveTo(0, y).lineTo(w, y);
    this.grid.stroke({ width: 1, color: COLOR.grid, alpha: 0.05 });

    this.frames.clear();
    for (const z of ZONES) {
      const r = this.rects.get(z)!;
      const c = ZONE_COLOR[z];
      const cut = 12;
      // 切角外框,右上與左下各切一角
      this.frames.poly([
        r.x, r.y, r.x + r.w - cut, r.y, r.x + r.w, r.y + cut,
        r.x + r.w, r.y + r.h, r.x + cut, r.y + r.h, r.x, r.y + r.h - cut,
      ]).fill({ color: c, alpha: z === 'auth' || z === 'fault' || z === 'chief' ? 0.06 : 0.03 }).stroke({ width: z === 'chief' ? 1.5 : 1.25, color: c, alpha: z === 'chief' ? 0.75 : 0.55 });
      this.frames.moveTo(r.x + 14, r.y + 36).lineTo(r.x + r.w - 14, r.y + 36).stroke({ width: 1, color: c, alpha: 0.25 });
      this.frames.rect(r.x + 14, r.y + 15, 3, 13).fill({ color: c, alpha: 0.9 });
      this.titles.get(z)!.position.set(r.x + 24, r.y + 12);
      this.counts.get(z)!.position.set(r.x + r.w - 16, r.y + 13);
    }
    this.place();
  }

  private setHover(id: string | null): void {
    this.hoverId = id;
    const view = id ? this.nodes.get(id) : undefined;
    if (!view) { this.onHover(null); return; }
    this.hoverPos = { x: view.root.x, y: view.root.y };
    this.onHover({ id: view.id, ...this.hoverPos });
  }

  /** 節點會自己移動:每一格確認游標還在它上面,並讓資訊卡跟著節點走。 */
  private checkHover(): void {
    if (!this.hoverId) return;
    const view = this.nodes.get(this.hoverId);
    const p = this.app.renderer.events.pointer.global;
    if (!view || Math.hypot(p.x - view.root.x, p.y - (view.root.y + 8 * view.root.scale.y)) > 46 * view.root.scale.x + 4) { this.setHover(null); return; }
    if (Math.abs(view.root.x - this.hoverPos.x) + Math.abs(view.root.y - this.hoverPos.y) > 2) this.setHover(this.hoverId);
  }

  /** 依狀態把節點排進所屬區塊的格位。 */
  private place(): void {
    const byZone = new Map<Zone, AgentInfo[]>(ZONES.map(z => [z, []]));
    // 子節點排在呼叫它的節點後面
    const rootTime = (a: AgentInfo) => this.agents.find(x => x.id === a.parentId)?.createdAt ?? a.createdAt;
    const ordered = [...this.agents].sort((p, q) => rootTime(p) - rootTime(q) || Number(Boolean(p.parentId)) - Number(Boolean(q.parentId)) || p.createdAt - q.createdAt);
    const chief = this.agents.find(a => a.id === this.chiefId && !a.parentId);
    for (const a of ordered) byZone.get(a === chief ? 'chief' : STATE_ZONE[a.state])!.push(a);
    // 沒有總管時顯示「+」六角形
    const cr = this.rects.get('chief');
    this.addChief.visible = !chief && !!cr;
    if (cr) this.addChief.position.set(cr.x + cr.w / 2, cr.y + HEADER + (cr.h - HEADER) / 2 - 16);
    for (const z of ZONES) {
      const r = this.rects.get(z);
      const list = byZone.get(z)!;
      this.counts.get(z)!.text = String(list.length);
      if (!r) continue;
      // 節點太多排不下時整體縮小,確保都留在區塊裡、點得到
      const room = r.h - HEADER - 8;
      let zoom = 1, cols = 1;
      for (; zoom >= 0.45; zoom -= 0.05) {
        cols = Math.max(1, Math.floor((r.w - 16) / (CELL_W * zoom)));
        if (Math.ceil(list.length / cols) * CELL_H * zoom <= room) break;
      }
      zoom = Math.max(zoom, 0.45);
      // 總管只有一個:放在區塊正中間(和「+」同一個位置)
      if (z === 'chief') {
        const view = list[0] && this.nodes.get(list[0].id);
        if (view) { view.zoom = 1; view.tx = r.x + r.w / 2; view.ty = r.y + HEADER + (r.h - HEADER) / 2 - 16; }
        continue;
      }
      list.forEach((a, i) => {
        const view = this.nodes.get(a.id);
        if (!view) return;
        view.zoom = zoom;
        view.tx = r.x + 8 + (CELL_W * zoom) / 2 + (i % cols) * CELL_W * zoom;
        view.ty = r.y + HEADER + 40 * zoom + Math.floor(i / cols) * CELL_H * zoom;
      });
    }
  }
}
