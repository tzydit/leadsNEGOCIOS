import { EventEmitter } from 'node:events';

// Gasto real das contas, lido das APIs de custo dos provedores. Só funciona
// com chaves de administrador da organização (não existem para contas
// individuais nem para assinaturas Claude Pro/Max ou ChatGPT Plus/Pro).
// As chaves vêm só de variáveis de ambiente e nunca vão para o navegador.

const pad = (n) => String(n).padStart(2, '0');
const isoDay = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

function monthWindow(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return { start, end, today: isoDay(now) };
}

async function getJson(fetchFn, url, headers) {
  const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(20000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message || `HTTP ${res.status}`);
  return body;
}

/** Anthropic: valores em centavos (string decimal), buckets diários em UTC. */
export async function fetchAnthropicCosts(key, { fetchFn = fetch, now = new Date() } = {}) {
  const { start, end, today } = monthWindow(now);
  let month = 0;
  let todayUsd = 0;
  let page = null;
  for (let i = 0; i < 10; i++) {
    const q = new URLSearchParams({ starting_at: start.toISOString(), ending_at: end.toISOString(), bucket_width: '1d', limit: '31' });
    if (page) q.set('page', page);
    const body = await getJson(fetchFn, `https://api.anthropic.com/v1/organizations/cost_report?${q}`, {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'User-Agent': 'ai-office/0.1',
    });
    for (const bucket of body.data ?? []) {
      const usd = (bucket.results ?? []).reduce((acc, r) => acc + (parseFloat(r.amount) || 0) / 100, 0);
      month += usd;
      if (String(bucket.starting_at).startsWith(today)) todayUsd += usd;
    }
    if (!body.has_more || !body.next_page) break;
    page = body.next_page;
  }
  return { monthUsd: month, todayUsd };
}

/** OpenAI: valores em dólares (amount.value), buckets diários em UTC. */
export async function fetchOpenAICosts(key, { fetchFn = fetch, now = new Date() } = {}) {
  const { start, end, today } = monthWindow(now);
  let month = 0;
  let todayUsd = 0;
  let page = null;
  for (let i = 0; i < 10; i++) {
    const q = new URLSearchParams({ start_time: String(start / 1000), end_time: String(end / 1000), bucket_width: '1d', limit: '31' });
    if (page) q.set('page', page);
    const body = await getJson(fetchFn, `https://api.openai.com/v1/organization/costs?${q}`, { Authorization: `Bearer ${key}` });
    for (const bucket of body.data ?? []) {
      const usd = (bucket.results ?? []).reduce((acc, r) => acc + (Number(r.amount?.value) || 0), 0);
      month += usd;
      if (isoDay(new Date(bucket.start_time * 1000)) === today) todayUsd += usd;
    }
    if (!body.has_more || !body.next_page) break;
    page = body.next_page;
  }
  return { monthUsd: month, todayUsd };
}

const PROVIDERS = {
  anthropic: { env: 'ANTHROPIC_ADMIN_KEY', fetch: fetchAnthropicCosts },
  openai: { env: 'OPENAI_ADMIN_KEY', fetch: fetchOpenAICosts },
};

export class Billing extends EventEmitter {
  constructor({ env = process.env, fetchFn = fetch } = {}) {
    super();
    this.env = env;
    this.fetchFn = fetchFn;
    this.timer = null;
    this.state = {};
    for (const [id, p] of Object.entries(PROVIDERS)) {
      this.state[id] = { configured: Boolean(env[p.env]), env: p.env, monthUsd: null, todayUsd: null, updatedAt: null, error: null };
    }
  }

  async refresh() {
    await Promise.all(
      Object.entries(PROVIDERS).map(async ([id, p]) => {
        const key = this.env[p.env];
        if (!key) return;
        try {
          const r = await p.fetch(key, { fetchFn: this.fetchFn });
          Object.assign(this.state[id], r, { updatedAt: Date.now(), error: null });
        } catch (err) {
          this.state[id].error = err.message;
        }
      }),
    );
    this.emit('update', this.state);
    return this.state;
  }

  start(seconds = 300) {
    this.stop();
    if (!Object.values(this.state).some((s) => s.configured)) return;
    // As APIs aceitam no máximo uma consulta por minuto de forma contínua.
    const ms = Math.max(60, Number(seconds) || 300) * 1000;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), ms);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}
