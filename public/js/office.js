import { BACK_H, FRONT_H, SPRITE_W, WORKER_STYLE, sprite } from './sprites.js';

// Mundo em pixels "lógicos"; o canvas é desenhado ampliado (escala inteira).
const RW = 192; // largura de uma sala
const RH = 128; // altura de uma sala
const CH = 48; // altura do corredor
const WORLD_H = RH * 2 + CH;
const COR_Y = RH + CH / 2; // linha central do corredor
const DOOR_X = 20; // porta fica no canto esquerdo de cada sala
const AISLE = 106; // corredor interno da sala (y local)
const SEAT_Y = 80; // y local dos pés quando chega na cadeira
const DESK_X = { claude: 36, codex: 112 };
const SPEED = 90; // px lógicos por segundo

const C = {
  void: '#0b0c12',
  wall: '#3b4263',
  wallTop: '#2b3049',
  wallTrim: '#262a40',
  wallLight: '#465078',
  sideWall: '#1c1f30',
  wood1: '#8b6a4b',
  wood2: '#7f6044',
  woodLine: '#6a4f37',
  tile1: '#d9cfbf',
  tile2: '#c6b9a4',
  carpet1: '#4b406c',
  carpet2: '#443a63',
  cor1: '#5a5e74',
  cor2: '#53576c',
  desk: '#a77b51',
  deskEdge: '#8a633f',
  deskFront: '#6c4c31',
  monitor: '#20222c',
  screenOff: '#10121a',
  chair: '#2c3048',
  chairTop: '#3a3f5e',
  plant: '#4f9a52',
  plantDark: '#3a7a3f',
  pot: '#9b5b3a',
};

const STATUS_TEXT = {
  running: ['▶ trabalhando', '#7aa7e8'],
  done: ['✔ concluída', '#7cc96a'],
  aprovado: ['✔ aprovada', '#7cc96a'],
  pendente: ['⚠ mudanças pendentes', '#e9b949'],
  failed: ['✖ falhou', '#e5636a'],
  budget: ['$ orçamento estourado', '#e5636a'],
  stopped: ['■ parada', '#9a9cae'],
  idle: ['○ pronta', '#9a9cae'],
};

export function lineStatus(line) {
  const r = line.run;
  if (!r) return 'idle';
  if (r.status === 'done') return r.outcome === 'aprovado' ? 'aprovado' : r.outcome === 'mudancas_pendentes' ? 'pendente' : 'done';
  return STATUS_TEXT[r.status] ? r.status : 'idle';
}
export { STATUS_TEXT };

export class Office {
  constructor(canvas, handlers) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.h = handlers;
    this.scale = 2;
    this.rooms = [];
    this.lines = [];
    this.selected = null;
    this.hover = null;
    this.avatars = [];
    this.avatarSeq = 0;
    this.world = document.createElement('canvas');
    this.wctx = this.world.getContext('2d');
    this.staticLayer = document.createElement('canvas');
    this.staticDirty = true;
    this.last = performance.now();
    this.t = 0;

    canvas.addEventListener('mousemove', (e) => this.onMove(e));
    canvas.addEventListener('mouseleave', () => {
      this.hover = null;
      canvas.style.cursor = 'default';
    });
    canvas.addEventListener('click', (e) => this.onClick(e));
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    document.fonts?.ready.then(() => (this.staticDirty = true));
  }

  // ---- dados --------------------------------------------------------------

  setData({ lines, skills }) {
    const sig = JSON.stringify([lines.map((l) => [l.id, [...new Set(l.steps.map((s) => s.worker))].sort()]), skills.length]);
    this.lines = lines;
    this.skills = skills;
    if (sig !== this.layoutSig) {
      this.layoutSig = sig;
      this.layout();
    }
    this.syncAvatars();
  }

  setSelected(id) {
    this.selected = id;
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
      r.x = r.col * RW;
      r.y = r.row === 0 ? 0 : RH + CH;
      r.w = RW;
      r.h = RH;
    }
    this.rooms = rooms;
    this.cols = Math.max(...rooms.map((r) => r.col)) + 1;
    this.worldW = this.cols * RW;
    this.world.width = this.worldW;
    this.world.height = WORLD_H;
    this.staticLayer.width = this.worldW;
    this.staticLayer.height = WORLD_H;
    this.staticDirty = true;
    this.resize();
    // avatares cujas salas mudaram de lugar recalculam o caminho
    for (const a of this.avatars) a.path = [];
  }

  resize() {
    const parent = this.canvas.parentElement;
    if (!this.worldW || !parent) return;
    const availH = parent.clientHeight - 8;
    const availW = parent.clientWidth - 8;
    let s = Math.floor(Math.min(availH / WORLD_H, Math.max(availW / this.worldW, 2)));
    s = Math.max(1, Math.min(4, s));
    const dpr = window.devicePixelRatio || 1;
    this.scale = s;
    this.dpr = dpr;
    this.canvas.style.width = `${this.worldW * s}px`;
    this.canvas.style.height = `${WORLD_H * s}px`;
    this.canvas.width = Math.round(this.worldW * s * dpr);
    this.canvas.height = Math.round(WORLD_H * s * dpr);
  }

  roomOfLine(id) {
    return this.rooms.find((r) => r.kind === 'line' && r.lineId === id);
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
    for (const a of this.avatars) {
      if (a.assign && !wantedKeys.has(a.assign.key)) a.assign = null;
    }
    for (const want of wanted) {
      let av = this.avatars.find((a) => a.assign?.key === want.key);
      if (av) {
        av.assign = want;
        continue;
      }
      av = this.avatars.find((a) => a.worker === want.worker && !a.assign && !a.leaving);
      if (!av) av = this.spawn(want.worker, false);
      av.assign = want;
    }
    // Sobrou mais de um ocioso do mesmo trabalhador? os extras vão embora.
    for (const w of Object.keys(WORKER_STYLE)) {
      const idle = this.avatars.filter((a) => a.worker === w && !a.assign && !a.leaving);
      idle.slice(1).forEach((a) => (a.leaving = true));
    }
  }

  spawn(worker, inCopa) {
    const n = this.avatars.filter((a) => a.worker === worker).length;
    const a = {
      id: ++this.avatarSeq,
      worker,
      label: n ? `${WORKER_STYLE[worker].name} ${n + 1}` : WORKER_STYLE[worker].name,
      x: 0,
      y: 0,
      loc: null,
      path: [],
      assign: null,
      leaving: false,
      seated: false,
      phase: Math.random() * 10,
    };
    if (inCopa) {
      const spot = this.copaSpot(a);
      a.x = spot.x;
      a.y = spot.y;
      a.loc = 'copa';
    } else {
      a.x = -6;
      a.y = COR_Y;
      a.loc = 'corridor';
    }
    this.avatars.push(a);
    return a;
  }

  copaSpot(a) {
    const copa = this.rooms.find((r) => r.kind === 'copa') ?? { x: 0, y: 0 };
    const spots = [
      [62, 96],
      [132, 96],
      [98, 112],
      [44, 72],
      [150, 72],
      [80, 70],
    ];
    const idx = (a.worker === 'claude' ? 0 : 1) + 2 * (this.avatars.filter((o) => o.worker === a.worker && o.id < a.id).length % 3);
    const [x, y] = spots[idx % spots.length];
    return { x: copa.x + x, y: copa.y + y };
  }

  targetOf(a) {
    if (a.leaving) return { loc: 'exit', x: -8, y: COR_Y };
    if (a.assign) {
      const room = this.roomOfLine(a.assign.lineId);
      if (room) return { loc: room.lineId, room, x: room.x + DESK_X[a.worker] + 24, y: room.y + SEAT_Y, seat: true };
    }
    const copa = this.rooms.find((r) => r.kind === 'copa');
    const s = this.copaSpot(a);
    return { loc: 'copa', room: copa, x: s.x, y: s.y };
  }

  roomByLoc(loc) {
    if (loc === 'copa') return this.rooms.find((r) => r.kind === 'copa');
    return this.roomOfLine(loc);
  }

  /** Caminho em L: sai da sala pela porta, anda no corredor, entra na outra. */
  planPath(a, target) {
    const pts = [];
    const from = this.roomByLoc(a.loc);
    if (from) {
      pts.push({ x: a.x, y: from.y + AISLE });
      pts.push({ x: from.x + DOOR_X, y: from.y + AISLE });
      pts.push({ x: from.x + DOOR_X, y: COR_Y });
    } else {
      pts.push({ x: a.x, y: COR_Y });
    }
    if (target.room) {
      pts.push({ x: target.room.x + DOOR_X, y: COR_Y });
      pts.push({ x: target.room.x + DOOR_X, y: target.room.y + AISLE });
      pts.push({ x: target.x, y: target.room.y + AISLE });
      pts.push({ x: target.x, y: target.y });
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
      if (target.loc === a.loc && !target.seat) {
        a.path = [{ x: target.x, y: target.y }];
      } else {
        a.path = this.planPath(a, target);
      }
      a.pendingLoc = target.loc;
    }
    this.avatars = this.avatars.filter((a) => !a.gone);
  }

  // ---- interação ----------------------------------------------------------

  toWorld(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * this.worldW, y: ((e.clientY - r.top) / r.height) * WORLD_H };
  }

  hit(p) {
    for (const a of this.avatars) {
      if (a.assign && p.x >= a.x - 7 && p.x <= a.x + 7 && p.y >= a.y - 20 && p.y <= a.y + 2) return { type: 'avatar', avatar: a, room: this.roomOfLine(a.assign.lineId) };
    }
    const room = this.rooms.find((r) => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h);
    return room ? { type: 'room', room } : null;
  }

  onMove(e) {
    const h = this.hit(this.toWorld(e));
    this.hover = h?.room ?? null;
    this.canvas.style.cursor = h ? 'pointer' : 'default';
  }

  onClick(e) {
    const h = this.hit(this.toWorld(e));
    if (!h) return;
    const room = h.room;
    if (h.type === 'avatar' || room?.kind === 'line') this.h.onLine?.(room.lineId, h.avatar?.worker);
    else if (room?.kind === 'new') this.h.onNew?.();
    else if (room?.kind === 'skills') this.h.onSkills?.();
    else if (room?.kind === 'copa') this.h.onCopa?.();
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
    if (!this.worldW) return;
    if (this.staticDirty) {
      this.drawStatic(this.staticLayer.getContext('2d'));
      this.staticDirty = false;
    }
    const w = this.wctx;
    w.clearRect(0, 0, this.worldW, WORLD_H);
    w.drawImage(this.staticLayer, 0, 0);
    this.drawDynamic(w);

    const ctx = this.ctx;
    const k = this.scale * this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.world, 0, 0, this.worldW * k, WORLD_H * k);
    ctx.setTransform(k, 0, 0, k, 0, 0);
    this.drawOverlay(ctx);
  }

  // ---- camada estática (piso, paredes, móveis) ----------------------------

  drawStatic(g) {
    g.fillStyle = C.void;
    g.fillRect(0, 0, this.worldW, WORLD_H);
    this.drawCorridor(g);
    for (const r of this.rooms) {
      if (r.kind === 'new') this.drawNewRoom(g, r);
      else {
        this.drawFloor(g, r);
        this.drawWalls(g, r);
        if (r.kind === 'copa') this.drawCopa(g, r);
        if (r.kind === 'skills') this.drawLibrary(g, r);
        if (r.kind === 'line') this.drawLineRoom(g, r);
      }
    }
  }

  drawCorridor(g) {
    for (let x = 0; x < this.worldW; x += 16) {
      for (let y = RH; y < RH + CH; y += 16) {
        g.fillStyle = ((x + y) / 16) % 2 ? C.cor1 : C.cor2;
        g.fillRect(x, y, 16, 16);
      }
    }
    g.fillStyle = '#4a4e62';
    g.fillRect(0, RH, this.worldW, 2);
    g.fillRect(0, RH + CH - 2, this.worldW, 2);
    // tapete da entrada
    g.fillStyle = '#7a3a3a';
    g.fillRect(0, COR_Y - 9, 10, 18);
    g.fillStyle = '#93484a';
    g.fillRect(2, COR_Y - 7, 6, 14);
    // bebedouros e plantas pelo corredor
    for (let c = 1; c < this.cols; c++) {
      const x = c * RW - 8;
      if (c % 2) this.plant(g, x, RH + CH - 4, 0.8);
      else {
        g.fillStyle = '#cfd8e6';
        g.fillRect(x - 3, RH + 10, 7, 8);
        g.fillStyle = '#7fb7e8';
        g.fillRect(x - 2, RH + 4, 5, 6);
        g.fillStyle = '#9aa3b5';
        g.fillRect(x - 3, RH + 18, 7, 3);
      }
    }
  }

  drawFloor(g, r) {
    if (r.kind === 'copa') {
      for (let x = 0; x < r.w; x += 8) for (let y = 0; y < r.h; y += 8) {
        g.fillStyle = ((x + y) / 8) % 2 ? C.tile1 : C.tile2;
        g.fillRect(r.x + x, r.y + y, 8, 8);
      }
      return;
    }
    if (r.kind === 'skills') {
      g.fillStyle = C.carpet1;
      g.fillRect(r.x, r.y, r.w, r.h);
      g.fillStyle = C.carpet2;
      for (let x = 0; x < r.w; x += 4) for (let y = (x / 4) % 2 ? 0 : 2; y < r.h; y += 4) g.fillRect(r.x + x, r.y + y, 1, 1);
      return;
    }
    g.fillStyle = C.wood1;
    g.fillRect(r.x, r.y, r.w, r.h);
    for (let y = 0; y < r.h; y += 8) {
      g.fillStyle = C.wood2;
      g.fillRect(r.x, r.y + y + 4, r.w, 4);
      g.fillStyle = C.woodLine;
      g.fillRect(r.x, r.y + y, r.w, 1);
      const off = (y / 8) % 2 ? 0 : 24;
      for (let x = off; x < r.w; x += 48) g.fillRect(r.x + x, r.y + y, 1, 8);
    }
  }

  drawWalls(g, r) {
    // parede do fundo
    g.fillStyle = C.wall;
    g.fillRect(r.x, r.y, r.w, 32);
    g.fillStyle = C.wallTop;
    g.fillRect(r.x, r.y, r.w, 3);
    g.fillStyle = C.wallLight;
    g.fillRect(r.x, r.y + 3, r.w, 1);
    g.fillStyle = C.wallTrim;
    g.fillRect(r.x, r.y + 29, r.w, 3);
    // paredes laterais
    g.fillStyle = C.sideWall;
    g.fillRect(r.x, r.y, 3, r.h);
    g.fillRect(r.x + r.w - 3, r.y, 3, r.h);
    if (r.row === 0) {
      // parede de baixo com porta
      g.fillRect(r.x, r.y + r.h - 4, r.w, 4);
      this.floorPatch(g, r, r.x + DOOR_X - 10, r.y + r.h - 4, 20, 4);
    } else {
      // porta aberta na parede do fundo
      g.fillStyle = C.sideWall;
      g.fillRect(r.x, r.y, r.w, 2);
      this.floorPatch(g, r, r.x + DOOR_X - 10, r.y, 20, 32);
      g.fillStyle = '#2a2116';
      g.fillRect(r.x + DOOR_X - 11, r.y, 1, 32);
      g.fillRect(r.x + DOOR_X + 10, r.y, 1, 32);
    }
  }

  floorPatch(g, r, x, y, w, h) {
    g.fillStyle = r.kind === 'copa' ? C.tile2 : r.kind === 'skills' ? C.carpet1 : C.wood2;
    g.fillRect(x, y, w, h);
  }

  drawNewRoom(g, r) {
    g.fillStyle = '#141623';
    g.fillRect(r.x + 4, r.y + 4, r.w - 8, r.h - 8);
    g.fillStyle = '#2a2f45';
    for (let x = r.x + 6; x < r.x + r.w - 6; x += 6) {
      g.fillRect(x, r.y + 6, 3, 1);
      g.fillRect(x, r.y + r.h - 7, 3, 1);
    }
    for (let y = r.y + 6; y < r.y + r.h - 6; y += 6) {
      g.fillRect(r.x + 6, y, 1, 3);
      g.fillRect(r.x + r.w - 7, y, 1, 3);
    }
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2 - 8;
    g.fillStyle = '#3d4566';
    g.fillRect(cx - 9, cy - 2, 18, 4);
    g.fillRect(cx - 2, cy - 9, 4, 18);
  }

  plant(g, x, y, s = 1) {
    g.fillStyle = C.pot;
    g.fillRect(x - 4 * s, y - 6 * s, 8 * s, 6 * s);
    g.fillStyle = '#7d4730';
    g.fillRect(x - 4 * s, y - 6 * s, 8 * s, 1);
    g.fillStyle = C.plantDark;
    g.fillRect(x - 6 * s, y - 14 * s, 12 * s, 8 * s);
    g.fillStyle = C.plant;
    g.fillRect(x - 4 * s, y - 18 * s, 8 * s, 8 * s);
    g.fillRect(x - 7 * s, y - 12 * s, 4 * s, 3 * s);
    g.fillRect(x + 3 * s, y - 13 * s, 4 * s, 3 * s);
  }

  window(g, x, y, w) {
    g.fillStyle = '#c7cede';
    g.fillRect(x, y, w, 16);
    g.fillStyle = '#86b6e8';
    g.fillRect(x + 2, y + 2, w - 4, 12);
    g.fillStyle = '#a9cdf2';
    g.fillRect(x + 2, y + 2, w - 4, 4);
    g.fillStyle = '#c7cede';
    g.fillRect(x + w / 2 - 1, y, 2, 16);
  }

  drawCopa(g, r) {
    const { x, y } = r;
    this.window(g, x + 96, y + 7, 40);
    // bancada + cafeteira + pia
    g.fillStyle = '#e8e2d6';
    g.fillRect(x + 8, y + 26, 72, 10);
    g.fillStyle = '#b9b1a2';
    g.fillRect(x + 8, y + 34, 72, 4);
    g.fillStyle = '#4b5064';
    g.fillRect(x + 14, y + 10, 14, 18);
    g.fillStyle = '#2b2e3a';
    g.fillRect(x + 17, y + 18, 8, 6);
    g.fillStyle = '#e5636a';
    g.fillRect(x + 25, y + 12, 2, 2);
    g.fillStyle = '#fff';
    g.fillRect(x + 19, y + 22, 4, 4);
    g.fillStyle = '#9aa3b5';
    g.fillRect(x + 44, y + 24, 20, 4);
    g.fillRect(x + 52, y + 16, 2, 8);
    // geladeira
    g.fillStyle = '#e6eaf0';
    g.fillRect(x + 152, y + 6, 22, 40);
    g.fillStyle = '#c9cfd8';
    g.fillRect(x + 152, y + 22, 22, 1);
    g.fillRect(x + 170, y + 12, 1, 6);
    g.fillRect(x + 170, y + 28, 1, 8);
    // mesa redonda e banquinhos
    g.fillStyle = '#8f6a49';
    g.fillRect(x + 82, y + 72, 32, 16);
    g.fillRect(x + 86, y + 70, 24, 20);
    g.fillStyle = '#a57c57';
    g.fillRect(x + 84, y + 72, 28, 12);
    g.fillStyle = '#fff';
    g.fillRect(x + 92, y + 76, 3, 3);
    g.fillRect(x + 102, y + 78, 3, 3);
    g.fillStyle = '#6b4c31';
    g.fillRect(x + 94, y + 90, 8, 6);
    // sofá
    g.fillStyle = '#5a6fa8';
    g.fillRect(x + 128, y + 102, 48, 14);
    g.fillStyle = '#4a5d91';
    g.fillRect(x + 128, y + 98, 48, 6);
    g.fillRect(x + 126, y + 100, 4, 16);
    g.fillRect(x + 174, y + 100, 4, 16);
    this.plant(g, x + 14, y + 120);
  }

  drawLibrary(g, r) {
    const { x, y } = r;
    const colors = ['#d9576b', '#e9b949', '#7aa7e8', '#7cc96a', '#c17ad6', '#e58a4f', '#5fc7c0', '#e6e2d6'];
    // estantes na parede do fundo (a porta fica à esquerda)
    for (const sx of [36, 112]) {
      g.fillStyle = '#5a3d27';
      g.fillRect(x + sx, y + 4, 70, 40);
      g.fillStyle = '#3f2a1a';
      for (const sy of [5, 18, 31]) g.fillRect(x + sx + 2, y + sy, 66, 11);
      let i = sx;
      for (const sy of [5, 18, 31]) {
        for (let bx = 3; bx < 66; ) {
          const w = 3 + ((i * 7 + bx) % 3);
          const h = 8 + ((i + bx) % 3);
          g.fillStyle = colors[(i + bx) % colors.length];
          g.fillRect(x + sx + bx, y + sy + 11 - h, w, h);
          bx += w + 1;
        }
        i += 3;
      }
    }
    // mesa de leitura com luminária e livros abertos
    g.fillStyle = C.deskEdge;
    g.fillRect(x + 62, y + 72, 72, 22);
    g.fillStyle = C.desk;
    g.fillRect(x + 62, y + 72, 72, 18);
    g.fillStyle = '#f4efe2';
    g.fillRect(x + 76, y + 77, 14, 8);
    g.fillRect(x + 106, y + 78, 12, 7);
    g.fillStyle = '#c9c1ae';
    g.fillRect(x + 83, y + 77, 1, 8);
    g.fillStyle = '#e9b949';
    g.fillRect(x + 120, y + 66, 8, 4);
    g.fillStyle = '#3f3f4a';
    g.fillRect(x + 123, y + 70, 2, 4);
    this.plant(g, x + 176, y + 122);
  }

  drawLineRoom(g, r) {
    const { x, y } = r;
    // quadro branco
    g.fillStyle = '#9aa0b4';
    g.fillRect(x + 118, y + 5, 66, 22);
    g.fillStyle = '#f2f1ea';
    g.fillRect(x + 120, y + 7, 62, 18);
    g.fillStyle = '#7d8398';
    g.fillRect(x + 124, y + 27, 56, 2);
    // mesas: só dos trabalhadores que participam da linha
    for (const w of r.workers) this.drawDesk(g, x + DESK_X[w], y, w);
    this.plant(g, x + 176, y + 122);
  }

  drawDesk(g, x, y, worker) {
    // monitor
    g.fillStyle = C.monitor;
    g.fillRect(x + 12, y + 22, 24, 18);
    g.fillStyle = C.screenOff;
    g.fillRect(x + 14, y + 24, 20, 13);
    g.fillStyle = C.monitor;
    g.fillRect(x + 22, y + 40, 4, 4);
    // tampo e frente
    g.fillStyle = C.desk;
    g.fillRect(x, y + 42, 48, 14);
    g.fillStyle = C.deskEdge;
    g.fillRect(x, y + 54, 48, 2);
    g.fillStyle = C.deskFront;
    g.fillRect(x + 1, y + 56, 46, 6);
    g.fillStyle = '#3a2a1c';
    g.fillRect(x + 2, y + 62, 3, 4);
    g.fillRect(x + 43, y + 62, 3, 4);
    // caneca e plaquinha com a cor do trabalhador
    g.fillStyle = '#e9e4d8';
    g.fillRect(x + 40, y + 45, 4, 5);
    g.fillStyle = WORKER_STYLE[worker].color;
    g.fillRect(x + 4, y + 46, 10, 4);
    g.fillRect(x + 18, y + 58, 12, 2);
    // teclado
    g.fillStyle = '#c9ccd6';
    g.fillRect(x + 16, y + 48, 16, 4);
  }

  // ---- camada dinâmica ----------------------------------------------------

  drawDynamic(g) {
    const t = this.t;
    for (const r of this.rooms) {
      if (r.kind !== 'line') continue;
      const line = this.lines.find((l) => l.id === r.lineId);
      if (!line) continue;
      this.drawBoard(g, r, line);
    }

    // cadeiras vazias primeiro, depois quem está sentado (de costas, cadeira na frente)
    const seated = new Map();
    for (const a of this.avatars) if (a.seated && a.assign) seated.set(`${a.assign.lineId}:${a.worker}`, a);
    for (const r of this.rooms) {
      if (r.kind !== 'line') continue;
      for (const w of r.workers) {
        const cx = r.x + DESK_X[w] + 24;
        const a = seated.get(`${r.lineId}:${w}`);
        if (a) {
          this.drawScreen(g, r.x + DESK_X[w], r.y, w, t + a.phase);
          const img = sprite(w, Math.floor((t + a.phase) * 6) % 2 ? 'sit1' : 'sit0');
          g.drawImage(img, Math.round(cx - SPRITE_W / 2), r.y + 58);
          this.drawChair(g, cx, r.y, true);
        } else {
          this.drawChair(g, cx, r.y, false);
        }
      }
    }

    // quem está andando ou na copa, ordenado por y para sobreposição correta
    const standing = this.avatars.filter((a) => !a.seated).sort((p, q) => p.y - q.y);
    for (const a of standing) {
      const pose = a.walking && Math.floor((t + a.phase) * 8) % 2 ? 'walk1' : 'walk0';
      const bob = !a.walking && Math.floor((t + a.phase) * 1.5) % 2 ? 1 : 0;
      g.fillStyle = 'rgba(0,0,0,.22)';
      g.fillRect(Math.round(a.x - 5), Math.round(a.y - 1), 10, 2);
      g.drawImage(sprite(a.worker, pose), Math.round(a.x - SPRITE_W / 2), Math.round(a.y - FRONT_H + bob));
      // cafezinho na mão de quem está na copa
      if (!a.walking && a.loc === 'copa' && !a.assign) {
        g.fillStyle = '#f4efe2';
        g.fillRect(Math.round(a.x + 5), Math.round(a.y - 8 + bob), 3, 3);
      }
    }
  }

  drawChair(g, cx, y, occupied) {
    const top = y + (occupied ? 69 : 62);
    g.fillStyle = C.chair;
    g.fillRect(cx - 6, top, 12, occupied ? 5 : 10);
    g.fillStyle = C.chairTop;
    g.fillRect(cx - 6, top, 12, 2);
    g.fillStyle = '#1a1c2a';
    g.fillRect(cx - 1, top + (occupied ? 5 : 10), 2, 4);
    g.fillRect(cx - 5, top + (occupied ? 9 : 14), 10, 2);
  }

  drawScreen(g, x, y, worker, t) {
    const color = WORKER_STYLE[worker].color;
    g.fillStyle = '#151824';
    g.fillRect(x + 14, y + 24, 20, 13);
    const scroll = Math.floor(t * 4);
    for (let i = 0; i < 5; i++) {
      const n = scroll + i;
      const indent = (n * 3) % 4 * 2;
      const len = 4 + ((n * 7) % 11);
      g.fillStyle = i === 4 ? '#e9edf2' : n % 3 === 0 ? color : '#8b93ad';
      g.fillRect(x + 15 + indent, y + 25 + i * 2 + 1, Math.min(len, 18 - indent), 1);
    }
    // brilho na mesa
    g.fillStyle = color + '33';
    g.fillRect(x + 8, y + 42, 32, 4);
  }

  drawBoard(g, r, line) {
    const attempts = line.run?.attempts ?? [];
    const running = line.run?.status === 'running';
    const n = line.steps.length;
    const chip = Math.max(3, Math.min(14, Math.floor(58 / Math.max(1, n)) - 2));
    let x = r.x + 122;
    const y = r.y + 12;
    line.steps.forEach((s, i) => {
      const last = [...attempts].reverse().find((a) => a.step === i);
      const st = last?.status;
      g.fillStyle = WORKER_STYLE[s.worker].color;
      if (!st) g.fillStyle = '#c9c6bb';
      if (st === 'running' && running && Math.floor(this.t * 3) % 2) g.fillStyle = '#f2f1ea';
      g.fillRect(x, y, chip, 8);
      if (!st) {
        g.fillStyle = WORKER_STYLE[s.worker].color;
        g.fillRect(x, y + 7, chip, 1);
      }
      if (st === 'done') {
        g.fillStyle = last.verdict === 'MUDANCAS_NECESSARIAS' ? '#c9871a' : '#2f8f3a';
        g.fillRect(x + chip / 2 - 1, y + 10, 2, 2);
      } else if (st === 'failed') {
        g.fillStyle = '#c23b44';
        g.fillRect(x + chip / 2 - 1, y + 10, 2, 2);
      }
      x += chip + 2;
    });
  }

  // ---- textos (resolução de tela) ----------------------------------------

  text(ctx, str, x, y, { size = 5, color = '#ebe6d6', font = 'Silkscreen', align = 'left', shadow = true } = {}) {
    ctx.font = `${size}px ${font}, monospace`;
    ctx.textAlign = align;
    ctx.textBaseline = 'top';
    if (shadow) {
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.fillText(str, x + 0.5, y + 0.5);
    }
    ctx.fillStyle = color;
    ctx.fillText(str, x, y);
  }

  fit(ctx, str, max) {
    if (ctx.measureText(str).width <= max) return str;
    let s = str;
    while (s.length > 1 && ctx.measureText(s + '…').width > max) s = s.slice(0, -1);
    return s + '…';
  }

  drawOverlay(ctx) {
    for (const r of this.rooms) {
      const lx = r.x + (r.row === 1 ? DOOR_X + 14 : 7);
      if (r.kind === 'line') {
        const line = this.lines.find((l) => l.id === r.lineId);
        if (!line) continue;
        ctx.font = '6px Silkscreen, monospace';
        const maxW = r.x + 114 - lx;
        this.text(ctx, this.fit(ctx, line.name, maxW), lx, r.y + 7, { size: 6 });
        const [label, color] = STATUS_TEXT[lineStatus(line)];
        const round = line.run?.round > 1 ? ` · rodada ${line.run.round}` : '';
        ctx.font = '4.5px "IBM Plex Mono", monospace';
        this.text(ctx, this.fit(ctx, label + round, maxW), lx, r.y + 17, { size: 4.5, color, font: '"IBM Plex Mono"' });
      } else if (r.kind === 'new') {
        this.text(ctx, '+ nova linha', r.x + r.w / 2, r.y + r.h / 2 + 8, { size: 6, color: '#5d6690', align: 'center', shadow: false });
      } else if (r.kind === 'skills') {
        this.text(ctx, r.title, r.x + 34, r.y + r.h - 22, { size: 6 });
        this.text(ctx, `${this.skills?.length ?? 0} skills · clique para ver`, r.x + 34, r.y + r.h - 13, { size: 4.5, color: '#b9b0d8', font: '"IBM Plex Mono"' });
      } else {
        this.text(ctx, r.title, lx, r.y + 9, { size: 6 });
      }
      if (this.hover === r || (r.kind === 'line' && r.lineId === this.selected)) {
        ctx.strokeStyle = r.lineId === this.selected ? 'rgba(122,167,232,.9)' : 'rgba(255,255,255,.35)';
        ctx.lineWidth = 1;
        ctx.strokeRect(r.x + 1.5, r.y + 1.5, r.w - 3, r.h - 3);
      }
    }

    for (const a of this.avatars) {
      if (a.seated && a.assign) {
        const style = WORKER_STYLE[a.worker];
        const msg = `${a.label}: ${a.assign.activity || 'trabalhando…'}`;
        this.bubble(ctx, msg, a.x, a.y + 4, style.color);
      } else if (!a.walking) {
        this.text(ctx, a.label, a.x, a.y + 2, { size: 4, align: 'center', color: '#1d1f2b', shadow: false });
      }
    }
  }

  bubble(ctx, msg, x, y, color) {
    ctx.font = '4.5px "IBM Plex Mono", monospace';
    const str = this.fit(ctx, msg, 84);
    const w = ctx.measureText(str).width + 6;
    const h = 8;
    let bx = Math.round(x - w / 2);
    bx = Math.max(bx, 2);
    const by = y + 4;
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    ctx.fillRect(bx + 1, by + 1, w, h);
    ctx.fillStyle = '#f7f4ec';
    ctx.fillRect(bx, by, w, h);
    ctx.fillStyle = color;
    ctx.fillRect(bx, by, 1.5, h);
    ctx.fillStyle = '#f7f4ec';
    ctx.fillRect(x - 1.5, by - 2, 3, 2);
    ctx.fillRect(x - 0.5, by - 3, 1, 1);
    this.text(ctx, str, bx + 3.5, by + 1.6, { size: 4.5, color: '#1d1f2b', font: '"IBM Plex Mono"', shadow: false });
  }
}
