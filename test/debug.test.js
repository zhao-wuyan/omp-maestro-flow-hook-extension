import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Bridge } from '../src/bridge.js';
import { resolveRuntime } from '../src/runtime.js';

test('real evaluator debug summaries expose only bounded metadata for context, denial and no output', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'omp debug '));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.workflow'));
  await mkdir(path.join(root, '.maestro'));
  await writeFile(path.join(root, '.workflow/state.json'), JSON.stringify({ version: 1, sessions: [] }));
  await writeFile(path.join(root, '.maestro/config.json'), JSON.stringify({ hooks: { toggles: { knowledgeGuard: true, workflowGuard: true } } }));
  const runtime = await resolveRuntime({});
  const rows = [];
  const bridge = new Bridge({ runtime, hooks: [], timeoutMs: 5000, eventBudgetMs: 20000 }, row => rows.push(row));
  const base = { hook_event_name: 'PreToolUse', cwd: root, session_id: 'debug-test', tool_name: 'Write', tool_input: { file_path: path.join(root, '.workflow/specs/private.md'), content: 'SECRET_INPUT_829' } };
  await bridge.invoke({ name: 'knowledge-guard' }, base, Date.now() + 10000);
  await bridge.invoke({ name: 'workflow-guard' }, { ...base, tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }, Date.now() + 10000);
  await bridge.invoke({ name: 'knowledge-guard' }, { ...base, tool_input: { file_path: path.join(root, '.workflow/state.json') } }, Date.now() + 10000);
  assert.deepEqual(rows.map(row => row.outcome), ['context', 'blocked', 'no-output']);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ['durationMs', 'event', 'hook', 'outcome', 'sessionId']);
    assert(Number.isInteger(row.durationMs) && row.durationMs >= 0);
  }
  assert(!JSON.stringify(rows).includes('SECRET_INPUT_829'));
});
