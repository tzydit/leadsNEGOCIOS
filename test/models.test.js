import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClaudeArgs } from '../server/adapters/claude.js';
import { buildCodexArgs } from '../server/adapters/codex.js';
import { sanitizeLine } from '../server/lines.js';
import { parseCodexCatalog } from '../server/models.js';

test('catálogo do Codex: só modelos visíveis, por prioridade, com níveis de raciocínio', () => {
  const list = parseCodexCatalog({
    models: [
      { slug: 'b', display_name: 'B', priority: 2, visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }], default_reasoning_level: 'low' },
      { slug: 'hidden', priority: 0, visibility: 'hide' },
      { slug: 'a', display_name: 'A', priority: 1, visibility: 'list', supported_reasoning_levels: [] },
      { slug: 'bad slug; rm', priority: 0, visibility: 'list' },
    ],
  });
  assert.deepEqual(list.map((m) => m.id), ['a', 'b']);
  assert.deepEqual(list[1].efforts, ['low', 'high']);
  assert.equal(list[1].defaultEffort, 'low');
});

test('modelo e raciocínio chegam aos dois CLIs', () => {
  const c = buildClaudeArgs({ role: 'executar', config: { model: 'claude-opus-5-5', effort: 'high' } });
  assert.deepEqual(c.slice(c.indexOf('--model'), c.indexOf('--model') + 2), ['--model', 'claude-opus-5-5']);
  assert.deepEqual(c.slice(c.indexOf('--effort'), c.indexOf('--effort') + 2), ['--effort', 'high']);
  const x = buildCodexArgs({ role: 'revisar', cwd: '/p', config: { model: 'gpt-6.1-sol', effort: 'xhigh' } });
  assert.deepEqual(x.slice(x.indexOf('-m'), x.indexOf('-m') + 2), ['-m', 'gpt-6.1-sol']);
  assert.ok(x.includes('model_reasoning_effort=xhigh'));
  const none = buildCodexArgs({ role: 'revisar', cwd: '/p', config: {} });
  assert.ok(!none.includes('-m') && !none.some((a) => a.startsWith('model_reasoning')));
});

test('etapa valida modelo e raciocínio', () => {
  const ok = sanitizeLine({ steps: [{ worker: 'codex', role: 'executar', model: 'gpt-6-astra', effort: 'ultra' }] }, new Set());
  assert.equal(ok.steps[0].model, 'gpt-6-astra');
  assert.equal(ok.steps[0].effort, 'ultra');
  assert.throws(() => sanitizeLine({ steps: [{ worker: 'codex', role: 'executar', model: 'x --dangerously' }] }, new Set()));
  assert.throws(() => sanitizeLine({ steps: [{ worker: 'claude', role: 'executar', effort: 'high"; x' }] }, new Set()));
});
