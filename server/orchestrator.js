import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { runClaude } from './adapters/claude.js';
import { runCodex } from './adapters/codex.js';
import { createSimulatedRunner } from './adapters/simulated.js';
import { clip } from './adapters/common.js';
import { ensureWorktree, getDiff, headCommit, isGitRepo } from './git.js';
import { buildPrompt, extractFindings, extractSummary, parseVerdict, VERDICT_ROLES, WORKERS } from './prompts.js';
import { detectCli, startProcess, waitForUrl } from './proc.js';
import { capture as chromeCapture } from './screenshot.js';
import { attemptCost } from './pricing.js';
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
    if (!line.run) return line;
    const { log, ...run } = line.run;
    return { ...line, run };
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

  start(lineId) {
    const line = this.store.lines.find((l) => l.id === lineId);
    if (!line) throw new Error('Linha não encontrada');
    if (this.active.has(lineId)) throw new Error('A linha já está rodando');
    if (!line.steps.length) throw new Error('A linha não tem etapas');
    const ctl = { kill: null, stopped: false };
    this.active.set(lineId, ctl);
    line.run = { status: 'running', startedAt: Date.now(), endedAt: null, round: 1, current: 0, attempts: [], log: [], dir: null, branch: null, base: null, notice: null, error: null, outcome: null };
    this.touch(line, true);
    const p = this.execute(line, ctl)
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

  async execute(line, ctl) {
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

    const preview = await this.startPreview(line, where.dir);
    try {
      await this.runSteps(line, ctl, where);
    } finally {
      preview?.stop();
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

  /** Sobe o site de preview da linha (se houver comando) e espera a URL responder. */
  async startPreview(line, dir) {
    const { url, command } = line.preview ?? {};
    if (!command || !dir) return null;
    this.log(line, { kind: 'info', text: `🌐 Subindo o site: ${command}` });
    const proc = startProcess(command, { cwd: dir });
    if (url) {
      const ok = await waitForUrl(url, 90000, () => proc.exited);
      this.log(line, ok ? { kind: 'info', text: `🌐 Site no ar em ${url}` } : { kind: 'error', text: `O site não respondeu em ${url}. ${proc.tail()}` });
    }
    return proc;
  }

  /** Captura desktop e celular da URL de preview no Chrome. */
  async captureFor(line, name) {
    const url = line.preview?.url;
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
    const settings = this.store.settings;
    let i = 0;
    let previous = null;
    let feedback = null;
    while (i < line.steps.length) {
      if (ctl.stopped) break;
      const step = line.steps[i];
      run.current = i;
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
        verdict: null,
        summary: '',
        finalText: '',
        error: null,
      };
      run.attempts.push(attempt);
      this.touch(line, true);

      const needsDiff = where.git && (VERDICT_ROLES.has(step.role) || step.role === 'analisar') && line.steps.slice(0, i).some((s) => s.role === 'executar');
      const diff = needsDiff ? await getDiff(where.dir, where.base, settings.diffMaxChars) : null;
      const wantsShots = (step.skills ?? []).includes('captura-tela');
      const shots = wantsShots ? await this.captureFor(line, `etapa${i + 1}-r${run.round}`) : null;
      if (shots?.files?.length) attempt.captures = shots.files.map((f) => path.basename(f.path));
      const capture = wantsShots ? { cmd: this.captureCmd(line), url: line.preview?.url, files: shots.files.map((f) => f.path), problems: shots.problems, error: shots.error } : null;
      const prompt = buildPrompt({ line, step, stepIndex: i, totalSteps: line.steps.length, skills: this.skills, previous, diff, baseCommit: where.base, feedback: step.role === 'executar' ? feedback : null, round: run.round, capture });
      if (step.role === 'executar') feedback = null;
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
      attempt.activity = '';
      this.addStats(step.worker, attempt);

      if (ctl.budget) {
        attempt.status = 'stopped';
        run.status = 'budget';
        run.error = `Orçamento de ${line.tokenBudget.toLocaleString('pt-BR')} tokens excedido.`;
        this.log(line, { kind: 'error', text: run.error });
        return;
      }
      if (ctl.stopped) {
        attempt.status = 'stopped';
        break;
      }
      if (!res.ok) {
        attempt.status = 'failed';
        attempt.error = res.error;
        this.store.stats[step.worker].falhas += 1;
        run.status = 'failed';
        run.error = `${WORKERS[step.worker].name} falhou: ${res.error}`;
        this.log(line, { step: i, worker: step.worker, kind: 'error', text: run.error });
        return;
      }
      attempt.status = 'done';
      this.log(line, { step: i, worker: step.worker, kind: 'done', text: `${WORKERS[step.worker].name} terminou${attempt.verdict ? ` · ${attempt.verdict}` : ''} · ${total(attempt.usage).toLocaleString('pt-BR')} tokens` });

      if (attempt.verdict) {
        this.store.stats[step.worker].revisoes += 1;
        const exec = [...run.attempts].reverse().find((a) => a.role === 'executar' && a.status === 'done');
        if (exec && step.role === 'revisar') this.store.stats[exec.worker][attempt.verdict === 'APROVADO' ? 'aprovadas' : 'reprovadas'] += 1;
      }

      if (attempt.verdict === 'MUDANCAS_NECESSARIAS') {
        let back = -1;
        for (let j = i - 1; j >= 0; j--) if (line.steps[j].role === 'executar') { back = j; break; }
        if (line.loop?.enabled && back >= 0 && run.round < line.loop.maxRounds) {
          run.round += 1;
          feedback = { worker: step.worker, text: extractFindings(res.finalText) };
          this.log(line, { kind: 'info', text: `Revisor pediu mudanças → volta para a etapa ${back + 1} (rodada ${run.round})` });
          previous = null;
          i = back;
          continue;
        }
        run.outcome = 'mudancas_pendentes';
      } else if (attempt.verdict === 'APROVADO') {
        run.outcome = 'aprovado';
      }
      previous = attempt;
      i += 1;
    }
    run.status = ctl.stopped ? 'stopped' : 'done';
    if (ctl.stopped) this.log(line, { kind: 'info', text: 'Linha interrompida pelo usuário' });
  }

  lineTokens(line) {
    return (line.run?.attempts ?? []).reduce((acc, a) => acc + total(a.usage), 0);
  }

  priceAttempt(attempt) {
    const c = attemptCost(this.store.settings.pricing, attempt.worker, attempt.usage);
    attempt.cost = c.usd;
    attempt.costExact = c.exact;
  }

  addStats(worker, attempt) {
    if (attempt.mode === 'real' && attempt.cost > 0) this.store.addDailyCost(worker, attempt.cost);
    const s = this.store.stats[worker];
    s.steps += 1;
    s.input += attempt.usage.input ?? 0;
    s.cachedInput += attempt.usage.cachedInput ?? 0;
    s.output += attempt.usage.output ?? 0;
    if (attempt.mode === 'real') s.costUsd += attempt.cost ?? 0;
    s.ms += attempt.endedAt - attempt.startedAt;
  }

  async stopAll() {
    const pending = [];
    for (const [id, ctl] of this.active) {
      this.stop(id);
      if (ctl.promise) pending.push(ctl.promise);
    }
    await Promise.allSettled(pending);
  }
}
