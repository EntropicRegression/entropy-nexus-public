import 'pixi.js/unsafe-eval';
import { Application, Circle, Container, Graphics, Matrix, Text, Texture } from 'pixi.js';
import { STATE_LABEL, STATE_ZONE, type AgentInfo, type AgentState, type LinkInfo, type MeetingView, type Zone } from '../../shared/types';
import { BACKEND_COLOR, COLOR, MEETING_COLOR, STATE_COLOR, ZONE_COLOR, ZONE_TITLE } from './theme';
import { HEADER_COMPACT, MIN_ZOOM, ZONES, centerOf, planBoard, slotAt, type BoardPlan, type Rect } from './board-layout';

const FONT = '"Segoe UI", "Microsoft JhengHei", sans-serif';

/** 協作連線畫在面板上的一段:從呼叫者(或主持人)到一個目標;端點被收進「+N」小標記時 toBadge 為 true。 */
export interface LinkSegment { to: string; x1: number; y1: number; x2: number; y2: number; fromBadge: boolean; toBadge: boolean; speaking: boolean; r1: number; r2: number }
export interface DrawnLink { id: string; kind: LinkInfo['kind']; from: string; label: string; segments: LinkSegment[] }

/** 區塊排不下、被收進「另外 N 個」的節點:哪個區塊、哪些節點、標記在面板上的位置與縮放。 */
/** rooms 是被收起來的會議室(執行區排不下時;清單裡排在節點前面,點了打開旁聽)。 */
export interface BoardMore { zone: Zone; ids: string[]; rooms: string[]; x: number; y: number; zoom: number }

const hexPoints = (r: number): number[] => {
  const pts: number[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i;
    pts.push(Math.cos(a) * r, Math.sin(a) * r);
  }
  return pts;
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** 虛線多邊形(PixiJS 沒有內建虛線):沿著每條邊交替畫線段與空白。 */
const dashedPoly = (g: Graphics, pts: number[], dash: number, gap: number): Graphics => {
  for (let i = 0; i < pts.length; i += 2) {
    const x1 = pts[i], y1 = pts[i + 1], x2 = pts[(i + 2) % pts.length], y2 = pts[(i + 3) % pts.length];
    const len = Math.hypot(x2 - x1, y2 - y1);
    for (let d = 0; d < len; d += dash + gap) {
      const a = d / len, b = Math.min(len, d + dash) / len;
      g.moveTo(x1 + (x2 - x1) * a, y1 + (y2 - y1) * a).lineTo(x1 + (x2 - x1) * b, y1 + (y2 - y1) * b);
    }
  }
  return g;
};

/** 開會中的節點要不要淡化:待授權與異常(error、lost)需要使用者處理,照常顯示,只留琥珀虛線外框。 */
export const dimInMeeting = (state: AgentState): boolean => state !== 'awaiting' && state !== 'error' && state !== 'lost';

/** 系統的「減少動態」設定(prefers-reduced-motion):開著時會議室不閃爍、不淡出。 */
const motionQuery = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
const reducedMotion = () => motionQuery?.matches ?? false;

/** 頭像蓋滿六角形的貼圖矩陣:等比例縮放,水平置中、垂直略偏上(臉通常在圖的中間偏上)。 */
const avatarMatrix = (tex: Texture, R: number) => {
  const k = Math.max((2 * R) / tex.width, (1.74 * R) / tex.height);
  return new Matrix(k, 0, 0, k, (-tex.width * k) / 2, -tex.height * k * 0.46);
};
const usable = (tex: Texture | null) => (tex && tex.width > 1 && tex.height > 1 && !tex.destroyed ? tex : null);

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
  /** 開會中:蓋在六角形上的灰紗(降低彩度)與琥珀虛線外框。 */
  private veil = new Graphics();
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
  /** 區塊排不下時被收進「另外 N 個」:不畫出來,也點不到。 */
  hidden = false;
  /** 正在參加會議(主持人或參與者):卡片保留但淡化,標示「開會中」(任務清單 2-7)。 */
  inMeeting = false;

  constructor(readonly id: string, onTap: (id: string) => void, onHover: (id: string | null) => void) {
    this.name.anchor.set(0.5, 0);
    this.readout.anchor.set(0.5, 0);
    this.name.y = 30;
    this.readout.y = 48;
    // AUTO 標記放在六角形的右上角(放正上方會和上一列節點的狀態文字重疊)
    this.auto.anchor.set(0, 0.5);
    this.root.addChild(this.glow, this.ring, this.body, this.avatar, this.frame, this.veil, this.name, this.readout, this.auto);
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

  /** 設定是否在開會中;下一次 apply 會重畫。 */
  setMeeting(on: boolean): void {
    if (on === this.inMeeting) return;
    this.inMeeting = on;
    this.key = '';
  }

  /** 畫面上的狀態文字與狀態(檢查用)。 */
  get label(): string { return this.readout.text; }
  get current(): AgentState { return this.state; }

  apply(a: AgentInfo, selected: boolean): void {
    const key = `${a.name}|${a.backend}|${a.state}|${a.detail}|${selected}|${a.permissionMode}|${a.parentId}|${this.inMeeting}`;
    if (key === this.key) return;
    this.key = key;
    this.state = a.state;
    const frame = BACKEND_COLOR[a.backend];
    const core = STATE_COLOR[a.state];
    // 有頭像時六角形畫大一點,臉才看得清楚。圖片尺寸不正常(還沒載入完、已被釋放)就當成沒有頭像
    const tex = usable(this.tex);
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
      this.avatar.poly(hexPoints(R - 1)).fill({ texture: tex, textureSpace: 'global', matrix: avatarMatrix(tex, R) });
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
    // 開會中:琥珀虛線外框;平常再加灰紗降低彩度、狀態文字改成「開會中」。待授權與異常照常顯示(那些需要你處理)
    this.veil.clear();
    if (this.inMeeting) {
      if (dimInMeeting(a.state)) {
        this.veil.poly(hexPoints(R - 1)).fill({ color: 0x5a6470, alpha: 0.38 });
        this.readout.text = '開會中';
        this.readout.style.fill = MEETING_COLOR.member;
      }
      dashedPoly(this.veil, hexPoints(R + 5), 5, 4).stroke({ width: 1.5, color: MEETING_COLOR.member, alpha: 0.75 });
    }
  }

  /** 畫面上的縮放:子代理節點小一號,但不會比最小縮放還小(字會讀不出來)。 */
  get scale(): number {
    return Math.max(this.zoom * this.subScale, Math.min(this.zoom, MIN_ZOOM));
  }

  tick(dt: number, t: number): void {
    this.root.visible = !this.hidden;
    // 收起來的節點重新出現時直接出現在新位置,不要從舊位置飛過來
    if (this.hidden) { this.placed = false; return; }
    if (!this.placed) { this.root.position.set(this.tx, this.ty); this.root.scale.set(this.scale); this.placed = true; }
    const k = 1 - Math.exp(-dt / 160);
    const target = this.scale;
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
    // 開會中的節點淡化(約 0.56);待授權與異常照常顯示,不能被淡化蓋掉
    if (this.inMeeting && dimInMeeting(this.state)) alpha *= 0.56;
    this.root.alpha = alpha;
    this.glow.alpha = glow;
    if (this.state === 'working') this.ring.rotation += dt / 380;
  }
}

/** 會議室的與會節點(主持人在最前面),畫成六角形下緣的迷你圓章。 */
export interface RoomMember { id: string; name: string; color: number; host: boolean }

/**
 * 會議室虛擬節點(任務清單 2-7):一場進行中的會議。不是 agent,只能點開旁聽,不能派工、改設定或刪除。
 * 外型和一般節點分得開:暖金外框加青色內框的雙層六角形、上方「MEETING」與直播綠點、主持人頭像右上角的金色主持角標、
 * 下緣一排與會節點的迷你圓章;名稱是會議主題(金色),狀態文字是「第 N/M 輪 · 發言者」。
 */
class RoomView {
  readonly root = new Container();
  private halo = new Graphics();
  private body = new Graphics();
  private avatar = new Graphics();
  private frame = new Graphics();
  private dot = new Graphics();
  private chips = new Container();
  private badge = new Text({ text: 'LIVE', style: { fontFamily: FONT, fontSize: 9, fontWeight: '700', fill: MEETING_COLOR.gold, letterSpacing: 1 } });
  private initial = new Text({ text: '', style: { fontFamily: FONT, fontSize: 20, fontWeight: '700', fill: MEETING_COLOR.gold } });
  private name = new Text({ text: '', style: { fontFamily: FONT, fontSize: 13, fontWeight: '600', fill: MEETING_COLOR.gold } });
  private readout = new Text({ text: '', style: { fontFamily: FONT, fontSize: 11, fill: MEETING_COLOR.cyan } });
  private tex: Texture | null = null;
  private key = '';
  /** 用的是誰的頭像(主持人的角色名稱;沒有頭像時是 null)。檢查用。 */
  avatarOf: string | null = null;
  meeting: MeetingView;
  members: RoomMember[] = [];
  selected = false;
  tx = 0;
  ty = 0;
  zoom = 1;
  placed = false;
  hidden = false;
  /** 散會後的短暫淡出:不再接收點擊,透明度降到 0 後移除。 */
  leaving = false;

  constructor(meeting: MeetingView, onTap: (id: string) => void, onHover: () => void) {
    this.meeting = meeting;
    this.initial.anchor.set(0.5, 0.5);
    this.name.anchor.set(0.5, 0);
    this.readout.anchor.set(0.5, 0);
    this.badge.anchor.set(1, 0.5);
    this.root.addChild(this.halo, this.body, this.avatar, this.initial, this.frame, this.chips, this.dot, this.badge, this.name, this.readout);
    this.root.eventMode = 'static';
    this.root.cursor = 'pointer';
    this.root.hitArea = new Circle(0, 8, 46);
    this.root.on('pointertap', e => { e.stopPropagation(); if (!this.leaving) onTap(this.meeting.id); });
    // 會議室沒有節點資訊卡:移進來時把其他節點的資訊卡收掉
    this.root.on('pointerover', onHover);
  }

  get id(): string { return this.meeting.id; }
  get scale(): number { return this.zoom; }
  get label(): { name: string; readout: string } { return { name: this.name.text, readout: this.readout.text }; }

  setAvatar(tex: Texture | null, character: string | null): void {
    this.avatarOf = tex ? character : null;
    if (tex === this.tex) return;
    this.tex = tex;
    this.key = '';
  }

  apply(m: MeetingView, members: RoomMember[], speakerName: string, selected: boolean): void {
    this.meeting = m;
    this.members = members;
    this.selected = selected;
    const key = `${m.topic}|${m.round}|${m.rounds}|${speakerName}|${selected}|${members.map(x => `${x.id}:${x.name}:${x.color}`).join(',')}`;
    if (key === this.key) return;
    this.key = key;
    const R = 34;
    const tex = usable(this.tex);
    this.halo.clear().poly(hexPoints(R + 11)).fill({ color: MEETING_COLOR.gold, alpha: 0.1 });
    if (selected) this.halo.poly(hexPoints(R + 15)).stroke({ width: 1.5, color: COLOR.text, alpha: 0.9 });
    this.body.clear().poly(hexPoints(R)).fill({ color: COLOR.bg, alpha: 0.92 });
    this.avatar.clear();
    const inner = R - 5;
    if (tex) this.avatar.poly(hexPoints(inner - 1)).fill({ texture: tex, textureSpace: 'global', matrix: avatarMatrix(tex, inner) });
    // 主持人沒有頭像:六角形裡寫主持人名稱的第一個字
    this.initial.visible = !tex;
    this.initial.text = Array.from(m.hostName.trim())[0] ?? '?';
    // 雙層外框:外圈暖金、內圈青色;右上角是金色的主持角標(小皇冠)
    const cx = R * 0.62, cy = -R * 0.74;
    this.frame.clear()
      .poly(hexPoints(R)).stroke({ width: 2.2, color: MEETING_COLOR.gold, alpha: 0.95 })
      .poly(hexPoints(inner)).stroke({ width: 1.2, color: MEETING_COLOR.cyan, alpha: 0.7 })
      .circle(cx, cy, 8).fill({ color: COLOR.bg }).stroke({ width: 1.2, color: MEETING_COLOR.gold })
      .poly([cx - 4.5, cy + 3, cx - 4.5, cy - 2.5, cx - 2, cy, cx, cy - 3.5, cx + 2, cy, cx + 4.5, cy - 2.5, cx + 4.5, cy + 3]).fill({ color: MEETING_COLOR.gold });
    // 左上角的「LIVE ●」:直播綠點加字樣(和一般節點右上角的 AUTO 同一個高度,不會壓到上一列的文字)
    this.dot.clear().circle(-R * 0.62, -R * 0.86, 3).fill({ color: MEETING_COLOR.live });
    this.badge.position.set(-R * 0.62 - 6, -R * 0.86);
    // 下緣的與會節點迷你圓章(主持人金邊,其他人用後台顏色)
    for (const c of this.chips.removeChildren()) c.destroy({ children: true });
    const shown = members.slice(0, 6);
    const step = 12;
    shown.forEach((x, i) => {
      const chip = new Container();
      const g = new Graphics().circle(0, 0, 5.5).fill({ color: COLOR.bg }).stroke({ width: 1.2, color: x.host ? MEETING_COLOR.gold : x.color });
      const t = new Text({ text: Array.from(x.name.trim())[0] ?? '?', style: { fontFamily: FONT, fontSize: 7, fontWeight: '700', fill: x.host ? MEETING_COLOR.gold : x.color } });
      t.anchor.set(0.5, 0.5);
      chip.addChild(g, t);
      chip.position.set((i - (shown.length - 1) / 2) * step, R * 0.8);
      this.chips.addChild(chip);
    });
    this.name.y = 34;
    this.readout.y = 50;
    this.name.text = clip(m.topic.replace(/\s+/g, ' ').trim() || '會議', 12);
    const round = m.round > 0 ? `第 ${m.round}/${m.rounds} 輪` : `開場 · 共 ${m.rounds} 輪`;
    this.readout.text = clip(speakerName ? `${round} · ${speakerName}` : round, 18);
  }

  /** 回傳 true 表示淡出結束,可以移除了。 */
  tick(dt: number, t: number): boolean {
    const still = reducedMotion();
    if (this.leaving) {
      if (still) return true;
      this.root.alpha -= dt / 220;
      return this.root.alpha <= 0;
    }
    this.root.visible = !this.hidden;
    if (this.hidden) { this.placed = false; return false; }
    if (!this.placed || still) { this.root.position.set(this.tx, this.ty); this.root.scale.set(this.scale); this.placed = true; }
    const k = 1 - Math.exp(-dt / 160);
    this.root.scale.set(this.root.scale.x + (this.scale - this.root.scale.x) * k);
    this.root.x += (this.tx - this.root.x) * k;
    this.root.y += (this.ty - this.root.y) * k;
    // 直播綠點與金色光暈緩慢呼吸;減少動態時保持不動
    this.dot.alpha = still ? 1 : 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t / 500));
    this.halo.alpha = still ? 1 : 0.7 + 0.5 * (0.5 + 0.5 * Math.sin(t / 900));
    return false;
  }

  leave(): void {
    this.leaving = true;
    this.root.eventMode = 'none';
    this.root.cursor = 'default';
  }
}

/** 區塊排不下時最後一格的「另外 N 個」:外型和節點一樣大,按下去列出被收起來的節點。 */
class MoreView {
  readonly root = new Container();
  private hex = new Graphics();
  private num = new Text({ text: '', style: { fontFamily: FONT, fontSize: 15, fontWeight: '700', fill: COLOR.text } });
  private label = new Text({ text: '', style: { fontFamily: FONT, fontSize: 13, fontWeight: '600', fill: COLOR.text } });
  private hint = new Text({ text: '點一下列出', style: { fontFamily: FONT, fontSize: 11, fill: COLOR.dim } });
  private key = '';
  count = 0;
  zoom = 1;
  /** 小標記:只有六角形和「+N」(區塊收合、或唯一的格子讓給選取中的節點時)。 */
  badge = false;
  /** 檢查用:標記佔的範圍換算成節點的縮放(節點的範圍是左右各 56、上 34、下 64 乘上縮放)。 */
  get boxScale(): number { return this.badge ? 0.3 : this.zoom; }

  constructor(private color: number, onTap: () => void) {
    this.num.anchor.set(0.5, 0.5);
    this.label.anchor.set(0.5, 0);
    this.hint.anchor.set(0.5, 0);
    this.label.y = 30;
    this.hint.y = 48;
    this.root.addChild(this.hex, this.num, this.label, this.hint);
    this.root.eventMode = 'static';
    this.root.cursor = 'pointer';
    this.root.hitArea = new Circle(0, 8, 44);
    this.root.visible = false;
    this.root.on('pointertap', e => { e.stopPropagation(); onTap(); });
    this.root.on('pointerover', () => { this.hex.alpha = 1; });
    this.root.on('pointerout', () => { this.hex.alpha = 0.8; });
    this.hex.alpha = 0.8;
  }

  set(count: number, x: number, y: number, zoom: number, open: boolean, badge = false): void {
    this.count = count;
    this.zoom = zoom;
    this.badge = badge;
    this.root.visible = count > 0;
    if (!count) return;
    this.root.position.set(x, y);
    this.root.scale.set(badge ? 0.62 : zoom);
    const key = `${count}|${open}|${badge}`;
    if (key === this.key) return;
    this.key = key;
    this.label.visible = this.hint.visible = !badge;
    this.num.style.fontSize = badge ? 19 : 15;
    this.root.hitArea = badge ? new Circle(0, 0, 30) : new Circle(0, 8, 44);
    // 疊起來的兩個六角形,表示後面還有節點
    this.hex.clear()
      .poly(hexPoints(24).map((v, i) => v + (i % 2 ? -4 : 5))).fill({ color: this.color, alpha: 0.05 }).stroke({ width: 1.25, color: this.color, alpha: 0.4 })
      .poly(hexPoints(24)).fill({ color: COLOR.bg, alpha: 0.95 }).stroke({ width: open ? 2.5 : 1.75, color: this.color, alpha: 0.95 });
    this.num.text = `+${count}`;
    this.label.text = `另外 ${count} 個`;
  }
}

/** 主面板:格線圖上的六個區塊,節點依狀態滑移到對應區塊;區塊大小依節點數分配(見 board-layout.ts)。 */
export class BoardScene {
  private app = new Application();
  private grid = new Graphics();
  private frames = new Graphics();
  private titles = new Map<Zone, Text>();
  private counts = new Map<Zone, Text>();
  private nodeLayer = new Container();
  /** 協作連線(節點呼叫節點、會議):畫在節點下方,不接收點擊。 */
  private linkLayer = new Graphics();
  private links: LinkInfo[] = [];
  private linksDrawn = false;
  private nodes = new Map<string, NodeView>();
  /** 會議室虛擬節點(進行中的會議,依 meeting id);散會後淡出中的移到 leavingRooms。 */
  private rooms = new Map<string, RoomView>();
  private leavingRooms = new Set<RoomView>();
  private meetings: MeetingView[] = [];
  private roomId: string | null = null;
  private rects = new Map<Zone, Rect>();
  /** 目前畫在畫面上的區塊外框:區塊大小改變時和節點一起滑過去。 */
  private drawn = new Map<Zone, Rect>();
  private plan: BoardPlan | null = null;
  /** 下一格直接把外框畫到定位(視窗大小改變時不做動畫)。 */
  private snap = true;
  private framesKey = '';
  private mores = new Map<Zone, MoreView>();
  private hiddenIds = new Map<Zone, string[]>();
  /** 執行區排不下而收進「另外 N 個」的會議室(清單裡可以點開)。 */
  private hiddenRooms = new Map<Zone, string[]>();
  /** 目前打開「另外 N 個」清單的區塊。 */
  private moreZone: Zone | null = null;
  private moreKey = '';
  /** 區塊完整標題的寬度(量一次就記住)。 */
  private titleWidths = new Map<Zone, number>();
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
  private addChiefZoom = 1;
  private addChiefHover = false;

  constructor(private onSelect: (id: string | null) => void, private onHover: (hover: { id: string; x: number; y: number } | null) => void = () => {}, private onAddChief: () => void = () => {}, private onMore: (more: BoardMore | null) => void = () => {}, private onRoom: (meetingId: string) => void = () => {}) {}

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
    this.addChief.on('pointerover', () => { g.alpha = 1; label.alpha = 1; this.addChiefHover = true; this.addChief.scale.set(this.addChiefZoom * 1.06); });
    this.addChief.on('pointerout', () => { this.addChiefHover = false; this.addChief.scale.set(this.addChiefZoom); });
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
    this.linkLayer.eventMode = 'none';
    this.app.stage.addChild(this.addChief, this.linkLayer, this.nodeLayer);
    for (const z of ZONES) {
      if (z === 'chief') continue;
      const more = new MoreView(ZONE_COLOR[z], () => this.toggleMore(z));
      this.mores.set(z, more);
      this.app.stage.addChild(more.root);
    }
    this.app.stage.eventMode = 'static';
    this.app.stage.on('pointertap', () => { this.closeMore(); this.onSelect(null); });
    this.app.renderer.on('resize', () => this.layout());
    // 對話視窗開關時面板的高度會變;視窗大小沒變,所以要自己偵測容器尺寸
    this.observer = new ResizeObserver(() => { if (this.ready) this.app.resize(); });
    this.observer.observe(host);
    this.app.ticker.add(tk => {
      this.time += tk.deltaMS;
      for (const n of this.nodes.values()) n.tick(tk.deltaMS, this.time);
      for (const r of this.rooms.values()) r.tick(tk.deltaMS, this.time);
      for (const r of this.leavingRooms) if (r.tick(tk.deltaMS, this.time)) { this.leavingRooms.delete(r); r.root.destroy({ children: true }); }
      this.stepFrames(tk.deltaMS);
      this.drawLinks();
      this.checkHover();
    });
    this.ready = true;
    this.layout();
    // 自我檢查用:回報各節點在畫面上的位置(被收進「另外 N 個」的節點不在 positions 裡,列在 hidden)、
    // 各區塊的範圍與標題列高度、「另外 N 個」標記的位置
    (window as unknown as Record<string, unknown>).__nexusBoard = {
      positions: () => [...this.nodes.values()].filter(n => !n.hidden).map(n => ({ id: n.id, x: n.root.x, y: n.root.y, scale: n.root.scale.x })),
      avatars: () => [...this.avatars].map(([c, t]) => [c, t !== null]),
      chiefPlus: () => ({ x: this.addChief.x, y: this.addChief.y, visible: this.addChief.visible, scale: this.addChiefZoom }),
      rect: (z: Zone) => this.rects.get(z),
      size: () => ({ w: this.app.screen.width, h: this.app.screen.height }),
      mode: () => ({ mode: this.plan?.mode ?? null, compact: this.plan?.compact ?? false }),
      header: (z: Zone) => this.plan?.zones[z].header ?? 0,
      hidden: () => ZONES.map(z => ({ zone: z, count: this.hiddenIds.get(z)?.length ?? 0, ids: this.hiddenIds.get(z) ?? [] })).filter(x => x.count > 0),
      more: () => [...this.mores].filter(([, m]) => m.root.visible).map(([z, m]) => ({ zone: z, x: m.root.x, y: m.root.y, scale: m.boxScale, count: m.count, badge: m.badge })),
      // 目前畫出的協作連線與端點(節點的畫面座標,被收進「+N」的端點改用小標記的位置)
      links: () => this.resolveLinks(),
      total: () => this.nodes.size,
      // 節點都滑到定位了嗎(還在移動時,位置和區塊範圍對不起來是正常的)
      settled: () => [...this.nodes.values(), ...this.rooms.values()].every(n => n.hidden || (n.placed && Math.abs(n.root.x - n.tx) < 0.5 && Math.abs(n.root.y - n.ty) < 0.5 && Math.abs(n.root.scale.x - n.scale) < 0.005)),
      openMore: (z: Zone) => this.toggleMore(z),
      // 會議室虛擬節點(不含散會後淡出中的):位置、用了誰的頭像、輪次與發言者、與會節點
      rooms: () => [...this.rooms.values()].map(r => ({
        id: r.id, hostId: r.meeting.hostId, avatarOf: r.avatarOf, x: r.root.x, y: r.root.y, scale: r.root.scale.x, visible: r.root.visible && !r.hidden,
        round: r.meeting.round, rounds: r.meeting.rounds, speakerId: r.meeting.speakerId, members: r.members.map(m => m.id), selected: r.selected, ...r.label,
      })),
      // 開會中而淡化的節點
      inMeeting: () => [...this.nodes.values()].filter(n => n.inMeeting).map(n => ({ id: n.id, alpha: n.root.alpha, label: n.label, state: n.current, dimmed: dimInMeeting(n.current) })),
      // 開會中的節點在各狀態下要不要淡化(判斷規則本身)
      dimInMeeting: (state: AgentState) => dimInMeeting(state),
      hiddenRooms: () => ZONES.map(z => ({ zone: z, ids: this.hiddenRooms.get(z) ?? [] })).filter(x => x.ids.length > 0),
      // 和在面板上點會議室相同
      tapRoom: (id: string) => { if (!this.rooms.has(id)) return false; this.onRoom(id); return true; },
    };
  }

  /** 更新進行中的會議(會議室虛擬節點)與目前打開的會議室。 */
  setMeetings(meetings: MeetingView[], roomId: string | null): void {
    this.meetings = meetings;
    this.roomId = roomId;
    this.sync(this.agents, this.selectedId);
  }

  /** 依目前的會議建立、更新或移除會議室;參與的節點標成開會中。 */
  private syncRooms(): void {
    const live = new Set(this.meetings.map(m => m.id));
    for (const [id, view] of this.rooms) {
      if (live.has(id)) continue;
      this.rooms.delete(id);
      // 散會:會議室立刻離開版面(其他節點馬上補位),原地短暫淡出;減少動態時直接移除
      if (reducedMotion()) view.root.destroy({ children: true });
      else { view.leave(); this.leavingRooms.add(view); }
    }
    const byId = new Map(this.agents.map(a => [a.id, a]));
    for (const m of this.meetings) {
      let view = this.rooms.get(m.id);
      if (!view) {
        view = new RoomView(m, id => { this.closeMore(); this.onRoom(id); }, () => this.setHover(null));
        this.rooms.set(m.id, view);
        this.nodeLayer.addChild(view.root);
      }
      const host = byId.get(m.hostId);
      view.setAvatar(host ? this.avatarOf(host.character) : null, host?.character || null);
      const members: RoomMember[] = [
        { id: m.hostId, name: m.hostName, color: host ? BACKEND_COLOR[host.backend] : MEETING_COLOR.gold, host: true },
        ...m.participants.map(p => { const a = byId.get(p.id); return { id: p.id, name: p.name, color: a ? BACKEND_COLOR[a.backend] : COLOR.dim, host: false }; }),
      ];
      const speaker = m.speakerId ? members.find(x => x.id === m.speakerId)?.name ?? byId.get(m.speakerId)?.name ?? '' : '';
      view.apply(m, members, speaker, m.id === this.roomId);
    }
    const busy = new Set(this.meetings.flatMap(m => [m.hostId, ...m.participants.map(p => p.id)]));
    for (const [id, view] of this.nodes) view.setMeeting(busy.has(id));
  }

  /** 更新進行中的協作連線(由核心服務推送)。 */
  setLinks(links: LinkInfo[]): void {
    this.links = links;
  }

  /** 節點在面板上的連線端點:看得到就是節點中心,被收進「另外 N 個」就是該區塊的小標記;都沒有時為 null。 */
  private endpointOf(id: string): { x: number; y: number; r: number; badge: boolean } | null {
    const v = this.nodes.get(id);
    if (v && !v.hidden && v.root.visible) return { x: v.root.x, y: v.root.y, r: 36 * v.root.scale.x, badge: false };
    for (const [z, ids] of this.hiddenIds) {
      if (!ids.includes(id)) continue;
      const m = this.mores.get(z);
      if (m?.root.visible) return { x: m.root.x, y: m.root.y, r: 16, badge: true };
    }
    return null;
  }

  /** 把連線資料對到畫面座標;端點找不到的(例如節點已被移除)略過。 */
  private resolveLinks(): DrawnLink[] {
    const out: DrawnLink[] = [];
    for (const l of this.links) {
      const a = this.endpointOf(l.from);
      if (!a) continue;
      const segments: LinkSegment[] = [];
      for (const t of l.to) {
        const b = this.endpointOf(t);
        if (!b || (a.x === b.x && a.y === b.y)) continue;
        segments.push({ to: t, x1: a.x, y1: a.y, x2: b.x, y2: b.y, fromBadge: a.badge, toBadge: b.badge, speaking: l.speaker === t, r1: a.r, r2: b.r });
      }
      if (segments.length) out.push({ id: l.id, kind: l.kind, from: l.from, label: l.label ?? '', segments });
    }
    return out;
  }

  /** 每一格重畫連線:淡淡的光暈線、流動的小點、目標端的箭頭;會議中正在發言的參與者外圍加一圈亮環。 */
  private drawLinks(): void {
    const g = this.linkLayer;
    if (!this.links.length) { if (this.linksDrawn) { g.clear(); this.linksDrawn = false; } return; }
    g.clear();
    this.linksDrawn = true;
    for (const l of this.resolveLinks()) {
      const color = l.kind === 'meeting' ? COLOR.warn : COLOR.accent;
      for (const s of l.segments) {
        const dx = s.x2 - s.x1, dy = s.y2 - s.y1, len = Math.hypot(dx, dy);
        const { r1, r2 } = s;
        if (len < r1 + r2 + 8) continue;
        const bend = Math.min(60, len * 0.16) * (l.kind === 'meeting' ? 0.6 : 1);
        const cx = (s.x1 + s.x2) / 2 - (dy / len) * bend, cy = (s.y1 + s.y2) / 2 + (dx / len) * bend;
        const at = (t: number) => ({ x: (1 - t) ** 2 * s.x1 + 2 * (1 - t) * t * cx + t * t * s.x2, y: (1 - t) ** 2 * s.y1 + 2 * (1 - t) * t * cy + t * t * s.y2 });
        const t0 = r1 / len, t1 = 1 - r2 / len;
        const pts: Array<{ x: number; y: number }> = [];
        for (let i = 0; i <= 16; i++) pts.push(at(t0 + ((t1 - t0) * i) / 16));
        g.moveTo(pts[0].x, pts[0].y);
        for (const p of pts.slice(1)) g.lineTo(p.x, p.y);
        g.stroke({ width: 7, color, alpha: s.speaking ? 0.16 : 0.07 });
        g.moveTo(pts[0].x, pts[0].y);
        for (const p of pts.slice(1)) g.lineTo(p.x, p.y);
        g.stroke({ width: s.speaking ? 2.4 : 1.4, color, alpha: s.speaking ? 0.85 : 0.45 });
        // 流動的小點(從呼叫者流向目標)
        for (let i = 0; i < 3; i++) {
          const p = at(t0 + (t1 - t0) * (((this.time / 1500 + i / 3) % 1)));
          g.circle(p.x, p.y, s.speaking ? 3 : 2.2).fill({ color, alpha: 0.95 });
        }
        // 箭頭
        const e = at(t1), b = at(t1 - 0.04);
        const ang = Math.atan2(e.y - b.y, e.x - b.x);
        g.poly([e.x, e.y, e.x - Math.cos(ang - 0.45) * 9, e.y - Math.sin(ang - 0.45) * 9, e.x - Math.cos(ang + 0.45) * 9, e.y - Math.sin(ang + 0.45) * 9]).fill({ color, alpha: 0.9 });
        if (s.speaking) {
          const pulse = 0.5 + 0.5 * Math.sin(this.time / 220);
          g.circle(s.x2, s.y2, r2 + 6 + pulse * 3).stroke({ width: 2, color, alpha: 0.5 + pulse * 0.4 });
        }
      }
    }
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
    }
    this.syncRooms();
    for (const a of agents) this.nodes.get(a.id)!.apply(a, a.id === selectedId);
    this.place();
  }

  /** 打開或關掉某個區塊的「另外 N 個」清單。 */
  private toggleMore(z: Zone): void {
    this.moreZone = this.moreZone === z || !(this.hiddenIds.get(z)?.length || this.hiddenRooms.get(z)?.length) ? null : z;
    this.place();
  }

  /** 關掉「另外 N 個」清單(點了面板空白處、選了節點、按 Esc)。 */
  closeMore(): void {
    if (!this.moreZone) return;
    this.moreZone = null;
    if (this.ready) this.place();
  }

  /** 把「另外 N 個」清單的內容通知外面;內容沒變就不重複通知。 */
  private emitMore(): void {
    const z = this.moreZone;
    const ids = z ? this.hiddenIds.get(z) ?? [] : [];
    const rooms = z ? this.hiddenRooms.get(z) ?? [] : [];
    const view = z ? this.mores.get(z) : undefined;
    if (!z || !(ids.length || rooms.length) || !view) {
      this.moreZone = null;
      if (this.moreKey) { this.moreKey = ''; this.onMore(null); }
      return;
    }
    const more: BoardMore = { zone: z, ids, rooms, x: view.root.x, y: view.root.y, zoom: view.zoom };
    const key = JSON.stringify(more);
    if (key === this.moreKey) return;
    this.moreKey = key;
    this.onMore(more);
  }

  /** 面板大小改變:重畫背景格線,區塊直接畫到新位置(不做動畫)。 */
  private layout(): void {
    const { width: w, height: h } = this.app.screen;
    this.app.stage.hitArea = this.app.screen;
    this.grid.clear();
    for (let x = 0; x <= w; x += 32) this.grid.moveTo(x, 0).lineTo(x, h);
    for (let y = 0; y <= h; y += 32) this.grid.moveTo(0, y).lineTo(w, y);
    this.grid.stroke({ width: 1, color: COLOR.grid, alpha: 0.05 });
    this.snap = true;
    this.place();
  }

  /** 每一格讓區塊外框往目標位置靠近(和節點同一個速度),有變動才重畫。 */
  private stepFrames(dt: number): void {
    if (!this.plan) return;
    const k = this.snap ? 1 : 1 - Math.exp(-dt / 160);
    let key = `${this.plan.mode}|${this.plan.compact}`;
    for (const z of ZONES) {
      const target = this.rects.get(z)!;
      let cur = this.drawn.get(z);
      if (!cur) { cur = { ...target }; this.drawn.set(z, cur); }
      for (const f of ['x', 'y', 'w', 'h'] as const) {
        const d = target[f] - cur[f];
        cur[f] = Math.abs(d) < 0.5 ? target[f] : cur[f] + d * k;
      }
      key += `|${cur.x},${cur.y},${cur.w},${cur.h}`;
    }
    this.snap = false;
    if (key === this.framesKey) return;
    this.framesKey = key;
    this.drawFrames();
  }

  private drawFrames(): void {
    this.frames.clear();
    for (const z of ZONES) {
      const r = this.drawn.get(z)!;
      const c = ZONE_COLOR[z];
      const compact = this.plan!.zones[z].header === HEADER_COMPACT;
      const narrow = r.w < 80;
      const cut = compact ? 9 : 12;
      const inset = narrow ? 6 : compact ? 10 : 14;
      // 切角外框,右上與左下各切一角
      this.frames.poly([
        r.x, r.y, r.x + r.w - cut, r.y, r.x + r.w, r.y + cut,
        r.x + r.w, r.y + r.h, r.x + cut, r.y + r.h, r.x, r.y + r.h - cut,
      ]).fill({ color: c, alpha: z === 'auth' || z === 'fault' || z === 'chief' ? 0.06 : 0.03 }).stroke({ width: z === 'chief' ? 1.5 : 1.25, color: c, alpha: z === 'chief' ? 0.75 : 0.55 });
      const lineY = compact ? 27 : 36;
      this.frames.moveTo(r.x + inset, r.y + lineY).lineTo(r.x + r.w - inset, r.y + lineY).stroke({ width: 1, color: c, alpha: 0.25 });
      // 收合成窄條的區塊只放標題(沒有左邊的色條與右邊的數量)
      if (!narrow) this.frames.rect(r.x + inset, r.y + (compact ? 8 : 15), 3, 13).fill({ color: c, alpha: 0.9 });
      this.titles.get(z)!.position.set(r.x + inset + (narrow ? 1 : 10), r.y + (compact ? 5 : 12));
      this.counts.get(z)!.visible = !narrow;
      this.counts.get(z)!.position.set(r.x + r.w - inset - 2, r.y + (compact ? 6 : 13));
    }
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
    if (!view || view.hidden || Math.hypot(p.x - view.root.x, p.y - (view.root.y + 8 * view.root.scale.y)) > 46 * view.root.scale.x + 4) { this.setHover(null); return; }
    if (Math.abs(view.root.x - this.hoverPos.x) + Math.abs(view.root.y - this.hoverPos.y) > 2) this.setHover(this.hoverId);
  }

  /** 依狀態把節點分到各區塊,依節點數分配區塊大小,再把節點排進格位;排不下的收進「另外 N 個」。 */
  private place(): void {
    const { width: w, height: h } = this.app.screen;
    if (w < 80 || h < 60) return;
    const byZone = new Map<Zone, AgentInfo[]>(ZONES.map(z => [z, []]));
    // 子節點排在呼叫它的節點後面
    const rootTime = (a: AgentInfo) => this.agents.find(x => x.id === a.parentId)?.createdAt ?? a.createdAt;
    const ordered = [...this.agents].sort((p, q) => rootTime(p) - rootTime(q) || Number(Boolean(p.parentId)) - Number(Boolean(q.parentId)) || p.createdAt - q.createdAt);
    const chief = this.agents.find(a => a.id === this.chiefId && !a.parentId);
    for (const a of ordered) byZone.get(a === chief ? 'chief' : STATE_ZONE[a.state])!.push(a);
    const count = (z: Zone) => byZone.get(z)!.length;
    // 會議室排在執行區的最前面(先佔格子,不會被收進「另外 N 個」)
    const rooms = [...this.rooms.values()];
    const plan = planBoard(w, h, { planning: count('planning'), active: count('active') + rooms.length, chief: count('chief'), standby: count('standby'), auth: count('auth'), fault: count('fault') });
    this.plan = plan;
    for (const z of ZONES) {
      const p = plan.zones[z];
      const list = byZone.get(z)!;
      this.rects.set(z, p.rect);
      this.counts.get(z)!.text = String(list.length);
      // 區塊太窄放不下完整標題時只留中文(「規劃 PLANNING」→「規劃」)
      this.titles.get(z)!.text = this.titleWidth(z) + (list.length ? 58 : 50) > p.rect.w ? ZONE_TITLE[z].split(' ')[0] : ZONE_TITLE[z];
      if (z === 'chief') {
        // 總管只有一個:放在區塊正中間(和「+」同一個位置);沒有總管時顯示「+」六角形
        const c = centerOf(p);
        this.addChief.visible = !chief;
        this.addChief.position.set(c.x, c.y);
        // 連總管區塊都只剩窄條時(視窗窄到不合理),把總管縮到放得進去
        if (p.collapsed) p.zoom = Math.max(0.4, Math.min(1, (p.rect.w - 4) / 112));
        this.addChiefZoom = p.zoom;
        this.addChief.scale.set(p.zoom * (this.addChiefHover ? 1.06 : 1));
        const view = list[0] && this.nodes.get(list[0].id);
        if (view) { view.hidden = false; view.zoom = p.zoom; view.tx = c.x; view.ty = c.y; }
        continue;
      }
      // 格位裡依序放:會議室(只有執行區有,一律優先佔格位)、節點。排不下的節點與會議室都列在「另外 N 個」的清單裡,點了照樣打開
      const slots: Array<{ id: string; view: NodeView | RoomView | undefined; room: boolean }> = [
        ...(z === 'active' ? rooms.map(r => ({ id: r.id, view: r, room: true })) : []),
        ...list.map(a => ({ id: a.id, view: this.nodes.get(a.id), room: false })),
      ];
      const roomCount = slots.filter(x => x.room).length;
      const tuck = (xs: typeof slots) => {
        this.hiddenIds.set(z, xs.filter(x => !x.room).map(x => x.id));
        this.hiddenRooms.set(z, xs.filter(x => x.room).map(x => x.id));
        return xs.length;
      };
      const sel = slots.findIndex(x => !x.room && x.id === this.selectedId);
      const more = this.mores.get(z)!;
      if (p.collapsed) {
        // 收合的區塊:節點與會議室全部收起來,標題下方放「+N」小標記
        for (const x of slots) if (x.view) x.view.hidden = true;
        more.set(tuck(slots), p.rect.x + p.rect.w / 2, p.rect.y + p.header + 22, 1, this.moreZone === z, true);
        continue;
      }
      if (p.hidden && p.shown === 0 && sel >= 0 && roomCount === 0) {
        // 只有一格、而選取中的節點在這個區塊(而且沒有會議室要佔這一格):這一格給它,其他節點的「+N」縮成小標記放在它的右上角
        const c = centerOf(p);
        slots.forEach((x, i) => {
          if (!x.view) return;
          x.view.hidden = i !== sel;
          if (i === sel) { x.view.zoom = p.zoom; x.view.tx = c.x; x.view.ty = c.y; }
        });
        more.set(tuck(slots.filter((_, i) => i !== sel)), c.x + 38 * p.zoom, c.y - 16 * p.zoom, p.zoom, this.moreZone === z, true);
        continue;
      }
      // 選取中的節點如果排在會被收起來的位置,把它換到最後一個看得到的格子(那一格不能是會議室的)
      if (p.hidden && p.shown > roomCount && sel >= p.shown) slots.splice(p.shown - 1, 0, ...slots.splice(sel, 1));
      const total = p.shown + (p.hidden ? 1 : 0);
      slots.forEach((x, i) => {
        const view = x.view;
        if (!view) return;
        view.hidden = i >= p.shown;
        if (view.hidden) return;
        const s = slotAt(p, i, total);
        view.zoom = p.zoom;
        view.tx = s.x;
        view.ty = s.y;
      });
      const at = p.shown > 0 ? slotAt(p, p.shown, total) : centerOf(p);
      more.set(tuck(slots.slice(p.shown)), at.x, at.y, p.zoom, this.moreZone === z);
    }
    this.emitMore();
  }

  private titleWidth(z: Zone): number {
    let width = this.titleWidths.get(z);
    if (width === undefined) {
      const t = this.titles.get(z)!;
      const text = t.text;
      t.text = ZONE_TITLE[z];
      width = t.width;
      t.text = text;
      this.titleWidths.set(z, width);
    }
    return width;
  }
}
