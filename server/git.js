import fs from 'node:fs';
import { exec } from './proc.js';

const git = (cwd, args) => exec('git', args, { cwd });

export async function isGitRepo(dir) {
  const r = await git(dir, ['rev-parse', '--is-inside-work-tree']);
  return r.code === 0 && r.stdout.trim() === 'true';
}

export async function headCommit(dir) {
  const r = await git(dir, ['rev-parse', 'HEAD']);
  return r.code === 0 ? r.stdout.trim() : null;
}

/**
 * Garante um git worktree isolado para a linha. Reaproveita se já existir,
 * assim uma linha rodada de novo continua de onde parou.
 */
export async function ensureWorktree(repoDir, wtPath, branch) {
  if (fs.existsSync(wtPath) && (await isGitRepo(wtPath))) {
    return { path: wtPath, created: false };
  }
  const head = await headCommit(repoDir);
  if (!head) throw new Error('O repositório não tem nenhum commit; faça um commit inicial para usar worktree.');
  const r = await git(repoDir, ['worktree', 'add', '-B', branch, wtPath, head]);
  if (r.code !== 0) throw new Error(`git worktree falhou: ${r.stderr.trim() || r.error}`);
  return { path: wtPath, created: true, base: head };
}

/**
 * Diff do diretório contra o commit base, incluindo arquivos novos (não
 * rastreados), truncado em maxChars para não estourar tokens do revisor.
 */
export async function getDiff(dir, base, maxChars = 12000) {
  const ref = base || 'HEAD';
  const [stat, diff, untracked] = await Promise.all([
    git(dir, ['diff', '--stat', ref]),
    git(dir, ['diff', '--no-color', ref]),
    git(dir, ['ls-files', '--others', '--exclude-standard']),
  ]);
  let text = diff.stdout;
  const newFiles = untracked.stdout.split('\n').filter(Boolean);
  for (const f of newFiles.slice(0, 25)) {
    if (text.length > maxChars) break;
    try {
      if (fs.statSync(`${dir}/${f}`).size > 50_000) continue;
    } catch {
      continue;
    }
    // --no-index sai com código 1 quando há diferença; o stdout é o que importa.
    const r = await git(dir, ['diff', '--no-color', '--no-index', '--', '/dev/null', f]);
    text += r.stdout;
  }
  const truncated = text.length > maxChars;
  return {
    stat: stat.stdout.trim() + (newFiles.length ? `\n novos: ${newFiles.length} arquivo(s)` : ''),
    diff: truncated ? text.slice(0, maxChars) : text,
    truncated,
    newFiles,
    empty: !text.trim(),
  };
}
