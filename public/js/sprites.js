// Sprites em pixel art desenhados a partir de mapas de caracteres.
// Cada letra é uma cor da paleta do trabalhador; '.' é transparente.

export const WORKER_STYLE = {
  claude: {
    name: 'Claude',
    color: '#d97757',
    pal: { H: '#5a3a2a', h: '#7a4e38', S: '#f1c6a2', s: '#d9a582', E: '#2a1f1a', C: '#d97757', D: '#b55c3f', W: '#fff1e2', P: '#3b3f58', B: '#1d1f2b' },
  },
  codex: {
    name: 'Codex',
    color: '#10a37f',
    pal: { H: '#1b1b20', h: '#2b2b33', K: '#0d6e57', k: '#13906f', S: '#d9a882', s: '#bf8f6c', E: '#101014', G: '#e9edf2', C: '#10a37f', D: '#0b7a5e', W: '#dff7ef', P: '#2c2f3d', B: '#14151c' },
  },
};

const LEGS_A = ['...PP..PP...', '...PP..PP...', '...BB..BB...'];
const LEGS_B = ['...PP..PP...', '..PP....PP..', '..BB....BB..'];

const FRONT = {
  claude: [
    '....hHHh....',
    '...HHHHHH...',
    '..HHHHHHHH..',
    '..HSSSSSSH..',
    '..SSESSESS..',
    '..sSSSSSSs..',
    '...SSSSSS...',
    '....ssss....',
    '..CCCWWCCC..',
    '.CCCCCCCCCC.',
    '.SCCCCCCCCS.',
    '.SCCCCCCCCS.',
    '.sDCCCCCCDs.',
    '...DDDDDD...',
    '...PPPPPP...',
  ],
  codex: [
    '....kKKk....',
    '...KKKKKK...',
    '..KKKKKKKK..',
    '..HSSSSSSH..',
    '..SGEGGEGS..',
    '..sSSSSSSs..',
    '...SSSSSS...',
    '....ssss....',
    '..DCCWWCCD..',
    '.CCCCCCCCCC.',
    '.SCCCCCCCCS.',
    '.SCCCCCCCCS.',
    '.sDCCCCCCDs.',
    '...DDDDDD...',
    '...PPPPPP...',
  ],
};

const BACK_TOP = {
  claude: ['....hHHh....', '...HHHHHH...', '..HHHHHHHH..', '..HHHHHHHH..', '..HHHHHHHH..', '..sHHHHHHs..', '...ssssss...'],
  codex: ['....kKKk....', '...KKKKKK...', '..KKKKKKKK..', '..KKKKKKKK..', '..HHHHHHHH..', '..sHHHHHHs..', '...ssssss...'],
};
const BACK_BODY_A = ['..CCCCCCCC..', '.CCCCCCCCCC.', 'SCCCCCCCCCCS', 'SCCCCCCCCCCS', '.CCCCCCCCCC.', '.DDDDDDDDDD.'];
const BACK_BODY_B = ['..CCCCCCCC..', 'SCCCCCCCCCC.', 'SCCCCCCCCCCS', '.CCCCCCCCCCS', '.CCCCCCCCCC.', '.DDDDDDDDDD.'];

export const SPRITE_W = 12;
export const FRONT_H = 18;
export const BACK_H = 13;

function paint(map, pal, scale = 1) {
  const c = document.createElement('canvas');
  c.width = map[0].length * scale;
  c.height = map.length * scale;
  const ctx = c.getContext('2d');
  map.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (ch === '.' || !pal[ch]) return;
      ctx.fillStyle = pal[ch];
      ctx.fillRect(x * scale, y * scale, scale, scale);
    });
  });
  return c;
}

const cache = new Map();

/** pose: 'walk0' | 'walk1' | 'sit0' | 'sit1' */
export function sprite(worker, pose, scale = 1) {
  const key = `${worker}:${pose}:${scale}`;
  if (cache.has(key)) return cache.get(key);
  const pal = WORKER_STYLE[worker].pal;
  let map;
  if (pose.startsWith('walk')) map = [...FRONT[worker], ...(pose === 'walk1' ? LEGS_B : LEGS_A)];
  else map = [...BACK_TOP[worker], ...(pose === 'sit1' ? BACK_BODY_B : BACK_BODY_A)];
  const c = paint(map, pal, scale);
  cache.set(key, c);
  return c;
}
