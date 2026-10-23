import { access, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HookError, runProcess } from './process.js';

async function exists(file) {
  try { await access(file, constants.F_OK); return true; }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false; throw error; }
}

export async function findExecutable(name, env = process.env) {
  const key = Object.keys(env).find(key => key.toLowerCase() === 'path');
  for (const dir of (env[key] ?? '').split(path.delimiter).filter(Boolean)) {
    for (const suffix of process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']) {
      const file = path.join(dir.replace(/^"|"$/g, ''), name + suffix);
      if (await exists(file)) return file;
    }
  }
  throw new HookError('runtime', `${name} is not available on PATH`);
}

async function verifyCli(file) {
  const cli = await realpath(file);
  const root = path.dirname(path.dirname(cli));
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (manifest.name !== 'maestro-flow' || path.resolve(root, manifest.bin?.maestro ?? '') !== cli) throw new HookError('runtime', 'The configured CLI is not maestro-flow/bin/maestro.js');
  return { cli, root, version: manifest.version };
}

export async function resolveRuntime(config, env = process.env) {
  let runtime;
  if (config.maestroCli) runtime = await verifyCli(config.maestroCli);
  else {
    const command = await findExecutable('maestro', env);
    const resolved = await realpath(command);
    if (resolved.endsWith('.js')) runtime = await verifyCli(resolved);
    else {
      // npm、pnpm 和 mise 的 Node shim：只提取明确的 bin/maestro.js 路径，不运行包装脚本。
      const candidates = [command.replace(/\.exe$/i, '.cmd'), command.replace(/\.(cmd|exe)$/i, '')];
      for (const candidate of candidates) {
        if (!await exists(candidate)) continue;
        const wrapper = await readFile(candidate, 'utf8');
        const match = wrapper.match(/(?:\$basedir|%dp0%|%~dp0|\$PSScriptRoot)[\\/]([^"\r\n]*?[\\/]bin[\\/]maestro\.js)/);
        if (!match) continue;
        runtime = await verifyCli(path.resolve(path.dirname(candidate), match[1].replace(/[\\/]/g, path.sep)));
        break;
      }
      if (!runtime) throw new HookError('runtime', 'Cannot resolve the Maestro launcher; set maestroCli to the current maestro-flow/bin/maestro.js');
    }
  }
  const node = config.node ?? await findExecutable('node', env);
  if (/\.(cmd|bat)$/i.test(node)) throw new HookError('runtime', 'node must be a native executable, not a shell shim');
  const metadataScript = `const m = await import(process.argv[1]); console.log(JSON.stringify({claude:m.HOOK_DEFS,codex:m.CODEX_HOOK_DEFS}));`;
  const metadata = await runProcess(node, ['--input-type=module', '-e', metadataScript, pathToFileURL(path.join(runtime.root, 'dist/src/commands/hooks.js')).href], { timeoutMs: 5000, env });
  if (metadata.code !== 0) throw new HookError('runtime', 'Cannot read the installed Maestro host hook catalog');
  let catalogs;
  try { catalogs = JSON.parse(metadata.stdout); }
  catch { throw new HookError('runtime', 'Invalid installed Maestro catalog'); }
  if (!catalogs.claude || !catalogs.codex) throw new HookError('runtime', 'Installed Maestro does not export its host hook catalog');
  return { ...runtime, node, catalogs };
}
