// Limites do plano (assinatura): quanto já foi usado da janela de 5 horas e da
// semana, no Claude (Pro/Max) e no Codex (ChatGPT Plus/Pro).
//
// Nada de tokens ou senhas passa por aqui: cada CLI responde com a própria
// conta já logada, sem chamar o modelo (não gasta tokens).
//  - Claude Code: pedido de controle `get_usage` no modo stream-json.
//  - Codex: `codex app-server`, método JSON-RPC `account/rateLimits/read`.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { IS_WIN, childEnv, quoteWin } from './proc.js';

const TIMEOUT_MS = 25000;

/**
 * Conversa JSON por linha com um processo: send(obj) escreve uma linha;
 * waitFor(pred) espera a primeira linha JSON que satisfaça pred.
 */
function jsonSession(bin, args) {
  const child = spawn(IS_WIN ? quoteWin(bin) : bin, IS_WIN ? args.map(quoteWin) : args, {
    env: childEnv(),
    shell: IS_WIN,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const waiting = [];
  const seen = [];
  let buf = '';
  let stderr = '';
  let failed = null;
  const check = (obj) => {
    for (const w of [...waiting]) {
      if (w.pred(obj)) {
        waiting.splice(waiting.indexOf(w), 1);
        w.resolve(obj);
      }
    }
  };
  const fail = (err) => {
    failed = err;
    for (const w of waiting.splice(0)) w.reject(err);
  };
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('{')) continue;
      try {
        const obj = JSON.parse(line);
        seen.push(obj);
        check(obj);
      } catch {
        // linha que não é JSON: ignora
      }
    }
  });
  child.stderr.setEncoding('utf8').on('data', (c) => (stderr = (stderr + c).slice(-2000)));
  child.on('error', (e) => fail(new Error(e.code === 'ENOENT' ? `CLI não encontrado: ${bin}` : e.message)));
  child.on('close', (code) => fail(new Error(`o CLI encerrou (código ${code})${stderr.trim() ? `: ${stderr.trim().split('\n').at(-1)}` : ''}`)));
  child.stdin.on('error', () => {});
  return {
    send: (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`),
    waitFor: (pred, ms = TIMEOUT_MS) => {
      const hit = seen.find(pred);
      if (hit) return Promise.resolve(hit);
      if (failed) return Promise.reject(failed);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve, reject };
        waiting.push(w);
        setTimeout(() => {
          const k = waiting.indexOf(w);
          if (k >= 0) {
            waiting.splice(k, 1);
            reject(new Error('o CLI não respondeu a tempo'));
          }
        }, ms).unref?.();
      });
    },
    close: () => {
      try {
        child.stdin.end();
      } catch {}
      setTimeout(() => {
        if (child.exitCode == null) child.kill();
      }, 1500).unref?.();
    },
  };
}

// ---- normalização ---------------------------------------------------------

const toMs = (v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};
const pct = (v) => (v == null || Number.isNaN(Number(v)) ? null : Math.max(0, Math.min(100, Number(v))));

const CLAUDE_WINDOWS = [
  ['five_hour', 'Sessão (5h)', '5h'],
  ['seven_day', 'Semana', 'sem'],
  ['seven_day_opus', 'Semana · Opus', 'Opus'],
  ['seven_day_sonnet', 'Semana · Sonnet', 'Sonnet'],
];

/** Resposta do get_usage do Claude Code → { plan, windows }. */
export function parseClaudeUsage(r) {
  if (!r || r.rate_limits_available === false || !r.rate_limits) {
    return { plan: r?.subscription_type ?? null, windows: [], note: 'Sem limites de plano (chave de API ou login sem assinatura).' };
  }
  const rl = r.rate_limits;
  const windows = [];
  for (const [key, label, short] of CLAUDE_WINDOWS) {
    const w = rl[key];
    if (w && pct(w.utilization) != null) windows.push({ id: key, label, short, used: pct(w.utilization), resetsAt: toMs(w.resets_at) });
  }
  for (const m of rl.model_scoped ?? []) {
    if (pct(m.utilization) != null) windows.push({ id: `model:${m.display_name}`, label: `Semana · ${m.display_name}`, short: m.display_name, used: pct(m.utilization), resetsAt: toMs(m.resets_at) });
  }
  return { plan: r.subscription_type ?? null, windows };
}

function windowLabel(mins, fallback) {
  if (!mins) return [fallback, fallback === 'Principal' ? 'lim' : 'lim2'];
  if (mins >= 10080) return ['Semana', 'sem'];
  if (mins >= 1440) return [`${Math.round(mins / 1440)} dias`, `${Math.round(mins / 1440)}d`];
  const h = Math.round(mins / 60);
  return [`Sessão (${h}h)`, `${h}h`];
}

/** Resposta do account/rateLimits/read do Codex → { plan, windows, resets }. */
export function parseCodexLimits(r) {
  const snap = r?.rateLimits ?? r?.rateLimitsByLimitId?.codex ?? null;
  if (!snap) return { plan: null, windows: [], note: 'O Codex não informou limites (login por chave de API?).' };
  const windows = [];
  for (const [key, fallback] of [['primary', 'Principal'], ['secondary', 'Secundário']]) {
    const w = snap[key];
    if (!w || pct(w.usedPercent) == null) continue;
    const [label, short] = windowLabel(w.windowDurationMins, fallback);
    windows.push({ id: key, label, short, used: pct(w.usedPercent), resetsAt: toMs(w.resetsAt) });
  }
  return { plan: snap.planType ?? null, windows, resets: r.rateLimitResetCredits?.availableCount ?? null, blocked: r.ordinaryUsageAllowed === false };
}

/** Evento rate_limit_event do stream do Claude (vem de graça em cada etapa). */
export function parseClaudeRateEvent(info) {
  const map = Object.fromEntries(CLAUDE_WINDOWS.map(([k, l, s]) => [k, [l, s]]));
  if (!info?.rateLimitType || !map[info.rateLimitType] || info.utilization == null) return null;
  const u = Number(info.utilization);
  const [label, short] = map[info.rateLimitType];
  return { id: info.rateLimitType, label, short, used: pct(u <= 1 ? u * 100 : u), resetsAt: toMs(info.resetsAt) };
}

// ---- leitura nos CLIs -------------------------------------------------------

export async function readClaudeUsage(bin = 'claude') {
  const s = jsonSession(bin, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--strict-mcp-config']);
  try {
    // Só pedidos de controle: nenhuma mensagem de usuário, então o modelo não é chamado.
    s.send({ type: 'control_request', request_id: 'ai-office-usage', request: { subtype: 'get_usage', skip_behaviors: true } });
    const msg = await s.waitFor((o) => o.type === 'control_response' && o.response?.request_id === 'ai-office-usage');
    if (msg.response.subtype !== 'success') throw new Error(msg.response.error || 'o Claude Code não respondeu o uso (atualize o Claude Code)');
    return parseClaudeUsage(msg.response.response);
  } finally {
    s.close();
  }
}

export async function readCodexLimits(bin = 'codex') {
  const s = jsonSession(bin, ['app-server']);
  try {
    s.send({ method: 'initialize', id: 1, params: { clientInfo: { name: 'ai_office', title: 'AI Office', version: '0.1.0' } } });
    const init = await s.waitFor((o) => o.id === 1);
    if (init.error) throw new Error(init.error.message || 'initialize falhou');
    s.send({ method: 'initialized' });
    s.send({ method: 'account/rateLimits/read', id: 2 });
    const res = await s.waitFor((o) => o.id === 2);
    if (res.error) throw new Error(res.error.message || 'account/rateLimits/read falhou');
    return parseCodexLimits(res.result);
  } finally {
    s.close();
  }
}

/**
 * Mantém os limites das duas contas atualizados. Consulta de tempos em tempos
 * (só para os CLIs instalados) e logo depois que uma etapa termina.
 */
export class Limits extends EventEmitter {
  constructor({ store, isReal, readers = { claude: readClaudeUsage, codex: readCodexLimits } }) {
    super();
    this.store = store;
    this.isReal = isReal; // (worker) => o CLI existe e está em modo real
    this.readers = readers;
    this.state = { claude: { status: 'idle' }, codex: { status: 'idle' } };
    this.timer = null;
    this.soon = null;
    this.busy = new Map();
  }

  start(seconds = 300) {
    clearInterval(this.timer);
    this.timer = setInterval(() => this.refresh(), Math.max(60, seconds) * 1000);
    this.timer.unref?.();
    setTimeout(() => this.refresh(), 3000).unref?.();
  }

  stop() {
    clearInterval(this.timer);
    clearTimeout(this.soon);
  }

  /** Depois de uma etapa: atualiza em alguns segundos (agrupa várias seguidas). */
  refreshSoon(ms = 5000) {
    clearTimeout(this.soon);
    this.soon = setTimeout(() => this.refresh(), ms);
    this.soon.unref?.();
  }

  /** Dado que já veio no stream de uma etapa do Claude. */
  observe(worker, win) {
    if (!win) return;
    const cur = this.state[worker] ?? {};
    const windows = [...(cur.windows ?? []).filter((w) => w.id !== win.id), win];
    this.state[worker] = { ...cur, status: 'ok', windows, updatedAt: Date.now() };
    this.emit('update', this.state);
  }

  async refreshOne(worker) {
    if (!this.isReal(worker)) {
      this.state[worker] = { status: 'off', windows: [], note: 'CLI não encontrado ou em modo simulado.' };
      return;
    }
    if (this.busy.get(worker)) return this.busy.get(worker);
    const bin = this.store.settings.workers[worker]?.bin || worker;
    const p = this.readers[worker](bin)
      .then((r) => {
        this.state[worker] = { status: 'ok', ...r, updatedAt: Date.now(), error: null };
      })
      .catch((err) => {
        const prev = this.state[worker] ?? {};
        this.state[worker] = { ...prev, status: prev.windows?.length ? 'ok' : 'error', error: String(err.message).slice(0, 200), updatedAt: prev.updatedAt ?? null };
      })
      .finally(() => this.busy.delete(worker));
    this.busy.set(worker, p);
    return p;
  }

  async refresh() {
    await Promise.all(['claude', 'codex'].map((w) => this.refreshOne(w)));
    this.emit('update', this.state);
    return this.state;
  }
}
