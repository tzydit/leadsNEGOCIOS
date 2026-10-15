#!/usr/bin/env node
// Instala as skills do AI Office para usar no Claude Code e no Codex fora do
// escritório também.
//
//   npm run skills:global                       → todas as sessões do usuário
//   npm run skills:install -- /caminho/projeto  → só aquele projeto
//   npm run skills:global -- --uninstall        → remove o que foi instalado
//
// Pastas globais: $CLAUDE_CONFIG_DIR/skills (padrão ~/.claude/skills) e
// $CODEX_HOME/skills (padrão ~/.codex/skills).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MARKER = '.ai-office.json';
const SRC = path.resolve(import.meta.dirname, '..', 'skills');

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const positional = args.filter((a) => !a.startsWith('--'));

function targets() {
  if (flag('--global')) {
    const home = os.homedir();
    return {
      'Claude Code': path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'skills'),
      Codex: path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'skills'),
    };
  }
  if (!positional[0]) {
    console.error('Uso: npm run skills:install -- /caminho/do/projeto   ou   npm run skills:global');
    process.exit(1);
  }
  const root = path.resolve(positional[0]);
  if (!fs.existsSync(root)) {
    console.error(`Pasta não encontrada: ${root}`);
    process.exit(1);
  }
  return { 'Claude Code': path.join(root, '.claude', 'skills'), Codex: path.join(root, '.agents', 'skills') };
}

// Skills do AI Office (skills/<nome>) e as melhores do GitHub (skills/github/<nome>).
const skills = [SRC, path.join(SRC, 'github')]
  .filter((root) => fs.existsSync(root))
  .flatMap((root) => fs.readdirSync(root).filter((n) => fs.existsSync(path.join(root, n, 'SKILL.md'))).map((n) => ({ name: n, dir: path.join(root, n) })));
const dryRun = flag('--dry-run');
const force = flag('--force');

for (const [agent, dest] of Object.entries(targets())) {
  if (flag('--uninstall')) {
    // Só remove o que o AI Office instalou (tem o marcador).
    const ours = fs.existsSync(dest) ? fs.readdirSync(dest).filter((n) => fs.existsSync(path.join(dest, n, MARKER))) : [];
    if (!dryRun) for (const n of ours) fs.rmSync(path.join(dest, n), { recursive: true, force: true });
    console.log(`✔ ${agent}: ${ours.length} skill(s) removida(s) de ${dest}`);
    continue;
  }
  const done = [];
  for (const { name, dir } of skills) {
    const to = path.join(dest, name);
    // Uma skill com o mesmo nome que não veio do AI Office é do usuário: não sobrescreve.
    if (fs.existsSync(to) && !fs.existsSync(path.join(to, MARKER)) && !force) {
      console.log(`  · ${agent}: ${name} já existe e não foi instalada pelo AI Office — mantida (use --force para substituir)`);
      continue;
    }
    if (!dryRun) {
      // Pasta inteira: as skills do GitHub trazem referências e a licença junto.
      fs.rmSync(to, { recursive: true, force: true });
      fs.cpSync(dir, to, { recursive: true });
      fs.writeFileSync(path.join(to, MARKER), JSON.stringify({ source: 'ai-office' }) + '\n');
    }
    done.push(name);
  }
  console.log(`✔ ${agent}: ${done.length} skill(s) em ${dest}${dryRun ? ' (simulação, nada gravado)' : ''}`);
}
if (flag('--global') && !flag('--uninstall')) {
  console.log('\nReinicie o Claude Code e o Codex. No Claude, as skills são ativadas pela descrição; no Codex, chame com $nome-da-skill ou deixe ele escolher.');
}
