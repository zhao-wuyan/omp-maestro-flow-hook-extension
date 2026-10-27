import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultConfigPath, initializeConfig, initializeLearning } from '../src/config.js';

test('initialization preserves existing settings and malformed files, including concurrent calls', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'omp init '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agent = path.join(root, 'isolated profile');
  const file = path.join(agent, 'maestro-hooks.json');
  assert.equal(await defaultConfigPath(agent), undefined);
  const results = await Promise.all([initializeConfig(file), initializeConfig(file)]);
  assert.equal(results.filter(result => result.created).length, 1);
  const custom = '{"version":1,"enabled":false,"source":{"kind":"catalog","level":"full"}}\n';
  await writeFile(file, custom);
  assert.equal((await initializeConfig(file)).created, false);
  assert.equal(await readFile(file, 'utf8'), custom);
  await writeFile(file, '{broken');
  assert.equal((await initializeConfig(file)).created, false);
  assert.equal(await readFile(file, 'utf8'), '{broken');
  assert.equal(await defaultConfigPath(agent), file);
  await mkdir(path.join(root, 'project'));
  assert.equal(await defaultConfigPath(path.join(root, 'another-profile')), undefined);
});

test('learning initialization requires an existing workflow and preserves records and conflicts', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'omp learning '));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeLearning(root);
  await assert.rejects(stat(path.join(root, '.workflow')), { code: 'ENOENT' });
  await mkdir(path.join(root, '.workflow'));
  await Promise.all([initializeLearning(root), initializeLearning(root)]);
  const ledger = path.join(root, '.workflow/learning/maestro-search.jsonl');
  await assert.rejects(readFile(ledger), { code: 'ENOENT' });
  await writeFile(ledger, 'existing-record\n');
  await initializeLearning(root);
  assert.equal(await readFile(ledger, 'utf8'), 'existing-record\n');
  await rm(path.join(root, '.workflow/learning'), { recursive: true });
  await writeFile(path.join(root, '.workflow/learning'), 'not-a-directory');
  await assert.rejects(initializeLearning(root), { code: 'EEXIST' });
  assert.equal(await readFile(path.join(root, '.workflow/learning'), 'utf8'), 'not-a-directory');
});
