import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createApp, PUBLIC_DIR } from '../server/app.js';
import { Orchestrator } from '../server/orchestrator.js';
import { loadSkills } from '../server/prompts.js';
import { hostAllowed, originAllowed } from '../server/security.js';
import { Store } from '../server/store.js';

test('hostAllowed e originAllowed', () => {
  assert.ok(hostAllowed('localhost:4317'));
  assert.ok(hostAllowed('127.0.0.1:4317'));
  assert.ok(!hostAllowed('evil.com'));
  assert.ok(!hostAllowed(undefined));
  assert.ok(originAllowed(undefined, 'localhost:1'));
  assert.ok(originAllowed('http://localhost:1', 'localhost:1'));
  assert.ok(!originAllowed('http://evil.com', 'localhost:1'));
});

test('API recusa DNS rebinding, origem estranha e corpo não-JSON', async (t) => {
  const store = new Store(null);
  const skills = loadSkills(path.resolve(import.meta.dirname, '..', 'skills'));
  const orch = new Orchestrator({ store, skills, worktreesDir: '/tmp/x', detect: async () => ({ available: false }) });
  await orch.detect();
  const { app, attach } = createApp({ store, orchestrator: orch, skills, publicDir: PUBLIC_DIR });
  const server = app.listen(0, '127.0.0.1');
  attach(server);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  assert.equal((await fetch(`${base}/api/state`)).status, 200);
  // fetch não deixa trocar o Host; http.request deixa (é o que um ataque de DNS rebinding produz)
  const rebinding = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/state', headers: { Host: 'evil.com' } }, (res) => resolve(res.statusCode));
  });
  assert.equal(rebinding, 403);
  const cross = await fetch(`${base}/api/lines`, { method: 'POST', headers: { Origin: 'http://evil.com', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(cross.status, 403);
  const form = await fetch(`${base}/api/lines`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(form.status, 415);

  const created = await (await fetch(`${base}/api/lines`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ template: '__proto__' }) })).json();
  assert.equal(created.steps.length, 2);
  const bad = await fetch(`${base}/api/lines/${created.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ steps: [{ worker: 'gpt', role: 'executar' }] }) });
  assert.equal(bad.status, 400);
  const tpl = await fetch(`${base}/api/templates/constructor`);
  assert.equal(tpl.status, 404);
});
