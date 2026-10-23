import test from 'node:test';
import assert from 'node:assert/strict';
import { commandTokens, parseMaestroCommand, selectHooks } from '../src/config.js';
import { interpretOutput, runProcess } from '../src/process.js';

const isKind = kind => error => error?.name === 'HookError' && error.kind === kind;

test('command authorization accepts argv, never a shell or an unknown evaluator', () => {
  for (const command of [
    'maestro hooks run knowledge-guard',
    '"C:\\Program Files\\maestro.cmd" hooks run knowledge-guard',
    'node "/opt/node_modules/maestro-flow/bin/maestro.js" hooks run knowledge-guard',
  ]) assert.equal(parseMaestroCommand(command), 'knowledge-guard', command);
  for (const command of [
    'sh -c "maestro hooks run knowledge-guard"',
    'cmd /c maestro hooks run knowledge-guard',
    'powershell -Command "maestro hooks run knowledge-guard"',
    'maestro hooks run unknown-evaluator',
    'maestro hooks run knowledge-guard --extra',
    'maestro hooks run knowledge-guard; echo injected',
    'maestro hooks run knowledge-guard && echo injected',
    'maestro hooks run knowledge-guard | echo injected',
    'maestro hooks run knowledge-guard > injected.txt',
    'maestro hooks run knowledge-guard < payload.json',
    'maestro hooks run $(echo knowledge-guard)',
    'maestro hooks run `echo knowledge-guard`',
    'maestro hooks run knowledge-guard\necho injected',
    'node /untrusted/other.js hooks run knowledge-guard',
    'maestro hooks run "knowledge-guard',
  ]) assert.equal(parseMaestroCommand(command), null, command);
  assert.equal(commandTokens('maestro hooks run knowledge-guard; injected'), null);
});

test('hook selection excludes injected/unknown commands and rejects duplicate authorizations', () => {
  const catalog = { 'knowledge-guard': { event: 'PreToolUse' } };
  const entry = command => ({ type: 'command', command });
  const document = commands => ({ hooks: { PreToolUse: [{ matcher: 'Write|Edit', hooks: commands.map(entry) }] } });
  assert.deepEqual(selectHooks(document([
    'maestro hooks run knowledge-guard; echo injected',
    'maestro hooks run unknown-evaluator',
    'cmd /c maestro hooks run knowledge-guard',
  ]), catalog), []);
  assert.throws(() => selectHooks(document([
    'maestro hooks run knowledge-guard',
    '"C:\\bin\\maestro.cmd" hooks run knowledge-guard',
  ]), catalog), isKind('conflict'));
  for (const options of [{ shell: true }, { async: true }, { if: 'true' }]) {
    const value = document(['maestro hooks run knowledge-guard']);
    Object.assign(value.hooks.PreToolUse[0].hooks[0], options);
    assert.throws(() => selectHooks(value, catalog), isKind('config'));
  }
});

test('nonzero evaluator failures are infrastructure errors, whereas exit 2 denies', async () => {
  for (const code of [1, 3, 7]) {
    const result = await runProcess(process.execPath, ['-e', `process.stdout.write(JSON.stringify({decision:'block',reason:'not a valid denial exit'})); process.exitCode=${code}`]);
    assert.equal(result.code, code);
    assert.throws(() => interpretOutput(result, 'PreToolUse'), isKind('exit'));
  }
  const denied = await runProcess(process.execPath, ['-e', "process.stdout.write(JSON.stringify({reason:'policy denial'})); process.exitCode=2"]);
  assert.deepEqual(interpretOutput(denied, 'PreToolUse'), {
    blocked: true, reason: 'policy denial', context: '', updatedInput: undefined,
  });
  assert.equal(interpretOutput({ code: 0, stdout: JSON.stringify({ decision: 'allow', additionalContext: 'warning' }) }, 'PreToolUse').blocked, false);
});

test('protocol rejects malformed outputs, event confusion, interactive asks and invalid updates', () => {
  for (const stdout of ['not JSON', '[]', 'null', '{invalid', JSON.stringify({ hookSpecificOutput: [] }), JSON.stringify({ additionalContext: 7 }), JSON.stringify({ decision: 'maybe' }), JSON.stringify({ reason: {} }), JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop' } }), JSON.stringify({ hookSpecificOutput: { updatedInput: [] } })]) {
    assert.throws(() => interpretOutput({ code: 0, stdout }, 'PreToolUse'), isKind('protocol'), stdout);
  }
  assert.equal(interpretOutput({ code: 2, stdout: 'policy denial', stderr: '' }, 'PreToolUse').blocked, true);
  assert.throws(() => interpretOutput({ code: 0, stdout: JSON.stringify({ permissionDecision: 'ask' }) }, 'PreToolUse'), isKind('unsupported'));
  assert.throws(() => interpretOutput({ code: 0, stdout: JSON.stringify({ hookSpecificOutput: { updatedInput: { prompt: 'wrong phase' } } }) }, 'PostToolUse'), isKind('protocol'));
  assert.equal(interpretOutput({ code: 0, stdout: 'real session context' }, 'SessionStart').context, 'real session context');
});

test('runProcess forwards stdin and captures stdout/stderr from a real child', async () => {
  const result = await runProcess(process.execPath, ['-e', "process.stdin.setEncoding('utf8');let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{process.stdout.write(input.toUpperCase());process.stderr.write('diagnostic');});"], { input: 'input payload' });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'INPUT PAYLOAD');
  assert.equal(result.stderr, 'diagnostic');
});

test('runProcess cancels a running real child and rejects an already-aborted invocation', async t => {
  const controller = new AbortController();
  const pending = runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal, timeoutMs: 10000 });
  const timer = setTimeout(() => controller.abort(), 250);
  t.after(() => clearTimeout(timer));
  await assert.rejects(pending, isKind('cancelled'));
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.exit(99)'], { signal: aborted.signal }), isKind('cancelled'));
});

test('runProcess enforces execution deadlines on a real child', async () => {
  await assert.rejects(runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 250 }), isKind('timeout'));
});

test('runProcess limits combined stdout and stderr bytes and terminates noisy children', async () => {
  for (const source of [
    "process.stdout.write('x'.repeat(8192));setInterval(()=>{},1000)",
    "process.stderr.write('x'.repeat(8192));setInterval(()=>{},1000)",
    "process.stdout.write('x'.repeat(3072));process.stderr.write('y'.repeat(3072));setInterval(()=>{},1000)",
  ]) {
    await assert.rejects(runProcess(process.execPath, ['-e', source], { maxBytes: 4096, timeoutMs: 10000 }), isKind('output-limit'));
  }
  const boundary = await runProcess(process.execPath, ['-e', "process.stdout.write('x'.repeat(2048));process.stderr.write('y'.repeat(2048))"], { maxBytes: 4096 });
  assert.equal(boundary.code, 0);
  assert.equal(Buffer.byteLength(boundary.stdout) + Buffer.byteLength(boundary.stderr), 4096);
});
