// Preços em US$ por 1 milhão de tokens, usados para estimar o custo ao vivo.
// O Claude informa o custo exato no fim de cada etapa e ele substitui a
// estimativa; o Codex não informa, então fica a estimativa. Os valores são
// editáveis em Configurações, porque mudam com frequência.
export const DEFAULT_PRICING = {
  'claude-fable-5-1': { input: 10, cacheRead: 0.25, cacheWrite: 12.5, output: 50 },
  'claude-opus-5-5': { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 },
  'claude-opus-5': { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 },
  'claude-sonnet-5-5': { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 },
  'claude-sonnet-5': { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 },
  'claude-haiku-5-5': { input: 0.1, cacheRead: 0.01, cacheWrite: 0.125, output: 0.5 },
  // Usados quando o modelo não é conhecido.
  'claude-padrao': { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 },
  'codex-padrao': { input: 2, cacheRead: 0.1, cacheWrite: 0, output: 10 },
};

const FIELDS = ['input', 'cacheRead', 'cacheWrite', 'output'];

/** Acha a linha de preço: nome exato, depois prefixo mais longo, depois o padrão do trabalhador. */
export function priceFor(pricing, worker, model) {
  const m = String(model || '').toLowerCase().replace(/\[.*\]$/, '');
  if (m && pricing[m]) return { key: m, ...pricing[m] };
  const prefix = Object.keys(pricing)
    .filter((k) => m.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  if (prefix) return { key: prefix, ...pricing[prefix] };
  const fallback = `${worker}-padrao`;
  return { key: fallback, ...(pricing[fallback] ?? DEFAULT_PRICING[fallback] ?? DEFAULT_PRICING['claude-padrao']) };
}

/** usage.input inclui o que veio do cache e o que foi gravado nele. */
export function estimateCost(pricing, worker, usage) {
  const p = priceFor(pricing, worker, usage?.model);
  const cacheRead = usage?.cachedInput ?? 0;
  const cacheWrite = usage?.cacheWrite ?? 0;
  const fresh = Math.max(0, (usage?.input ?? 0) - cacheRead - cacheWrite);
  return (fresh * p.input + cacheRead * p.cacheRead + cacheWrite * p.cacheWrite + (usage?.output ?? 0) * p.output) / 1e6;
}

/** Custo da tentativa: o exato do CLI quando existe, senão a estimativa. */
export function attemptCost(pricing, worker, usage) {
  if (usage?.costUsd > 0) return { usd: usage.costUsd, exact: true };
  return { usd: estimateCost(pricing, worker, usage), exact: false };
}

export function sanitizePricing(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('tabela de preços inválida');
  const out = {};
  for (const [name, row] of Object.entries(input).slice(0, 60)) {
    const key = String(name).trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(key)) throw new Error(`nome de modelo inválido: ${name}`);
    out[key] = {};
    for (const f of FIELDS) {
      const v = Number(row?.[f] ?? 0);
      if (!Number.isFinite(v) || v < 0 || v > 10000) throw new Error(`preço inválido em ${key}.${f}`);
      out[key][f] = v;
    }
  }
  return out;
}
