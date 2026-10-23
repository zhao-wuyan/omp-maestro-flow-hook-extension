import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultConfigPath, initializeConfig } from '../src/config.js';

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
