#!/usr/bin/env node
// Copia as skills do AI Office para um projeto, para usar no Claude Code
// (.claude/skills) e no Codex (.agents/skills) fora do escritório também.
import fs from 'node:fs';
import path from 'node:path';

const target = process.argv[2];
if (!target) {
  console.error('Uso: npm run skills:install -- /caminho/do/projeto');
  process.exit(1);
}
const src = path.resolve(import.meta.dirname, '..', 'skills');
const root = path.resolve(target);
if (!fs.existsSync(root)) {
  console.error(`Pasta não encontrada: ${root}`);
  process.exit(1);
}

const dests = [path.join(root, '.claude', 'skills'), path.join(root, '.agents', 'skills')];
for (const dest of dests) {
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name, 'SKILL.md');
    if (!fs.existsSync(from)) continue;
    fs.mkdirSync(path.join(dest, name), { recursive: true });
    fs.copyFileSync(from, path.join(dest, name, 'SKILL.md'));
  }
  console.log(`✔ skills copiadas para ${path.relative(process.cwd(), dest) || dest}`);
}
