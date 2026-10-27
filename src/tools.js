import { HookError } from './process.js';

export const TOOL_NAMES = { bash: 'Bash', write: 'Write', edit: 'Edit', read: 'Read', grep: 'Grep', glob: 'Glob', task: 'Agent' };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function toolViews(toolName, input) {
  // xd 是工具设备调用，不是文件写入；local/ssh 等文件资源仍走原守卫。
  if (toolName === 'write' && typeof input.path === 'string' && /^xd:\/\//i.test(input.path)) return [];
  const name = TOOL_NAMES[toolName] ?? toolName;
  if (toolName === 'task') {
    const tasks = Array.isArray(input.tasks) ? input.tasks : [input];
    return tasks.map((task, index) => {
      if (!object(task) || typeof task.task !== 'string') throw new HookError('input', 'OMP subtask must contain task text');
      return { name, index: Array.isArray(input.tasks) ? index : undefined, input: { ...task, subagent_type: task.agent?.trim() || 'task', prompt: task.task } };
    });
  }
  if (toolName === 'edit') {
    const paths = Array.isArray(input.paths) ? input.paths : [input.path ?? input._path].filter(Boolean);
    if (!paths.length) throw new HookError('input', 'Cannot determine every target of the OMP edit operation');
    return paths.map(file => ({ name, input: { ...input, file_path: file } }));
  }
  return [{ name, input: { ...input, ...(typeof input.path === 'string' ? { file_path: input.path } : {}) } }];
}

export function applyUpdate(toolName, original, view, updated) {
  if (toolName === 'task') {
    const task = { ...(view.index === undefined ? original : original.tasks[view.index]) };
    for (const [key, value] of Object.entries(updated)) {
      if (key === 'prompt' || key === 'subagent_type' || key === 'task') continue;
      task[key] = value;
    }
    if (updated.prompt !== undefined) task.task = updated.prompt;
    if (updated.subagent_type !== undefined && updated.subagent_type !== view.input.subagent_type) task.agent = updated.subagent_type;
    return view.index === undefined ? task : { ...original, tasks: original.tasks.map((item, index) => index === view.index ? task : item) };
  }
  // edit 的 path/paths 是派生检查字段，无法把 Claude 单文件改写无损还原为 hashline patch。
  if (toolName === 'edit') throw new HookError('unsupported', 'updatedInput for OMP edit requires a native patch transformation');
  const result = { ...original };
  for (const [key, value] of Object.entries(updated)) {
    if (key === 'file_path') result.path = value;
    else result[key] = value;
  }
  return result;
}

export function toolResponse(event) {
  const text = event.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
  if (event.toolName === 'bash') return { stdout: text, stderr: '', ...(typeof event.details?.exitCode === 'number' ? { exitCode: event.details.exitCode } : {}), interrupted: false };
  if (event.toolName === 'write' || event.toolName === 'edit') return { filePath: event.input.path ?? event.input.paths, success: !event.isError, output: text };
  return { output: text, ...(object(event.details) ? { details: event.details } : {}) };
}
