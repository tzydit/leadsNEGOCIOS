import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Billing, fetchAnthropicCosts, fetchOpenAICosts } from '../server/billing.js';
import { DEFAULT_PRICING, attemptCost, estimateCost, priceFor, sanitizePricing } from '../server/pricing.js';
import { childEnv } from '../server/proc.js';

test('priceFor: nome exato, prefixo e padrão do trabalhador', () => {
  assert.equal(priceFor(DEFAULT_PRICING, 'claude', 'claude-sonnet-5-5').key, 'claude-sonnet-5-5');
  assert.equal(priceFor(DEFAULT_PRICING, 'claude', 'claude-opus-5-5[1m]').key, 'claude-opus-5-5');
  assert.equal(priceFor(DEFAULT_PRICING, 'claude', 'claude-opus-5-5-20261001').key, 'claude-opus-5-5');
  assert.equal(priceFor(DEFAULT_PRICING, 'claude', '').key, 'claude-padrao');
  assert.equal(priceFor(DEFAULT_PRICING, 'codex', 'gpt-x').key, 'codex-padrao');
});

test('estimateCost separa entrada nova, leitura e escrita de cache e saída', () => {
  const pricing = { 'm': { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 } };
  // 1M de entrada = 600k novos + 300k lidos do cache + 100k gravados; 100k de saída
  const usd = estimateCost(pricing, 'claude', { model: 'm', input: 1_000_000, cachedInput: 300_000, cacheWrite: 100_000, output: 100_000 });
  assert.equal(usd.toFixed(4), (1.2 + 0.06 + 0.25 + 1).toFixed(4));
});

test('attemptCost prefere o custo exato informado pelo CLI', () => {
  assert.deepEqual(attemptCost(DEFAULT_PRICING, 'claude', { costUsd: 0.5, input: 9e9 }), { usd: 0.5, exact: true });
  assert.equal(attemptCost(DEFAULT_PRICING, 'codex', { input: 1e6, output: 0 }).exact, false);
});

test('sanitizePricing recusa valores e nomes inválidos', () => {
  assert.deepEqual(sanitizePricing({ 'Gpt-6': { input: '1', output: 2 } }), { 'gpt-6': { input: 1, cacheRead: 0, cacheWrite: 0, output: 2 } });
  assert.throws(() => sanitizePricing({ x: { input: -1 } }));
  assert.throws(() => sanitizePricing({ '../x': {} }));
  assert.throws(() => sanitizePricing([]));
});

test('chaves de administrador não vão para os processos das IAs', () => {
  process.env.ANTHROPIC_ADMIN_KEY = 'sk-ant-admin-x';
  process.env.OPENAI_ADMIN_KEY = 'sk-admin-x';
  const env = childEnv({ FOO: '1' });
  assert.equal(env.ANTHROPIC_ADMIN_KEY, undefined);
  assert.equal(env.OPENAI_ADMIN_KEY, undefined);
  assert.equal(env.FOO, '1');
  delete process.env.ANTHROPIC_ADMIN_KEY;
  delete process.env.OPENAI_ADMIN_KEY;
});

const now = new Date('2026-10-15T15:00:00Z');
const fakeFetch = (pages) => {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, headers: opts.headers });
    const body = pages[calls.length - 1];
    return { ok: true, json: async () => body };
  };
  fn.calls = calls;
  return fn;
};

test('Anthropic cost_report: centavos → dólares, mês e hoje, com paginação', async () => {
  const f = fakeFetch([
    { data: [{ starting_at: '2026-10-01T00:00:00Z', results: [{ amount: '150.5', currency: 'USD' }] }], has_more: true, next_page: 'p2' },
    { data: [{ starting_at: '2026-10-15T00:00:00Z', results: [{ amount: '200' }, { amount: '50' }] }], has_more: false },
  ]);
  const r = await fetchAnthropicCosts('sk-ant-admin', { fetchFn: f, now });
  assert.equal(r.monthUsd.toFixed(3), '4.005');
  assert.equal(r.todayUsd, 2.5);
  assert.match(f.calls[0].url, /cost_report\?starting_at=2026-10-01T00%3A00%3A00\.000Z&ending_at=2026-10-16/);
  assert.equal(f.calls[0].headers['x-api-key'], 'sk-ant-admin');
  assert.match(f.calls[1].url, /page=p2/);
});

test('OpenAI costs: amount.value em dólares, mês e hoje', async () => {
  const today = Date.UTC(2026, 9, 15) / 1000;
  const f = fakeFetch([{ data: [{ start_time: today - 86400, results: [{ amount: { value: 1.25, currency: 'usd' } }] }, { start_time: today, results: [{ amount: { value: 0.5 } }] }], has_more: false }]);
  const r = await fetchOpenAICosts('sk-admin', { fetchFn: f, now });
  assert.equal(r.monthUsd, 1.75);
  assert.equal(r.todayUsd, 0.5);
  assert.equal(f.calls[0].headers.Authorization, 'Bearer sk-admin');
  assert.match(f.calls[0].url, /organization\/costs\?start_time=1790812800/);
});

test('Billing guarda o erro sem derrubar e ignora provedor sem chave', async () => {
  const b = new Billing({ env: { ANTHROPIC_ADMIN_KEY: 'k' }, fetchFn: async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'invalid x-api-key' } }) }) });
  const st = await b.refresh();
  assert.equal(st.anthropic.error, 'invalid x-api-key');
  assert.equal(st.openai.configured, false);
});
