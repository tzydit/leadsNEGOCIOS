import { SIT_H, STAND_H, WORKER_STYLE, sprite } from './sprites.js';

// ---- geometria do mundo (pixels lógicos) -----------------------------------
const RW = 208; // largura de uma sala
const RH = 152; // altura de uma sala
const CH = 56; // corredor
const MX = 128; // gramado nas laterais
const MT = 88; // gramado em cima
const WALL = 30; // parede do fundo
const DOOR_X = 104; // porta no meio da sala
const DOOR_W = 28;
const AISLE = 122; // linha de circulação dentro da sala (y local)
const DESK_X = { claude: 22, codex: 122 }; // início de cada estação de trabalho
const DESK_Y = 66; // borda de trás do tampo
const SEAT_Y = 56; // onde o personagem para atrás da mesa
const SPEED = 80;

const BX = MX;
const BY = MT;
const COR_Y = BY + RH + CH / 2;
const BUILD_H = RH * 2 + CH;
// faixas abaixo do prédio
const HEDGE_Y = BY + BUILD_H + 22;
const WALK_Y = HEDGE_Y + 22;
const ROAD_Y = WALK_Y + 26;
const ROAD_H = 46;
const WORLD_H = ROAD_Y + ROAD_H + 22 + 46;

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4];

const C = {
  grass: '#6e9b4a',
  grassDark: '#628d41',
  grassLight: '#7dab55',
  outerWall: '#3d4150',
  wallCap: '#9aa1b0',
  partition: '#c7c9d1',
  partitionDark: '#9a9dab',
  wallFace: '#f1e8d8',
  wallFaceShade: '#e2d6c1',
  wainscot: '#c9b08c',
  baseboard: '#8a6a4a',
  tile1: '#efe4d0',
  tile2: '#e9dcc5',
  tileLine: '#dccdb3',
  copa1: '#e3ebf5',
  copa2: '#cbd8e8',
  wood1: '#c89462',
  wood2: '#bb8756',
  woodLine: '#a5764a',
  corridor1: '#ece6db',
  corridor2: '#e4ddd0',
  runner: '#9ea3ad',
  desk: '#e7c99a',
  deskEdge: '#c9a46f',
  deskFront: '#b68e5b',
  chair: '#3e5fa8',
  chairDark: '#2d477f',
  monitor: '#262a35',
  screenOff: '#11141c',
  plant: '#4f9a52',
  plantDark: '#377a3c',
  plantLight: '#6dbb6a',
  pot: '#c26a3c',
  potDark: '#9a4f2a',
  brick: '#c99a7c',
  brickLine: '#b08268',
  road: '#4b4b55',
  roadLine: '#e8d58a',
  hedge: '#3f7a3a',
  hedgeLight: '#4f9147',
};

const STATUS = {
  running: ['trabalhando', '#5fb0ff'],
  done: ['concluída', '#7cc96a'],
  aprovado: ['aprovada', '#7cc96a'],
  pendente: ['mudanças pendentes', '#f0b94a'],
  failed: ['falhou', '#ff6b72'],
  budget: ['orçamento estourado', '#ff6b72'],
  stopped: ['parada', '#a5a8b8'],
  idle: ['pronta', '#a5a8b8'],
};
export const STATUS_TEXT = STATUS;

export function lineStatus(line) {
  const r = line.run;
  if (!r) return 'idle';
  if (r.status === 'done') return r.outcome === 'aprovado' ? 'aprovado' : r.outcome === 'mudancas_pendentes' ? 'pendente' : 'done';
  return STATUS[r.status] ? r.status : 'idle';
}

/** Ícone do balão a partir do texto da atividade. */
export function activityIcon(text = '') {
  if (/^(Editando|Criando|Removendo)/.test(text)) return '✏️';
  if (/^Lendo/.test(text)) return '📖';
  if (/^(Buscando|Procurando)/.test(text)) return '🔎';
  if (/^\$/.test(text)) return '⌨️';
  if (/Pensando/.test(text)) return '💭';
  if (/Escrevendo/.test(text)) return '📝';
  if (/Pesquisando/.test(text)) return '🌐';
  if (/Organizando/.test(text)) return '📋';
  if (/falhou|código/.test(text)) return '⚠️';
  return '💬';
}

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const R = (g, x, y, w, h, c) => {
  g.fillStyle = c;
  g.fillRect(Math.round(x), Math.round(y), w, h);
};

export class Office {
  constructor(canvas, handlers) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.h = handlers;
    this.rooms = [];
    this.lines = [];
    this.skills = [];
    this.selected = null;
    this.hover = null;
    this.avatars = [];
    this.avatarSeq = 0;
    this.world = document.createElement('canvas');
    this.wctx = this.world.getContext('2d');
    this.staticLayer = document.createElement('canvas');
    this.staticDirty = true;
    this.cam = { x: 0, y: 0, z: 1 };
    this.insets = { left: 0, right: 0, top: 0, bottom: 0 };
    this.last = performance.now();
    this.t = 0;
    this.drag = null;

    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    window.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener('mouseleave', () => (this.hover = null));
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    document.fonts?.ready.then(() => (this.staticDirty = true));
  }

  // ---- dados --------------------------------------------------------------

  setData({ lines, skills }) {
    const sig = JSON.stringify(lines.map((l) => [l.id, [...new Set(l.steps.map((s) => s.worker))].sort()]));
    this.lines = lines;
    this.skills = skills ?? [];
    if (sig !== this.layoutSig) {
      this.layoutSig = sig;
      this.layout();
    }
    this.syncAvatars();
  }

  setSelected(id) {
    this.selected = id;
  }

  setInsets(insets) {
    this.insets = { ...this.insets, ...insets };
  }

  layout() {
    const rooms = [
      { kind: 'copa', col: 0, row: 0, title: 'Copa' },
      { kind: 'skills', col: 0, row: 1, title: 'Biblioteca de Skills' },
    ];
    this.lines.forEach((line, i) => {
      rooms.push({ kind: 'line', col: 1 + Math.floor(i / 2), row: i % 2, lineId: line.id, workers: [...new Set(line.steps.map((s) => s.worker))] });
    });
    const n = this.lines.length;
    rooms.push({ kind: 'new', col: 1 + Math.floor(n / 2), row: n % 2, title: 'Nova linha' });
    for (const r of rooms) {
      r.x = BX + r.col * RW;
      r.y = r.row === 0 ? BY : BY + RH + CH;
      r.w = RW;
      r.h = RH;
    }
    this.rooms = rooms;
    this.cols = Math.max(2, Math.max(...rooms.map((r) => r.col)) + 1);
    this.buildW = this.cols * RW;
    this.worldW = BX + this.buildW + MX;
    this.world.width = this.worldW;
    this.world.height = WORLD_H;
    this.staticLayer.width = this.worldW;
    this.staticLayer.height = WORLD_H;
    this.staticDirty = true;
    for (const a of this.avatars) a.path = [];
    if (!this.userMoved) this.fit();
  }

  // ---- câmera -------------------------------------------------------------

  resize() {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    this.dpr = window.devicePixelRatio || 1;
    this.vw = parent.clientWidth;
    this.vh = parent.clientHeight;
    this.canvas.width = Math.round(this.vw * this.dpr);
    this.canvas.height = Math.round(this.vh * this.dpr);
    this.canvas.style.width = `${this.vw}px`;
    this.canvas.style.height = `${this.vh}px`;
    if (!this.userMoved && this.worldW) this.fit();
    this.clampCam();
  }

  view() {
    const i = this.insets;
    return { x: i.left, y: i.top, w: Math.max(100, this.vw - i.left - i.right), h: Math.max(100, this.vh - i.top - i.bottom) };
  }

  /** Enquadra o prédio inteiro na área livre entre os painéis. */
  fit() {
    if (!this.vw || !this.worldW) return;
    const v = this.view();
    const ideal = Math.min(v.w / (this.buildW + 48), v.h / (BUILD_H + 64));
    this.cam.z = [...ZOOMS].reverse().find((z) => z <= ideal) ?? ZOOMS[0];
    this.centerOn(BX + this.buildW / 2, BY + BUILD_H / 2);
    this.userMoved = false;
  }

  centerOn(wx, wy) {
    const v = this.view();
    this.cam.x = wx - (v.x + v.w / 2) / this.cam.z;
    this.cam.y = wy - (v.y + v.h / 2) / this.cam.z;
    this.clampCam();
  }

  focusLine(id) {
    const r = this.rooms.find((x) => x.lineId === id);
    if (!r) return;
    const v = this.view();
    const ideal = Math.min(v.w / (RW + 40), v.h / (RH + 60));
    const z = [...ZOOMS].reverse().find((k) => k <= ideal) ?? ZOOMS[0];
    if (this.cam.z < z) this.cam.z = z;
    this.centerOn(r.x + r.w / 2, r.y + r.h / 2);
    this.userMoved = true;
  }

  zoomBy(dir, sx = null, sy = null) {
    const v = this.view();
    sx ??= v.x + v.w / 2;
    sy ??= v.y + v.h / 2;
    let i = ZOOMS.findIndex((z) => z >= this.cam.z - 1e-6);
    if (i < 0) i = ZOOMS.length - 1;
    const next = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, i + dir))];
    const wx = this.cam.x + sx / this.cam.z;
    const wy = this.cam.y + sy / this.cam.z;
    this.cam.z = next;
    this.cam.x = wx - sx / next;
    this.cam.y = wy - sy / next;
    this.clampCam();
    this.userMoved = true;
  }

  clampCam() {
    if (!this.worldW || !this.vw) return;
    const z = this.cam.z;
    this.cam.x = Math.min(Math.max(this.cam.x, -this.vw / z / 2), this.worldW - this.vw / z / 2);
    this.cam.y = Math.min(Math.max(this.cam.y, -this.vh / z / 2), WORLD_H - this.vh / z / 2);
  }

  toWorld(e) {
    const r = this.canvas.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    return { x: this.cam.x + sx / this.cam.z, y: this.cam.y + sy / this.cam.z, sx, sy };
  }

  // ---- avatares -----------------------------------------------------------

  /** Quem precisa estar em qual mesa agora (uma tentativa rodando por linha). */
  assignments() {
    const out = [];
    for (const line of this.lines) {
      const r = line.run;
      if (!r || r.status !== 'running') continue;
      const a = r.attempts?.[r.attempts.length - 1];
      if (a && a.status === 'running') out.push({ key: `${line.id}:${a.worker}`, lineId: line.id, worker: a.worker, activity: a.activity, role: a.role });
    }
    return out;
  }

  syncAvatars() {
    for (const w of Object.keys(WORKER_STYLE)) {
      if (!this.avatars.some((a) => a.worker === w)) this.spawn(w, true);
    }
    const wanted = this.assignments();
    const wantedKeys = new Set(wanted.map((a) => a.key));
    for (const a of this.avatars) if (a.assign && !wantedKeys.has(a.assign.key)) a.assign = null;
    for (const want of wanted) {
      let av = this.avatars.find((a) => a.assign?.key === want.key);
      if (av) {
        av.assign = want;
        continue;
      }
      av = this.avatars.find((a) => a.worker === want.worker && !a.assign && !a.leaving) ?? this.spawn(want.worker, false);
      av.assign = want;
    }
    // Sobrou mais de um ocioso do mesmo trabalhador? Os extras vão embora.
    for (const w of Object.keys(WORKER_STYLE)) {
      this.avatars.filter((a) => a.worker === w && !a.assign && !a.leaving).slice(1).forEach((a) => (a.leaving = true));
    }
  }

  spawn(worker, inCopa) {
    const n = this.avatars.filter((a) => a.worker === worker).length;
    const a = { id: ++this.avatarSeq, worker, label: n ? `${WORKER_STYLE[worker].name} ${n + 1}` : WORKER_STYLE[worker].name, x: 0, y: 0, loc: null, path: [], assign: null, leaving: false, seated: false, phase: Math.random() * 10, dir: 1 };
    if (inCopa) {
      const s = this.copaSpot(a);
      Object.assign(a, { x: s.x, y: s.y, loc: 'copa' });
    } else {
      Object.assign(a, { x: BX - 26, y: COR_Y, loc: 'outside' });
    }
    this.avatars.push(a);
    return a;
  }

  copaSpot(a) {
    const copa = this.rooms.find((r) => r.kind === 'copa') ?? { x: BX, y: BY };
    const spots = [[40, 108], [168, 108], [104, 140], [40, 76], [124, 76], [80, 132]];
    const idx = (a.worker === 'claude' ? 0 : 1) + 2 * (this.avatars.filter((o) => o.worker === a.worker && o.id < a.id).length % 3);
    const [x, y] = spots[idx % spots.length];
    return { x: copa.x + x, y: copa.y + y };
  }

  targetOf(a) {
    if (a.leaving) return { loc: 'exit', x: BX - 40, y: COR_Y };
    if (a.assign) {
      const room = this.roomOfLine(a.assign.lineId);
      if (room) return { loc: room.lineId, room, x: room.x + DESK_X[a.worker] + 40, y: room.y + SEAT_Y, seat: true };
    }
    const copa = this.rooms.find((r) => r.kind === 'copa');
    const s = this.copaSpot(a);
    return { loc: 'copa', room: copa, x: s.x, y: s.y };
  }

  roomOfLine(id) {
    return this.rooms.find((r) => r.kind === 'line' && r.lineId === id);
  }

  roomByLoc(loc) {
    if (loc === 'copa') return this.rooms.find((r) => r.kind === 'copa');
    return this.roomOfLine(loc);
  }

  /** Caminho: sai pela porta, anda no corredor, entra e contorna a mesa até a cadeira. */
  planPath(a, target) {
    const pts = [];
    const from = this.roomByLoc(a.loc);
    if (from) {
      if (a.y < from.y + DESK_Y + 20) {
        // está atrás de uma mesa: sai pela lateral da estação
        const side = a.x < from.x + RW / 2 ? from.x + 10 : from.x + RW - 12;
        pts.push({ x: side, y: a.y }, { x: side, y: from.y + AISLE });
      } else pts.push({ x: a.x, y: from.y + AISLE });
      pts.push({ x: from.x + DOOR_X, y: from.y + AISLE }, { x: from.x + DOOR_X, y: COR_Y });
    } else {
      pts.push({ x: a.x, y: COR_Y });
    }
    const to = target.room;
    if (to) {
      pts.push({ x: to.x + DOOR_X, y: COR_Y }, { x: to.x + DOOR_X, y: to.y + AISLE });
      if (target.seat) {
        const side = target.x < to.x + RW / 2 ? to.x + 10 : to.x + RW - 12;
        pts.push({ x: side, y: to.y + AISLE }, { x: side, y: target.y }, { x: target.x, y: target.y });
      } else {
        pts.push({ x: target.x, y: to.y + AISLE }, { x: target.x, y: target.y });
      }
    } else {
      pts.push({ x: target.x, y: target.y });
    }
    return pts;
  }

  updateAvatars(dt) {
    for (const a of this.avatars) {
      if (a.path.length) {
        a.seated = false;
        let budget = SPEED * dt;
        while (budget > 0 && a.path.length) {
          const p = a.path[0];
          const dx = p.x - a.x;
          const dy = p.y - a.y;
          const d = Math.hypot(dx, dy);
          if (Math.abs(dx) > 0.5) a.dir = dx > 0 ? 1 : -1;
          if (d <= budget) {
            a.x = p.x;
            a.y = p.y;
            a.path.shift();
            budget -= d;
          } else {
            a.x += (dx / d) * budget;
            a.y += (dy / d) * budget;
            budget = 0;
          }
        }
        a.walking = true;
        if (!a.path.length) a.loc = a.pendingLoc;
        continue;
      }
      a.walking = false;
      const target = this.targetOf(a);
      const there = target.loc === a.loc && Math.abs(target.x - a.x) < 0.5 && Math.abs(target.y - a.y) < 0.5;
      if (there) {
        a.seated = Boolean(target.seat);
        if (target.loc === 'exit') a.gone = true;
        continue;
      }
      a.path = target.loc === a.loc && !target.seat ? [{ x: target.x, y: target.y }] : this.planPath(a, target);
      a.pendingLoc = target.loc;
    }
    this.avatars = this.avatars.filter((a) => !a.gone);
  }

  // ---- interação ----------------------------------------------------------

  hit(p) {
    for (const a of this.avatars) {
      const top = a.seated ? a.y - 8 : a.y - STAND_H;
      if (a.assign && p.x >= a.x - 9 && p.x <= a.x + 9 && p.y >= top && p.y <= a.y + (a.seated ? 18 : 2)) return { type: 'avatar', avatar: a, room: this.roomOfLine(a.assign.lineId) };
    }
    const room = this.rooms.find((r) => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h);
    return room ? { type: 'room', room } : null;
  }

  onDown(e) {
    if (e.button !== 0) return;
    this.drag = { sx: e.clientX, sy: e.clientY, cx: this.cam.x, cy: this.cam.y, moved: false };
  }

  onMove(e) {
    if (this.drag) {
      const dx = e.clientX - this.drag.sx;
      const dy = e.clientY - this.drag.sy;
      if (Math.abs(dx) + Math.abs(dy) > 4) this.drag.moved = true;
      if (this.drag.moved) {
        this.userMoved = true;
        this.cam.x = this.drag.cx - dx / this.cam.z;
        this.cam.y = this.drag.cy - dy / this.cam.z;
        this.clampCam();
        this.canvas.style.cursor = 'grabbing';
        return;
      }
    }
    if (e.target !== this.canvas) return;
    const h = this.hit(this.toWorld(e));
    this.hover = h?.room ?? null;
    this.canvas.style.cursor = h ? 'pointer' : 'grab';
  }

  onUp(e) {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    this.canvas.style.cursor = 'grab';
    if (d.moved || e.target !== this.canvas) return;
    const h = this.hit(this.toWorld(e));
    if (!h) return;
    const room = h.room;
    if (h.type === 'avatar' || room?.kind === 'line') this.h.onLine?.(room.lineId, h.avatar?.worker);
    else if (room?.kind === 'new') this.h.onNew?.();
    else if (room?.kind === 'skills') this.h.onSkills?.();
    else if (room?.kind === 'copa') this.h.onCopa?.();
  }

  onWheel(e) {
    e.preventDefault();
    const p = this.toWorld(e);
    this.zoomBy(e.deltaY < 0 ? 1 : -1, p.sx, p.sy);
  }

  // ---- loop ---------------------------------------------------------------

  start() {
    const frame = (now) => {
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      this.t += dt;
      this.updateAvatars(dt);
      this.draw();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  draw() {
    if (!this.worldW || !this.vw) return;
    if (this.staticDirty) {
      this.drawStatic(this.staticLayer.getContext('2d'));
      this.staticDirty = false;
    }
    const w = this.wctx;
    w.drawImage(this.staticLayer, 0, 0);
    this.drawDynamic(w);

    const ctx = this.ctx;
    const k = this.cam.z * this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = C.grass;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(k, 0, 0, k, -this.cam.x * k, -this.cam.y * k);
    ctx.drawImage(this.world, 0, 0);
    // textos em coordenadas de tela, sempre nítidos
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawOverlay(ctx);
  }

  sx(wx) {
    return (wx - this.cam.x) * this.cam.z;
  }

  sy(wy) {
    return (wy - this.cam.y) * this.cam.z;
  }

  // ---- camada estática ----------------------------------------------------

  drawStatic(g) {
    this.drawGround(g);
    this.drawBuildingShadow(g);
    this.drawCorridor(g);
    for (const r of this.rooms) {
      if (r.kind === 'new') {
        this.drawEmptyRoom(g, r);
        continue;
      }
      this.drawFloor(g, r);
      this.drawWalls(g, r);
      if (r.kind === 'copa') this.drawCopa(g, r);
      if (r.kind === 'skills') this.drawLibrary(g, r);
      if (r.kind === 'line') this.drawLineRoom(g, r);
    }
    this.drawOuterWall(g);
  }

  drawGround(g) {
    const W = this.worldW;
    R(g, 0, 0, W, WORLD_H, C.grass);
    const rand = rng(7);
    for (let i = 0; i < (W * WORLD_H) / 90; i++) R(g, rand() * W, rand() * WORLD_H, 2, 1, rand() < 0.5 ? C.grassDark : C.grassLight);
    // caminho de tijolo da entrada até a calçada
    R(g, 0, COR_Y - 12, BX, 24, C.brick);
    R(g, 40, COR_Y - 12, 24, WALK_Y - COR_Y + 12, C.brick);
    for (let y = COR_Y - 12; y < COR_Y + 12; y += 6) R(g, 0, y, BX, 1, C.brickLine);
    for (let y = COR_Y + 12; y < WALK_Y; y += 6) R(g, 40, y, 24, 1, C.brickLine);
    // cerca viva
    for (let x = BX - 8; x < BX + this.buildW + 8; x += 14) {
      R(g, x, HEDGE_Y, 12, 10, C.hedge);
      R(g, x + 1, HEDGE_Y + 1, 10, 4, C.hedgeLight);
    }
    // calçada, rua e calçada do outro lado
    R(g, 0, WALK_Y, W, 22, C.brick);
    for (let x = 0; x < W; x += 12) R(g, x, WALK_Y, 1, 22, C.brickLine);
    for (let y = WALK_Y; y < WALK_Y + 22; y += 6) R(g, 0, y, W, 1, C.brickLine);
    R(g, 0, WALK_Y + 22, W, 2, '#8d8f99');
    R(g, 0, ROAD_Y, W, ROAD_H, C.road);
    for (let x = 6; x < W; x += 32) R(g, x, ROAD_Y + ROAD_H / 2 - 1, 16, 2, C.roadLine);
    R(g, 0, ROAD_Y + ROAD_H, W, 2, '#8d8f99');
    R(g, 0, ROAD_Y + ROAD_H + 2, W, 18, C.brick);
    for (let x = 0; x < W; x += 12) R(g, x, ROAD_Y + ROAD_H + 2, 1, 18, C.brickLine);
    // postes de luz
    for (let x = BX; x < BX + this.buildW; x += 104) {
      R(g, x, WALK_Y - 22, 2, 26, '#3b3d48');
      R(g, x - 2, WALK_Y - 26, 6, 4, '#3b3d48');
      R(g, x - 1, WALK_Y - 25, 4, 2, '#ffe9a3');
    }
    // árvores em volta do prédio (posições fixas por semente)
    const rnd = rng(42);
    const avoid = (x, y) =>
      (x > BX - 24 && x < BX + this.buildW + 24 && y > BY - 30 && y < HEDGE_Y + 16) ||
      (y > WALK_Y - 30 && y < ROAD_Y + ROAD_H + 28) ||
      (y > COR_Y - 34 && y < WALK_Y && x < BX + 4 && x > 28);
    const spots = [];
    for (let y = 22; y < WORLD_H + 20; y += 30) {
      for (let x = 8; x < W; x += 34) {
        const px = x + rnd() * 18;
        const py = y + rnd() * 14;
        if (rnd() < 0.45 && !avoid(px, py)) spots.push([px, py, rnd() < 0.3]);
      }
    }
    spots.sort((a, b) => a[1] - b[1]).forEach(([x, y, pine]) => (pine ? this.pine(g, x, y) : this.tree(g, x, y)));
  }

  tree(g, x, y) {
    g.fillStyle = 'rgba(0,0,0,.18)';
    g.beginPath();
    g.ellipse(x, y + 2, 11, 4, 0, 0, Math.PI * 2);
    g.fill();
    R(g, x - 2, y - 8, 4, 10, '#7a4f2e');
    const blob = (cx, cy, r, c) => {
      g.fillStyle = c;
      g.beginPath();
      g.arc(Math.round(cx), Math.round(cy), r, 0, Math.PI * 2);
      g.fill();
    };
    blob(x, y - 16, 11, '#2f6b30');
    blob(x - 5, y - 14, 8, '#3b8040');
    blob(x + 4, y - 19, 8, '#3f8a43');
    blob(x - 2, y - 21, 6, '#55a356');
    blob(x - 4, y - 22, 2, '#7cc26f');
  }

  pine(g, x, y) {
    g.fillStyle = 'rgba(0,0,0,.18)';
    g.beginPath();
    g.ellipse(x, y + 2, 8, 3, 0, 0, Math.PI * 2);
    g.fill();
    R(g, x - 1, y - 6, 3, 8, '#6a4427');
    const layer = (top, half, c) => {
      g.fillStyle = c;
      g.beginPath();
      g.moveTo(x, top);
      g.lineTo(x - half, top + half * 1.3);
      g.lineTo(x + half, top + half * 1.3);
      g.closePath();
      g.fill();
    };
    layer(y - 26, 7, '#2c5e35');
    layer(y - 20, 9, '#2f6638');
    layer(y - 14, 10, '#356f3d');
    R(g, x - 1, y - 24, 2, 3, '#4f8f55');
  }

  drawBuildingShadow(g) {
    g.fillStyle = 'rgba(0,0,0,.22)';
    g.fillRect(BX - 2, BY + 4, this.buildW + 10, BUILD_H + 6);
  }

  drawOuterWall(g) {
    const x0 = BX - 4;
    const y0 = BY - 4;
    const w = this.buildW + 8;
    const h = BUILD_H + 8;
    R(g, x0, y0, w, 4, C.outerWall);
    R(g, x0, y0 + h - 4, w, 4, C.outerWall);
    R(g, x0, y0, 4, h, C.outerWall);
    R(g, x0 + w - 4, y0, 4, h, C.outerWall);
    R(g, x0, y0, w, 1, C.wallCap);
    // entrada à esquerda do corredor, com capacho
    R(g, x0, COR_Y - 12, 4, 24, C.corridor1);
    R(g, x0 - 7, COR_Y - 10, 7, 20, '#7a3d3a');
    R(g, x0 - 6, COR_Y - 8, 5, 16, '#954b47');
  }

  drawCorridor(g) {
    const y = BY + RH;
    for (let x = BX; x < BX + this.buildW; x += 16) {
      for (let yy = y; yy < y + CH; yy += 16) R(g, x, yy, 16, 16, ((x - BX + yy) / 16) % 2 ? C.corridor1 : C.corridor2);
    }
    for (let c = 0; c < this.cols; c++) {
      const rx = BX + c * RW;
      R(g, rx + 22, COR_Y - 6, RW - 44, 12, C.runner);
      R(g, rx + 24, COR_Y - 4, RW - 48, 8, '#a9aeb8');
      if (c % 2 === 0) {
        R(g, rx + 150, y + 4, 34, 7, '#8a6a4a');
        R(g, rx + 151, y + 4, 32, 3, '#a5825e');
      }
      if (c > 0) this.plant(g, rx + 8, y + CH - 4, 0.8);
    }
  }

  drawFloor(g, r) {
    const { x, y } = r;
    if (r.kind === 'copa') {
      for (let i = 0; i < r.w; i += 13) for (let j = WALL; j < r.h; j += 13) R(g, x + i, y + j, 13, 13, ((i + j) / 13) % 2 ? C.copa1 : C.copa2);
      return;
    }
    if (r.kind === 'skills') {
      R(g, x, y + WALL, r.w, r.h - WALL, C.wood1);
      for (let j = WALL; j < r.h; j += 8) {
        R(g, x, y + j + 4, r.w, 4, C.wood2);
        R(g, x, y + j, r.w, 1, C.woodLine);
        for (let i = ((j - WALL) / 8) % 2 ? 0 : 20; i < r.w; i += 40) R(g, x + i, y + j, 1, 8, C.woodLine);
      }
      return;
    }
    for (let i = 0; i < r.w; i += 16) {
      for (let j = WALL; j < r.h; j += 16) {
        R(g, x + i, y + j, 16, 16, ((i + j) / 16) % 2 ? C.tile1 : C.tile2);
        R(g, x + i, y + j, 16, 1, C.tileLine);
        R(g, x + i, y + j, 1, 16, C.tileLine);
      }
    }
  }

  drawWalls(g, r) {
    const { x, y } = r;
    R(g, x, y, r.w, WALL, C.wallFace);
    R(g, x, y, r.w, 3, C.partitionDark);
    R(g, x, y + 3, r.w, 2, C.wallFaceShade);
    R(g, x, y + WALL - 9, r.w, 6, C.wainscot);
    R(g, x, y + WALL - 3, r.w, 3, C.baseboard);
    R(g, x, y, 3, r.h, C.partition);
    R(g, x + r.w - 3, y, 3, r.h, C.partition);
    R(g, x + r.w - 1, y, 1, r.h, C.partitionDark);
    if (r.row === 0) {
      // parede de baixo, com porta para o corredor
      R(g, x, y + r.h - 4, r.w, 4, C.partition);
      R(g, x, y + r.h - 1, r.w, 1, C.partitionDark);
      this.floorPatch(g, r, x + DOOR_X - DOOR_W / 2, y + r.h - 4, DOOR_W, 4);
    } else {
      // porta na parede do fundo, que dá para o corredor
      this.floorPatch(g, r, x + DOOR_X - DOOR_W / 2, y, DOOR_W, WALL);
      R(g, x + DOOR_X - DOOR_W / 2 - 2, y, 2, WALL, C.baseboard);
      R(g, x + DOOR_X + DOOR_W / 2, y, 2, WALL, C.baseboard);
    }
  }

  floorPatch(g, r, x, y, w, h) {
    R(g, x, y, w, h, r.kind === 'copa' ? C.copa2 : r.kind === 'skills' ? C.wood2 : C.tile1);
  }

  drawEmptyRoom(g, r) {
    R(g, r.x, r.y, r.w, r.h, '#cfc9bd');
    for (let i = 0; i < r.w; i += 16) for (let j = 0; j < r.h; j += 16) R(g, r.x + i, r.y + j, 16, 1, '#c3bcae');
    g.fillStyle = 'rgba(80,74,64,.45)';
    for (let i = r.x + 6; i < r.x + r.w - 6; i += 8) {
      g.fillRect(i, r.y + 6, 4, 1);
      g.fillRect(i, r.y + r.h - 7, 4, 1);
    }
    for (let j = r.y + 6; j < r.y + r.h - 6; j += 8) {
      g.fillRect(r.x + 6, j, 1, 4);
      g.fillRect(r.x + r.w - 7, j, 1, 4);
    }
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    R(g, cx - 10, cy - 2, 20, 4, 'rgba(80,74,64,.55)');
    R(g, cx - 2, cy - 10, 4, 20, 'rgba(80,74,64,.55)');
  }

  plant(g, x, y, s = 1) {
    const S = (v) => Math.round(v * s);
    R(g, x - S(5), y - S(8), S(10), S(8), C.pot);
    R(g, x - S(5), y - S(8), S(10), 2, C.potDark);
    R(g, x - S(7), y - S(17), S(14), S(9), C.plantDark);
    R(g, x - S(5), y - S(21), S(10), S(9), C.plant);
    R(g, x - S(8), y - S(14), S(4), S(4), C.plant);
    R(g, x + S(4), y - S(15), S(4), S(4), C.plant);
    R(g, x - S(2), y - S(20), S(3), S(3), C.plantLight);
  }

  windowOnWall(g, x, y, w) {
    R(g, x, y + 5, w, 18, '#dfe3ea');
    R(g, x + 2, y + 7, w - 4, 14, '#8fc3ef');
    R(g, x + 2, y + 7, w - 4, 5, '#b3d8f6');
    R(g, x + w / 2 - 1, y + 5, 2, 18, '#dfe3ea');
  }

  clock(g, x, y) {
    R(g, x - 5, y, 10, 10, '#2d2f38');
    R(g, x - 4, y + 1, 8, 8, '#f4f1e8');
    R(g, x, y + 2, 1, 3, '#2d2f38');
    R(g, x, y + 5, 3, 1, '#2d2f38');
  }

  drawCopa(g, r) {
    const { x, y } = r;
    this.windowOnWall(g, x + 112, y, 32);
    this.clock(g, x + 98, y + 7);
    // bancada com cafeteira, micro-ondas e pia
    R(g, x + 6, y + 22, 84, 16, '#f4f2ee');
    R(g, x + 6, y + 36, 84, 6, '#c9c6bf');
    R(g, x + 10, y + 8, 18, 16, '#4b5064');
    R(g, x + 13, y + 12, 12, 7, '#20232c');
    R(g, x + 24, y + 10, 2, 2, '#ff6b72');
    R(g, x + 34, y + 12, 22, 12, '#d8dbe2');
    R(g, x + 37, y + 14, 12, 8, '#3a3f4c');
    R(g, x + 62, y + 24, 22, 8, '#b7bfcc');
    R(g, x + 72, y + 18, 2, 7, '#9aa3b5');
    // máquina de refrigerante e geladeira
    R(g, x + 150, y + 8, 22, 44, '#d6453f');
    R(g, x + 153, y + 12, 16, 22, '#2b2f3b');
    for (let i = 0; i < 3; i++) for (let j = 0; j < 4; j++) R(g, x + 155 + i * 5, y + 14 + j * 5, 3, 3, ['#ffd166', '#7cc96a', '#5fb0ff'][i]);
    R(g, x + 153, y + 38, 16, 6, '#1c1f28');
    R(g, x + 176, y + 6, 26, 46, '#e8ecf2');
    R(g, x + 176, y + 26, 26, 1, '#c3c9d3');
    R(g, x + 198, y + 12, 2, 8, '#a0a8b5');
    // bebedouro
    R(g, x + 8, y + 54, 10, 14, '#cfd8e6');
    R(g, x + 9, y + 46, 8, 9, '#7fb7e8');
    // mesas redondas com cadeiras
    for (const [tx, ty] of [[60, 88], [148, 88]]) {
      for (const dx of [-17, 17]) {
        R(g, x + tx + dx - 5, y + ty - 4, 10, 10, C.chair);
        R(g, x + tx + dx - 5, y + ty - 4, 10, 3, C.chairDark);
      }
      g.fillStyle = '#bfc5d0';
      g.beginPath();
      g.ellipse(x + tx, y + ty + 1, 13, 9, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#f2f4f7';
      g.beginPath();
      g.ellipse(x + tx, y + ty, 12, 8, 0, 0, Math.PI * 2);
      g.fill();
      R(g, x + tx - 4, y + ty - 3, 3, 3, '#ffffff');
      R(g, x + tx + 2, y + ty - 1, 3, 3, '#c26a3c');
    }
    this.plant(g, x + 14, y + 146);
    this.plant(g, x + 194, y + 146);
  }

  drawLibrary(g, r) {
    const { x, y } = r;
    const colors = ['#d9576b', '#e9b949', '#5fb0ff', '#7cc96a', '#c17ad6', '#e58a4f', '#5fc7c0', '#f4efe2'];
    for (const [sx, sw] of [[8, 76], [124, 76]]) {
      R(g, x + sx, y + 2, sw, 44, '#6b4a30');
      for (const sy of [5, 19, 33]) {
        R(g, x + sx + 2, y + sy, sw - 4, 12, '#4a3220');
        for (let bx = 3, i = sx + sy; bx < sw - 5; i++) {
          const w = 3 + ((i * 7) % 3);
          const h = 8 + ((i * 5) % 4);
          R(g, x + sx + bx, y + sy + 12 - h, w, h, colors[i % colors.length]);
          bx += w + 1;
        }
      }
    }
    R(g, x + 44, y + 74, 120, 56, '#5d6fa6');
    R(g, x + 48, y + 78, 112, 48, '#6e81ba');
    R(g, x + 70, y + 88, 68, 22, C.deskEdge);
    R(g, x + 70, y + 88, 68, 18, C.desk);
    R(g, x + 80, y + 92, 14, 9, '#f4efe2');
    R(g, x + 112, y + 93, 12, 8, '#f4efe2');
    R(g, x + 86, y + 92, 1, 9, '#c9c1ae');
    for (const ax of [48, 148]) {
      R(g, x + ax, y + 90, 14, 16, '#a2463f');
      R(g, x + ax, y + 90, 14, 5, '#7f3530');
    }
    R(g, x + 186, y + 100, 3, 30, '#3b3d48');
    R(g, x + 181, y + 94, 13, 7, '#ffe08a');
    this.plant(g, x + 14, y + 146);
    this.plant(g, x + 194, y + 146);
  }

  drawLineRoom(g, r) {
    const { x, y } = r;
    if (r.row === 0) {
      this.windowOnWall(g, x + 14, y, 36);
      this.windowOnWall(g, x + 58, y, 36);
    } else {
      // pôsteres na parede do corredor (a porta fica no meio)
      R(g, x + 22, y + 6, 18, 18, '#2d2f38');
      R(g, x + 24, y + 8, 14, 14, '#e58a4f');
      R(g, x + 27, y + 11, 8, 4, '#ffe08a');
      R(g, x + 48, y + 6, 18, 18, '#2d2f38');
      R(g, x + 50, y + 8, 14, 14, '#5fb0ff');
      R(g, x + 54, y + 14, 6, 6, '#f4f1e8');
    }
    // quadro branco (as etapas aparecem nele)
    R(g, x + 130, y + 4, 70, 22, '#9aa0b4');
    R(g, x + 132, y + 6, 66, 18, '#fbfaf6');
    R(g, x + 134, y + 25, 60, 2, '#7d8398');
    if (r.row === 0) this.clock(g, x + 112, y + 7);
    // tapete
    R(g, x + 44, y + 98, 120, 38, '#c8d3e0');
    R(g, x + 47, y + 101, 114, 32, '#d9e2ec');
    for (const w of ['claude', 'codex']) if (r.workers.includes(w)) this.drawDesk(g, x + DESK_X[w], y, w);
    // estante, luminária e plantas
    R(g, x + 186, y + 34, 16, 26, '#8a6a4a');
    for (let i = 0; i < 3; i++) R(g, x + 188, y + 36 + i * 8, 12, 6, ['#d9576b', '#5fb0ff', '#7cc96a'][i]);
    R(g, x + 8, y + 106, 3, 26, '#3b3d48');
    R(g, x + 3, y + 100, 13, 7, '#ffe08a');
    this.plant(g, x + 14, y + 146);
    this.plant(g, x + 194, y + 146);
  }

  drawDesk(g, x, y, worker) {
    const top = y + DESK_Y;
    R(g, x, top, 64, 18, C.desk);
    R(g, x, top, 64, 2, '#f3dcb5');
    R(g, x, top + 16, 64, 2, C.deskEdge);
    R(g, x + 1, top + 18, 62, 7, C.deskFront);
    R(g, x + 4, top + 20, 22, 3, '#a27d4d');
    R(g, x + 38, top + 20, 22, 3, '#a27d4d');
    R(g, x + 2, top + 25, 3, 4, '#7a5a37');
    R(g, x + 59, top + 25, 3, 4, '#7a5a37');
    // monitor à esquerda da estação, tela virada para quem olha
    R(g, x + 4, top - 14, 26, 18, C.monitor);
    R(g, x + 6, top - 12, 22, 13, C.screenOff);
    R(g, x + 15, top + 4, 4, 3, C.monitor);
    // teclado, caneca e plaquinha com a cor do trabalhador
    R(g, x + 32, top + 6, 18, 5, '#d4d8e0');
    R(g, x + 33, top + 7, 16, 1, '#b3b8c3');
    R(g, x + 54, top + 4, 5, 6, '#f4efe2');
    R(g, x + 26, top + 19, 12, 3, WORKER_STYLE[worker].color);
  }

  // ---- camada dinâmica ----------------------------------------------------

  drawDynamic(g) {
    const t = this.t;
    for (const r of this.rooms) {
      if (r.kind !== 'line') continue;
      const line = this.lines.find((l) => l.id === r.lineId);
      if (line) this.drawBoard(g, r, line);
    }
    const seated = new Map();
    for (const a of this.avatars) if (a.seated && a.assign) seated.set(`${a.assign.lineId}:${a.worker}`, a);
    for (const r of this.rooms) {
      if (r.kind !== 'line') continue;
      for (const w of r.workers) {
        const dx = r.x + DESK_X[w];
        const cx = dx + 40;
        const a = seated.get(`${r.lineId}:${w}`);
        this.drawChair(g, cx, r.y, Boolean(a));
        if (a) {
          this.drawScreen(g, dx, r.y, w, t + a.phase);
          const img = sprite(w, Math.floor((t + a.phase) * 6) % 2 ? 'sitA' : 'sitB');
          g.drawImage(img, Math.round(cx - img.width / 2), r.y + DESK_Y + 5 - img.height);
        }
      }
    }
    // quem está em pé ou andando, por ordem de profundidade
    const standing = this.avatars.filter((a) => !a.seated).sort((p, q) => p.y - q.y);
    for (const a of standing) {
      const pose = a.walking ? (Math.floor((t + a.phase) * 8) % 2 ? 'walkA' : 'walkB') : 'stand';
      const img = sprite(a.worker, pose);
      const bob = !a.walking && Math.floor((t + a.phase) * 1.2) % 2 ? 1 : 0;
      g.fillStyle = 'rgba(0,0,0,.22)';
      g.beginPath();
      g.ellipse(Math.round(a.x), Math.round(a.y), 7, 2.5, 0, 0, Math.PI * 2);
      g.fill();
      const px = Math.round(a.x - img.width / 2);
      const py = Math.round(a.y - img.height + 1 + bob);
      if (a.dir < 0) {
        g.save();
        g.translate(px + img.width, py);
        g.scale(-1, 1);
        g.drawImage(img, 0, 0);
        g.restore();
      } else g.drawImage(img, px, py);
      if (!a.walking && a.loc === 'copa' && !a.assign) R(g, a.x + 7, a.y - 11 + bob, 3, 4, '#f4efe2');
    }
    this.drawCar(g, t);
  }

  drawChair(g, cx, y, occupied) {
    const top = y + DESK_Y - 24;
    R(g, cx - 8, top, 16, 12, C.chair);
    R(g, cx - 8, top, 16, 3, '#5577c2');
    R(g, cx - 8, top + 10, 16, 2, C.chairDark);
    if (!occupied) {
      R(g, cx - 7, top + 12, 14, 9, C.chairDark);
      R(g, cx - 6, top + 12, 12, 7, C.chair);
    }
  }

  drawScreen(g, x, y, worker, t) {
    const color = WORKER_STYLE[worker].color;
    const top = y + DESK_Y - 12;
    R(g, x + 6, top, 22, 13, '#141826');
    const scroll = Math.floor(t * 4);
    for (let i = 0; i < 5; i++) {
      const n = scroll + i;
      const indent = ((n * 3) % 4) * 2;
      const len = 4 + ((n * 7) % 11);
      R(g, x + 7 + indent, top + 2 + i * 2, Math.min(len, 19 - indent), 1, i === 4 ? '#e9edf2' : n % 3 === 0 ? color : '#8b93ad');
    }
    g.fillStyle = `${color}40`;
    g.fillRect(x + 2, y + DESK_Y + 1, 30, 4);
  }

  drawBoard(g, r, line) {
    const attempts = line.run?.attempts ?? [];
    const running = line.run?.status === 'running';
    const n = line.steps.length;
    const chip = Math.max(3, Math.min(12, Math.floor(60 / Math.max(1, n)) - 2));
    let x = r.x + 135;
    const y = r.y + 10;
    line.steps.forEach((s, i) => {
      const last = [...attempts].reverse().find((a) => a.step === i);
      const st = last?.status;
      let c = WORKER_STYLE[s.worker].color;
      if (!st) c = '#cfcbc0';
      if (st === 'running' && running && Math.floor(this.t * 3) % 2) c = '#fbfaf6';
      R(g, x, y, chip, 8, c);
      if (!st) R(g, x, y + 7, chip, 1, WORKER_STYLE[s.worker].color);
      if (st === 'done') R(g, x + chip / 2 - 1, y + 10, 2, 2, last.verdict === 'MUDANCAS_NECESSARIAS' ? '#c9871a' : '#2f8f3a');
      if (st === 'failed') R(g, x + chip / 2 - 1, y + 10, 2, 2, '#c23b44');
      x += chip + 2;
    });
  }

  drawCar(g, t) {
    const span = this.worldW + 80;
    const x = ((t * 34) % span) - 40;
    const y = ROAD_Y + ROAD_H / 2 + 5;
    R(g, x, y + 10, 34, 3, 'rgba(0,0,0,.25)');
    R(g, x, y, 34, 11, '#f4efe2');
    R(g, x + 7, y - 6, 18, 7, '#f4efe2');
    R(g, x + 9, y - 5, 6, 5, '#8fc3ef');
    R(g, x + 17, y - 5, 6, 5, '#8fc3ef');
    R(g, x + 32, y + 3, 2, 3, '#ffe08a');
    R(g, x, y + 4, 2, 3, '#ff6b72');
    R(g, x + 5, y + 9, 6, 4, '#24263a');
    R(g, x + 23, y + 9, 6, 4, '#24263a');
  }

  // ---- etiquetas e balões (resolução de tela) ----------------------------

  pill(ctx, x, y, w, h, fill, stroke) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, h / 2);
    else ctx.rect(x, y, w, h);
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  clip(ctx, str, max) {
    if (ctx.measureText(str).width <= max) return str;
    let s = str;
    while (s.length > 1 && ctx.measureText(`${s}…`).width > max) s = s.slice(0, -1);
    return `${s}…`;
  }

  /** Placa escura no topo da sala. */
  roomTag(ctx, r, text, { dots = [], badge = null, statusColor = null, highlight = false } = {}) {
    ctx.font = '600 12px Inter, system-ui, sans-serif';
    const label = this.clip(ctx, text, Math.max(60, r.w * this.cam.z - 70));
    const tw = ctx.measureText(label).width;
    const extra = (statusColor ? 14 : 0) + (dots.length ? dots.length * 9 + 2 : 0) + (badge ? 22 : 0);
    const w = tw + 20 + extra;
    const h = 22;
    const cx = this.sx(r.x + r.w / 2);
    const y = this.sy(r.y) - h / 2 - 2;
    let x = cx - w / 2;
    this.pill(ctx, x, y, w, h, highlight ? '#2b4f8f' : 'rgba(30,32,40,.94)', highlight ? '#6aa2ff' : 'rgba(255,255,255,.12)');
    x += 10;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    if (statusColor) {
      ctx.fillStyle = statusColor;
      ctx.beginPath();
      ctx.arc(x + 4, y + h / 2, 4, 0, Math.PI * 2);
      ctx.fill();
      x += 14;
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, x, y + h / 2 + 0.5);
    x += tw + 6;
    for (const c of dots) {
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.arc(x + 3, y + h / 2, 3.5, 0, Math.PI * 2);
      ctx.fill();
      x += 9;
    }
    if (badge) {
      this.pill(ctx, x + 2, y + 4, 16, h - 8, 'rgba(255,255,255,.14)');
      ctx.font = '600 10px Inter, system-ui, sans-serif';
      ctx.fillStyle = '#d8dbe6';
      ctx.textAlign = 'center';
      ctx.fillText(badge, x + 10, y + h / 2 + 0.5);
    }
  }

  /** Crachá com a letra da IA e o nome. */
  nameTag(ctx, a, wx, wy) {
    const style = WORKER_STYLE[a.worker];
    ctx.font = '600 11px Inter, system-ui, sans-serif';
    const tw = ctx.measureText(a.label).width;
    const w = tw + 26;
    const h = 18;
    const x = this.sx(wx) - w / 2;
    const y = this.sy(wy);
    this.pill(ctx, x, y, w, h, 'rgba(30,32,40,.92)');
    ctx.fillStyle = style.color;
    ctx.beginPath();
    ctx.arc(x + 9, y + h / 2, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 8px Inter, system-ui, sans-serif';
    ctx.fillText(style.letter, x + 9, y + h / 2 + 0.5);
    ctx.font = '600 11px Inter, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(a.label, x + 19, y + h / 2 + 0.5);
  }

  /** Balão branco com ícone e o que a IA está fazendo. */
  bubble(ctx, text, wx, wy) {
    ctx.font = '500 12px Inter, system-ui, sans-serif';
    const label = this.clip(ctx, text, 210);
    const tw = ctx.measureText(label).width;
    const w = tw + 34;
    const h = 24;
    const ax = this.sx(wx);
    const x = ax - w / 2;
    const y = this.sy(wy) - h - 6;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.25)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 2;
    this.pill(ctx, x, y, w, h, '#ffffff');
    ctx.restore();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(ax - 5, y + h - 1);
    ctx.lineTo(ax + 5, y + h - 1);
    ctx.lineTo(ax, y + h + 6);
    ctx.fill();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.font = '12px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
    ctx.fillText(activityIcon(text), x + 8, y + h / 2 + 1);
    ctx.font = '500 12px Inter, system-ui, sans-serif';
    ctx.fillStyle = '#23252e';
    ctx.fillText(label, x + 26, y + h / 2 + 0.5);
  }

  drawOverlay(ctx) {
    const z = this.cam.z;
    for (const r of this.rooms) {
      const sel = r.kind === 'line' && r.lineId === this.selected;
      if (!sel && this.hover !== r) continue;
      ctx.strokeStyle = sel ? 'rgba(106,162,255,.95)' : 'rgba(255,255,255,.55)';
      ctx.lineWidth = sel ? 3 : 2;
      ctx.strokeRect(this.sx(r.x) + 1, this.sy(r.y) + 1, r.w * z - 2, r.h * z - 2);
    }
    for (const r of this.rooms) {
      if (r.kind === 'line') {
        const line = this.lines.find((l) => l.id === r.lineId);
        if (!line) continue;
        this.roomTag(ctx, r, line.name, {
          statusColor: STATUS[lineStatus(line)][1],
          dots: r.workers.map((w) => WORKER_STYLE[w].color),
          badge: String(line.steps.length),
          highlight: line.id === this.selected,
        });
      } else if (r.kind === 'new') {
        this.roomTag(ctx, r, '+ Nova linha');
      } else {
        this.roomTag(ctx, r, r.kind === 'skills' ? `📚 ${r.title}` : `☕ ${r.title}`);
      }
    }
    if (z < 0.75) return; // longe demais para crachás e balões
    for (const a of this.avatars) {
      if (a.seated && a.assign) {
        const r = this.roomOfLine(a.assign.lineId);
        if (!r) continue;
        this.nameTag(ctx, a, a.x, r.y + DESK_Y + 30);
        this.bubble(ctx, a.assign.activity || 'trabalhando…', a.x, r.y + DESK_Y + 2 - SIT_H);
      } else if (!a.walking || z >= 1.5) {
        this.nameTag(ctx, a, a.x, a.y + 3);
      }
    }
  }
}
