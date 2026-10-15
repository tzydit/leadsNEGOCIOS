import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { MAX_STEPS, TEMPLATES, newLine, sanitizeLine } from './lines.js';
import { ROLES, WORKERS } from './prompts.js';
import { EFFORT_RE, MODEL_RE } from './models.js';
import { sanitizePricing } from './pricing.js';
import { defaultStats, mergeSettings } from './store.js';
import { hostAllowed, localOnly, originAllowed } from './security.js';

/** Monta o app HTTP + WebSocket em volta de um Orchestrator. */
export function createApp({ store, orchestrator, skills, publicDir, billing = null, extraHosts = [] }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(localOnly({ extraHosts }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(publicDir));

  const knownSkills = new Set(skills.map((s) => s.name));
  const getLine = (id) => store.lines.find((l) => l.id === id);
  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      res.status(err.status ?? 400).json({ error: err.message });
    }
  };
  const notFound = () => Object.assign(new Error('Linha não encontrada'), { status: 404 });

  const snapshot = () => ({
    settings: store.settings,
    lines: store.lines,
    stats: store.stats,
    costDaily: store.data.costDaily,
    billing: billing?.state ?? {},
    workers: orchestrator.workersInfo(),
    models: orchestrator.models,
    skills: skills.map(({ name, description }) => ({ name, description })),
    roles: Object.fromEntries(Object.entries(ROLES).map(([k, v]) => [k, { label: v.label, defaultSkills: v.defaultSkills }])),
    templates: Object.fromEntries(Object.entries(TEMPLATES).map(([k, v]) => [k, v.label])),
    running: store.lines.filter((l) => orchestrator.isRunning(l.id)).map((l) => l.id),
    maxSteps: MAX_STEPS,
  });

  app.get('/api/state', (req, res) => res.json(snapshot()));

  app.get('/api/skills/:name', (req, res) => {
    const s = skills.find((k) => k.name === req.params.name);
    if (!s) return res.status(404).json({ error: 'Skill não encontrada' });
    res.json(s);
  });

  app.get('/api/templates/:key', (req, res) => {
    if (!Object.hasOwn(TEMPLATES, req.params.key)) return res.status(404).json({ error: 'Modelo não encontrado' });
    const { steps, loop } = newLine({ id: 'tmp', index: 0, template: req.params.key });
    res.json({ steps, loop });
  });

  app.put('/api/settings', wrap(async (req, res) => {
    const b = req.body ?? {};
    const patch = {};
    if (b.defaultWorkdir !== undefined) patch.defaultWorkdir = String(b.defaultWorkdir).slice(0, 500).trim();
    if (b.diffMaxChars !== undefined) patch.diffMaxChars = Math.min(200000, Math.max(1000, Number(b.diffMaxChars) || 12000));
    if (b.handoffMaxChars !== undefined) patch.handoffMaxChars = Math.min(20000, Math.max(200, Number(b.handoffMaxChars) || 2000));
    if (b.billingPollSeconds !== undefined) patch.billingPollSeconds = Math.min(3600, Math.max(60, Number(b.billingPollSeconds) || 300));
    if (b.pricing !== undefined) patch.pricing = sanitizePricing(b.pricing);
    patch.workers = {};
    for (const w of Object.keys(WORKERS)) {
      const src = b.workers?.[w];
      if (!src) continue;
      const dst = {};
      if (src.mode !== undefined) {
        if (!['auto', 'real', 'simulado'].includes(src.mode)) throw new Error('modo inválido');
        dst.mode = src.mode;
      }
      for (const k of ['bin', 'model', 'effort', 'extraArgs', 'allowedTools']) if (src[k] !== undefined) dst[k] = String(src[k]).slice(0, 1000).trim();
      if (dst.model && !MODEL_RE.test(dst.model)) throw new Error(`modelo inválido: ${dst.model}`);
      if (dst.effort && !EFFORT_RE.test(dst.effort)) throw new Error(`raciocínio inválido: ${dst.effort}`);
      if (src.maxBudgetUsd !== undefined) dst.maxBudgetUsd = Math.max(0, Number(src.maxBudgetUsd) || 0);
      patch.workers[w] = dst;
    }
    store.data.settings = mergeSettings(store.settings, patch);
    store.save();
    await orchestrator.detect();
    if (patch.billingPollSeconds) billing?.start(patch.billingPollSeconds);
    broadcast({ type: 'state', state: snapshot() });
    res.json({ ok: true });
  }));

  app.post('/api/billing/refresh', wrap(async (req, res) => {
    res.json(billing ? await billing.refresh() : {});
  }));

  app.post('/api/lines', wrap(async (req, res) => {
    if (store.lines.length >= 12) throw new Error('Máximo de 12 linhas');
    const id = store.nextId('l');
    const line = newLine({ id, index: store.lines.length + 1, template: req.body?.template });
    store.lines.push(line);
    store.save();
    broadcast({ type: 'state', state: snapshot() });
    res.json(line);
  }));

  app.put('/api/lines/:id', wrap(async (req, res) => {
    const line = getLine(req.params.id);
    if (!line) throw notFound();
    if (orchestrator.isRunning(line.id)) throw Object.assign(new Error('Pare a linha antes de editar'), { status: 409 });
    Object.assign(line, sanitizeLine(req.body ?? {}, knownSkills));
    store.save();
    orchestrator.emit('line', orchestrator.publicLine(line));
    res.json(orchestrator.publicLine(line));
  }));

  app.delete('/api/lines/:id', wrap(async (req, res) => {
    const line = getLine(req.params.id);
    if (!line) throw notFound();
    if (orchestrator.isRunning(line.id)) throw Object.assign(new Error('Pare a linha antes de remover'), { status: 409 });
    store.data.lines = store.lines.filter((l) => l.id !== line.id);
    store.save();
    broadcast({ type: 'state', state: snapshot() });
    res.json({ ok: true });
  }));

  app.post('/api/lines/:id/run', wrap(async (req, res) => {
    const line = getLine(req.params.id);
    if (!line) throw notFound();
    orchestrator.start(line.id);
    broadcast({ type: 'running', running: snapshot().running });
    res.json({ ok: true });
  }));

  app.post('/api/lines/:id/stop', wrap(async (req, res) => {
    res.json({ ok: orchestrator.stop(req.params.id) });
  }));

  app.get('/api/lines/:id/log', wrap(async (req, res) => {
    const line = getLine(req.params.id);
    if (!line) throw notFound();
    res.json(line.run?.log ?? []);
  }));

  app.get('/api/lines/:id/diff', wrap(async (req, res) => {
    const line = getLine(req.params.id);
    if (!line) throw notFound();
    const dir = line.run?.dir;
    if (!dir || !fs.existsSync(dir)) return res.json({ empty: true, message: 'Rode a linha em uma pasta git para ver o diff.' });
    const { getDiff, isGitRepo } = await import('./git.js');
    if (!(await isGitRepo(dir))) return res.json({ empty: true, message: 'A pasta não é um repositório git.' });
    res.json({ ...(await getDiff(dir, line.run.base, 200000)), branch: line.run.branch, dir });
  }));

  app.post('/api/stats/reset', (req, res) => {
    store.data.stats = defaultStats();
    store.save();
    broadcast({ type: 'stats', stats: store.stats });
    res.json({ ok: true });
  });

  app.post('/api/detect', wrap(async (req, res) => {
    await orchestrator.detect();
    broadcast({ type: 'state', state: snapshot() });
    res.json(orchestrator.workersInfo());
  }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'rota não encontrada' }));

  // ---- WebSocket ----------------------------------------------------------
  const wss = new WebSocketServer({ noServer: true });
  const broadcast = (msg) => {
    const data = JSON.stringify(msg);
    for (const c of wss.clients) if (c.readyState === 1) c.send(data);
  };
  wss.on('connection', (ws) => ws.send(JSON.stringify({ type: 'state', state: snapshot() })));
  orchestrator.on('line', (line) => broadcast({ type: 'line', line, running: snapshot().running }));
  orchestrator.on('log', (msg) => broadcast({ type: 'log', ...msg }));
  orchestrator.on('stats', (stats) => broadcast({ type: 'stats', stats, costDaily: store.data.costDaily }));
  billing?.on('update', (state) => broadcast({ type: 'billing', billing: state }));

  const attach = (server) => {
    server.on('upgrade', (req, socket, head) => {
      const okPath = req.url === '/ws';
      if (!okPath || !hostAllowed(req.headers.host, extraHosts) || !originAllowed(req.headers.origin, req.headers.host)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        return socket.destroy();
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });
  };

  return { app, attach, wss, snapshot };
}

export const PUBLIC_DIR = path.resolve(import.meta.dirname, '..', 'public');
