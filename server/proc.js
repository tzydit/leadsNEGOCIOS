import { spawn, execFile } from 'node:child_process';

const IS_WIN = process.platform === 'win32';

/** Divide uma string de argumentos respeitando aspas simples/duplas. */
export function splitArgs(str) {
  const out = [];
  if (!str) return out;
  let cur = '';
  let quote = null;
  let has = false;
  for (const ch of String(str)) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

// No Windows os CLIs globais do npm são .cmd e precisam de shell; o prompt vai
// sempre por stdin, então só flags passam pela linha de comando.
function quoteWin(arg) {
  if (/^[\w./:=@,+-]+$/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

// Chaves de administrador (usadas só para ler custos) nunca vão para as IAs.
const PRIVATE_ENV = ['ANTHROPIC_ADMIN_KEY', 'OPENAI_ADMIN_KEY'];
export function childEnv(extra = {}) {
  const out = { ...process.env, ...extra };
  for (const k of PRIVATE_ENV) delete out[k];
  return out;
}

/**
 * Roda um processo que emite JSONL no stdout. Cada linha JSON vira onJson(obj);
 * linhas que não são JSON vão para onText. Retorna { done, kill }.
 */
export function runJsonl({ bin, args, cwd, stdin, env, onJson, onText }) {
  const child = spawn(IS_WIN ? quoteWin(bin) : bin, IS_WIN ? args.map(quoteWin) : args, {
    cwd,
    env: childEnv(env),
    shell: IS_WIN,
    detached: !IS_WIN,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let buf = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        onText?.(line);
        continue;
      }
      onJson(obj);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-8000);
  });

  const done = new Promise((resolve) => {
    child.on('error', (err) => resolve({ code: -1, error: err.message, stderr }));
    child.on('close', (code, signal) => {
      const rest = buf.trim();
      if (rest) {
        try {
          onJson(JSON.parse(rest));
        } catch {
          onText?.(rest);
        }
      }
      resolve({ code, signal, stderr });
    });
  });

  child.stdin.on('error', () => {});
  if (stdin != null) child.stdin.end(stdin);
  else child.stdin.end();

  const kill = () => {
    if (child.exitCode != null || child.killed) return;
    try {
      if (IS_WIN) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      else process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  };

  return { done, kill };
}

/**
 * Sobe um comando de longa duração (ex.: servidor de desenvolvimento) via shell.
 * Guarda o fim da saída para diagnóstico e mata a árvore de processos no stop().
 */
export function startProcess(command, { cwd } = {}) {
  const child = spawn(command, { cwd, shell: true, detached: !IS_WIN, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  let exited = false;
  const keep = (c) => (out = (out + c).slice(-2000));
  child.stdout.setEncoding('utf8').on('data', keep);
  child.stderr.setEncoding('utf8').on('data', keep);
  child.on('exit', () => (exited = true));
  child.on('error', (e) => {
    exited = true;
    keep(String(e.message));
  });
  return {
    get exited() {
      return exited;
    },
    tail: () => out.trim().split('\n').slice(-5).join(' | '),
    stop: () => {
      if (exited) return;
      try {
        if (IS_WIN) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        else process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    },
  };
}

/** Espera uma URL responder (qualquer status HTTP) até o prazo. */
export async function waitForUrl(url, timeoutMs = 90000, gaveUp = () => false) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end && !gaveUp()) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(2000) });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return false;
}

/** execFile com promise que nunca rejeita: { code, stdout, stderr }. */
export function exec(bin, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { maxBuffer: 32 * 1024 * 1024, windowsHide: true, shell: IS_WIN && opts.shell, ...opts },
      (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error: err?.message });
      },
    );
  });
}

/** Descobre se um CLI existe e retorna a versão. */
export async function detectCli(bin) {
  const r = await exec(IS_WIN ? quoteWin(bin) : bin, ['--version'], { timeout: 15000, shell: IS_WIN });
  if (r.code !== 0) return { available: false };
  return { available: true, version: r.stdout.trim().split('\n')[0] };
}
