import { Bridge } from './bridge.js';
import { defaultConfigPath, initializeConfig, loadBridgeConfig } from './config.js';
import { HookError } from './process.js';
import { findScopedSettings } from '@oh-my-pi/pi-coding-agent/config/settings';
import { TruncatedText } from '@oh-my-pi/pi-tui';
import path from 'node:path';

const INSTANCE = Symbol.for('omp.maestro-flow-hooks.instances');
const CONFIGS = Symbol.for('omp.maestro-flow-hooks.authorized-configs');
const instances = globalThis[INSTANCE] ??= new Map();
const authorizedConfigs = globalThis[CONFIGS] ??= new Map();

export default function maestroHooks(api) {
  api.setLabel('Maestro host hooks');
  api.registerFlag('maestro-hooks-config', { type: 'string', description: 'Absolute path to explicitly authorized Maestro bridge JSON' });
  for (const type of ['maestro-hooks-debug-state', 'maestro-hooks-summary']) {
    api.registerMessageRenderer(type, (message, _options, theme) => new TruncatedText(theme.fg('dim', message.content), 1, 0));
  }
  let bridge;
  let configFile;
  let failure;
  let startupContext = '';
  let promptContext = '';
  let deferredContext = '';
  let startedSession;
  const shuttingDown = new AbortController();
  const ownedSessions = new Set();
  let ignoredExtensionPrompts = 0;
  let operation = new AbortController();
  const debugSessions = new Set();
  const summarizedSessions = new Set();
  const debugEnabled = ctx => debugSessions.has(ctx.sessionManager.getSessionId());
  const reportInvocation = ({ sessionId, event, hook, durationMs, outcome }, ctx) => {
    if (!debugSessions.has(sessionId)) return;
    // triggerTurn:false 在宿主忙碌时仍会进入 steer 队列；调试输出只能走被动 UI 通知。
    ctx.ui.notify(`[Maestro Hook] ${event} / ${hook} · ${durationMs} ms · ${outcome}`, 'info');
  };
  const summarize = ctx => {
    if (ctx.agent.kind !== 'main') return;
    const id = ctx.sessionManager.getSessionId();
    if (summarizedSessions.has(id)) return;
    summarizedSessions.add(id);
    if (failure || bridge?.config.reason?.startsWith('Maestro is unavailable:')) return;
    const config = bridge?.config;
    const source = config?.source;
    const content = config?.enabled
      ? `[Maestro Hooks] 已启用 · ${source.kind}${source.level ? `/${source.level}` : ''} · ${config.hooks.length} 个 Hook · Maestro ${config.runtime.version} · debug ${debugEnabled(ctx) ? '开启' : '关闭'}`
      : `[Maestro Hooks] 未启用 · ${config?.reason ?? '无可用配置'} · /maestro-hooks init`;
    api.sendMessage({ customType: 'maestro-hooks-summary', display: true, content }, { triggerTurn: false });
  };

  api.on('context', event => {
    const uiOnly = new Set(['maestro-hooks-debug', 'maestro-hooks-debug-state', 'maestro-hooks-summary']);
    if (!event.messages.some(message => message.role === 'custom' && uiOnly.has(message.customType))) return;
    return { messages: event.messages.filter(message => message.role !== 'custom' || !uiOnly.has(message.customType)) };
  });

  const fail = (error, ctx) => {
    const kind = error instanceof HookError ? error.kind : 'config';
    // 只记录错误类型；不记录配置原文、prompt、stdout 或工具参数。
    const detail = error instanceof HookError ? error.message : 'Cannot load the authorized JSON configuration or Maestro installation';
    failure = `Maestro hook infrastructure error (${kind}): ${detail}. Run /maestro-hooks status or reload.`;
    api.logger.error('Maestro hook bridge failed', { kind });
    ctx.ui.notify(failure, 'error');
    return failure;
  };

  const conflict = ctx => {
    // 宿主 AsyncLocalStorage 提供当前会话设置，不初始化或修改全局状态。
    const settings = findScopedSettings(ctx.cwd);
    if (!settings || typeof settings.rawValue !== 'function') throw new HookError('conflict', 'Cannot inspect session-native hook settings on this OMP version');
    const enabled = settings.rawValue({ segments: ['claudeHooks', 'enabled'], definition: {} });
    if (enabled !== undefined && typeof enabled !== 'boolean') throw new HookError('conflict', 'Cannot determine native Claude hook ownership');
    if (enabled) throw new HookError('conflict', 'Native Claude hooks are enabled; disable the native bridge or this extension, not both together');
  };

  async function reload(ctx) {
    bridge = undefined;
    failure = undefined;
    startupContext = '';
    promptContext = '';
    deferredContext = '';
    startedSession = undefined;
    configFile = api.getFlag('maestro-hooks-config') || process.env.OMP_MAESTRO_HOOKS_CONFIG || authorizedConfigs.get(ctx.cwd);
    try {
      configFile ??= await defaultConfigPath(findScopedSettings(ctx.cwd).getAgentDir());
      const config = await loadBridgeConfig(configFile);
      if (!config.enabled) { bridge = new Bridge(config); return; }
      if (process.argv.includes('acp')) throw new HookError('unsupported', 'ACP has no reliable UserPromptSubmit provenance in the current OMP API; use RPC, TUI or print');
      conflict(ctx);
      const id = ctx.sessionManager.getSessionId();
      if (instances.has(id) && instances.get(id) !== api) throw new HookError('conflict', 'Another Maestro bridge instance owns this session');
      instances.set(id, api);
      ownedSessions.add(id);
      authorizedConfigs.set(ctx.cwd, configFile);
      bridge = new Bridge(config, row => reportInvocation(row, ctx));
    } catch (error) {
      if (error instanceof HookError && error.kind === 'unavailable') {
        const reason = `Maestro is unavailable: ${error.message}. Maestro hooks are suspended; conversation and tools remain available. Install or repair Maestro, then run /maestro-hooks reload.`;
        bridge = new Bridge({ enabled: false, hooks: [], reason });
        api.logger.warn('Maestro hook bridge suspended', { kind: error.kind });
        api.sendMessage({ customType: 'maestro-hooks-warning', display: true, content: reason }, { triggerTurn: false });
      } else fail(error, ctx);
    }
  }

  const enabled = ctx => {
    if (!bridge?.config.enabled || failure) return false;
    try { conflict(ctx); return true; }
    catch (error) { fail(error, ctx); return false; }
  };

  async function start(ctx, source) {
    if (ctx.agent.kind !== 'main') return;
    const id = ctx.sessionManager.getSessionId();
    if (id === startedSession) return;
    startedSession = id;
    startupContext = '';
    promptContext = '';
    deferredContext = '';
    if (!enabled(ctx)) return;
    try {
      const result = await bridge.lifecycle('SessionStart', ctx, { source }, shuttingDown.signal);
      startupContext = result.context;
      if (result.blocked) failure = result.reason;
    } catch (error) { fail(error, ctx); }
  }

  api.on('session_start', async (_event, ctx) => {
    await reload(ctx);
    const source = process.argv.some(arg => ['--resume', '-r', '--continue', '-c', '--restore'].includes(arg) || /^--(?:resume|restore)=/.test(arg)) || ctx.sessionManager.getEntries().some(entry => entry.type === 'message') ? 'resume' : 'startup';
    await start(ctx, source);
    summarize(ctx);
  });
  api.on('session_switch', async (event, ctx) => { await start(ctx, event.reason === 'new' ? 'startup' : 'resume'); summarize(ctx); });
  api.on('session_branch', async (_event, ctx) => { await start(ctx, 'resume'); summarize(ctx); });

  api.on('input', async (event, ctx) => {
    if (operation.signal.aborted) operation = new AbortController();
    if (/^\/maestro-hooks(?:\s|$)/.test(event.text.trim())) return;
    if (event.source === 'extension') { ignoredExtensionPrompts++; return; }
    if (ctx.agent.kind !== 'main') return;
    promptContext = '';
    if (failure) { ctx.ui.notify(failure, 'error'); return { handled: true }; }
    if (!enabled(ctx)) return failure ? { handled: true } : undefined;
    try {
      const result = await bridge.lifecycle('UserPromptSubmit', ctx, { prompt: event.text, user_prompt: event.text }, shuttingDown.signal);
      if (result.blocked) { ctx.ui.notify(result.reason, 'error'); return { handled: true }; }
      promptContext = result.context;
    } catch (error) { fail(error, ctx); return { handled: true }; }
  });

  api.on('before_agent_start', async (event, ctx) => {
    if (ctx.agent.kind !== 'main') return;
    if (failure) { ctx.abort(); return; }
    if (operation.signal.aborted) operation = new AbortController();
    // print/json 模式没有 input 事件；只处理真实 CLI 提交。
    if (['print', 'json'].includes(ctx.mode) && !ignoredExtensionPrompts && enabled(ctx)) {
      try {
        const result = await bridge.lifecycle('UserPromptSubmit', ctx, { prompt: event.prompt, user_prompt: event.prompt }, shuttingDown.signal);
        promptContext = result.context;
        if (result.blocked) failure = result.reason;
      } catch (error) { fail(error, ctx); }
    }
    if (ignoredExtensionPrompts) ignoredExtensionPrompts--;
    const context = [promptContext, deferredContext].filter(Boolean).join('\n\n');
    // 稳定启动策略留在 system；动态上下文作为宿主可信消息追加并持久化，避免改写历史前缀。
    promptContext = '';
    deferredContext = '';
    if (failure) { ctx.abort(); return; }
    return {
      ...(startupContext ? { systemPrompt: [...event.systemPrompt, startupContext] } : {}),
      ...(context ? { message: { customType: 'maestro-hooks-context', content: context, display: false, attribution: 'agent' } } : {}),
    };
  });

  api.on('tool_call', async (event, ctx) => {
    if (failure) return { block: true, reason: failure };
    if (!enabled(ctx)) return failure ? { block: true, reason: failure } : undefined;
    const signal = AbortSignal.any([operation.signal, shuttingDown.signal]);
    try { return await bridge.tool(event, ctx, 'PreToolUse', signal); }
    catch (error) { return { block: true, reason: signal.aborted ? 'Maestro hook cancelled' : fail(error, ctx) }; }
  });
  api.on('tool_result', async (event, ctx) => {
    if (!enabled(ctx) || event.isError) return;
    const signal = AbortSignal.any([operation.signal, shuttingDown.signal]);
    try { return await bridge.tool(event, ctx, 'PostToolUse', signal); }
    catch (error) { if (!signal.aborted) return { additionalContext: fail(error, ctx) }; }
  });

  api.on('session_stop', async (event, ctx) => {
    if (ctx.agent.kind !== 'main' || event.stop_hook_active || !enabled(ctx)) return;
    try {
      const result = await bridge.lifecycle('Stop', ctx, { stop_hook_active: event.stop_hook_active }, event.signal);
      if (result.blocked) return { decision: 'block', reason: result.reason, additionalContext: result.context || undefined };
      // 只有明确 block 才继续；遥测及普通告知不能自行唤醒模型。
      if (result.context) deferredContext = result.context;
    } catch (error) { fail(error, ctx); }
  });

  api.registerCommand('maestro-hooks', {
    description: 'Maestro hook bridge: init | status | reload | debug [on|off]',
    handler: async (args, ctx) => {
      const command = args.trim();
      if (/^debug(?:\s|$)/.test(command)) {
        if (!['debug', 'debug on', 'debug off'].includes(command)) { ctx.ui.notify('Usage: /maestro-hooks debug [on|off]', 'warning'); return; }
        const id = ctx.sessionManager.getSessionId();
        if (command === 'debug on') debugSessions.add(id);
        if (command === 'debug off') debugSessions.delete(id);
        api.sendMessage({ customType: 'maestro-hooks-debug-state', display: true, content: `Maestro Hook debug ${debugEnabled(ctx) ? '已开启' : '已关闭'}，仅当前会话生效。` }, { triggerTurn: false });
        return;
      }
      if (args.trim() === 'init') {
        try {
          const file = api.getFlag('maestro-hooks-config') || process.env.OMP_MAESTRO_HOOKS_CONFIG || path.join(findScopedSettings(ctx.cwd).getAgentDir(), 'maestro-hooks.json');
          const result = await initializeConfig(file);
          ctx.ui.notify(`${result.created ? 'Created catalog + standard configuration' : 'Existing configuration preserved'}: ${file}`, 'info');
          await reload(ctx);
          await start(ctx, 'resume');
        } catch (error) { fail(error, ctx); }
      } else if (args.trim() === 'reload') { await reload(ctx); await start(ctx, 'resume'); }
      else if (args.trim() && args.trim() !== 'status') { ctx.ui.notify('Usage: /maestro-hooks init | status | reload | debug [on|off]', 'warning'); return; }
      const config = bridge?.config;
      api.sendMessage({ customType: 'maestro-hooks-status', display: true, content: JSON.stringify({
        enabled: !!config?.enabled && !failure, configuration: configFile ?? null, source: config?.source ?? null,
        debug: debugEnabled(ctx),
        maestroVersion: config?.runtime?.version ?? null,
        hooks: config?.hooks ?? [], counts: bridge?.counts ?? {}, error: failure ?? null,
        disabledReason: config?.reason ?? null, nativeOverlap: failure?.includes('conflict') ? 'conflict' : 'none detected',
      }, null, 2) }, { triggerTurn: false });
    },
  });

  api.on('agent_end', () => { operation.abort(); });
  api.on('session_shutdown', () => {
    shuttingDown.abort();
    for (const id of ownedSessions) if (instances.get(id) === api) instances.delete(id);
  });
}
