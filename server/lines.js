import { EFFORT_RE, MODEL_RE } from './models.js';
import { ROLES, WORKERS } from './prompts.js';

export const MAX_STEPS = 12;

const step = (worker, role, instruction = '', extra = []) => ({ worker, role, instruction, skills: [...new Set([...ROLES[role].defaultSkills, ...extra])] });

export const TEMPLATES = {
  'claude-faz-codex-revisa': {
    label: 'Claude faz → Codex revisa',
    loop: { enabled: true, maxRounds: 2 },
    steps: () => [step('claude', 'executar'), step('codex', 'revisar', 'Revise as mudanças da etapa anterior.')],
  },
  'codex-faz-claude-revisa': {
    label: 'Codex faz → Claude revisa',
    loop: { enabled: true, maxRounds: 2 },
    steps: () => [step('codex', 'executar'), step('claude', 'revisar', 'Revise as mudanças da etapa anterior.')],
  },
  'planejar-executar-revisar': {
    label: 'Claude planeja → Codex faz → Claude revisa',
    loop: { enabled: true, maxRounds: 2 },
    steps: () => [
      step('claude', 'planejar'),
      step('codex', 'executar', 'Execute o plano da etapa anterior.'),
      step('claude', 'revisar', 'Revise se o plano foi cumprido e se o código está correto.'),
    ],
  },
  'frontend-com-capturas': {
    label: 'Front-end com capturas de tela',
    loop: { enabled: true, maxRounds: 2 },
    steps: () => [
      step('claude', 'executar', '', ['frontend-design', 'accessibility', 'captura-tela']),
      step('codex', 'revisar', 'Revise o código e o visual pelas capturas: layout, celular, contraste e acessibilidade.', ['captura-tela']),
    ],
  },
  'auditoria-cruzada': {
    label: 'Auditoria de segurança cruzada',
    loop: { enabled: false, maxRounds: 1 },
    steps: () => [
      step('claude', 'auditar', 'Audite a segurança do projeto inteiro.'),
      step('codex', 'auditar', 'Confirme ou refute cada achado do auditor anterior e procure o que ele deixou passar.'),
    ],
  },
  'analise-fria': {
    label: 'Análise fria do projeto',
    loop: { enabled: false, maxRounds: 1 },
    steps: () => [
      step('claude', 'analisar', 'Faça a análise fria do projeto.'),
      step('codex', 'analisar', 'Contraponha a análise anterior: o que está errado, exagerado ou faltando?'),
    ],
  },
  vazia: {
    label: 'Linha vazia',
    loop: { enabled: false, maxRounds: 1 },
    steps: () => [step('claude', 'executar')],
  },
};

const str = (v, max) => String(v ?? '').slice(0, max);
const validOr = (v, re, what) => {
  if (v && !re.test(v)) throw new Error(`${what} inválido: ${v}`);
  return v;
};

/** Quem corrige quando o revisor pede mudanças ('' = quem executou). */
export function sanitizeFixer(f) {
  const worker = WORKERS[f?.worker] ? f.worker : '';
  return {
    worker,
    model: worker ? validOr(str(f?.model, 80).trim(), MODEL_RE, 'modelo') : '',
    effort: worker ? validOr(str(f?.effort, 16).trim(), EFFORT_RE, 'raciocínio') : '',
  };
}

/** Valida e normaliza a configuração de uma linha vinda do cliente. */
export function sanitizeLine(input, knownSkills) {
  const out = {};
  if (input.name !== undefined) out.name = str(input.name, 60).trim() || 'Linha';
  if (input.workdir !== undefined) out.workdir = str(input.workdir, 500).trim();
  if (input.useWorktree !== undefined) out.useWorktree = Boolean(input.useWorktree);
  if (input.preview !== undefined) {
    const url = str(input.preview?.url, 300).trim();
    if (url && !/^https?:\/\/[^\s]+$/i.test(url)) throw new Error('A URL de preview precisa começar com http:// ou https://');
    out.preview = { url, command: str(input.preview?.command, 500).trim() };
  }
  if (input.tokenBudget !== undefined) out.tokenBudget = Math.max(0, Math.floor(Number(input.tokenBudget) || 0));
  if (input.loop !== undefined) {
    out.loop = {
      enabled: Boolean(input.loop?.enabled),
      maxRounds: Math.min(5, Math.max(1, Math.floor(Number(input.loop?.maxRounds) || 1))),
      fixer: sanitizeFixer(input.loop?.fixer),
    };
  }
  if (input.steps !== undefined) {
    if (!Array.isArray(input.steps)) throw new Error('steps deve ser uma lista');
    out.steps = input.steps.slice(0, MAX_STEPS).map((s) => {
      if (!WORKERS[s?.worker]) throw new Error(`trabalhador inválido: ${s?.worker}`);
      if (!ROLES[s?.role]) throw new Error(`papel inválido: ${s?.role}`);
      return {
        worker: s.worker,
        role: s.role,
        instruction: str(s.instruction, 8000),
        skills: Array.isArray(s.skills) ? [...new Set(s.skills.filter((n) => knownSkills.has(n)))] : [],
        model: validOr(str(s.model, 80).trim(), MODEL_RE, 'modelo'),
        effort: validOr(str(s.effort, 16).trim(), EFFORT_RE, 'raciocínio'),
      };
    });
  }
  return out;
}

export function newLine({ id, index, template = 'claude-faz-codex-revisa', workdir = '' }) {
  const t = Object.hasOwn(TEMPLATES, template) ? TEMPLATES[template] : TEMPLATES['claude-faz-codex-revisa'];
  return {
    id,
    name: `Linha ${index}`,
    workdir,
    useWorktree: true,
    tokenBudget: 0,
    preview: { url: '', command: '' },
    loop: { ...t.loop, fixer: { worker: '', model: '', effort: '' } },
    steps: t.steps().map((s) => ({ ...s, model: '', effort: '' })),
    run: null,
  };
}
