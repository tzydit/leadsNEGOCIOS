import path from 'node:path';
import { createApp, PUBLIC_DIR } from './app.js';
import { Orchestrator } from './orchestrator.js';
import { loadSkills } from './prompts.js';
import { Store } from './store.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA_DIR = process.env.AI_OFFICE_DATA ?? path.join(ROOT, 'data');
const PORT = Number(process.env.PORT ?? 4317);
const HOST = process.env.HOST ?? '127.0.0.1';

const store = new Store(path.join(DATA_DIR, 'state.json'));
const skills = loadSkills(path.join(ROOT, 'skills'));
const orchestrator = new Orchestrator({ store, skills, worktreesDir: path.join(DATA_DIR, 'worktrees') });
const workers = await orchestrator.detect();
const { app, attach } = createApp({ store, orchestrator, skills, publicDir: PUBLIC_DIR });

const server = app.listen(PORT, HOST, () => {
  console.log(`\n  🏢 AI Office em http://localhost:${PORT}\n`);
  for (const [w, info] of Object.entries(workers)) {
    console.log(`  ${w.padEnd(7)} ${info.available ? `✔ ${info.version}` : '✖ não encontrado'} → modo ${info.mode}`);
  }
  console.log(`  skills: ${skills.map((s) => s.name).join(', ')}\n`);
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
