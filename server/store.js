import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_PRICING } from './pricing.js';

export const DEFAULT_SETTINGS = {
  defaultWorkdir: '',
  diffMaxChars: 12000,
  handoffMaxChars: 2000,
  billingPollSeconds: 300,
  pricing: DEFAULT_PRICING,
  workers: {
    claude: {
      mode: 'auto', // auto | real | simulado
      bin: 'claude',
      model: '',
      effort: '',
      allowedTools: 'Bash(npm test:*) Bash(npm run:*) Bash(npx vitest:*) Bash(npx jest:*) Bash(git status:*) Bash(git diff:*)',
      maxBudgetUsd: 0,
      extraArgs: '',
    },
    codex: {
      mode: 'auto',
      bin: 'codex',
      model: '',
      effort: '',
      extraArgs: '',
    },
  },
};

const emptyStats = () => ({ steps: 0, input: 0, cachedInput: 0, output: 0, costUsd: 0, ms: 0, aprovadas: 0, reprovadas: 0, revisoes: 0, falhas: 0 });

export function defaultStats() {
  return { claude: emptyStats(), codex: emptyStats() };
}

/** Estado persistido em data/state.json, com gravação agrupada (debounce). */
export class Store {
  constructor(file) {
    this.file = file;
    this.timer = null;
    this.data = { settings: structuredClone(DEFAULT_SETTINGS), lines: [], stats: defaultStats(), costDaily: {}, seq: 0 };
    if (file && fs.existsSync(file)) {
      try {
        const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
        this.data = {
          ...this.data,
          ...loaded,
          settings: mergeSettings(DEFAULT_SETTINGS, loaded.settings),
          stats: { ...defaultStats(), ...loaded.stats },
          costDaily: loaded.costDaily ?? {},
        };
        // Linhas que estavam rodando quando o servidor caiu não estão mais.
        for (const line of this.data.lines) {
          if (line.run?.status === 'running') line.run.status = 'stopped';
          for (const a of line.run?.attempts ?? []) if (a.status === 'running') a.status = 'stopped';
        }
      } catch (err) {
        console.warn(`[store] não consegui ler ${file}: ${err.message}`);
      }
    }
  }

  get settings() {
    return this.data.settings;
  }

  get lines() {
    return this.data.lines;
  }

  get stats() {
    return this.data.stats;
  }

  /** Soma o custo real (não simulado) de uma etapa no dia local. */
  addDailyCost(worker, usd, date = new Date()) {
    const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const d = (this.data.costDaily[day] ??= {});
    d[worker] = (d[worker] ?? 0) + usd;
    const days = Object.keys(this.data.costDaily).sort();
    for (const old of days.slice(0, Math.max(0, days.length - 62))) delete this.data.costDaily[old];
  }

  nextId(prefix) {
    this.data.seq += 1;
    return `${prefix}${this.data.seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  save() {
    if (!this.file) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 400);
  }

  flush() {
    if (!this.file) return;
    clearTimeout(this.timer);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

export function mergeSettings(base, patch = {}) {
  return {
    ...base,
    ...patch,
    pricing: patch?.pricing ?? base.pricing,
    workers: {
      claude: { ...base.workers.claude, ...patch?.workers?.claude },
      codex: { ...base.workers.codex, ...patch?.workers?.codex },
    },
  };
}
