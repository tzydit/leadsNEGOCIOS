import fs from 'node:fs';
import path from 'node:path';

export const WORKERS = {
  claude: { name: 'Claude' },
  codex: { name: 'Codex' },
};

export const ROLES = {
  executar: { label: 'Executar', defaultSkills: ['economia-tokens'] },
  revisar: { label: 'Revisar', defaultSkills: ['economia-tokens', 'revisao-codigo'] },
  auditar: { label: 'Auditar segurança', defaultSkills: ['economia-tokens', 'auditoria-seguranca'] },
  planejar: { label: 'Planejar', defaultSkills: ['economia-tokens'] },
  analisar: { label: 'Análise fria', defaultSkills: ['economia-tokens', 'analise-fria'] },
};

export const VERDICT_ROLES = new Set(['revisar', 'auditar']);

/** Lê skills/<nome>/SKILL.md → { name, description, body } (body sem frontmatter). */
export function loadSkills(skillsDir) {
  const out = [];
  if (!fs.existsSync(skillsDir)) return out;
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(skillsDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    const meta = {};
    if (m) {
      for (const line of m[1].split('\n')) {
        const kv = line.match(/^(\w+):\s*(.*)$/);
        if (kv) meta[kv[1]] = kv[2].trim();
      }
    }
    out.push({ name: meta.name || entry.name, description: meta.description || '', body: (m ? m[2] : raw).trim() });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function parseVerdict(text) {
  const matches = [...String(text ?? '').matchAll(/VEREDITO:\s*\**\s*(APROVADO|MUDAN[CÇ]AS[_ ]NECESS[AÁ]RIAS)/gi)];
  if (!matches.length) return null;
  const v = matches[matches.length - 1][1].toUpperCase();
  return v.startsWith('APROVADO') ? 'APROVADO' : 'MUDANCAS_NECESSARIAS';
}

/** Resumo para repassar à próxima IA: o bloco RESUMO: se existir, senão o texto todo. */
export function extractSummary(text, maxChars = 2000) {
  const str = String(text ?? '').trim();
  const idx = str.search(/RESUMO:/i);
  let summary = idx >= 0 ? str.slice(idx + 'RESUMO:'.length) : str;
  summary = summary.replace(/VEREDITO:.*$/gim, '').trim();
  return summary.length > maxChars ? summary.slice(0, maxChars) + '\n[…resumo truncado]' : summary;
}

/** Achados do revisor sem o veredito, para devolver ao executor. */
export function extractFindings(text, maxChars = 3000) {
  const str = String(text ?? '').replace(/VEREDITO:.*$/gim, '').trim();
  return str.length > maxChars ? str.slice(0, maxChars) + '\n[…truncado]' : str;
}

const ROLE_BRIEF = {
  executar: 'Você é o EXECUTOR desta linha. Faça a tarefa editando os arquivos do diretório atual. Não faça commit nem push.',
  revisar: 'Você é o REVISOR desta linha. NÃO edite arquivos. Revise friamente o trabalho da etapa anterior.',
  auditar: 'Você é o AUDITOR DE SEGURANÇA desta linha. NÃO edite arquivos. Procure vulnerabilidades exploráveis.',
  planejar: 'Você é o PLANEJADOR desta linha. NÃO edite arquivos. Produza um plano curto e executável por outra IA.',
  analisar: 'Você é o ANALISTA desta linha. NÃO edite arquivos. Faça um diagnóstico frio e honesto.',
};

/**
 * Monta o prompt de uma etapa. Partes fixas (skills, papel) vêm primeiro para
 * aproveitar cache de prompt; contexto variável (resumo, diff) vem por último.
 */
export function buildPrompt({ line, step, stepIndex, totalSteps, skills, previous, diff, baseCommit, feedback, round }) {
  const parts = [];
  const chosen = (step.skills ?? []).map((n) => skills.find((s) => s.name === n)).filter(Boolean);
  if (chosen.length) {
    parts.push('# Skills obrigatórias desta etapa');
    for (const s of chosen) parts.push(`## skill: ${s.name}\n${s.body}`);
  }

  parts.push(`# Tarefa — AI Office · linha "${line.name}" · etapa ${stepIndex + 1}/${totalSteps}${round > 1 ? ` · rodada ${round}` : ''}`);
  parts.push(ROLE_BRIEF[step.role] ?? ROLE_BRIEF.executar);
  parts.push(`## Instrução do usuário\n${step.instruction?.trim() || '(sem instrução específica — siga o papel e as skills)'}`);

  if (feedback) {
    parts.push(`## Correções pedidas pelo revisor (${WORKERS[feedback.worker]?.name ?? feedback.worker})\nCorrija os itens BLOQUEANTE/IMPORTANTE abaixo. Não refaça o que já está certo.\n${feedback.text}`);
  }
  if (previous) {
    const who = WORKERS[previous.worker]?.name ?? previous.worker;
    parts.push(`## Resultado da etapa anterior (${who}, ${ROLES[previous.role]?.label ?? previous.role})\n${previous.summary || '(sem resumo)'}`);
  }
  if (diff && !diff.empty) {
    parts.push(
      `## Mudanças a analisar (git diff contra ${baseCommit ? baseCommit.slice(0, 10) : 'HEAD'})\n` +
        `\`\`\`\n${diff.stat}\n\`\`\`\n\`\`\`diff\n${diff.diff}\n\`\`\`` +
        (diff.truncated ? `\n(diff truncado — rode \`git diff ${baseCommit ? baseCommit.slice(0, 10) : 'HEAD'} -- <arquivo>\` só nos arquivos que precisar)` : ''),
    );
  } else if (diff && diff.empty && VERDICT_ROLES.has(step.role)) {
    parts.push('## Mudanças a analisar\nNenhuma mudança no diretório. Analise o projeto conforme a instrução.');
  }

  const out = ['## Formato da resposta', 'Responda em português, direto ao ponto.', 'Termine com `RESUMO:` (no máximo 5 linhas) — é o que a próxima IA vai receber.'];
  if (step.role === 'planejar') out.push('No RESUMO, coloque o plano em passos numerados.');
  if (VERDICT_ROLES.has(step.role)) out.push('A ÚLTIMA linha deve ser exatamente `VEREDITO: APROVADO` ou `VEREDITO: MUDANCAS_NECESSARIAS`.');
  parts.push(out.join('\n'));

  return parts.join('\n\n');
}
