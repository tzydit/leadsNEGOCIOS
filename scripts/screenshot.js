#!/usr/bin/env node
// Captura de tela no Chrome para as IAs conferirem o design.
//   node scripts/screenshot.js <url> [--name home] [--sizes desktop,mobile] [--full] [--theme dark] [--wait 1500] [--out pasta]
import path from 'node:path';
import { capture, parseSizes } from '../server/screenshot.js';

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const VALUE_FLAGS = new Set(['--out', '--name', '--sizes', '--theme', '--wait']);
const url = args.find((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(args[i - 1]));
if (!url || args.includes('--help')) {
  console.log('Uso: node scripts/screenshot.js <url> [--name nome] [--sizes desktop,tablet,mobile] [--full] [--theme dark|light] [--wait ms] [--out pasta]');
  process.exit(url ? 0 : 1);
}
try {
  const r = await capture({
    url,
    outDir: path.resolve(opt('out', '.ai-office/capturas')),
    name: opt('name', 'captura'),
    sizes: parseSizes(opt('sizes', 'desktop,mobile')),
    full: args.includes('--full'),
    theme: opt('theme', null),
    waitMs: Math.min(15000, Math.max(0, Number(opt('wait', 800)) || 0)),
  });
  for (const f of r.files) console.log(`📸 ${f.size} (${f.width}x${f.height}): ${f.path}`);
  if (r.problems.length) for (const p of r.problems) console.log(`⚠ ${p}`);
  else console.log('✔ nenhum erro de console, requisição ou overflow horizontal');
  console.log(`(navegador: ${r.via})`);
} catch (err) {
  console.error(`✖ ${err.message}`);
  process.exit(1);
}
