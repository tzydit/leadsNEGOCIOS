import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec } from './proc.js';

const IS_WIN = process.platform === 'win32';

/** Pontos de partida: pasta pessoal e, no Windows, as unidades (C:, D:...). */
export function roots() {
  const out = [{ label: 'Início', path: os.homedir() }];
  if (IS_WIN) {
    for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      const p = `${l}:\\`;
      if (fs.existsSync(p)) out.push({ label: `${l}:`, path: p });
    }
  } else out.push({ label: '/', path: '/' });
  return out;
}

const isGit = (p) => fs.existsSync(path.join(p, '.git'));

/** Lista só as subpastas (nada de conteúdo de arquivo), marcando repositórios git. */
export function listFolders(dir) {
  const abs = path.resolve(dir || os.homedir());
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch (err) {
    const msg = err.code === 'ENOENT' ? 'Pasta não encontrada' : err.code === 'EACCES' || err.code === 'EPERM' ? 'Sem permissão para abrir esta pasta' : err.message;
    throw Object.assign(new Error(`${msg}: ${abs}`), { status: 400 });
  }
  const folders = entries
    .filter((e) => {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '$RECYCLE.BIN' || e.name === 'System Volume Information') return false;
      if (e.isDirectory()) return true;
      if (!e.isSymbolicLink()) return false;
      try {
        return fs.statSync(path.join(abs, e.name)).isDirectory();
      } catch {
        return false;
      }
    })
    .map((e) => ({ name: e.name, path: path.join(abs, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' }))
    .slice(0, 500)
    .map((f) => ({ ...f, git: isGit(f.path) }));
  const parent = path.dirname(abs);
  return { path: abs, parent: parent !== abs ? parent : null, git: isGit(abs), sep: path.sep, folders, roots: roots() };
}

let picking = false;

/**
 * Abre a janela nativa de escolher pasta do sistema (Windows, macOS ou Linux
 * com zenity/kdialog). Aparece no computador onde o AI Office está rodando.
 */
export async function pickFolderNative(start, run = exec) {
  if (picking) throw Object.assign(new Error('Já existe uma janela de escolher pasta aberta.'), { status: 409 });
  picking = true;
  try {
    const startDir = start && fs.existsSync(start) && fs.statSync(start).isDirectory() ? path.resolve(start) : '';
    let r;
    if (IS_WIN) {
      const quoted = startDir.replace(/'/g, "''");
      const ps = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
        "$d.Description = 'Escolha a pasta do projeto'",
        '$d.ShowNewFolderButton = $true',
        startDir ? `$d.SelectedPath = '${quoted}'` : '',
        '$o = New-Object System.Windows.Forms.Form -Property @{TopMost=$true; ShowInTaskbar=$false}',
        "if ($d.ShowDialog($o) -eq 'OK') { [Console]::OutputEncoding = [Text.Encoding]::UTF8; [Console]::Out.Write($d.SelectedPath) }",
      ]
        .filter(Boolean)
        .join('; ');
      r = await run('powershell', ['-NoProfile', '-STA', '-Command', ps], { timeout: 600000 });
    } else if (process.platform === 'darwin') {
      const def = startDir ? ` default location (POSIX file "${startDir.replace(/"/g, '\\"')}")` : '';
      r = await run('osascript', ['-e', `POSIX path of (choose folder with prompt "Escolha a pasta do projeto"${def})`], { timeout: 600000 });
    } else {
      r = await run('zenity', ['--file-selection', '--directory', '--title=Escolha a pasta do projeto', ...(startDir ? [`--filename=${startDir}/`] : [])], { timeout: 600000 });
      if (/ENOENT/i.test(r.error ?? '')) {
        r = await run('kdialog', ['--getexistingdirectory', startDir || os.homedir(), '--title', 'Escolha a pasta do projeto'], { timeout: 600000 });
      }
    }
    if (/ENOENT/i.test(r.error ?? '')) throw Object.assign(new Error('Janela do sistema indisponível neste computador; use a lista de pastas.'), { status: 501 });
    // Cancelar a janela devolve código diferente de zero (ou saída vazia).
    if (r.code !== 0) return { cancelled: true };
    let chosen = r.stdout.trim();
    if (!chosen) return { cancelled: true };
    // tira a barra final, mas não da raiz de uma unidade ("C:\\") nem de "/"
    if (!/^([A-Za-z]:)?[\\/]$/.test(chosen)) chosen = chosen.replace(/[\\/]+$/, '');
    return { path: path.resolve(chosen), git: isGit(chosen) };
  } finally {
    picking = false;
  }
}
