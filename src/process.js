import path from 'node:path';
import { spawn } from 'node:child_process';

export class HookError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'HookError';
    this.kind = kind;
  }
}

// 始终直接启动可执行文件，不执行配置里的 shell 文本。
export function runProcess(command, args, { cwd, env = process.env, input = '', timeoutMs = 5000, signal, maxBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new HookError('cancelled', 'Maestro hook cancelled'));
    let child;
    try {
      child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      return reject(new HookError('spawn', 'Cannot start the Maestro runtime'));
    }
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let failure;
    let killer;
    const terminate = error => {
      if (failure) return;
      failure = error;
      if (!child.pid) return;
      if (process.platform === 'win32') {
        killer = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL'); }
      }
    };
    const abort = () => terminate(new HookError('cancelled', 'Maestro hook cancelled'));
    const timer = setTimeout(() => terminate(new HookError('timeout', 'Maestro hook exceeded its execution budget')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) {
      stream.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) terminate(new HookError('output-limit', 'Maestro hook exceeded its output limit'));
        else chunks.push(chunk);
      });
    }
    // 提前退出可能关闭 stdin；其他写入错误属于基础设施错误。
    child.stdin.on('error', error => {
      if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') terminate(new HookError('stdin', 'Cannot send Maestro hook input'));
    });
    child.on('error', () => { failure ??= new HookError('spawn', 'Cannot start the Maestro runtime'); });
    child.on('close', (code, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      const finish = () => failure ? reject(failure) : resolve({ code, signal: exitSignal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
      if (killer && killer.exitCode === null && killer.signalCode === null) killer.once('close', finish);
      else finish();
    });
    child.stdin.end(input);
  });
}

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function interpretOutput(result, event) {
  if (result.code !== 0 && result.code !== 2) throw new HookError('exit', `Maestro hook failed (exit ${result.code ?? result.signal ?? 'unknown'})`);
  const text = result.stdout.trim();
  let output = {};
  if (text) {
    try { output = JSON.parse(text); }
    catch {
      if (result.code === 2) output = { reason: text };
      else if (['SessionStart', 'UserPromptSubmit'].includes(event) && !text.startsWith('{') && !text.startsWith('[')) output = { additionalContext: text };
      else throw new HookError('protocol', 'Maestro hook returned invalid JSON');
    }
  }
  if (!record(output)) throw new HookError('protocol', 'Maestro hook output must be an object');
  const specific = output.hookSpecificOutput ?? {};
  if (!record(specific)) throw new HookError('protocol', 'Invalid hookSpecificOutput');
  if (specific.hookEventName !== undefined && specific.hookEventName !== event) throw new HookError('protocol', 'Maestro hook output names a different event');
  const contexts = [];
  for (const value of [output.additionalContext, specific.additionalContext, output.systemMessage]) {
    if (value === undefined) continue;
    if (typeof value !== 'string') throw new HookError('protocol', 'Maestro hook context must be text');
    if (value.trim() && !contexts.includes(value)) contexts.push(value);
  }
  for (const permission of [output.permissionDecision, specific.permissionDecision]) {
    if (permission !== undefined && !['allow', 'deny', 'ask'].includes(permission)) throw new HookError('protocol', 'Unknown Maestro permission decision');
    if (permission === 'ask') throw new HookError('unsupported', 'Maestro permissionDecision=ask needs an interactive approval protocol');
  }
  if (output.decision !== undefined && !['allow', 'approve', 'block'].includes(output.decision)) throw new HookError('protocol', 'Unknown Maestro decision');
  if (specific.updatedInput !== undefined && (!record(specific.updatedInput) || event !== 'PreToolUse')) throw new HookError('protocol', 'updatedInput is only valid for PreToolUse');
  const blocked = result.code === 2 || output.decision === 'block' || output.permissionDecision === 'deny' || specific.permissionDecision === 'deny' || output.continue === false;
  const reason = specific.permissionDecisionReason ?? output.permissionDecisionReason ?? output.reason ?? output.stopReason ?? (result.code === 2 ? result.stderr.trim() : undefined);
  if (reason !== undefined && typeof reason !== 'string') throw new HookError('protocol', 'Maestro hook reason must be text');
  return { blocked, reason: reason || (blocked ? 'Maestro hook denied this operation' : undefined), context: contexts.join('\n\n'), updatedInput: specific.updatedInput };
}
