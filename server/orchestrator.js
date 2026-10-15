import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { runClaude } from './adapters/claude.js';
import { runCodex } from './adapters/codex.js';
import { createSimulatedRunner } from './adapters/simulated.js';
import { clip } from './adapters/common.js';
import { ensureWorktree, getDiff, headCommit, isGitRepo } from './git.js';
import { buildPrompt, DIFF_ROLES, EDIT_ROLES, extractFindings, extractSummary, parseVerdict, VERDICT_ROLES, WORKERS } from './prompts.js';
import { detectCli, startProcess, waitForUrl } from './proc.js';
import { capture as chromeCapture } from './screenshot.js';
import { findStaticRoot, serveStatic } from './preview.js';
import { attemptCost, priceFor } from './pricing.js';
import { CLAUDE_MODELS, CODEX_FALLBACK, loadCodexModels } from './models.js';

const LOG_LIMIT = 400;
const total = (u) => (u?.input ?? 0) + (u?.output ?? 0);

/**
 * Executa as linhas de trabalho. Cada linha roda suas etapas em sequência;
 * linhas diferentes rodam em paralelo (cada uma no seu worktree).
 */
export class Orchestrator extends EventEmitter {
  constructor({ store, skills, skillsDir = null, worktreesDir, capturesDir = path.join(worktreesDir, '..', 'capturas'), runners = {}, detect = detectCli, loadModels = loadCodexModels, capture = chromeCapture }) {
    super();
    this.store = store;
    this.skills = skills;
    this.skillsDir = skillsDir;
    this.capturesDir = capturesDir;
    this.captureFn = capture;
    this.screenshotScript = path.resolve(import.meta.dirname, '..', 'scripts', 'screenshot.js');
    this.worktreesDir = worktreesDir;
    this.real = { claude: runners.claude ?? runClaude, codex: runners.codex ?? runCodex };
    this.simulated = runners.simulated ?? createSimulatedRunner();
    this.detectFn = detect;
    this.loadModels = loadModels;
    this.models = { claude: { models: CLAUDE_MODELS, source: 'lista' }, codex: { models: [], source: 'nenhum' } };
    this.cli = { claude: { available: false }, codex: { available: false } };
    this.active = new Map(); // lineId -> { kill, stopped }
    this.previews = new Map(); // lineId -> { url, stop } do site no ar
    this.throttle = new Map();
  }

  async detect() {
    const s = this.store.settings.workers;
    const [claude, codex] = await Promise.all([this.detectFn(s.claude.bin || 'claude'), this.detectFn(s.codex.bin || 'codex')]);
    this.cli = { claude, codex };
    // A lista do Codex vem do próprio CLI; sem ele, uma lista salva.
    this.models.codex = codex.available ? await this.loadModels(s.codex.bin || 'codex') : { models: CODEX_FALLBACK, source: 'fallback' };
    return this.workersInfo();
  }

  modeOf(worker) {
    const mode = this.store.settings.workers[worker]?.mode ?? 'auto';
    if (mode === 'auto') return this.cli[worker]?.available ? 'real' : 'simulado';
    return mode;
  }

  workersInfo() {
    const out = {};
    for (const w of Object.keys(WORKERS)) out[w] = { ...this.cli[w], mode: this.modeOf(w), setting: this.store.settings.workers[w]?.mode ?? 'auto' };
    return out;
  }

  isRunning(lineId) {
    return this.active.has(lineId);
  }

  // ---- notificações -------------------------------------------------------

  publicLine(line) {
    const previewUrl = this.previews.get(line.id)?.url ?? null;
    if (!line.run) return { ...line, previewUrl };
    const { log, ...run } = line.run;
    return { ...line, run, previewUrl };
  }

  touch(line, immediate = false) {
    this.store.save();
    const send = () => {
      this.throttle.delete(line.id);
      this.emit('line', this.publicLine(line));
    };
    if (immediate) {
      clearTimeout(this.throttle.get(line.id));
      return send();
    }
    if (!this.throttle.has(line.id)) this.throttle.set(line.id, setTimeout(send, 250));
  }

  log(line, entry) {
    if (!line.run) return;
    const e = { t: Date.now(), ...entry };
    line.run.log.push(e);
    if (line.run.log.length > LOG_LIMIT) line.run.log.splice(0, line.run.log.length - LOG_LIMIT);
    this.emit('log', { lineId: line.id, entry: e });
  }

  // ---- execução -----------------------------------------------------------

  async resolveDir(line) {
    const dir = (line.workdir || this.store.settings.defaultWorkdir || '').trim();
    const allSimulated = line.steps.every((s) => this.modeOf(s.worker) === 'simulado');
    if (!dir) {
      if (allSimulated) return { dir: null, git: false };
      throw new Error('Defina a pasta do projeto (na linha ou nas configurações).');
    }
    const abs = path.resolve(dir);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`Pasta não encontrada: ${abs}`);
    const git = await isGitRepo(abs);
    if (line.useWorktree && git) {
      const wtPath = path.join(this.worktreesDir, line.id);
      const branch = `ai-office/${line.id}`;
      const wt = await ensureWorktree(abs, wtPath, branch);
      if (wt.created) line.baseCommit = wt.base;
      return { dir: wt.path, git: true, branch, base: line.baseCommit ?? (await headCommit(wt.path)), notice: wt.created ? `Worktree criado no branch ${branch}` : `Continuando no worktree do branch ${branch}` };
    }
    return {
      dir: abs,
      git,
      base: git ? await headCommit(abs) : null,
      notice: line.useWorktree && !git ? 'A pasta não é um repositório git: rodando direto nela, sem worktree e sem diff.' : null,
    };
  }

  /** Mudanças que ficaram pendentes na última execução (o que o revisor pediu). */
  pendingOf(run) {
    if (run?.status !== 'done' || run.outcome !== 'mudancas_pendentes') return null;
    if (run.pending) return run.pending;
    const a = [...(run.attempts ?? [])].reverse().find((x) => x.verdict === 'MUDANCAS_NECESSARIAS');
    return a ? { step: a.step, worker: a.worker, findings: a.findings ?? extractFindings(a.finalText) } : null;
  }

  /** Roda a linha. Com fix = { worker, model, effort }, só aplica as mudanças pendentes. */
  start(lineId, { fix = null } = {}) {
    const line = this.store.lines.find((l) => l.id === lineId);
    if (!line) throw new Error('Linha não encontrada');
    if (this.active.has(lineId)) throw new Error('A linha já está rodando');
    if (!line.steps.length) throw new Error('A linha não tem etapas');
    const prev = line.run;
    const pending = fix ? this.pendingOf(prev) : null;
    if (fix && !pending) throw new Error('Não há mudanças pendentes para corrigir');
    if (fix && !WORKERS[fix.worker]) throw new Error('Escolha quem vai corrigir');
    if (pending && !line.steps[pending.step]) throw new Error('As etapas mudaram: rode a linha de novo');
    const ctl = { kill: null, stopped: false };
    this.active.set(lineId, ctl);
    line.run = {
      status: 'running', startedAt: Date.now(), endedAt: null, round: fix ? (prev.round ?? 1) + 1 : 1, current: 0,
      attempts: fix ? prev.attempts : [], log: [], dir: null, branch: null, base: null, notice: null, error: null, outcome: null, pending: null,
    };
    this.touch(line, true);
    const p = this.execute(line, ctl, fix ? { fixer: fix, pending } : null)
      .catch((err) => {
        line.run.status = 'failed';
        line.run.error = err.message;
        this.log(line, { kind: 'error', text: err.message });
      })
      .finally(() => {
        line.run.endedAt = Date.now();
        this.active.delete(lineId);
        this.touch(line, true);
        this.store.save();
        this.emit('stats', this.store.stats);
      });
    ctl.promise = p;
    return p;
  }

  stop(lineId) {
    const ctl = this.active.get(lineId);
    if (!ctl) return false;
    ctl.stopped = true;
    ctl.kill?.();
    return true;
  }

  async execute(line, ctl, fix = null) {
    const run = line.run;
    const where = await this.resolveDir(line);
    run.dir = where.dir;
    run.branch = where.branch ?? null;
    run.base = where.base ?? null;
    run.notice = where.notice ?? null;
    if (where.notice) this.log(line, { kind: 'info', text: where.notice });

    // Duas linhas sem worktree na mesma pasta se atropelariam.
    if (where.dir) {
      for (const other of this.store.lines) {
        if (other.id !== line.id && this.active.has(other.id) && other.run?.dir === where.dir) {
          throw new Error(`A pasta já está em uso pela linha "${other.name}". Ative o worktree ou espere ela terminar.`);
        }
      }
    }

    let preview = null;
    try {
      preview = await this.ensurePreview(line, where.dir);
    } catch (err) {
      this.log(line, { kind: 'error', text: `🌐 preview não subiu: ${err.message}` });
    }
    let ok = false;
    try {
      if (fix) await this.runFix(line, ctl, where, fix);
      else await this.runSteps(line, ctl, where);
      ok = line.run.status === 'done';
    } finally {
      // Terminou a última validação: o site fica no ar para você conferir.
      if (!ok) this.stopPreview(line.id);
      else if (preview?.url) this.log(line, { kind: 'info', text: `✅ Pronto! Veja como ficou: ${preview.url}` });
    }
  }

  // ---- capturas de tela -------------------------------------------------

  captureDir(line) {
    return path.join(this.capturesDir, line.id);
  }

  /** Comando que as IAs usam para capturar; o mesmo prefixo é liberado no Claude. */
  captureCmd(line) {
    return `node "${this.screenshotScript}" --out "${this.captureDir(line)}"`;
  }

  /**
   * Sobe (ou reaproveita) o site da linha: o comando do projeto, a URL que você
   * já roda, ou um servidor estático em 127.0.0.1 se a pasta tiver index.html.
   */
  async ensurePreview(line, dir) {
    const { url, command } = line.preview ?? {};
    const key = `${dir}|${command}|${url}`;
    const cur = this.previews.get(line.id);
    if (cur && cur.key === key && !cur.proc?.exited) return cur;
    this.stopPreview(line.id);
    let p = null;
    if (command && dir) {
      this.log(line, { kind: 'info', text: `🌐 Subindo o site: ${command}` });
      const proc = startProcess(command, { cwd: dir });
      p = { key, url: url || null, proc, stop: () => proc.stop() };
      if (url && !(await waitForUrl(url, 90000, () => proc.exited))) {
        this.log(line, { kind: 'error', text: `O site não respondeu em ${url}. ${proc.tail()}` });
        proc.stop();
        return null;
      }
    } else if (url) {
      p = { key, url, stop: () => {} };
    } else {
      const root = findStaticRoot(dir);
      if (!root) return null;
      const srv = await serveStatic(root);
      p = { key, url: srv.url, stop: srv.stop };
    }
    this.previews.set(line.id, p);
    if (p.url) this.log(line, { kind: 'info', text: `🌐 Site no ar em ${p.url}` });
    return p;
  }

  stopPreview(lineId) {
    const p = this.previews.get(lineId);
    if (!p) return false;
    this.previews.delete(lineId);
    p.stop();
    return true;
  }

  /** Botão "Ver resultado": sobe o preview da última pasta usada pela linha. */
  async openPreview(lineId) {
    const line = this.store.lines.find((l) => l.id === lineId);
    if (!line) throw Object.assign(new Error('Linha não encontrada'), { status: 404 });
    const base = line.run?.dir || (line.workdir || this.store.settings.defaultWorkdir || '').trim();
    if (!base) throw new Error('Defina a pasta do projeto');
    const p = await this.ensurePreview(line, path.resolve(base));
    if (!p?.url) throw new Error('Nada para abrir: a pasta não tem index.html e a linha não tem URL de preview');
    this.touch(line, true);
    return p.url;
  }

  /** Captura desktop e celular da URL de preview no Chrome. */
  async captureFor(line, name) {
    const url = this.previews.get(line.id)?.url ?? line.preview?.url;
    if (!url) return { files: [], problems: [], error: null };
    try {
      const r = await this.captureFn({ url, outDir: this.captureDir(line), name, chromePath: this.store.settings.chromePath || undefined });
      this.log(line, { kind: 'info', text: `📸 ${r.files.map((f) => `${f.size} ${path.basename(f.path)}`).join(' · ')} (${r.via})` });
      for (const p of r.problems) this.log(line, { kind: 'error', text: `navegador: ${p}` });
      return r;
    } catch (err) {
      this.log(line, { kind: 'error', text: `📸 captura falhou: ${err.message.split('\n')[0]}` });
      return { files: [], problems: [], error: err.message.split('\n')[0] };
    }
  }

  async runSteps(line, ctl, where) {
    const run = line.run;
    let i = 0;
    let previous = null;
    let feedback = null;
    while (i < line.steps.length) {
      if (ctl.stopped) break;
      run.current = i;
      // Voltando com correções: quem corrige pode ser outra IA/modelo (loop.fixer).
      const fixing = Boolean(feedback && EDIT_ROLES.has(line.steps[i].role));
      const step = fixing ? this.fixerStep(line, line.steps[i]) : line.steps[i];
      const { attempt, stop } = await this.runAttempt(line, ctl, where, step, i, { previous, feedback: fixing ? feedback : null, fix: fixing });
      if (fixing) feedback = null;
      if (stop === 'stopped') break;
      if (stop) return;
      this.countVerdict(run, step, attempt);

      if (attempt.verdict === 'MUDANCAS_NECESSARIAS') {
        let back = -1;
        for (let j = i - 1; j >= 0; j--) if (EDIT_ROLES.has(line.steps[j].role)) { back = j; break; }
        if (line.loop?.enabled && back >= 0 && run.round < line.loop.maxRounds) {
          run.round += 1;
          feedback = { worker: step.worker, text: attempt.findings };
          const fx = this.fixerStep(line, line.steps[back]);
          this.log(line, { kind: 'info', text: `Revisor pediu mudanças → ${WORKERS[fx.worker].name} corrige na etapa ${back + 1} (rodada ${run.round})` });
          previous = null;
          i = back;
          continue;
        }
        run.outcome = 'mudancas_pendentes';
        run.pending = { step: i, worker: step.worker, findings: attempt.findings };
      } else if (attempt.verdict === 'APROVADO') {
        run.outcome = 'aprovado';
        run.pending = null;
      }
      previous = attempt;
      i += 1;
    }
    if (ctl.stopped) return this.finishStopped(line);
    run.status = 'done';
  }

  /** Etapa de correção: a execução original, com a IA/modelo escolhidos para corrigir. */
  fixerStep(line, base, fixer = line.loop?.fixer) {
    if (!fixer?.worker) return base;
    const same = fixer.worker === base.worker;
    return { ...base, worker: fixer.worker, model: fixer.model || (same ? base.model : ''), effort: fixer.effort || (same ? base.effort : '') };
  }

  countVerdict(run, step, attempt) {
    if (!attempt.verdict) return;
    this.store.stats[step.worker].revisoes += 1;
    const exec = [...run.attempts].reverse().find((a) => EDIT_ROLES.has(a.role) && a.status === 'done');
    if (exec && step.role === 'revisar') this.store.stats[exec.worker][attempt.verdict === 'APROVADO' ? 'aprovadas' : 'reprovadas'] += 1;
  }

  finishStopped(line) {
    line.run.status = 'stopped';
    this.log(line, { kind: 'info', text: 'Linha interrompida pelo usuário' });
  }

  /**
   * "Corrigir com…": a linha terminou com mudanças pendentes; a IA escolhida
   * aplica os apontamentos e quem pediu as mudanças revisa de novo.
   */
  async runFix(line, ctl, where, { fixer, pending }) {
    const run = line.run;
    const revIdx = pending.step;
    let back = -1;
    for (let j = revIdx - 1; j >= 0; j--) if (EDIT_ROLES.has(line.steps[j].role)) { back = j; break; }
    const base = back >= 0
      ? line.steps[back]
      : { worker: fixer.worker, role: 'executar', instruction: 'Aplique as correções apontadas pelo revisor, sem refazer o que já está certo.', skills: ['economia-tokens'], model: '', effort: '' };
    const step = this.fixerStep(line, base, fixer);
    const at = back >= 0 ? back : revIdx;
    this.log(line, { kind: 'info', text: `🔧 ${WORKERS[step.worker].name} vai aplicar as mudanças pedidas (rodada ${run.round})` });
    run.current = at;
    const fixed = await this.runAttempt(line, ctl, where, step, at, { feedback: { worker: pending.worker, text: pending.findings }, fix: true });
    if (fixed.stop === 'stopped' || (!fixed.stop && ctl.stopped)) return this.finishStopped(line);
    if (fixed.stop) return;
    // quem pediu as mudanças confere de novo
    const rev = line.steps[revIdx];
    run.current = revIdx;
    const again = await this.runAttempt(line, ctl, where, rev, revIdx, { previous: fixed.attempt });
    if (again.stop === 'stopped') return this.finishStopped(line);
    if (again.stop) return;
    this.countVerdict(run, rev, again.attempt);
    if (again.attempt.verdict === 'MUDANCAS_NECESSARIAS') {
      run.outcome = 'mudancas_pendentes';
      run.pending = { step: revIdx, worker: rev.worker, findings: again.attempt.findings };
    } else {
      run.outcome = again.attempt.verdict === 'APROVADO' ? 'aprovado' : null;
      run.pending = null;
    }
    run.status = 'done';
  }

  /**
   * Roda uma etapa (uma tentativa). Devolve { attempt, res, stop } com stop
   * 'budget' | 'stopped' | 'failed' | null.
   */
  async runAttempt(line, ctl, where, step, i, { previous = null, feedback = null, fix = false } = {}) {
    const run = line.run;
    const settings = this.store.settings;
    const mode = this.modeOf(step.worker);
    const attempt = {
      step: i,
      worker: step.worker,
      role: step.role,
      round: run.round,
      mode,
      status: 'running',
      activity: 'Chegando na mesa…',
      startedAt: Date.now(),
      endedAt: null,
      usage: { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, costUsd: 0, model: '' },
      cost: 0,
      costExact: false,
      // Economia medida: cache (tokens lidos do cache custam bem menos) e
      // repasse (a próxima IA recebe só o RESUMO, não tudo o que a anterior escreveu).
      saved: {
        cache: 0,
        cacheUsd: 0,
        handoff: previous ? Math.max(0, (previous.usage?.output ?? 0) - Math.round((previous.summary ?? '').length / 4)) : 0,
      },
      verdict: null,
      summary: '',
      finalText: '',
      error: null,
      ...(fix ? { fix: true } : {}),
    };
    run.attempts.push(attempt);
    this.touch(line, true);

    const needsDiff = where.git && DIFF_ROLES.has(step.role) && (line.steps.slice(0, i).some((s) => EDIT_ROLES.has(s.role)) || run.attempts.some((a) => a.fix));
    const diff = needsDiff ? await getDiff(where.dir, where.base, settings.diffMaxChars) : null;
    // Skills sempre ligadas para esta IA (ex.: caveman no Claude) entram em toda etapa dela.
    step = { ...step, skills: [...new Set([...(step.skills ?? []), ...(settings.workers[step.worker].alwaysSkills ?? [])])] };
    const wantsShots = step.skills.includes('captura-tela');
    const shots = wantsShots ? await this.captureFor(line, `etapa${i + 1}-r${run.round}`) : null;
    if (shots?.files?.length) attempt.captures = shots.files.map((f) => path.basename(f.path));
    const capture = wantsShots ? { cmd: this.captureCmd(line), url: this.previews.get(line.id)?.url ?? line.preview?.url, files: shots.files.map((f) => f.path), problems: shots.problems, error: shots.error } : null;
    const prompt = buildPrompt({ line, step, stepIndex: i, totalSteps: line.steps.length, skills: this.skills, previous, diff, baseCommit: where.base, feedback, round: run.round, capture });
    const chosen = [step.model || settings.workers[step.worker].model || 'modelo padrão', step.effort || settings.workers[step.worker].effort].filter(Boolean).join(' · ');
    this.log(line, { step: i, worker: step.worker, kind: 'info', text: `${WORKERS[step.worker].name} começou: ${step.role} (${mode}) · ${chosen} · prompt ~${Math.round(prompt.length / 4)} tokens` });

    const runner = mode === 'real' ? this.real[step.worker] : this.simulated;
    const cfg = {
      ...settings.workers[step.worker],
      model: step.model || settings.workers[step.worker].model,
      effort: step.effort || settings.workers[step.worker].effort,
      skillsDir: (step.skills ?? []).some((n) => this.skills.find((k) => k.name === n)?.hasFiles) ? this.skillsDir : null,
      screenshots: wantsShots ? { rule: `Bash(node "${this.screenshotScript}":*)`, dirs: [this.captureDir(line)], images: capture.files } : null,
    };
    const handle = runner({
      prompt,
      cwd: where.dir ?? process.cwd(),
      role: step.role,
      worker: step.worker,
      round: run.round,
      config: cfg,
      onEvent: (ev) => {
        if (ev.kind !== 'text') attempt.activity = clip(ev.text, 80);
        else attempt.activity = 'Escrevendo resposta…';
        this.log(line, { step: i, worker: step.worker, kind: ev.kind, text: ev.kind === 'text' ? String(ev.text).slice(0, 4000) : ev.text });
        this.touch(line);
      },
      onUsage: (u) => {
        attempt.usage = u;
        this.priceAttempt(attempt);
        this.touch(line);
        if (line.tokenBudget > 0 && this.lineTokens(line) > line.tokenBudget && !ctl.budget) {
          ctl.budget = true;
          ctl.kill?.();
        }
      },
    });
    ctl.kill = handle.kill;
    const res = await handle.done;
    ctl.kill = null;

    attempt.endedAt = Date.now();
    attempt.usage = res.usage ?? attempt.usage;
    this.priceAttempt(attempt);
    attempt.finalText = String(res.finalText ?? '').slice(0, 20000);
    attempt.summary = extractSummary(res.finalText, settings.handoffMaxChars);
    attempt.verdict = VERDICT_ROLES.has(step.role) ? parseVerdict(res.finalText) : null;
    if (attempt.verdict === 'MUDANCAS_NECESSARIAS') attempt.findings = extractFindings(res.finalText);
    attempt.activity = '';
    this.addStats(step.worker, attempt);

    if (ctl.budget) {
      attempt.status = 'stopped';
      run.status = 'budget';
      run.error = `Orçamento de ${line.tokenBudget.toLocaleString('pt-BR')} tokens excedido.`;
      this.log(line, { kind: 'error', text: run.error });
      return { attempt, res, stop: 'budget' };
    }
    if (ctl.stopped) {
      attempt.status = 'stopped';
      return { attempt, res, stop: 'stopped' };
    }
    if (!res.ok) {
      attempt.status = 'failed';
      attempt.error = res.error;
      this.store.stats[step.worker].falhas += 1;
      run.status = 'failed';
      run.error = `${WORKERS[step.worker].name} falhou: ${res.error}`;
      this.log(line, { step: i, worker: step.worker, kind: 'error', text: run.error });
      return { attempt, res, stop: 'failed' };
    }
    attempt.status = 'done';
    this.log(line, { step: i, worker: step.worker, kind: 'done', text: `${WORKERS[step.worker].name} terminou${attempt.verdict ? ` · ${attempt.verdict}` : ''} · ${total(attempt.usage).toLocaleString('pt-BR')} tokens` });
    return { attempt, res, stop: null };
  }

  lineTokens(line) {
    return (line.run?.attempts ?? []).reduce((acc, a) => acc + total(a.usage), 0);
  }

  priceAttempt(attempt) {
    const pricing = this.store.settings.pricing;
    const c = attemptCost(pricing, attempt.worker, attempt.usage);
    attempt.cost = c.usd;
    attempt.costExact = c.exact;
    const p = priceFor(pricing, attempt.worker, attempt.usage.model);
    const cached = attempt.usage.cachedInput ?? 0;
    attempt.saved ??= { cache: 0, cacheUsd: 0, handoff: 0 };
    attempt.saved.cache = p.input > 0 ? Math.round(cached * (1 - p.cacheRead / p.input)) : 0;
    attempt.saved.cacheUsd = (cached * Math.max(0, p.input - p.cacheRead)) / 1e6;
  }

  addStats(worker, attempt) {
    if (attempt.mode === 'real' && attempt.cost > 0) this.store.addDailyCost(worker, attempt.cost);
    const s = this.store.stats[worker];
    s.steps += 1;
    s.input += attempt.usage.input ?? 0;
    s.cachedInput += attempt.usage.cachedInput ?? 0;
    s.output += attempt.usage.output ?? 0;
    if (attempt.mode === 'real') {
      s.costUsd += attempt.cost ?? 0;
      s.savedCache = (s.savedCache ?? 0) + (attempt.saved?.cache ?? 0);
      s.savedHandoff = (s.savedHandoff ?? 0) + (attempt.saved?.handoff ?? 0);
      s.savedUsd = (s.savedUsd ?? 0) + (attempt.saved?.cacheUsd ?? 0);
    }
    s.ms += attempt.endedAt - attempt.startedAt;
  }

  async stopAll() {
    const pending = [];
    for (const [id, ctl] of this.active) {
      this.stop(id);
      if (ctl.promise) pending.push(ctl.promise);
    }
    await Promise.allSettled(pending);
    for (const id of [...this.previews.keys()]) this.stopPreview(id);
  }
}
