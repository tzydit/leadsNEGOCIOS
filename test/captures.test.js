import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { buildClaudeArgs } from '../server/adapters/claude.js';
import { buildCodexArgs } from '../server/adapters/codex.js';
import { createSimulatedRunner } from '../server/adapters/simulated.js';
import { TEMPLATES, newLine, sanitizeLine } from '../server/lines.js';
import { Orchestrator } from '../server/orchestrator.js';
import { buildPrompt, loadSkills } from '../server/prompts.js';
import { findStaticRoot, resolveInside, serveStatic } from '../server/preview.js';
import { capture, checkUrl, parseSizes, safeName } from '../server/screenshot.js';
import { Store } from '../server/store.js';

const skills = loadSkills(path.resolve(import.meta.dirname, '..', 'skills'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-shot-'));

test('validações da captura', () => {
  assert.equal(checkUrl('http://localhost:5173'), 'http://localhost:5173/');
  assert.throws(() => checkUrl('file:///etc/passwd'));
  assert.throws(() => checkUrl('javascript:alert(1)'));
  assert.deepEqual(parseSizes('mobile,desktop,mobile'), ['mobile', 'desktop']);
  assert.throws(() => parseSizes('4k'));
  assert.equal(safeName('../Etapa 1!'), 'etapa-1');
});

test('preview da linha: só http(s) e modelo de front-end com capturas', () => {
  assert.deepEqual(sanitizeLine({ preview: { url: 'http://localhost:3000', command: 'npm run dev' } }, new Set()).preview, { url: 'http://localhost:3000', command: 'npm run dev' });
  assert.throws(() => sanitizeLine({ preview: { url: 'file:///x' } }, new Set()));
  const steps = TEMPLATES['frontend-com-capturas'].steps();
  assert.ok(steps.every((s) => s.skills.includes('captura-tela')));
  assert.ok(steps[0].skills.includes('frontend-design'));
});

test('prompt troca o comando da skill e lista as capturas e os problemas', () => {
  const p = buildPrompt({
    line: { name: 'L' },
    step: { role: 'executar', worker: 'claude', instruction: 'tela de login', skills: ['captura-tela'] },
    stepIndex: 0,
    totalSteps: 1,
    skills,
    round: 1,
    capture: { cmd: 'node "/x/screenshot.js" --out "/c/l1"', url: 'http://localhost:5173', files: ['/c/l1/etapa1-r1-desktop.png'], problems: ['rolagem horizontal de 40px em mobile'] },
  });
  assert.doesNotMatch(p, /\{\{CAPTURA_CMD\}\}/);
  assert.match(p, /node "\/x\/screenshot\.js" --out "\/c\/l1" <url> --name/);
  assert.match(p, /Site de preview: http:\/\/localhost:5173/);
  assert.match(p, /- \/c\/l1\/etapa1-r1-desktop\.png/);
  assert.match(p, /rolagem horizontal de 40px/);
});

test('permissões: Claude libera só o comando de captura; Codex recebe as imagens', () => {
  const shots = { rule: 'Bash(node "/x/screenshot.js":*)', dirs: ['/c/l1'], images: ['/c/l1/a-desktop.png', '/c/l1/a-mobile.png'] };
  for (const role of ['executar', 'revisar']) {
    const a = buildClaudeArgs({ role, config: { screenshots: shots } });
    assert.ok(a.includes('Bash(node "/x/screenshot.js":*)'), role);
    assert.ok(a.includes('/c/l1'), role);
  }
  const exec = buildCodexArgs({ role: 'executar', cwd: '/p', config: { screenshots: shots } });
  assert.deepEqual(exec.filter((x, i) => exec[i - 1] === '-i'), shots.images);
  assert.ok(exec.includes('sandbox_workspace_write.network_access=true'));
  const review = buildCodexArgs({ role: 'revisar', cwd: '/p', config: { screenshots: shots } });
  assert.ok(review.includes('-i') && !review.includes('sandbox_workspace_write.network_access=true'));
  assert.equal(review.at(-1), '-');
});

test('orquestrador: sobe o site, captura antes da etapa com a skill e deixa o site no ar no fim', async () => {
  const port = 41000 + Math.floor(Math.random() * 2000);
  const calls = [];
  const fakeCapture = async ({ url, outDir, name }) => {
    calls.push({ url, name });
    const file = path.join(outDir, `${name}-desktop.png`);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(file, 'png');
    return { files: [{ size: 'desktop', path: file, width: 1440, height: 900 }], problems: ['console: falha'], via: 'teste' };
  };
  const prompts = [];
  const simulated = createSimulatedRunner({ stepMs: 1, decide: () => 'APROVADO' });
  const spy = (args) => {
    prompts.push(args.prompt);
    return simulated(args);
  };
  const store = new Store(null);
  const data = tmp();
  const orch = new Orchestrator({ store, skills, worktreesDir: path.join(data, 'wt'), capturesDir: path.join(data, 'cap'), runners: { simulated: spy }, detect: async () => ({ available: false }), capture: fakeCapture });
  const line = Object.assign(newLine({ id: 'l1', index: 1, template: 'frontend-com-capturas' }), {
    workdir: tmp(),
    preview: { url: `http://127.0.0.1:${port}/`, command: `node -e "require('http').createServer((q,s)=>s.end('ok')).listen(${port})"` },
  });
  line.steps[1].skills = line.steps[1].skills.filter((s) => s !== 'captura-tela');
  store.lines.push(line);
  await orch.detect();
  await orch.start('l1');
  assert.equal(line.run.status, 'done', line.run.error);
  assert.deepEqual(calls.map((c) => c.name), ['etapa1-r1']);
  assert.deepEqual(line.run.attempts[0].captures, ['etapa1-r1-desktop.png']);
  assert.match(prompts[0], /etapa1-r1-desktop\.png/);
  assert.doesNotMatch(prompts[1], /Capturas de tela/);
  assert.ok(line.run.log.some((e) => /Site no ar/.test(e.text)));
  // terminou a última validação: o site continua no ar para conferir
  assert.equal(orch.publicLine(line).previewUrl, `http://127.0.0.1:${port}/`);
  assert.ok(line.run.log.some((e) => /Veja como ficou/.test(e.text)));
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'ok');
  // desligar (fechar o AI Office) derruba o site
  await orch.stopAll();
  await new Promise((r) => setTimeout(r, 300));
  await assert.rejects(fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) }));
  assert.equal(orch.publicLine(line).previewUrl, null);
});

test('preview estático: serve a pasta com index.html, sem sair dela nem mostrar ocultos', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>oi</h1>');
  fs.writeFileSync(path.join(dir, 'script.js'), 'console.log(1)');
  fs.writeFileSync(path.join(dir, '.env'), 'SEGREDO=1');
  assert.equal(findStaticRoot(dir), dir);
  assert.equal(findStaticRoot(tmp()), null);
  assert.equal(resolveInside(dir, '/../x'), null);
  assert.equal(resolveInside(dir, '/%2e%2e/x'), null);
  assert.equal(resolveInside(dir, '/.env'), null);
  assert.equal(resolveInside(dir, '/a/./b.js'), null);
  assert.equal(resolveInside(dir, '/js/app.js?v=1'), path.join(dir, 'js', 'app.js'));
  const srv = await serveStatic(dir);
  try {
    assert.match(srv.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const home = await fetch(srv.url);
    assert.equal(await home.text(), '<h1>oi</h1>');
    assert.match(home.headers.get('content-type'), /text\/html/);
    assert.match((await fetch(`${srv.url}script.js`)).headers.get('content-type'), /javascript/);
    assert.equal((await fetch(`${srv.url}.env`)).status, 404);
    assert.equal((await fetch(`${srv.url}nada.css`)).status, 404);
    assert.equal((await fetch(srv.url, { method: 'POST' })).status, 405);
  } finally {
    srv.stop();
  }
});

test('orquestrador: sem comando nem URL, sobe servidor estático e o botão reabre depois', async () => {
  const store = new Store(null);
  const data = tmp();
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'index.html'), 'site');
  const orch = new Orchestrator({ store, skills, worktreesDir: path.join(data, 'wt'), capturesDir: path.join(data, 'cap'), runners: { simulated: createSimulatedRunner({ stepMs: 1, decide: () => 'APROVADO' }) }, detect: async () => ({ available: false }) });
  const line = Object.assign(newLine({ id: 'l2', index: 1, template: 'claude-faz-codex-revisa' }), { workdir: dir, useWorktree: false });
  store.lines.push(line);
  await orch.detect();
  await orch.start('l2');
  const url = orch.publicLine(line).previewUrl;
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.equal(await (await fetch(url)).text(), 'site');
  orch.stopPreview('l2');
  assert.equal(orch.publicLine(line).previewUrl, null);
  const again = await orch.openPreview('l2');
  assert.equal(await (await fetch(again)).text(), 'site');
  await orch.stopAll();
  await assert.rejects(orch.openPreview('nao-existe'));
});

const chromium = process.env.CHROME_PATH || ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));
test('captura real no navegador (desktop e celular, com problemas detectados)', { skip: !chromium && 'sem navegador neste ambiente' }, async () => {
  const server = http.createServer((req, res) => {
    if (req.url !== '/') return res.writeHead(404).end();
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><meta name=viewport content="width=device-width"><body style="margin:0"><div style="width:600px;height:50px;background:#c33"></div><img src="/x.png"><script>console.error("ops")</script>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const out = tmp();
    const r = await capture({ url: `http://127.0.0.1:${server.address().port}/`, outDir: out, name: 'home', chromePath: chromium, waitMs: 100 });
    assert.deepEqual(r.files.map((f) => f.size), ['desktop', 'mobile']);
    for (const f of r.files) assert.ok(fs.statSync(f.path).size > 500);
    assert.ok(r.problems.some((p) => /ops/.test(p)));
    assert.ok(r.problems.some((p) => /HTTP 404/.test(p)));
    assert.ok(r.problems.some((p) => /rolagem horizontal de \d+px em mobile/.test(p)));
  } finally {
    server.close();
  }
});
