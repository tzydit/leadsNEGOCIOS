import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClaudeArgs, parseClaudeEvent, splitTools } from '../server/adapters/claude.js';
import { buildCodexArgs, parseCodexEvent } from '../server/adapters/codex.js';
import { emptyUsage } from '../server/adapters/common.js';
import { splitArgs } from '../server/proc.js';

const claudeState = () => ({ usage: emptyUsage(), seen: new Set(), lastText: '', finalText: '', error: null, finished: false });

test('Claude: ferramentas viram atividades legíveis e o uso é contado uma vez por mensagem', () => {
  const st = claudeState();
  const msg = (content) => ({ type: 'assistant', message: { id: 'm1', content, usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 } } });
  const ev1 = parseClaudeEvent(msg([{ type: 'tool_use', name: 'Edit', input: { file_path: '/a/b/routes.js' } }]), st);
  const ev2 = parseClaudeEvent(msg([{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }]), st);
  assert.deepEqual(ev1, [{ kind: 'file', text: 'Editando routes.js' }]);
  assert.deepEqual(ev2, [{ kind: 'command', text: '$ npm test' }]);
  assert.equal(st.usage.input, 100);
  assert.equal(st.usage.cachedInput, 90);
});

test('Claude: evento result define texto final, uso total e custo', () => {
  const st = claudeState();
  parseClaudeEvent({ type: 'result', subtype: 'success', is_error: false, result: 'feito\nRESUMO:\n- x', total_cost_usd: 0.12, usage: { input_tokens: 3, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 50 } }, st);
  assert.equal(st.finalText, 'feito\nRESUMO:\n- x');
  assert.deepEqual(st.usage, { input: 1203, cachedInput: 1000, cacheWrite: 200, output: 50, costUsd: 0.12, model: '' });
  assert.equal(st.error, null);
});

test('Claude: revisor roda somente leitura, executor com acceptEdits', () => {
  const ro = buildClaudeArgs({ role: 'revisar', config: { model: 'sonnet', allowedTools: 'Bash(rm:*)' } });
  assert.ok(ro.includes('dontAsk'));
  assert.ok(!ro.includes('Bash(rm:*)'));
  assert.deepEqual(ro.slice(ro.indexOf('--model'), ro.indexOf('--model') + 2), ['--model', 'sonnet']);
  const rw = buildClaudeArgs({ role: 'executar', config: { allowedTools: 'Bash(npm test:*) "Bash(git diff:*)"' } });
  assert.ok(rw.includes('acceptEdits'));
  assert.ok(rw.includes('Bash(npm test:*)') && rw.includes('Bash(git diff:*)'));
});

test('Codex: itens do exec --json viram eventos e uso é somado', () => {
  const st = { usage: emptyUsage(), lastText: '', error: null, finished: false };
  assert.deepEqual(parseCodexEvent({ type: 'item.started', item: { type: 'command_execution', command: "bash -lc 'npm test'" } }, st), [{ kind: 'command', text: '$ npm test' }]);
  assert.deepEqual(parseCodexEvent({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'src/a.ts', kind: 'update' }, { path: 'b.ts', kind: 'add' }] } }, st), [
    { kind: 'file', text: 'Editando a.ts' },
    { kind: 'file', text: 'Criando b.ts' },
  ]);
  parseCodexEvent({ type: 'item.completed', item: { type: 'agent_message', text: 'ok\nVEREDITO: APROVADO' } }, st);
  parseCodexEvent({ type: 'turn.completed', usage: { input_tokens: 5000, cached_input_tokens: 4000, output_tokens: 300 } }, st);
  assert.equal(st.lastText, 'ok\nVEREDITO: APROVADO');
  assert.deepEqual(st.usage, { input: 5000, cachedInput: 4000, cacheWrite: 0, output: 300, costUsd: 0, model: '' });
  parseCodexEvent({ type: 'turn.failed', error: { message: 'quota' } }, st);
  assert.equal(st.error, 'quota');
});

test('Codex: sandbox depende do papel e o prompt vai por stdin', () => {
  const ro = buildCodexArgs({ role: 'auditar', cwd: '/p', config: {} });
  assert.deepEqual(ro.slice(ro.indexOf('--sandbox'), ro.indexOf('--sandbox') + 2), ['--sandbox', 'read-only']);
  assert.equal(ro.at(-1), '-');
  const rw = buildCodexArgs({ role: 'executar', cwd: '/p', config: { model: 'gpt-5-codex' } });
  assert.ok(rw.includes('workspace-write'));
  assert.ok(rw.includes('gpt-5-codex'));
});

test('splitTools não quebra padrões com espaço dentro de parênteses', () => {
  assert.deepEqual(splitTools('Bash(npm test:*) Read, "Bash(git diff:*)"'), ['Bash(npm test:*)', 'Read', 'Bash(git diff:*)']);
});

test('splitArgs respeita aspas', () => {
  assert.deepEqual(splitArgs(`a "b c" 'd e' f`), ['a', 'b c', 'd e', 'f']);
  assert.deepEqual(splitArgs(''), []);
});
