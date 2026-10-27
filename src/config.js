import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { HookError } from './process.js';
import { resolveRuntime } from './runtime.js';

export const HOST_HOOKS = new Set(['session-context', 'kg-auto-init', 'search-daemon-start', 'spec-injector', 'skill-context', 'keyword-spec-injector', 'kg-sync', 'prompt-guard', 'preflight-guard', 'spec-validator', 'knowledge-guard', 'workflow-guard', 'delegate-monitor', 'search-cache-invalidator', 'team-monitor', 'telemetry', 'coordinator-tracker']);
const EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']);
const LEVELS = ['none', 'minimal', 'standard', 'full'];
const base = value => value.replace(/\\/g, '/').split('/').pop().toLowerCase();

// 仅识别 argv，不解释变量、重定向、管道或 shell 运算符。
export function commandTokens(command) {
  if (typeof command !== 'string') return null;
  const tokens = [];
  let token = '';
  let quote;
  for (const char of command.trim()) {
    if (quote) {
      if (char === quote) quote = undefined;
      else token += char;
    } else if (char === '"' || char === "'") quote = char;
    else if (/\s/.test(char)) { if (token) { tokens.push(token); token = ''; } }
    else if (/[;&|<>`$\n\r]/.test(char)) return null;
    else token += char;
  }
  if (quote) return null;
  if (token) tokens.push(token);
  return tokens;
}

export function parseMaestroCommand(command) {
  const tokens = commandTokens(command);
  if (!tokens) return null;
  let rest;
  if (['maestro', 'maestro.cmd', 'maestro.exe'].includes(base(tokens[0] ?? ''))) rest = tokens.slice(1);
  else if (['node', 'node.exe'].includes(base(tokens[0] ?? '')) && /(?:^|\/)maestro-flow\/bin\/maestro\.js$/i.test((tokens[1] ?? '').replace(/\\/g, '/'))) rest = tokens.slice(2);
  else return null;
  if (rest.length !== 3 || rest[0] !== 'hooks' || rest[1] !== 'run' || !HOST_HOOKS.has(rest[2])) return null;
  return rest[2];
}

export function selectHooks(document, catalog) {
  if (!document || typeof document !== 'object' || !document.hooks || typeof document.hooks !== 'object') throw new HookError('config', 'Hook source must contain a hooks object');
  if (document.disableAllHooks === true) return [];
  const hooks = [];
  const seen = new Set();
  for (const [event, groups] of Object.entries(document.hooks)) {
    if (!Array.isArray(groups)) throw new HookError('config', 'Hook event groups must be arrays');
    for (const group of groups) {
      if (!Array.isArray(group.hooks)) throw new HookError('config', 'Hook group must contain a hooks array');
      for (const entry of group.hooks) {
        const name = parseMaestroCommand(entry.command);
        if (!name) continue;
        if (entry.type !== 'command' || entry.async || entry.if || entry.shell) throw new HookError('config', `Unsupported execution options for ${name}`);
        if (!EVENTS.has(event) || catalog[name]?.event !== event) throw new HookError('config', `Hook ${name} is assigned to the wrong host event`);
        const matcher = group.matcher ?? '';
        if (typeof matcher !== 'string') throw new HookError('config', 'Hook matcher must be text');
        compileMatcher(matcher);
        if (seen.has(name)) throw new HookError('conflict', `Duplicate Maestro hook: ${name}`);
        seen.add(name);
        hooks.push({ name, event, matcher, timeoutMs: entry.timeout === undefined ? undefined : checkedTimeout(entry.timeout * 1000) });
      }
    }
  }
  return hooks;
}

function checkedTimeout(value) {
  if (!Number.isFinite(value) || value < 1 || value > 20000) throw new HookError('config', 'Hook timeout must be between 1 and 20000 ms');
  return value;
}

export function compileMatcher(matcher) {
  if (!matcher || matcher === '*') return () => true;
  let regex;
  try { regex = new RegExp(`^(?:${matcher})$`); }
  catch { throw new HookError('config', 'Invalid Maestro hook matcher'); }
  return value => regex.test(value);
}

export async function initializeConfig(file) {
  if (!path.isAbsolute(file)) throw new HookError('config', 'The initialization path must be absolute');
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(file, JSON.stringify({ version: 1, source: { kind: 'catalog', level: 'standard' } }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { created: true, file };
  } catch (error) {
    if (error.code === 'EEXIST') return { created: false, file };
    throw error;
  }
}

export async function initializeLearning(cwd) {
  const workflow = path.join(cwd, '.workflow');
  try {
    if (!(await stat(workflow)).isDirectory()) return;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return;
    throw error;
  }
  // 不递归创建父目录：普通项目不会因此获得 .workflow，也不伪造搜索记录。
  try { await mkdir(path.join(workflow, 'learning')); }
  catch (error) {
    if (error.code !== 'EEXIST' || !(await stat(path.join(workflow, 'learning'))).isDirectory()) throw error;
  }
}

export async function defaultConfigPath(agentDir) {
  const file = path.join(agentDir, 'maestro-hooks.json');
  try { await readFile(file, 'utf8'); return file; }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

export async function loadBridgeConfig(file, env = process.env) {
  if (!file) return { enabled: false, hooks: [], reason: 'No authorized configuration; run /maestro-hooks init or specify --maestro-hooks-config / OMP_MAESTRO_HOOKS_CONFIG' };
  if (!path.isAbsolute(file)) throw new HookError('config', 'The bridge configuration path must be absolute');
  const config = JSON.parse(await readFile(file, 'utf8'));
  if (config.enabled === false) return { enabled: false, hooks: [], file, reason: 'Disabled in bridge configuration' };
  if (config.version !== 1) throw new HookError('config', 'Expected bridge configuration version 1');
  const source = config.source;
  if (!source || !['catalog', 'claude', 'codex'].includes(source.kind)) throw new HookError('config', 'Choose exactly one catalog, claude or codex source');
  for (const key of ['maestroCli', 'node']) {
    if (config[key] !== undefined && (typeof config[key] !== 'string' || !path.isAbsolute(config[key]))) throw new HookError('config', `${key} must be an absolute path`);
  }
  let runtime;
  try { runtime = await resolveRuntime(config, env); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.kind === 'spawn') {
      throw new HookError('unavailable', 'The Maestro CLI or Node runtime is missing or cannot be started');
    }
    throw error;
  }
  const catalog = runtime.catalogs[source.kind === 'codex' ? 'codex' : 'claude'];
  let hooks;
  if (source.kind === 'catalog') {
    if (!LEVELS.includes(source.level)) throw new HookError('config', 'Catalog source requires level: none|minimal|standard|full');
    hooks = Object.entries(catalog).filter(([name, def]) => HOST_HOOKS.has(name) && LEVELS.indexOf(def.level) <= LEVELS.indexOf(source.level)).map(([name, def]) => ({ name, event: def.event, matcher: def.matcher ?? '' }));
  } else {
    if (typeof source.path !== 'string' || !path.isAbsolute(source.path)) throw new HookError('config', 'Hook source path must be explicitly authorized and absolute');
    hooks = selectHooks(JSON.parse(await readFile(source.path, 'utf8')), catalog);
  }
  return { enabled: true, file, source, runtime, hooks, timeoutMs: checkedTimeout(config.timeoutMs ?? 5000), eventBudgetMs: checkedTimeout(config.eventBudgetMs ?? 20000) };
}
