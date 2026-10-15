import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createSimulatedRunner } from '../server/adapters/simulated.js';
import { newLine } from '../server/lines.js';
import { Orchestrator } from '../server/orchestrator.js';
import { loadSkills } from '../server/prompts.js';
import { Store } from '../server/store.js';

const skills = loadSkills(path.resolve(import.meta.dirname, '..', 'skills'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-'));
const noCli = async () => ({ available: false });

function setup({ runners, detect = noCli, template, line: patch } = {}) {
  const store = new Store(null);
  const orch = new Orchestrator({ store, skills, worktreesDir: path.join(tmp(), 'wt'), runners, detect });
  const line = Object.assign(newLine({ id: 'l1', index: 1, template }), patch);
  store.lines.push(line);
  return { store, orch, line };
}

test('ciclo de revisão: revisor pede mudanças, executor corrige, revisor aprova', async () => {
  const simulated = createSimulatedRunner({ stepMs: 1, decide: ({ round }) => (round === 1 ? 'MUDANCAS_NECESSARIAS' : 'APROVADO') });
  const { orch, line, store } = setup({ runners: { simulated } });
  await orch.detect();
  await orch.start('l1');
  const seq = line.run.attempts.map((a) => `${a.worker}:${a.role}:r${a.round}:${a.verdict ?? '-'}`);
  assert.deepEqual(seq, ['claude:executar:r1:-', 'codex:revisar:r1:MUDANCAS_NECESSARIAS', 'claude:executar:r2:-', 'codex:revisar:r2:APROVADO']);
  assert.equal(line.run.status, 'done');
  assert.equal(line.run.outcome, 'aprovado');
  assert.equal(store.stats.claude.reprovadas, 1);
  assert.equal(store.stats.claude.aprovadas, 1);
  assert.equal(store.stats.codex.revisoes, 2);
  assert.ok(line.run.log.some((e) => /corrige na etapa 1/.test(e.text)));
});

test('sem ciclo, mudanças pedidas ficam pendentes', async () => {
  const simulated = createSimulatedRunner({ stepMs: 1, decide: () => 'MUDANCAS_NECESSARIAS' });
  const { orch, line } = setup({ runners: { simulated }, line: { loop: { enabled: false, maxRounds: 1 } } });
  await orch.start('l1');
  assert.equal(line.run.attempts.length, 2);
  assert.equal(line.run.outcome, 'mudancas_pendentes');
});

test('orçamento de tokens interrompe a linha', async () => {
  const simulated = createSimulatedRunner({ stepMs: 1, decide: () => 'APROVADO' });
  const { orch, line } = setup({ runners: { simulated }, line: { tokenBudget: 3000 } });
  await orch.start('l1');
  assert.equal(line.run.status, 'budget');
  assert.match(line.run.error, /Orçamento/);
});

test('parar interrompe a etapa atual', async () => {
  const simulated = createSimulatedRunner({ stepMs: 50 });
  const { orch, line } = setup({ runners: { simulated } });
  const p = orch.start('l1');
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(orch.stop('l1'));
  await p;
  assert.equal(line.run.status, 'stopped');
  assert.equal(line.run.attempts.at(-1).status, 'stopped');
  assert.equal(orch.isRunning('l1'), false);
});

test('falha do CLI marca a linha como falha com a mensagem', async () => {
  const failing = () => ({ done: Promise.resolve({ ok: false, finalText: '', usage: { input: 0, cachedInput: 0, output: 0, costUsd: 0 }, error: 'não autenticado' }), kill() {} });
  const dir = tmp();
  const { orch, line, store } = setup({ runners: { claude: failing }, detect: async () => ({ available: true, version: 'x' }), line: { workdir: dir } });
  await orch.detect();
  await orch.start('l1');
  assert.equal(line.run.status, 'failed');
  assert.match(line.run.error, /Claude falhou: não autenticado/);
  assert.equal(store.stats.claude.falhas, 1);
});

test('modo real exige pasta do projeto', async () => {
  const { orch, line } = setup({ detect: async () => ({ available: true, version: 'x' }) });
  await orch.detect();
  await orch.start('l1');
  assert.equal(line.run.status, 'failed');
  assert.match(line.run.error, /pasta do projeto/);
});

test('worktree isolado: executor escreve, revisor recebe o diff com o arquivo novo', async () => {
  const repo = tmp();
  const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'um\n');
  git('add', '.');
  git('commit', '-qm', 'init');

  const prompts = [];
  const ok = (finalText) => ({ done: Promise.resolve({ ok: true, finalText, usage: { input: 10, cachedInput: 0, output: 5, costUsd: 0 } }), kill() {} });
  const claude = ({ cwd, prompt }) => {
    prompts.push(prompt);
    fs.writeFileSync(path.join(cwd, 'novo.js'), 'export const x = 1;\n');
    fs.appendFileSync(path.join(cwd, 'a.txt'), 'dois\n');
    return ok('feito\nRESUMO:\n- criei novo.js');
  };
  const codex = ({ prompt, role }) => {
    prompts.push(prompt);
    assert.equal(role, 'revisar');
    return ok('nada\nRESUMO:\n- ok\nVEREDITO: APROVADO');
  };
  const { orch, line } = setup({ runners: { claude, codex }, detect: async () => ({ available: true, version: 'x' }), line: { workdir: repo, useWorktree: true } });
  await orch.detect();
  await orch.start('l1');

  assert.equal(line.run.status, 'done', line.run.error);
  assert.equal(line.run.outcome, 'aprovado');
  assert.match(line.run.branch, /^ai-office\/l1$/);
  assert.notEqual(line.run.dir, repo);
  assert.ok(!fs.existsSync(path.join(repo, 'novo.js')), 'o projeto original não é tocado');
  const review = prompts[1];
  assert.match(review, /\+export const x = 1;/);
  assert.match(review, /\+dois/);
  assert.match(review, /criei novo\.js/);
});

test('custo: etapa real entra no gasto do dia, simulada não', async () => {
  const usage = { input: 1_000_000, cachedInput: 0, cacheWrite: 0, output: 0, costUsd: 0, model: 'gpt-x' };
  const codex = () => ({ done: Promise.resolve({ ok: true, finalText: 'ok\nVEREDITO: APROVADO', usage }), kill() {} });
  const simulated = createSimulatedRunner({ stepMs: 1, decide: () => 'APROVADO' });
  const dir = tmp();
  const { orch, line, store } = setup({
    runners: { codex, simulated },
    detect: async (bin) => ({ available: bin === 'codex', version: 'x' }),
    line: { workdir: dir, useWorktree: false },
  });
  await orch.detect();
  await orch.start('l1');
  const [exec, review] = line.run.attempts;
  assert.equal(exec.mode, 'simulado');
  assert.equal(review.mode, 'real');
  assert.equal(review.cost, 2); // 1M de entrada × US$ 2 (codex-padrao)
  assert.equal(review.costExact, false);
  const today = Object.values(store.data.costDaily)[0];
  assert.deepEqual(today, { codex: 2 });
  assert.equal(store.stats.claude.costUsd, 0);
});

test('skills sempre ligadas da IA entram no prompt de toda etapa dela', async () => {
  const prompts = [];
  const simulated = createSimulatedRunner({ stepMs: 1, decide: () => 'APROVADO' });
  const spy = (args) => {
    prompts.push([args.worker, args.prompt]);
    return simulated(args);
  };
  const { orch } = setup({ runners: { simulated: spy } });
  await orch.start('l1');
  const [claude, codex] = prompts;
  assert.equal(claude[0], 'claude');
  assert.match(claude[1], /skill: caveman/);
  assert.doesNotMatch(codex[1], /skill: caveman/);
});

test('ciclo com "quem corrige": o Codex corrige no lugar do Claude, com o modelo escolhido', async () => {
  const seen = [];
  const sim = createSimulatedRunner({ stepMs: 1, decide: ({ round }) => (round === 1 ? 'MUDANCAS_NECESSARIAS' : 'APROVADO') });
  const simulated = (args) => {
    seen.push({ worker: args.worker, role: args.role, model: args.config.model, prompt: args.prompt });
    return sim(args);
  };
  const { orch, line } = setup({ runners: { simulated }, line: { loop: { enabled: true, maxRounds: 2, fixer: { worker: 'codex', model: 'gpt-5.5', effort: 'high' } } } });
  await orch.start('l1');
  assert.deepEqual(line.run.attempts.map((a) => `${a.worker}:${a.role}${a.fix ? ':fix' : ''}`), ['claude:executar', 'codex:revisar', 'codex:executar:fix', 'codex:revisar']);
  assert.equal(seen[2].model, 'gpt-5.5');
  assert.match(seen[2].prompt, /Correções pedidas pelo revisor/);
  assert.equal(line.run.outcome, 'aprovado');
  assert.ok(line.run.log.some((e) => /Codex corrige na etapa 1/.test(e.text)));
});

test('mudanças pendentes ficam visíveis e "Corrigir com" aplica e revisa de novo', async () => {
  let fixed = false;
  const sim = createSimulatedRunner({ stepMs: 1, decide: () => (fixed ? 'APROVADO' : 'MUDANCAS_NECESSARIAS') });
  const seen = [];
  const simulated = (args) => {
    seen.push({ worker: args.worker, role: args.role, model: args.config.model, prompt: args.prompt });
    if (args.role === 'executar' && seen.length > 2) fixed = true;
    return sim(args);
  };
  const { orch, line } = setup({ runners: { simulated }, line: { loop: { enabled: false, maxRounds: 1 } } });
  assert.throws(() => orch.start('l1', { fix: { worker: 'claude' } }), /Não há mudanças pendentes/);
  await orch.start('l1');
  assert.equal(line.run.outcome, 'mudancas_pendentes');
  assert.equal(line.run.pending.step, 1);
  assert.equal(line.run.pending.worker, 'codex');
  assert.ok(line.run.pending.findings.length > 10);
  assert.doesNotMatch(line.run.pending.findings, /VEREDITO/);
  await orch.start('l1', { fix: { worker: 'claude', model: 'claude-haiku-5-5', effort: '' } });
  assert.deepEqual(line.run.attempts.map((a) => `${a.worker}:${a.role}${a.fix ? ':fix' : ''}`), ['claude:executar', 'codex:revisar', 'claude:executar:fix', 'codex:revisar']);
  assert.equal(seen[2].model, 'claude-haiku-5-5');
  assert.match(seen[2].prompt, /Correções pedidas pelo revisor \(Codex\)/);
  assert.equal(line.run.round, 2);
  assert.equal(line.run.status, 'done');
  assert.equal(line.run.outcome, 'aprovado');
  assert.equal(line.run.pending, null);
});

test('auditoria sem etapa de execução: "Corrigir com" cria a correção e o auditor confere', async () => {
  const sim = createSimulatedRunner({ stepMs: 1, decide: () => 'MUDANCAS_NECESSARIAS' });
  const { orch, line } = setup({ runners: { simulated: sim }, template: 'auditoria-cruzada' });
  await orch.start('l1');
  const pend = line.run.pending;
  assert.ok(pend);
  await orch.start('l1', { fix: { worker: 'codex' } });
  const last = line.run.attempts.slice(-2);
  assert.deepEqual(last.map((a) => `${a.worker}:${a.role}`), ['codex:executar', `${line.steps[pend.step].worker}:${line.steps[pend.step].role}`]);
  assert.equal(line.run.outcome, 'mudancas_pendentes');
});

test('revisar e corrigir: recebe o diff, edita arquivos e lista o que corrigiu', async () => {
  const seen = [];
  const sim = createSimulatedRunner({ stepMs: 1 });
  const simulated = (args) => {
    seen.push(args);
    return sim(args);
  };
  const { orch, line } = setup({ runners: { simulated }, template: 'claude-faz-codex-revisa-corrige' });
  await orch.start('l1');
  assert.deepEqual(line.run.attempts.map((a) => `${a.worker}:${a.role}:${a.verdict ?? '-'}`), ['claude:executar:-', 'codex:revisar_corrigir:-']);
  assert.equal(line.run.status, 'done');
  const p = seen[1].prompt;
  assert.match(p, /REVISOR-CORRETOR/);
  assert.match(p, /✔ corrigido/);
  assert.doesNotMatch(p, /A ÚLTIMA linha deve ser exatamente `VEREDITO/);
  assert.match(p, /Não precisa de VEREDITO/);
  assert.match(p, /skill: revisao-codigo/);
});
