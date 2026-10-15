import { exec } from './proc.js';

const IS_WIN = process.platform === 'win32';
export const EFFORT_RE = /^[a-z]{1,16}$/;
export const MODEL_RE = /^[\w.:\-[\]/]{1,80}$/;

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// O Claude Code não tem comando que liste modelos; esta lista segue os
// modelos atuais (aceita também os apelidos fable/opus/sonnet/haiku).
export const CLAUDE_MODELS = [
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', description: 'O mais capaz, para o trabalho mais difícil (mais caro).', efforts: CLAUDE_EFFORTS },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', description: 'Muito capaz para código e agentes.', efforts: CLAUDE_EFFORTS },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', description: 'Rápido e capaz para o dia a dia.', efforts: CLAUDE_EFFORTS },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', description: 'O mais rápido e barato; bom para revisões simples.', efforts: CLAUDE_EFFORTS },
];

// Usada só se o Codex não estiver instalado (catálogo de out/2026).
export const CODEX_FALLBACK = [
  { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', description: '', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  { id: 'gpt-6-astra', label: 'GPT-6-Astra', description: 'Frontier intelligence for the most demanding work.', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  { id: 'gpt-6-sol', label: 'GPT-6-Sol', description: '', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  { id: 'gpt-6-luna', label: 'GPT-6-Luna', description: '', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
];

/** Converte a saída de `codex debug models` na lista que a interface usa. */
export function parseCodexCatalog(json) {
  const list = Array.isArray(json?.models) ? json.models : Array.isArray(json) ? json : [];
  return list
    .filter((m) => m?.slug && m.visibility !== 'hide' && MODEL_RE.test(m.slug))
    .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
    .map((m) => ({
      id: m.slug,
      label: m.display_name || m.slug,
      description: m.description || '',
      efforts: (m.supported_reasoning_levels ?? []).map((l) => l.effort).filter((e) => EFFORT_RE.test(e ?? '')),
      defaultEffort: m.default_reasoning_level || '',
    }));
}

/** Lê o catálogo do próprio Codex (não precisa de login nem gasta tokens). */
export async function loadCodexModels(bin = 'codex') {
  const r = await exec(IS_WIN ? `"${bin}"` : bin, ['debug', 'models'], { timeout: 30000, shell: IS_WIN });
  if (r.code !== 0) return { models: CODEX_FALLBACK, source: 'fallback' };
  try {
    const models = parseCodexCatalog(JSON.parse(r.stdout));
    return models.length ? { models, source: 'cli' } : { models: CODEX_FALLBACK, source: 'fallback' };
  } catch {
    return { models: CODEX_FALLBACK, source: 'fallback' };
  }
}
