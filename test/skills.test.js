import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildClaudeArgs } from '../server/adapters/claude.js';
import { buildPrompt, loadSkills, parseFrontmatter } from '../server/prompts.js';

const SKILLS_DIR = path.resolve(import.meta.dirname, '..', 'skills');
const skills = loadSkills(SKILLS_DIR);

test('frontmatter: aspas, blocos dobrados e campos aninhados', () => {
  const a = parseFrontmatter('---\nname: "security-best-practices"\ndescription: "Faz X"\n---\ncorpo');
  assert.equal(a.meta.name, 'security-best-practices');
  assert.equal(a.meta.description, 'Faz X');
  assert.equal(a.body, 'corpo');
  const b = parseFrontmatter('---\nname: caveman\ndescription: >\n  linha um\n  linha dois\nmetadata:\n  author: x\n---\nok');
  assert.equal(b.meta.description, 'linha um linha dois');
  assert.equal(b.meta.name, 'caveman');
});

test('as melhores do GitHub carregam com origem, licença e destaque', () => {
  const best = skills.filter((s) => s.melhor);
  assert.deepEqual(best.map((s) => s.name).sort(), [
    'accessibility', 'caveman', 'core-web-vitals', 'differential-review', 'frontend-design', 'performance',
    'security-best-practices', 'security-threat-model', 'sharp-edges', 'vercel-react-best-practices',
  ]);
  for (const s of best) {
    assert.ok(['frontend', 'seguranca', 'geral'].includes(s.categoria), s.name);
    assert.match(s.url, /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/tree\/[0-9a-f]{40}\//, s.name);
    assert.ok(s.licenca && s.autor !== 'AI Office', s.name);
    assert.ok(s.description.length > 20 && s.porque.length > 20, s.name);
  }
  // as melhores aparecem primeiro
  assert.ok(skills.findIndex((s) => !s.melhor) >= best.length);
});

test('cópias do GitHub são só texto e trazem a licença', () => {
  const root = path.join(SKILLS_DIR, 'github');
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    const files = fs.readdirSync(dir, { recursive: true }).map(String);
    assert.ok(files.some((f) => /^LICENSE/.test(f)), `${name} sem licença`);
    const exec = files.filter((f) => /\.(py|sh|js|mjs|ts|exe|bat|ps1)$/.test(f));
    assert.deepEqual(exec, [], `${name} tem executáveis`);
  }
});

test('prompt aponta os arquivos de apoio e o Claude ganha acesso de leitura a eles', () => {
  const p = buildPrompt({
    line: { name: 'L' },
    step: { role: 'auditar', worker: 'claude', instruction: 'audite', skills: ['security-best-practices'] },
    stepIndex: 0,
    totalSteps: 1,
    skills,
    round: 1,
  });
  assert.match(p, /skill: security-best-practices/);
  assert.match(p, new RegExp(`Arquivos de apoio[^\\n]*${path.join('skills', 'github', 'security-best-practices').replace(/[\\/]/g, '.')}`));
  const args = buildClaudeArgs({ role: 'auditar', config: { skillsDir: SKILLS_DIR } });
  assert.deepEqual(args.slice(args.indexOf('--add-dir'), args.indexOf('--add-dir') + 2), ['--add-dir', SKILLS_DIR]);
  assert.ok(!buildClaudeArgs({ role: 'auditar', config: {} }).includes('--add-dir'));
});

test('com várias skills, o prompt diz como resolver conflitos entre elas', () => {
  const base = { line: { name: 'L' }, stepIndex: 0, totalSteps: 1, skills, round: 1 };
  const one = buildPrompt({ ...base, step: { role: 'revisar', worker: 'codex', instruction: 'x', skills: ['economia-tokens'] } });
  assert.doesNotMatch(one, /Se conflitarem/);
  const many = buildPrompt({ ...base, step: { role: 'revisar', worker: 'codex', instruction: 'x', skills: ['economia-tokens', 'differential-review'] } });
  assert.match(many, /Se conflitarem: o papel e o "Formato da resposta"/);
  assert.match(many, /não grave relatórios em arquivo/);
  assert.ok(many.indexOf('Se conflitarem') < many.indexOf('skill: economia-tokens'));
});

test('caveman fica sempre ligado no Claude e o Claude roda sem os MCPs do usuário', async () => {
  const { DEFAULT_SETTINGS } = await import('../server/store.js');
  assert.deepEqual(DEFAULT_SETTINGS.workers.claude.alwaysSkills, ['caveman']);
  assert.deepEqual(DEFAULT_SETTINGS.workers.codex.alwaysSkills, []);
  const args = buildClaudeArgs({ role: 'executar', config: {} });
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(!buildClaudeArgs({ role: 'executar', config: { loadMcp: true } }).includes('--strict-mcp-config'));
  // comandos de checagem que antes travavam a etapa por falta de permissão
  for (const r of ['Bash(node --check:*)', 'Bash(grep:*)', 'PowerShell(node --check:*)', 'PowerShell(git status:*)', 'Bash(npm test:*)']) assert.ok(args.includes(r), r);
  const ro = buildClaudeArgs({ role: 'revisar', config: {} });
  assert.ok(ro.includes('Bash(grep:*)') && !ro.includes('Bash(npm run:*)'));
});
