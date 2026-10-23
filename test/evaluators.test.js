import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Bridge, sessionId } from '../src/bridge.js';
import { resolveRuntime } from '../src/runtime.js';
import { interpretOutput, runProcess } from '../src/process.js';

let runtime;
before(async () => {
  try {
    // Resolve the installed CLI from PATH, rather than substituting an echo fixture.
    runtime = await resolveRuntime({ node: process.execPath });
  } catch (error) {
    throw new Error('Real evaluator tests require maestro-flow installed with maestro on PATH: ' + error.message, { cause: error });
  }
});

async function workspace(t, workflowConfig = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'omp-maestro-behavior-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ['.workflow/specs', '.maestro', 'tmp']) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  await writeFile(path.join(root, '.workflow/state.json'), JSON.stringify({ version: 1, sessions: [] }));
  await writeFile(path.join(root, '.workflow/config.json'), JSON.stringify(workflowConfig));
  await writeFile(path.join(root, '.maestro/config.json'), JSON.stringify({
    hooks: { toggles: { knowledgeGuard: true, workflowGuard: true, specInjector: true, delegateMonitor: true } },
  }));
  const environment = {
    MAESTRO_HOME: path.join(root, '.maestro'),
    MAESTRO_PROJECT_ROOT: root,
    CLAUDE_PROJECT_DIR: root,
    MAESTRO_HOOKS_ENABLE: 'knowledge-guard,workflow-guard,spec-injector,delegate-monitor',
    MAESTRO_HOOKS_DISABLE: '',
    TMPDIR: path.join(root, 'tmp'),
    TMP: path.join(root, 'tmp'),
    TEMP: path.join(root, 'tmp'),
  };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  return root;
}

function context(cwd, id = randomUUID()) {
  return { cwd, sessionManager: { getSessionId: () => id } };
}

function bridge(...names) {
  return new Bridge({
    runtime,
    hooks: names.map(name => ({ name, event: runtime.catalogs.claude[name].event, matcher: runtime.catalogs.claude[name].matcher })),
    timeoutMs: 15000,
    eventBudgetMs: 20000,
  });
}

function event(toolName, input) {
  return { toolName, input, toolCallId: randomUUID(), content: [{ type: 'text', text: 'completed' }], isError: false };
}

test('real knowledge-guard warnings remain visible without blocking writes', async t => {
  const root = await workspace(t);
  const input = { path: path.join(root, '.workflow/specs/new-rule.md'), content: 'new rule', custom: 'preserve' };
  const result = await bridge('knowledge-guard').tool(event('write', input), context(root), 'PreToolUse');
  assert.notEqual(result.block, true);
  assert.match(result.additionalContext, /KnowledgeGuard/);
  assert.match(result.additionalContext, /pipeline/);
  assert.equal(result.input, undefined, 'an advisory must not rewrite the write request');
  assert.equal(input.custom, 'preserve');
});

test('enabled real workflow-guard exits 2 and blocks a dangerous command', async t => {
  const root = await workspace(t);
  const ctx = context(root);
  const input = { command: 'rm -rf /', timeout: 30 };
  const raw = await runProcess(runtime.node, [runtime.cli, 'hooks', 'run', 'workflow-guard'], {
    cwd: root,
    input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd: root, session_id: sessionId(ctx), tool_name: 'Bash', tool_input: input }),
    timeoutMs: 15000,
  });
  assert.equal(raw.code, 2, 'the evaluator must really execute, not silently pass its workspace/toggle gate');
  assert.equal(interpretOutput(raw, 'PreToolUse').blocked, true);
  const result = await bridge('workflow-guard').tool(event('bash', input), ctx, 'PreToolUse');
  assert.equal(result.block, true);
  assert.ok(result.reason.length > 0);
  assert.deepEqual(input, { command: 'rm -rf /', timeout: 30 });
  const allowed = await bridge('workflow-guard').tool(event('bash', { command: 'echo safe' }), ctx, 'PreToolUse');
  assert.notEqual(allowed.block, true);
});

test('delegate notifications are session-isolated and delivered exactly once', async t => {
  const root = await workspace(t);
  const first = context(root);
  const second = context(root);
  const firstFile = path.join(root, 'tmp', `maestro-notify-${sessionId(first)}.jsonl`);
  const secondFile = path.join(root, 'tmp', `maestro-notify-${sessionId(second)}.jsonl`);
  const notification = (execId, prompt) => ({ execId, prompt, tool: 'node', mode: 'analysis', exitCode: 0, read: false });
  await writeFile(firstFile, JSON.stringify(notification('first-only', 'first private result')) + '\n');
  await writeFile(secondFile, JSON.stringify(notification('second-only', 'second private result')) + '\n');
  const monitor = bridge('delegate-monitor');
  const completed = event('bash', { command: 'echo completed' });
  const a = await monitor.tool(completed, first, 'PostToolUse');
  assert.match(a.additionalContext, /first-only/);
  assert.doesNotMatch(a.additionalContext, /second-only/);
  assert.equal(JSON.parse((await readFile(firstFile, 'utf8')).trim()).read, true);
  assert.equal(JSON.parse((await readFile(secondFile, 'utf8')).trim()).read, false);
  assert.equal((await monitor.tool(completed, first, 'PostToolUse')).additionalContext, undefined);
  const b = await monitor.tool(completed, second, 'PostToolUse');
  assert.match(b.additionalContext, /second-only/);
  assert.doesNotMatch(b.additionalContext, /first-only/);
  assert.equal((await monitor.tool(completed, second, 'PostToolUse')).additionalContext, undefined);
});

test('real spec-injector independently rewrites batch prompts while preserving order and fields', async t => {
  const root = await workspace(t, {
    specInjection: {
      mapping: {
        'omp-coder': { categories: ['coding'] },
        'omp-reviewer': { categories: ['review'] },
        'omp-unmapped': { categories: [] },
      },
    },
  });
  await writeFile(path.join(root, '.workflow/specs/coding-conventions.md'), '# Coding\n\nCODING_SENTINEL_713: preserve transactional writes.\n');
  await writeFile(path.join(root, '.workflow/specs/review-standards.md'), '# Review\n\nREVIEW_SENTINEL_829: inspect authorization boundaries.\n');
  const input = {
    context: 'shared batch context',
    customBatch: { keep: true },
    tasks: [
      { name: 'Coder', agent: 'omp-coder', task: 'Implement alpha.', solutionSpace: 'one change', tools: ['read'], custom: { first: true } },
      { name: 'Reviewer', agent: 'omp-reviewer', task: 'Review beta.', solutionSpace: 'one review', model: 'chosen-model', custom: { second: true } },
      { name: 'Unmapped', agent: 'omp-unmapped', task: 'Leave gamma alone.', custom: { third: true } },
    ],
  };
  const original = structuredClone(input);
  const result = await bridge('spec-injector').tool(event('task', input), context(root), 'PreToolUse');
  assert.ok(result.input, 'real specs and explicit agent mappings must produce updated prompts');
  assert.notEqual(result.block, true);
  assert.equal(result.input.context, input.context);
  assert.deepEqual(result.input.customBatch, input.customBatch);
  assert.deepEqual(result.input.tasks.map(task => task.name), ['Coder', 'Reviewer', 'Unmapped']);
  for (const [index, sentinel, other] of [[0, 'CODING_SENTINEL_713', 'REVIEW_SENTINEL_829'], [1, 'REVIEW_SENTINEL_829', 'CODING_SENTINEL_713']]) {
    const task = result.input.tasks[index];
    assert.match(task.task, new RegExp(sentinel));
    assert.doesNotMatch(task.task, new RegExp(other));
    assert.ok(task.task.endsWith(original.tasks[index].task));
    const { task: rewritten, ...fields } = task;
    const { task: previous, ...originalFields } = original.tasks[index];
    assert.deepEqual(fields, originalFields, 'host-only and custom fields must survive without derived prompt/subagent_type leakage');
  }
  assert.deepEqual(result.input.tasks[2], original.tasks[2]);
  assert.deepEqual(input, original, 'batch projection must not mutate the incoming event');
});

test('real spec-injector rewrites a single task using the explicit default-agent mapping without leaking agent fields', async t => {
  const root = await workspace(t, {
    specInjection: { mapping: { task: { categories: ['coding'] } } },
  });
  await writeFile(path.join(root, '.workflow/specs/coding-conventions.md'), '# Coding\n\nSINGLE_DEFAULT_SENTINEL_941: preserve atomic updates.\n');
  const input = {
    name: 'SingleDefault',
    task: 'Implement the single default-agent change.',
    context: 'single task context',
    solutionSpace: 'one bounded change',
    tools: ['read', 'edit'],
    custom: { keep: true },
  };
  const original = structuredClone(input);
  const result = await bridge('spec-injector').tool(event('task', input), context(root), 'PreToolUse');
  assert.ok(result.input, 'an agent-less single task must use the explicitly configured task mapping');
  assert.notEqual(result.block, true);
  assert.match(result.input.task, /SINGLE_DEFAULT_SENTINEL_941/);
  assert.ok(result.input.task.endsWith(original.task));
  const { task: rewritten, ...fields } = result.input;
  const { task: previous, ...originalFields } = original;
  assert.deepEqual(fields, originalFields);
  for (const field of ['agent', 'subagent_type', 'prompt', 'tasks']) {
    assert.equal(Object.hasOwn(result.input, field), false, `${field} must not leak from the evaluator projection`);
  }
  assert.deepEqual(input, original, 'single-task projection must not mutate the incoming event');
});
