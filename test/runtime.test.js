import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
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

test('catalog initialization permits a slow module beyond the old five-second limit', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'omp slow catalog '));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'bin'));
  await mkdir(path.join(root, 'dist/src/commands'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'maestro-flow', type: 'module', version: 'test', bin: { maestro: 'bin/maestro.js' } }));
  const cli = path.join(root, 'bin/maestro.js');
  await writeFile(cli, '');
  await writeFile(path.join(root, 'dist/src/commands/hooks.js'), 'await new Promise(resolve => setTimeout(resolve, 5500)); export const HOOK_DEFS = {}; export const CODEX_HOOK_DEFS = {};');
  const file = path.join(root, 'bridge.json');
  await writeFile(file, JSON.stringify({ version: 1, node: process.execPath, maestroCli: cli, source: { kind: 'catalog', level: 'standard' } }));
  const config = await loadBridgeConfig(file);
  assert.equal(config.enabled, true);
});
