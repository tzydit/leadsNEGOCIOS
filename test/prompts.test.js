import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildPrompt, extractSummary, loadSkills, parseVerdict } from '../server/prompts.js';

const skills = loadSkills(path.resolve(import.meta.dirname, '..', 'skills'));

test('todas as skills têm nome e descrição no frontmatter', () => {
  assert.ok(skills.length >= 6);
  for (const s of skills) {
    assert.match(s.name, /^[a-z0-9-]+$/);
    assert.ok(s.description.length > 20, s.name);
    assert.ok(!s.body.startsWith('---'));
  }
});

test('parseVerdict pega o último veredito, com ou sem acento', () => {
  assert.equal(parseVerdict('x\nVEREDITO: APROVADO'), 'APROVADO');
  assert.equal(parseVerdict('VEREDITO: APROVADO\n...\nVEREDITO: MUDANÇAS NECESSÁRIAS'), 'MUDANCAS_NECESSARIAS');
  assert.equal(parseVerdict('**VEREDITO:** MUDANCAS_NECESSARIAS'), 'MUDANCAS_NECESSARIAS');
  assert.equal(parseVerdict('VEREDITO: **MUDANCAS_NECESSARIAS**'), 'MUDANCAS_NECESSARIAS');
  assert.equal(parseVerdict('sem veredito'), null);
});

test('extractSummary usa o bloco RESUMO e remove o veredito', () => {
  assert.equal(extractSummary('blá blá\nRESUMO:\n- a\n- b\nVEREDITO: APROVADO'), '- a\n- b');
  assert.equal(extractSummary('texto curto'), 'texto curto');
  assert.ok(extractSummary('x'.repeat(5000), 100).endsWith('[…resumo truncado]'));
});

test('buildPrompt: revisor recebe skills, resumo anterior, diff e exigência de veredito', () => {
  const p = buildPrompt({
    line: { name: 'Login' },
    step: { role: 'revisar', worker: 'codex', instruction: 'Confira a validação', skills: ['revisao-codigo', 'inexistente'] },
    stepIndex: 1,
    totalSteps: 2,
    skills,
    previous: { worker: 'claude', role: 'executar', summary: '- criei validators.js' },
    diff: { stat: '1 file changed', diff: '+const a = 1;', truncated: true, empty: false },
    baseCommit: 'abcdef1234567',
    round: 1,
  });
  assert.match(p, /skill: revisao-codigo/);
  assert.doesNotMatch(p, /inexistente/);
  assert.match(p, /REVISOR/);
  assert.match(p, /Confira a validação/);
  assert.match(p, /criei validators\.js/);
  assert.match(p, /\+const a = 1;/);
  assert.match(p, /git diff abcdef1234/);
  assert.match(p, /VEREDITO: APROVADO` ou `VEREDITO: MUDANCAS_NECESSARIAS/);
  // partes fixas antes das variáveis (melhor para cache de prompt)
  assert.ok(p.indexOf('skill: revisao-codigo') < p.indexOf('Confira a validação'));
});

test('buildPrompt: executor na 2ª rodada recebe as correções do revisor', () => {
  const p = buildPrompt({
    line: { name: 'L' },
    step: { role: 'executar', worker: 'claude', instruction: 'Faça X', skills: [] },
    stepIndex: 0,
    totalSteps: 2,
    skills,
    feedback: { worker: 'codex', text: '[BLOQUEANTE] a.js:1 — bug' },
    round: 2,
  });
  assert.match(p, /rodada 2/);
  assert.match(p, /Correções pedidas pelo revisor \(Codex\)/);
  assert.match(p, /\[BLOQUEANTE\] a\.js:1/);
  assert.doesNotMatch(p, /VEREDITO/);
});
