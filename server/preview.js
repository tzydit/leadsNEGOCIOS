// Servidor estático mínimo para ver o resultado de uma linha no navegador
// quando o projeto é um site sem comando de start (index.html + js/css).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.webmanifest': 'application/manifest+json',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
};

/** Pasta com o site: a própria pasta ou dist/build/public, a primeira com index.html. */
export function findStaticRoot(dir) {
  if (!dir) return null;
  for (const sub of ['', 'dist', 'build', 'public']) {
    const root = path.join(dir, sub);
    if (fs.existsSync(path.join(root, 'index.html'))) return root;
  }
  return null;
}

/** Caminho do arquivo pedido dentro de root, ou null se escapar dela ou tocar em pasta oculta. */
export function resolveInside(root, urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch {
    return null;
  }
  if (rel.includes('\0')) return null;
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  if (parts.some((p) => p === '..' || p.startsWith('.'))) return null; // .env, .git…
  const file = path.resolve(root, ...parts);
  const inside = path.relative(root, file);
  if (inside.startsWith('..') || path.isAbsolute(inside)) return null;
  return file;
}

/** Sobe em 127.0.0.1 numa porta livre. Retorna { url, stop }. */
export function serveStatic(root) {
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    let file = resolveInside(root, req.url ?? '/');
    try {
      if (file && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    } catch {
      file = null;
    }
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Não encontrado');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/`,
        stop: () => {
          server.closeAllConnections?.();
          server.close();
        },
      });
    });
  });
}
