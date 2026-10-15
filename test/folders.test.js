import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listFolders, pickFolderNative } from '../server/folders.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-dirs-'));

test('lista só subpastas visíveis, em ordem, marcando repositórios git', () => {
  const d = tmp();
  for (const n of ['zeta', 'Alfa', '.oculta', 'node_modules', 'projeto']) fs.mkdirSync(path.join(d, n));
  fs.mkdirSync(path.join(d, 'projeto', '.git'));
  fs.writeFileSync(path.join(d, 'arquivo.txt'), 'x');
  const r = listFolders(d);
  assert.equal(r.path, d);
  assert.equal(r.parent, path.dirname(d));
  assert.deepEqual(r.folders.map((f) => f.name), ['Alfa', 'projeto', 'zeta']);
  assert.deepEqual(r.folders.filter((f) => f.git).map((f) => f.name), ['projeto']);
  assert.equal(listFolders(path.join(d, 'projeto')).git, true);
  assert.ok(r.roots.length >= 1);
});

test('pasta que não existe vira erro 400 com mensagem em português', () => {
  assert.throws(() => listFolders(path.join(tmp(), 'nao-existe')), (e) => e.status === 400 && /não encontrada/.test(e.message));
});

test('janela nativa: escolhida, cancelada, indisponível e uma por vez', async () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, '.git'));
  const ok = await pickFolderNative('', async () => ({ code: 0, stdout: `${d}${path.sep}\n`, stderr: '' }));
  assert.deepEqual(ok, { path: d, git: true });
  assert.deepEqual(await pickFolderNative('', async () => ({ code: 1, stdout: '', stderr: '' })), { cancelled: true });
  await assert.rejects(pickFolderNative('', async () => ({ code: 1, stdout: '', stderr: '', error: 'spawn zenity ENOENT' })), (e) => e.status === 501);
  let release;
  const slow = pickFolderNative('', () => new Promise((r) => (release = () => r({ code: 1, stdout: '', stderr: '' }))));
  await assert.rejects(pickFolderNative('', async () => ({ code: 0, stdout: d })), (e) => e.status === 409);
  release();
  await slow;
});
