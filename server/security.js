// O AI Office dispara IAs que editam código na sua máquina: só aceita
// requisições do próprio navegador local.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function hostAllowed(hostHeader, extra = []) {
  if (!hostHeader) return false;
  const host = hostHeader.replace(/:\d+$/, '').toLowerCase();
  return LOCAL_HOSTS.has(host) || extra.includes(host);
}

export function originAllowed(origin, hostHeader) {
  if (!origin) return true; // ferramentas de linha de comando não mandam Origin
  try {
    const u = new URL(origin);
    return u.host.toLowerCase() === String(hostHeader).toLowerCase();
  } catch {
    return false;
  }
}

/** Bloqueia DNS rebinding (Host) e chamadas cross-site (Origin + JSON obrigatório). */
export function localOnly({ extraHosts = [] } = {}) {
  return (req, res, next) => {
    if (!hostAllowed(req.headers.host, extraHosts)) return res.status(403).json({ error: 'Host não permitido' });
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (!originAllowed(req.headers.origin, req.headers.host)) return res.status(403).json({ error: 'Origem não permitida' });
      // Formulários cross-site só conseguem mandar text/plain, form ou multipart.
      if (req.headers['content-type'] && !req.is('application/json')) {
        return res.status(415).json({ error: 'Use application/json' });
      }
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:");
    next();
  };
}
