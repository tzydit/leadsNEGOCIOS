// Personagens chibi em pixel art, desenhados a partir de mapas de caracteres.
// Cada letra é uma cor da paleta do trabalhador; '.' é transparente.
// Um contorno escuro é aplicado automaticamente em volta de cada sprite.

export const WORKER_STYLE = {
  claude: {
    name: 'Claude',
    letter: 'C',
    color: '#e07a4f',
    pal: { H: '#6b3f2a', h: '#8a5638', S: '#f6cfac', s: '#e3ad86', E: '#2a1f1a', W: '#ffffff', M: '#c4624a', C: '#e07a4f', D: '#b85b37', L: '#f3a27c', P: '#3c4160', B: '#24263a' },
  },
  codex: {
    name: 'Codex',
    letter: 'X',
    color: '#14a37f',
    pal: { H: '#1f1d27', h: '#3a3646', S: '#e5b48f', s: '#c99472', E: '#15151c', W: '#ffffff', G: '#2b2f3d', M: '#a8644e', C: '#14a37f', D: '#0c7a5f', L: '#43c9a2', P: '#2c3247', B: '#191b26' },
  },
};

const OUTLINE = 'rgba(28, 24, 36, 0.92)';
// Objetos que eles seguram (caneca, livro, celular): iguais para todos.
const PROPS = { K: '#f4efe2', k: '#6b4a30', R: '#d9576b', r: '#fbf6ea', Y: '#2b2f3b', y: '#8fc3ef' };

// Cabeça grande (chibi). 16 colunas.
const HEAD = {
  claude: [
    '.....hHHHHh.....',
    '...hHHHHHHHHh...',
    '..HHHHHHHHHHHH..',
    '..HHHHHHHHHHHH..',
    '.HHHSSSSSSSHHHH.',
    '.HHSSSSSSSSSSHH.',
    '.HSSEESSSSEESSH.',
    '..SSEESSSSEESS..',
    '..SSSSSSSSSSSS..',
    '..sSSSSMMSSSSs..',
    '...SSSSSSSSSS...',
    '....ssSSSSss....',
  ],
  codex: [
    '.....hHHHHh.....',
    '...hHHHHHHHHh...',
    '..HHHHHHHHHHHH..',
    '..HHHHHHHHHHHH..',
    '.HHHSSSSSSSSHHH.',
    '.HHSSSSSSSSSSHH.',
    '.HSGGGGSSGGGGSH.',
    '..SGEWGGGGEWGS..',
    '..SGGGGSSGGGGS..',
    '..sSSSSMMSSSSs..',
    '...SSSSSSSSSS...',
    '....ssSSSSss....',
  ],
};

const TORSO = [
  '.....DCCCCD.....',
  '....CCCLLCCC....',
  '...SCCCCCCCCS...',
  '...SCCCCCCCCS...',
  '...sCCDDDDCCs...',
  '....DDDDDDDD....',
];

const LEGS = {
  stand: ['....PPPPPPPP....', '....PPP..PPP....', '....PPP..PPP....', '....BBB..BBB....', '...BBBB..BBBB...'],
  walkA: ['....PPPPPPPP....', '...PPP...PPP....', '...PPP....PPP...', '...BBB....BBB...', '..BBBB....BBBB..'],
  walkB: ['....PPPPPPPP....', '....PPP...PPP...', '...PPP....PPP...', '...BBB....BBB...', '..BBBB....BBBB..'],
};

// Tronco com as mãos ocupadas, para quando estão sem tarefa.
const TORSOS = {
  base: TORSO,
  cup: ['.....DCCCCD.....', '....CCCLLCCCKkK.', '...SCCCCCCCSKKK.', '...SCCCCCCCC.KK.', '...sCCDDDDCC....', '....DDDDDDDD....'],
  read: ['.....DCCCCD.....', '....CCCLLCCC....', '...SRrrrrrrRS...', '...SRrrrrrrRS...', '...sRRRRRRRRs...', '....DDDDDDDD....'],
  phone: ['.....DCCCCD.....', '....CCCLLCCC....', '...CCCCCCCCCC...', '...CCSYYYYSCC...', '...sCCYyyYCCs...', '....DDDDDDDD....'],
  // braços para cima: as mãos ficam ao lado da cabeça (ver headFor)
  stretch: ['CC...DCCCCD...CC', '.CCCCCCLLCCCCCC.', '...CCCCCCCCCC...', '...CCCCCCCCCC...', '....CCDDDDCC....', '....DDDDDDDD....'],
};
// Sentado numa cadeira, visto de frente: pernas dobradas.
const SIT_LEGS = ['....PPPPPPPP....', '...PPPPPPPPPP...', '...BBB....BBB...'];

// pose → [tronco, pernas, ajuste da cabeça]
const IDLE_POSES = {
  cup: ['cup', 'stand'],
  read: ['read', 'stand'],
  phone: ['phone', 'stand'],
  stretch: ['stretch', 'stand', 'arms'],
  sitIdle: ['base', 'sit'],
  sitCup: ['cup', 'sit'],
  sitRead: ['read', 'sit'],
  sitPhone: ['phone', 'sit'],
  nap: ['base', 'sit', 'sleep'],
};

function headFor(worker, mod) {
  const rows = [...HEAD[worker]];
  if (mod === 'sleep') {
    // olhos fechados: só um risco
    rows[6] = rows[6].replace(/E/g, 'S').replace(/W/g, 'G');
    rows[7] = rows[7].replace(/W/g, 'G');
  }
  if (mod === 'arms') {
    return rows.map((r, i) => {
      const c = i < 2 ? 'S' : 'C';
      return c + r.slice(1, -1) + c;
    });
  }
  return rows;
}

// Sentado atrás da mesa: só cabeça, tronco e braços apoiados (digitando).
const SIT_ARMS = {
  a: ['.....DCCCCD.....', '....CCCLLCCC....', '...CCCCCCCCCC...', '..SCCCCCCCCCCS..', '..SS.CCCCCC.SS..'],
  b: ['.....DCCCCD.....', '....CCCLLCCC....', '...CCCCCCCCCC...', '..SCCCCCCCCCCS..', '.SS..CCCCCC..S..'],
};

export const SPRITE_W = 16;
export const STAND_H = HEAD.claude.length + TORSO.length + LEGS.stand.length; // 23
export const SIT_H = HEAD.claude.length + SIT_ARMS.a.length; // 17

function paint(map, pal, scale = 1) {
  // 1px de margem para o contorno.
  const w = map[0].length + 2;
  const h = map.length + 2;
  const grid = Array.from({ length: h }, () => Array(w).fill(null));
  map.forEach((row, y) => [...row].forEach((ch, x) => ch !== '.' && pal[ch] && (grid[y + 1][x + 1] = pal[ch])));
  const c = document.createElement('canvas');
  c.width = w * scale;
  c.height = h * scale;
  const ctx = c.getContext('2d');
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let color = grid[y][x];
      if (!color) {
        const near = [grid[y - 1]?.[x], grid[y + 1]?.[x], grid[y]?.[x - 1], grid[y]?.[x + 1]].some(Boolean);
        if (!near) continue;
        color = OUTLINE;
      }
      ctx.fillStyle = color;
      ctx.fillRect(x * scale, y * scale, scale, scale);
    }
  }
  return c;
}

const cache = new Map();

/**
 * pose: 'stand' | 'walkA' | 'walkB' | 'sitA' | 'sitB' | 'portrait' ou uma pose
 * de folga (cup, read, phone, stretch, sitIdle, sitCup, sitRead, sitPhone, nap).
 * Sprites têm 1px de contorno em volta.
 */
export function sprite(worker, pose, scale = 1) {
  const key = `${worker}:${pose}:${scale}`;
  if (cache.has(key)) return cache.get(key);
  const pal = { ...PROPS, ...WORKER_STYLE[worker].pal };
  let map;
  const idle = IDLE_POSES[pose];
  if (idle) {
    const [torso, legs, mod] = idle;
    map = [...headFor(worker, mod), ...TORSOS[torso], ...(legs === 'sit' ? SIT_LEGS : LEGS.stand)];
  } else if (pose === 'portrait') map = [...HEAD[worker], TORSO[0], TORSO[1], TORSO[2]];
  else if (pose === 'sitA' || pose === 'sitB') map = [...HEAD[worker], ...SIT_ARMS[pose === 'sitA' ? 'a' : 'b']];
  else map = [...HEAD[worker], ...TORSO, ...LEGS[pose] ?? LEGS.stand];
  const c = paint(map, pal, scale);
  cache.set(key, c);
  return c;
}

/** Retrato para listas: canvas pronto para inserir no DOM. */
export function portrait(worker, scale = 2) {
  const src = sprite(worker, 'portrait', scale);
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  c.className = 'portrait';
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, 0, 0);
  return c;
}
