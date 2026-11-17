import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// 仅替代宿主 UI／设置接口；扩展、配置、Bridge 和子进程取消均使用生产实现。
const hostModules = new Map([
  ['@oh-my-pi/pi-coding-agent/config/settings', 'export const findScopedSettings = () => ({ rawValue: () => false });'],
  ['@oh-my-pi/pi-tui', 'export class TruncatedText {}'],
]);
const loader = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (hostModules.has(specifier)) return { url: `data:text/javascript,${encodeURIComponent(hostModules.get(specifier))}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const { default: maestroHooks } = await import('../src/index.js');
loader.deregister();

async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'omp-hook-lifecycle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'bin'));
  await mkdir(path.join(root, 'dist/src/commands'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'maestro-flow', type: 'module', version: 'test', bin: { maestro: 'bin/maestro.js' } }));
  await writeFile(path.join(root, 'dist/src/commands/hooks.js'), `export const HOOK_DEFS = { 'preflight-guard': { event: 'PreToolUse', matcher: 'Bash|Write|Edit', level: 'standard' } }; export const CODEX_HOOK_DEFS = {};`);
  // 故障注入 CLI：写入调用凭据；slow 在父测试发出结束事件前保持运行。
  await writeFile(path.join(root, 'bin/maestro.js'), `
import { writeFileSync } from 'node:fs';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const event = JSON.parse(input);
writeFileSync(event.tool_use_id, event.tool_name);
if (event.tool_input.command === 'slow') setInterval(() => {}, 1000);
else process.stdout.write(JSON.stringify(event.tool_input.command === 'deny' ? { permissionDecision: 'deny', reason: 'guard-denied' } : { additionalContext: 'guard-checked' }));
`);
  const config = path.join(root, 'bridge.json');
  await writeFile(config, JSON.stringify({ version: 1, node: process.execPath, maestroCli: path.join(root, 'bin/maestro.js'), source: { kind: 'catalog', level: 'standard' } }));
  const handlers = new Map();
  maestroHooks({
    setLabel() {}, registerFlag() {}, registerMessageRenderer() {}, registerCommand() {},
    getFlag: () => config, sendMessage() {}, logger: { warn() {}, error() {} },
    on: (name, handler) => handlers.set(name, handler),
  });
  const ctx = { cwd: root, agent: { kind: 'main' }, mode: 'rpc', sessionManager: { getSessionId: () => path.basename(root), getEntries: () => [] }, ui: { notify() {} } };
  const emit = (name, event = {}) => handlers.get(name)(event, ctx);
  t.after(() => emit('session_shutdown'));
  await emit('session_start');
  const call = (name, tool, command = 'safe') => emit('tool_call', { toolName: tool, input: { path: path.join(root, 'source.js'), command }, toolCallId: path.join(root, name) });
  return { root, emit, call };
}

async function waitForFile(file) {
  const deadline = Date.now() + 4000;
  for (;;) {
    try { await access(file); return; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert(Date.now() < deadline, 'Hook child did not reach its ready marker');
    await delay(10);
  }
}

test('automatic continuations keep Bash/Edit/Write guarded across delayed nonterminal end notifications', async t => {
  const { root, emit, call } = await setup(t);
  await emit('agent_start');
  assert.equal((await call('first', 'bash')).additionalContext, 'guard-checked');
  for (const tool of ['bash', 'edit', 'write']) {
    await emit('agent_end', { willContinue: true, awaitingAsyncWork: true });
    const paused = await call(`${tool}-wake`, tool);
    assert.equal(paused.additionalContext, 'guard-checked');
    await emit('agent_start');
    // 宿主异步投递上一轮的结束通知时，下一轮可能已开始。
    await emit('agent_end', { willContinue: true });
    const result = await call(tool, tool);
    assert.equal(result.block, undefined);
    assert.equal(result.additionalContext, 'guard-checked');
    assert.equal(await readFile(path.join(root, tool), 'utf8'), tool === 'bash' ? 'Bash' : tool === 'edit' ? 'Edit' : 'Write');
  }
  assert.deepEqual(await call('denied', 'bash', 'deny'), { block: true, reason: 'guard-denied' });
});

test('agent end cancels an in-flight hook while the next actual run recovers', async t => {
  const { root, emit, call } = await setup(t);
  await emit('agent_start');
  const pending = call('running', 'bash', 'slow');
  await waitForFile(path.join(root, 'running'));
  await emit('agent_end', { willContinue: false });
  // 下一轮可以在上一轮子进程清理完成前开始；在途调用仍持有原来的取消 signal。
  await emit('agent_start');
  assert.deepEqual(await pending, { block: true, reason: 'Maestro hook cancelled' });
  assert.equal((await call('recovered', 'bash')).additionalContext, 'guard-checked');
});

test('session shutdown cancellation cannot be cleared by a later agent start', async t => {
  const { root, emit, call } = await setup(t);
  await emit('agent_start');
  const pending = call('running', 'bash', 'slow');
  await waitForFile(path.join(root, 'running'));
  await emit('session_shutdown');
  assert.deepEqual(await pending, { block: true, reason: 'Maestro hook cancelled' });
  await emit('agent_start');
  assert.deepEqual(await call('after-shutdown', 'bash'), { block: true, reason: 'Maestro hook cancelled' });
  await assert.rejects(access(path.join(root, 'after-shutdown')), { code: 'ENOENT' });
});
