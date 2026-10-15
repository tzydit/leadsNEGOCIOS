import { VERDICT_ROLES } from '../prompts.js';
import { emptyUsage } from './common.js';

// Roteiros de demonstração: deixam o escritório "vivo" sem nenhum CLI instalado.
const SCRIPTS = {
  executar: [
    ['info', 'Sessão simulada iniciada'],
    ['thinking', 'Pensando…'],
    ['tool', 'Buscando "TODO"'],
    ['tool', 'Lendo index.js'],
    ['tool', 'Lendo routes.js'],
    ['file', 'Editando routes.js'],
    ['file', 'Criando validators.js'],
    ['command', '$ npm test -- routes'],
    ['text', 'Implementei a validação nas rotas e criei os testes.'],
  ],
  revisar: [
    ['info', 'Sessão simulada iniciada'],
    ['tool', 'Lendo o diff recebido'],
    ['command', '$ git diff --stat'],
    ['tool', 'Lendo routes.js'],
    ['thinking', 'Pensando…'],
  ],
  auditar: [
    ['info', 'Sessão simulada iniciada'],
    ['tool', 'Buscando "innerHTML"'],
    ['tool', 'Buscando "exec("'],
    ['command', '$ npm audit --omit=dev'],
    ['tool', 'Lendo auth.js'],
    ['thinking', 'Pensando…'],
  ],
  planejar: [
    ['info', 'Sessão simulada iniciada'],
    ['tool', 'Lendo README.md'],
    ['tool', 'Procurando src/**/*.js'],
    ['thinking', 'Pensando…'],
  ],
};
SCRIPTS.analisar = SCRIPTS.planejar;
SCRIPTS.revisar_corrigir = [...SCRIPTS.revisar.slice(0, 4), ['file', 'Editando routes.js'], ['command', '$ npm test -- routes']];
SCRIPTS.auditar_corrigir = [...SCRIPTS.auditar.slice(0, 5), ['file', 'Editando auth.js']];
SCRIPTS.analisar_corrigir = [...SCRIPTS.planejar.slice(0, 3), ['file', 'Editando index.js']];

function finalTextFor(role, verdict, worker) {
  if (role === 'executar') {
    return `Implementação feita (simulação ${worker}).\nRESUMO:\n- routes.js: validação de entrada nas rotas\n- validators.js: novo, schemas de validação\n- testes de rota passando`;
  }
  if (role.endsWith('_corrigir')) {
    return `[IMPORTANTE] routes.js:42 — id inexistente retornava 500 → ✔ corrigido\n[MENOR] routes.js:10 — nome pouco claro → ✖ não corrigido (fora do escopo)\nRESUMO:\n- 1 achado corrigido, 1 deixado (simulação ${worker})`;
  }
  if (role === 'planejar' || role === 'analisar') {
    return `NOTA GERAL: 6/10 — estrutura ok, falta validação nas bordas.\nPRÓXIMOS PASSOS:\n1. Validar entradas\n2. Testes de rota\nRESUMO:\n- plano em 2 passos (simulação ${worker})`;
  }
  const finding =
    verdict === 'MUDANCAS_NECESSARIAS'
      ? role === 'auditar'
        ? '[ALTA] routes.js:42 — entrada do usuário sem validação vai direto para a query\n  Exploração: id = "1 OR 1=1"\n  Correção: query parametrizada'
        : '[IMPORTANTE] routes.js:42 — falta tratar id inexistente (retorna 500 em vez de 404)'
      : 'Nenhum achado bloqueante.';
  return `${finding}\nRESUMO:\n- revisão simulada por ${worker}\nVEREDITO: ${verdict}`;
}

/** Decide o veredito da simulação: na 1ª rodada às vezes pede mudanças. */
const defaultDecide = ({ round }) => (round === 1 && Math.random() < 0.5 ? 'MUDANCAS_NECESSARIAS' : 'APROVADO');

export function createSimulatedRunner({ stepMs = 1400, decide = defaultDecide } = {}) {
  return function runSimulated({ role, worker, round = 1, onEvent, onUsage }) {
    const script = SCRIPTS[role] ?? SCRIPTS.executar;
    const usage = emptyUsage();
    let i = 0;
    let timer = null;
    let killed = false;
    let resolveDone;
    const done = new Promise((r) => (resolveDone = r));

    const tick = () => {
      if (killed) return;
      if (i < script.length) {
        const [kind, text] = script[i++];
        onEvent({ kind, text });
        usage.input += 1800 + Math.floor(Math.random() * 1200);
        usage.cachedInput += 900 + Math.floor(Math.random() * 600);
        usage.output += 120 + Math.floor(Math.random() * 200);
        onUsage({ ...usage });
        timer = setTimeout(tick, stepMs * (0.6 + Math.random() * 0.8));
        return;
      }
      const verdict = VERDICT_ROLES.has(role) ? decide({ role, round, worker }) : null;
      const finalText = finalTextFor(role, verdict, worker);
      onEvent({ kind: 'text', text: finalText });
      resolveDone({ ok: true, finalText, usage });
    };
    timer = setTimeout(tick, stepMs * 0.5);

    return {
      done,
      kill: () => {
        killed = true;
        clearTimeout(timer);
        resolveDone({ ok: false, finalText: '', usage, error: 'interrompido' });
      },
    };
  };
}
