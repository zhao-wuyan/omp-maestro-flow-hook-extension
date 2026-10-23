import { compileMatcher } from './config.js';
import { HookError, interpretOutput, runProcess } from './process.js';
import { applyUpdate, toolResponse, toolViews } from './tools.js';

export function sessionId(ctx) {
  const id = ctx.sessionManager.getSessionId();
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new HookError('session', 'OMP did not provide a safe stable session id');
  return id;
}

export class Bridge {
  constructor(config, onInvocation) { this.config = config; this.counts = {}; this.onInvocation = onInvocation; }

  async invoke(hook, input, deadline, signal) {
    const started = performance.now();
    let outcome = 'error';
    try {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new HookError('timeout', 'Maestro event exceeded its execution budget');
      const { runtime } = this.config;
      const result = await runProcess(runtime.node, [runtime.cli, 'hooks', 'run', hook.name], {
        cwd: input.cwd,
        // 不继承另一宿主遗留的项目定位变量，工作目录由实际事件提供。
        env: { ...process.env, MAESTRO_PROJECT_ROOT: input.cwd, CLAUDE_PROJECT_DIR: input.cwd },
        input: JSON.stringify(input),
        timeoutMs: Math.min(hook.timeoutMs ?? this.config.timeoutMs, remaining), signal,
      });
      this.counts[hook.name] = (this.counts[hook.name] ?? 0) + 1;
      const output = interpretOutput(result, input.hook_event_name);
      const outcomes = [];
      if (output.blocked) outcomes.push('blocked');
      if (output.updatedInput) outcomes.push('updated');
      if (output.context) outcomes.push('context');
      outcome = outcomes.join('+') || 'no-output';
      return output;
    } catch (error) {
      outcome = ['timeout', 'cancelled'].includes(error.kind) ? error.kind : 'error';
      throw error;
    } finally {
      this.onInvocation?.({ sessionId: input.session_id, event: input.hook_event_name, hook: hook.name, durationMs: Math.round(performance.now() - started), outcome });
    }
  }

  async lifecycle(event, ctx, extra = {}, signal) {
    const contexts = [];
    let blocked = false;
    let reason;
    const deadline = Date.now() + this.config.eventBudgetMs;
    for (const hook of this.config.hooks.filter(hook => hook.event === event)) {
      if (event === 'SessionStart' && !compileMatcher(hook.matcher)(extra.source)) continue;
      const output = await this.invoke(hook, { hook_event_name: event, cwd: ctx.cwd, session_id: sessionId(ctx), ...extra }, deadline, signal);
      if (output.updatedInput) throw new HookError('protocol', 'Lifecycle hook cannot rewrite tool input');
      if (output.context) contexts.push(output.context);
      if (output.blocked) { blocked = true; reason = output.reason; break; }
    }
    return { blocked, reason, context: contexts.join('\n\n') };
  }

  async tool(event, ctx, phase, signal) {
    if (phase === 'PostToolUse' && event.isError) return;
    const deadline = Date.now() + this.config.eventBudgetMs;
    const contexts = [];
    let effective = event.input;
    let changed = false;
    for (const hook of this.config.hooks.filter(hook => hook.event === phase)) {
      // 每个 Hook 重新投影当前输入；后续 Hook 看见已应用的修改。
      for (const view of toolViews(event.toolName, effective)) {
        if (!compileMatcher(hook.matcher)(view.name)) continue;
        const output = await this.invoke(hook, {
          hook_event_name: phase, cwd: ctx.cwd, session_id: sessionId(ctx),
          tool_name: view.name, tool_use_id: event.toolCallId, tool_input: view.input,
          ...(phase === 'PostToolUse' ? { tool_response: toolResponse({ ...event, input: effective }) } : {}),
        }, deadline, signal);
        if (output.context) contexts.push(output.context);
        if (output.blocked) {
          if (phase !== 'PreToolUse') throw new HookError('protocol', 'PostToolUse cannot prevent an already executed tool');
          return { block: true, reason: [output.reason, ...contexts].filter(Boolean).join('\n\n') };
        }
        if (output.updatedInput) {
          effective = applyUpdate(event.toolName, effective, view, output.updatedInput);
          changed = true;
        }
      }
    }
    return { ...(changed ? { input: effective } : {}), ...(contexts.length ? { additionalContext: contexts.join('\n\n') } : {}) };
  }
}
