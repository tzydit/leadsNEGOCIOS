import fs from 'node:fs';
import path from 'node:path';
import { createApp, PUBLIC_DIR } from './app.js';
import { Billing } from './billing.js';
import { Orchestrator } from './orchestrator.js';
import { loadSkills, readCatalog } from './prompts.js';
import { Store } from './store.js';

const ROOT = path.resolve(import.meta.dirname, '..');
// Chaves de administrador (opcionais) para ler o gasto real das contas.
if (fs.existsSync(path.join(ROOT, '.env'))) process.loadEnvFile?.(path.join(ROOT, '.env'));
const DATA_DIR = process.env.AI_OFFICE_DATA ?? path.join(ROOT, 'data');
const PORT = Number(process.env.PORT ?? 4317);
const HOST = process.env.HOST ?? '127.0.0.1';

const store = new Store(path.join(DATA_DIR, 'state.json'));
const SKILLS_DIR = path.join(ROOT, 'skills');
const skills = loadSkills(SKILLS_DIR);
const orchestrator = new Orchestrator({ store, skills, skillsDir: SKILLS_DIR, worktreesDir: path.join(DATA_DIR, 'worktrees') });
const workers = await orchestrator.detect();
const billing = new Billing();
billing.start(store.settings.billingPollSeconds);
const { app, attach } = createApp({ store, orchestrator, skills, billing, skillsFora: readCatalog(SKILLS_DIR).fora ?? [], publicDir: PUBLIC_DIR });

const server = app.listen(PORT, HOST, () => {
  console.log(`\n  🏢 AI Office em http://localhost:${PORT}\n`);
  for (const [w, info] of Object.entries(workers)) {
    console.log(`  ${w.padEnd(7)} ${info.available ? `✔ ${info.version}` : '✖ não encontrado'} → modo ${info.mode}`);
  }
  console.log(`  skills: ${skills.length} (${skills.filter((s) => s.melhor).length} ⭐ melhores do GitHub)`);
  const accounts = Object.entries(billing.state).map(([id, s]) => `${id} ${s.configured ? '✔' : '✖'}`);
  console.log(`  gasto real das contas: ${accounts.join(' · ')} (chaves de administrador no .env)\n`);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') console.warn('  ⚠ HOST diferente de localhost: não exponha o AI Office na rede.\n');
});
attach(server);

const shutdown = async () => {
  await orchestrator.stopAll();
  store.flush();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
