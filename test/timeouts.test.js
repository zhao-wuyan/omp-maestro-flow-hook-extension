import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Bridge } from '../src/bridge.js';

async function setup(t, hooks) {
  const root = await mkdtemp(path.join(tmpdir(), 'omp-hook-timeout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // 真实子进程故障注入；不冒充 Maestro evaluator 验证。
  const cli = path.join(root, 'slow.mjs');
  await writeFile(cli, "setInterval(() => {}, 1000);\n");
  const rows = [];
  const bridge = new Bridge({ runtime: { node: process.execPath, cli }, hooks, timeoutMs: 50, eventBudgetMs: 2000 }, row => rows.push(row));
  const ctx = { cwd: root, sessionManager: { getSessionId: () => 'timeout-test' } };
  return { root, bridge, ctx, rows };
}

test('notification timeout reports safe diagnostics and does not lock the next event', async t => {
  const { root, bridge, ctx, rows } = await setup(t, [{ name: 'delegate-monitor', event: 'PostToolUse', matcher: 'Bash' }]);
  const event = { toolName: 'bash', input: { command: 'SECRET_INPUT' }, toolCallId: 'first', content: [{ type: 'text', text: 'completed' }], isError: false };
  const result = await bridge.tool(event, ctx, 'PostToolUse');
  assert.notEqual(result.block, true);
  assert.equal(rows[0].outcome, 'timeout');
  assert.equal(bridge.lastTimeout.hook, 'delegate-monitor');
  assert.equal(bridge.lastTimeout.event, 'PostToolUse');
  assert.equal(bridge.lastTimeout.action, 'warn-and-continue');
  assert.equal(bridge.lastTimeout.timeoutMs, 50);
  assert.equal(bridge.lastTimeout.eventBudgetMs, 2000);
  assert.equal(bridge.lastTimeout.scope, 'hook');
  assert(bridge.lastTimeout.durationMs >= 50);
  assert(!JSON.stringify(bridge.lastTimeout).includes('SECRET_INPUT'));
  const marker = path.join(root, 'later.txt');
  await writeFile(bridge.config.runtime.cli, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'later-hook-ran');`);
  bridge.config.timeoutMs = 2000;
  await bridge.tool(event, ctx, 'PostToolUse');
  assert.equal(await readFile(marker, 'utf8'), 'later-hook-ran');
});

test('guard timeout fails the current operation but permits a subsequent invocation', async t => {
  const { bridge, ctx } = await setup(t, [{ name: 'workflow-guard', event: 'PreToolUse', matcher: 'Bash' }]);
  const event = { toolName: 'bash', input: { command: 'echo safe' }, toolCallId: 'guarded' };
  await assert.rejects(bridge.tool(event, ctx, 'PreToolUse'), error => {
    assert.equal(error.kind, 'timeout');
    assert.match(error.message, /PreToolUse \/ workflow-guard/);
    assert.match(error.message, /50 ms/);
    assert.equal(error.diagnostic.action, 'block-current');
    return true;
  });
  await writeFile(bridge.config.runtime.cli, "process.stdout.write('{}');\n");
  bridge.config.timeoutMs = 2000;
  assert.notEqual((await bridge.tool(event, ctx, 'PreToolUse')).block, true);
});

test('exhausted event budget is diagnosed and cannot bypass a later guard', async t => {
  const { bridge, ctx } = await setup(t, []);
  const input = { cwd: ctx.cwd, session_id: 'timeout-test', hook_event_name: 'PreToolUse' };
  await assert.rejects(bridge.invoke({ name: 'workflow-guard' }, input, Date.now() - 1), error => {
    assert.equal(error.diagnostic.scope, 'event');
    assert.equal(error.diagnostic.timeoutMs, 0);
    assert.equal(error.diagnostic.action, 'block-current');
    return true;
  });
  const output = await bridge.invoke({ name: 'telemetry' }, { ...input, hook_event_name: 'Stop' }, Date.now() - 1);
  assert.notEqual(output.blocked, true);
  assert.equal(bridge.lastTimeout.action, 'warn-and-continue');
});

test('optional timeout cannot spend an event budget and then bypass a prompt guard', async t => {
  const { bridge, ctx } = await setup(t, [
    { name: 'skill-context', event: 'UserPromptSubmit' },
    { name: 'prompt-guard', event: 'UserPromptSubmit' },
  ]);
  bridge.config.eventBudgetMs = 1;
  await assert.rejects(bridge.lifecycle('UserPromptSubmit', ctx), error => {
    assert.equal(error.diagnostic.hook, 'prompt-guard');
    assert.equal(error.diagnostic.scope, 'event');
    assert.equal(error.diagnostic.action, 'block-current');
    return true;
  });
});

test('optional hooks still propagate cancellation and invalid protocol output', async t => {
  const { bridge, ctx } = await setup(t, [{ name: 'delegate-monitor', event: 'PostToolUse', matcher: 'Bash' }]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(bridge.invoke({ name: 'telemetry' }, {}, Date.now() - 1, controller.signal), { kind: 'cancelled' });
  await writeFile(bridge.config.runtime.cli, "process.stdout.write('{invalid');\n");
  bridge.config.timeoutMs = 2000;
  await assert.rejects(bridge.tool({ toolName: 'bash', input: { command: 'echo safe' }, content: [], isError: false }, ctx, 'PostToolUse'), { kind: 'protocol' });
});

test('a timed out optional hook preserves earlier context and runs a later hook in the same event', async t => {
  const { bridge, ctx } = await setup(t, [
    { name: 'session-context', event: 'SessionStart', timeoutMs: 2000 },
    { name: 'kg-auto-init', event: 'SessionStart', timeoutMs: 50 },
    { name: 'spec-injector', event: 'SessionStart', timeoutMs: 2000 },
  ]);
  await writeFile(bridge.config.runtime.cli, `
    if (process.argv.at(-1) === 'kg-auto-init') setInterval(() => {}, 1000);
    else process.stdout.write(JSON.stringify({ additionalContext: process.argv.at(-1) }));
  `);
  bridge.config.eventBudgetMs = 10000;
  const result = await bridge.lifecycle('SessionStart', ctx, { source: 'startup' });
  assert.equal(result.context, 'session-context\n\nspec-injector');
  assert.equal(result.blocked, false);
  assert.equal(bridge.lastTimeout.hook, 'kg-auto-init');
});
