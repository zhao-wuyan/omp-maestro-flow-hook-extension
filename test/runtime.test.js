import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadBridgeConfig } from '../src/config.js';

test('missing PATH CLI and stale CLI paths suspend only the bridge, not configuration errors', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'omp missing maestro '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'bridge.json');
  await writeFile(file, JSON.stringify({ version: 1, source: { kind: 'catalog', level: 'standard' } }));
  await assert.rejects(loadBridgeConfig(file, { PATH: root }), error => error.kind === 'unavailable');
  await writeFile(file, JSON.stringify({ version: 1, maestroCli: path.join(root, 'missing', 'bin', 'maestro.js'), source: { kind: 'catalog', level: 'standard' } }));
  await assert.rejects(loadBridgeConfig(file), error => error.kind === 'unavailable');
  await writeFile(file, '{invalid');
  await assert.rejects(loadBridgeConfig(file), SyntaxError);
  await assert.rejects(loadBridgeConfig(path.join(root, 'missing-config.json')), error => error.code === 'ENOENT' && error.kind !== 'unavailable');
});
