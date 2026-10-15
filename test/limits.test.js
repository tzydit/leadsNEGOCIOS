import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Limits, parseClaudeRateEvent, parseClaudeUsage, parseCodexLimits, readClaudeUsage, readCodexLimits } from '../server/limits.js';
import { parseClaudeEvent } from '../server/adapters/claude.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-lim-'));

// CLI falso: lê JSON por linha e responde como o CLI de verdade.
function fakeCli(body) {
  const file = path.join(tmp(), 'fake.mjs');
  fs.writeFileSync(file, `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => { const m = JSON.parse(line); ${body} });
`);
  fs.chmodSync(file, 0o755);
  return file;
}

const CLAUDE_USAGE = {
  subscription_type: 'pro',
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 44, resets_at: '2026-10-15T21:20:00Z' },
    seven_day: { utilization: 48, resets_at: '2026-10-18T09:00:00Z' },
    seven_day_opus: null,
  },
};

const CODEX_LIMITS = {
  ordinaryUsageAllowed: true,
  rateLimits: {
    limitId: 'codex',
    primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: 1792000000 },
    secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1792500000 },
    planType: 'plus',
  },
  rateLimitResetCredits: { availableCount: 3, credits: null },
};

test('normaliza o uso do Claude (5h e semana) e do Codex (primária e secundária)', () => {
  const c = parseClaudeUsage(CLAUDE_USAGE);
  assert.equal(c.plan, 'pro');
  assert.deepEqual(c.windows.map((w) => [w.short, w.used]), [['5h', 44], ['sem', 48]]);
  assert.equal(c.windows[0].resetsAt, Date.parse('2026-10-15T21:20:00Z'));
  assert.equal(parseClaudeUsage({ rate_limits_available: false, rate_limits: null }).windows.length, 0);

  const x = parseCodexLimits(CODEX_LIMITS);
  assert.equal(x.plan, 'plus');
  assert.equal(x.resets, 3);
  assert.deepEqual(x.windows.map((w) => [w.label, w.short, w.used]), [['Sessão (5h)', '5h', 3], ['Semana', 'sem', 0]]);
  assert.equal(x.windows[0].resetsAt, 1792000000 * 1000);
});

test('rate_limit_event do stream do Claude vira janela de limite e não vai para o log', () => {
  assert.deepEqual(parseClaudeRateEvent({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.44, resetsAt: 1792000000 }), { id: 'five_hour', label: 'Sessão (5h)', short: '5h', used: 44, resetsAt: 1792000000000 });
  assert.equal(parseClaudeRateEvent({ status: 'allowed' }), null);
  const st = { usage: {}, seen: new Set() };
  const evs = parseClaudeEvent({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'seven_day', utilization: 48 } }, st);
  assert.deepEqual(evs.map((e) => [e.kind, e.win.used]), [['ratelimit', 48]]);
});

test('lê o uso no Claude Code só com pedido de controle (nenhuma mensagem para o modelo)', { skip: process.platform === 'win32' }, async () => {
  const log = path.join(tmp(), 'stdin.log');
  const bin = fakeCli(`
    fs.appendFileSync(${JSON.stringify(log)}, line + '\\n');
    if (process.argv.includes('-p') && m.type === 'control_request' && m.request.subtype === 'get_usage')
      out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: ${JSON.stringify(CLAUDE_USAGE)} } });
  `);
  const r = await readClaudeUsage(bin);
  assert.deepEqual(r.windows.map((w) => w.used), [44, 48]);
  const sent = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(sent.every((m) => m.type === 'control_request'), 'não pode mandar mensagem de usuário');
});

test('Claude antigo sem get_usage: erro claro', { skip: process.platform === 'win32' }, async () => {
  const bin = fakeCli(`out({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: 'Unknown subtype' } });`);
  await assert.rejects(readClaudeUsage(bin), /Unknown subtype/);
});

test('lê os limites do Codex pelo app-server (initialize → account/rateLimits/read)', { skip: process.platform === 'win32' }, async () => {
  const bin = fakeCli(`
    if (process.argv[2] !== 'app-server') process.exit(2);
    if (m.method === 'initialize') out({ id: m.id, result: { userAgent: 'fake' } });
    else if (m.method === 'account/rateLimits/read') out({ id: m.id, result: ${JSON.stringify(CODEX_LIMITS)} });
  `);
  const r = await readCodexLimits(bin);
  assert.deepEqual(r.windows.map((w) => w.used), [3, 0]);
  assert.equal(r.resets, 3);
});

test('Limits: só consulta CLIs reais, guarda erro sem apagar o último valor', async () => {
  let fail = false;
  const store = { settings: { workers: { claude: { bin: 'claude' }, codex: { bin: 'codex' } } } };
  const lim = new Limits({
    store,
    isReal: (w) => w === 'claude',
    readers: {
      claude: async () => {
        if (fail) throw new Error('sem rede');
        return parseClaudeUsage(CLAUDE_USAGE);
      },
      codex: async () => assert.fail('Codex simulado não deve ser consultado'),
    },
  });
  const updates = [];
  lim.on('update', (s) => updates.push(s));
  await lim.refresh();
  assert.equal(lim.state.claude.status, 'ok');
  assert.equal(lim.state.codex.status, 'off');
  fail = true;
  await lim.refresh();
  assert.equal(lim.state.claude.status, 'ok');
  assert.equal(lim.state.claude.windows.length, 2);
  assert.match(lim.state.claude.error, /sem rede/);
  lim.observe('claude', { id: 'five_hour', label: 'Sessão (5h)', short: '5h', used: 60, resetsAt: null });
  assert.equal(lim.state.claude.windows.find((w) => w.id === 'five_hour').used, 60);
  assert.equal(updates.length, 3);
});
