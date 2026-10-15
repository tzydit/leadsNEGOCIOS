import fs from 'node:fs';
import path from 'node:path';

export const WORKERS = {
  claude: { name: 'Claude' },
  codex: { name: 'Codex' },
};

export const ROLES = {
  executar: { label: 'Executar', defaultSkills: ['economia-tokens'] },
  revisar: { label: 'Revisar', defaultSkills: ['economia-tokens', 'revisao-codigo'] },
  auditar: { label: 'Auditar segurança', defaultSkills: ['economia-tokens', 'auditoria-seguranca', 'security-best-practices'] },
  planejar: { label: 'Planejar', defaultSkills: ['economia-tokens'] },
  analisar: { label: 'Análise fria', defaultSkills: ['economia-tokens', 'analise-fria'] },
};

export const VERDICT_ROLES = new Set(['revisar', 'auditar']);

/** Lê o frontmatter YAML simples de um SKILL.md (chaves de topo, aspas e blocos > ou |). */
export function parseFrontmatter(raw) {
  const text = String(raw).replace(/\r\n/g, '\n');
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text.trim() };
  const meta = {};
  const lines = m[1].split('\n');
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      const block = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) block.push(lines[++i].trim());
      value = block.join(value.startsWith('>') ? ' ' : '\n');
    } else if (/^(["']).*\1$/.test(value)) {
      value = value.slice(1, -1);
    }
    meta[kv[1]] = value;
  }
  return { meta, body: m[2].trim() };
}

export function readCatalog(skillsDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(skillsDir, 'catalog.json'), 'utf8'));
  } catch {
    return { fontes: {}, skills: {} };
  }
}

/**
 * Lê as skills do AI Office (skills/<nome>) e as melhores do GitHub
 * (skills/github/<nome>), com origem, licença e destaque do catálogo.
 */
export function loadSkills(skillsDir) {
  const out = [];
  if (!fs.existsSync(skillsDir)) return out;
  const catalog = readCatalog(skillsDir);
  const roots = [skillsDir, path.join(skillsDir, 'github')];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      const file = path.join(dir, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      const { meta, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
      const name = meta.name || entry.name;
      const info = catalog.skills?.[name] ?? {};
      const fonte = info.fonte && info.fonte !== 'ai-office' ? catalog.fontes?.[info.fonte] : null;
      const extra = fs.readdirSync(dir).filter((f) => !/^(SKILL\.md|LICENSE.*|NOTICE.*|README\.md|metadata\.json)$/i.test(f));
      out.push({
        name,
        description: meta.description || '',
        body,
        dir,
        hasFiles: extra.length > 0,
        tokens: Math.round(body.length / 4),
        categoria: info.categoria ?? 'geral',
        melhor: Boolean(info.melhor),
        recomendada: Boolean(info.recomendada),
        origem: fonte ? info.fonte : 'ai-office',
        autor: fonte?.autor ?? 'AI Office',
        licenca: fonte?.licenca ?? 'MIT',
        url: fonte ? `https://github.com/${info.fonte}/tree/${fonte.commit}/${info.caminho ?? ''}` : null,
        porque: info.porque ?? '',
      });
    }
  }
  const rank = (s) => (s.melhor ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || a.categoria.localeCompare(b.categoria) || a.name.localeCompare(b.name));
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
export function buildPrompt({ line, step, stepIndex, totalSteps, skills, previous, diff, baseCommit, feedback, round, capture = null }) {
  const parts = [];
  const chosen = (step.skills ?? []).map((n) => skills.find((s) => s.name === n)).filter(Boolean);
  if (chosen.length) {
    parts.push('# Skills obrigatórias desta etapa');
    if (chosen.length > 1) {
      parts.push(
        'Use todas juntas. Se conflitarem: o papel e o "Formato da resposta" no fim deste prompt vencem (não grave relatórios em arquivo se o papel não edita arquivos; entregue o conteúdo na resposta); as skills de conteúdo (front-end, segurança, revisão) decidem O QUE verificar ou fazer; economia-tokens decide COMO ler e escrever (pouco e direto), sem pular verificações que as outras exigem.',
      );
    }
    for (const s of chosen) {
      // Skills grandes trazem referências em arquivos; a IA lê só o que precisar.
      const files = s.hasFiles ? `\n(Arquivos de apoio desta skill — referências citadas acima: ${s.dir})` : '';
      const body = s.body.replaceAll('{{CAPTURA_CMD}}', capture?.cmd ?? 'node scripts/screenshot.js');
      parts.push(`## skill: ${s.name}${files}\n${body}`);
    }
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

  if (capture) {
    const lines = ['## Capturas de tela (Chrome)'];
    lines.push(capture.url ? `Site de preview: ${capture.url}` : 'Sem URL de preview configurada: suba o site você mesmo e use a URL local.');
    lines.push(`Comando: \`${capture.cmd} <url> --name <nome>\``);
    if (capture.files?.length) lines.push(`Capturas feitas agora, antes desta etapa (abra e olhe antes de concluir):\n${capture.files.map((f) => `- ${f}`).join('\n')}`);
    if (capture.problems?.length) lines.push(`Problemas vistos no navegador:\n${capture.problems.map((p) => `- ${p}`).join('\n')}`);
    if (capture.error) lines.push(`A captura automática falhou: ${capture.error}`);
    parts.push(lines.join('\n'));
  }

  const out = ['## Formato da resposta', 'Responda em português, direto ao ponto.', 'Termine com `RESUMO:` (no máximo 5 linhas) — é o que a próxima IA vai receber.'];
  if (step.role === 'planejar') out.push('No RESUMO, coloque o plano em passos numerados.');
  if (VERDICT_ROLES.has(step.role)) out.push('A ÚLTIMA linha deve ser exatamente `VEREDITO: APROVADO` ou `VEREDITO: MUDANCAS_NECESSARIAS`.');
  parts.push(out.join('\n'));

  return parts.join('\n\n');
}
