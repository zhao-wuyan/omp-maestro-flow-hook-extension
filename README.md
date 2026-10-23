# OMP Maestro host hooks

将 Maestro 的宿主 Hook 接入 OMP 原生 Extension。无需给 Maestro 安装器添加 OMP 选项，不修改 OMP 核心或 Maestro 安装目录。无运行时 npm 依赖；需要 OMP、Node.js >= 22.19、已安装的 `maestro-flow`。

## 安装与启用

在需要启用的项目目录执行，直接从 GitHub 安装（Windows、macOS、Linux 使用同一条命令）：

```sh
omp plugin install https://github.com/zhao-wuyan/omp-maestro-flow-hook-extension --local
```

`--local` 表示项目级安装，不修改用户全局插件列表。OMP 会下载插件，无需手动 clone 或保留本地源码目录；运行需要已安装的 Maestro 和 Node.js。

如果希望所有项目都可用，可自行选择用户级安装（省略 `--local`）：

```sh
omp plugin install https://github.com/zhao-wuyan/omp-maestro-flow-hook-extension
```

插件 manifest 是 `package.json#omp.extensions`。不要用 `--plugin-dir` 代替。只有本地开发时才使用 `omp plugin install "/absolute/path/to/clone" --local` 链接源码，或 `omp -e "/absolute/path/to/clone/src/index.js"` 临时加载。

首次启动 OMP 后执行：

```text
/maestro-hooks init
```

命令默认在当前 OMP agent 配置目录创建 `maestro-hooks.json`，内容为 `catalog + standard`；随后加载配置、以 resume 语义初始化并显示状态。已有文件（包括损坏的文件）绝不覆盖，需自行修正。若 Maestro CLI 或 Node 缺失，则明确告警并暂停桥接，不影响正常对话和工具；其他配置／协议错误及桥接冲突会明确报错，不把“文件已创建”当作启用成功。

安装动作本身不会生成配置。`init` 是显式授权动作；创建后，后续 OMP 启动会自动读取该用户级配置，无需设置环境变量。不会修改 OMP 主配置、全局环境变量或扫描项目目录中的任意 Hook 文件。

### 配置文件放在哪里

推荐放在 **OMP 的用户配置目录**，文件名使用 `maestro-hooks.json`，与 OMP 自己的 `config.yml` 分开，不把插件字段写入 OMP 主配置：

| 平台 | 默认推荐位置 |
|---|---|
| Windows | `%USERPROFILE%\.omp\agent\maestro-hooks.json` |
| macOS／Linux | `~/.omp/agent/maestro-hooks.json` |

如果通过 `PI_CODING_AGENT_DIR` 或 OMP profile 隔离配置，`init` 自动使用宿主提供的对应 agent 配置目录。也可以让多个 profile 显式引用同一个文件；文件位置不决定插件安装范围，项目级安装仍只对安装项目生效。

也可以手动创建下列 JSON。默认自动查找仅限当前 OMP agent 目录的 `maestro-hooks.json`；其他位置必须显式指定。若 CLI 参数或环境变量已指定配置路径，`init` 在该路径初始化而不是另外生成一份，仍绝不覆盖已有文件。

初始化默认内容：

```json
{
  "version": 1,
  "source": { "kind": "catalog", "level": "standard" }
}
```

### 可选：显式指定其他配置路径

Windows PowerShell：

```powershell
$env:OMP_MAESTRO_HOOKS_CONFIG = Join-Path $HOME ".omp\agent\maestro-hooks.json"
omp
```

macOS／Linux：

```sh
OMP_MAESTRO_HOOKS_CONFIG="$HOME/.omp/agent/maestro-hooks.json" omp
```

以上只对当前进程／终端作用域生效，不会替你持久修改全局环境。也可使用 `omp --maestro-hooks-config "/absolute/path/maestro-hooks.json"`。JSON 中的 `source.path`、`maestroCli`、`node` 若填写，也必须是绝对路径；不要直接写未展开的 `~` 或 `%USERPROFILE%`。

路径优先级：CLI 参数 > 环境变量 > 同进程、同 cwd 父会话的明确授权配置 > 当前 OMP agent 目录的 `maestro-hooks.json`。全部不存在时插件保持禁用，提示执行 `/maestro-hooks init`。显式指定的文件损坏或不存在时会报错，不偷偷退回默认文件。

## 唯一权威来源

每次只选择一种来源，绝不合并 Claude 和 Codex：

- `catalog`：读取当前 Maestro 安装包导出的 Claude host catalog；级别为 `none`、`minimal`、`standard`、`full`。这就是不依赖 Maestro 安装器 OMP 选项的启用方式。
- `claude`：`"source": {"kind":"claude","path":"/absolute/.claude/settings.json"}`。
- `codex`：`"source": {"kind":"codex","path":"/absolute/.codex/hooks.json"}`，保留 Codex 的 SessionStart spec 注入及 matcher，不强行改成 Claude 事件。

文件模式仅执行其中白名单内的 `maestro hooks run <known-name>`，或明确的 `node .../maestro-flow/bin/maestro.js hooks run <known-name>`。不执行原始 shell 文本，不因包含 `maestro` 字样就信任；Orca、git-ai、RTK 等条目被排除。重复 Hook、错配事件、异步／条件 shell 选项、无效 matcher 会明确报错。尊重 Claude `disableAllHooks`。

实际执行始终使用当前 PATH 解析的 Maestro CLI、Node 原生可执行文件和参数数组，不使用来源文件中陈旧的绝对路径。支持 npm／pnpm／mise 常见 shim；无法解析时配置绝对 `maestroCli`（当前 `maestro-flow/bin/maestro.js`）及可选 `node`。验证包名和 bin 清单，不执行 shell 包装器。

Maestro 自身 `hooks.toggles`、`MAESTRO_HOOKS_ENABLE`／`MAESTRO_HOOKS_DISABLE`、工作区识别和 `.workflow/config.json` 仍由原 CLI evaluator 决定。文件模式以实际已安装条目体现安装级别；catalog 模式的级别由上述显式授权决定，不继承另一宿主的安装级别。不会重新实现守卫。

### 哪些配置需要自己维护

| 配置 | 读取方 | 控制范围 |
|---|---|---|
| `maestro-hooks.json` | 本插件 | 是否授权启用、唯一 Hook 来源、catalog 级别、执行预算及可选 CLI 路径 |
| Maestro 全局／项目 `.maestro/config.json`、`MAESTRO_HOOKS_ENABLE`／`MAESTRO_HOOKS_DISABLE` | 原 Maestro CLI | Hook 自身启用状态及配置合并 |
| 项目的 `.workflow/config.json` | 原 Maestro evaluator | 守卫模式、知识门禁、规范注入映射等具体行为 |

桥接配置不是 Maestro 配置的副本。改变插件的 `level` 不会改写 Maestro 配置，也不会覆盖 Maestro 明确关闭的 Hook；反过来，Maestro 开启的 Hook 若不在所选来源／级别中，也不会被桥接执行。

### level 各等级的含义

**`source.level` 只适用于 `source.kind: "catalog"`。** 等级按 `none < minimal < standard < full` 累加，决定哪些 Hook 有资格被调用，不代表强制开启或更强的阻断模式。推荐日常使用 `standard`。

以下按已核对的 Maestro `0.5.92` Claude host catalog 说明；插件运行时读取当前安装版本，不硬编码这些等级归属：

| level | Hook 范围 | 适用情况 |
|---|---|---|
| `none` | 不调用任何宿主 Hook | 暂时停止桥接；若希望连 CLI 定位／配置加载也停用，使用顶层 `"enabled": false` |
| `minimal` | 仅 `spec-injector`，在 `Agent`／OMP `task` 执行前按 Maestro 规则注入规范 | 只需要子代理规范注入，不需要会话上下文、通知、知识门禁或其他守卫 |
| `standard` | 包含 `minimal`，并加入下列会话、提示、工具守卫、通知及 Stop Hook | 推荐默认，覆盖常用 Maestro 宿主能力 |
| `full` | 包含 `standard`，再加入 `workflow-guard` 和 `prompt-guard` | 需要这两个额外守卫，并已检查 Maestro 自身开关与规则配置 |

`standard` 在 `minimal` 基础上新增的完整清单：

- SessionStart：`session-context`、`kg-auto-init`、`search-daemon-start`。
- UserPromptSubmit：`skill-context`、`keyword-spec-injector`、`kg-sync`。
- PreToolUse：`preflight-guard`、`spec-validator`、`knowledge-guard`。
- PostToolUse：`delegate-monitor`、`search-cache-invalidator`。
- Stop：`team-monitor`、`telemetry`、`coordinator-tracker`。

**选择 `full` 不等于强制开启 `workflow-guard`／`prompt-guard`。** evaluator 仍遵守 Maestro 自身 toggle；关闭时可以合法 no-op。告警还是阻断也由 evaluator 决定，不由 level 决定。工作区、matcher、agent 映射等条件同样继续生效。

选择 `claude`／`codex` 文件来源时，执行范围由该文件已有的 Maestro Hook 条目决定，不使用 `source.level` 再筛选，也不额外叠加 catalog。尤其 Codex 的 `minimal` 对应 SessionStart `session-context`，与上表的 Claude catalog `minimal` 不同；不要混为同一套事件。

修改桥接文件后执行 `/maestro-hooks reload`，再用 `/maestro-hooks status` 确认来源及实际加载的 Hook 清单；状态中的调用次数不能证明 evaluator 没有因自身开关而 no-op。

## 事件覆盖

| Maestro | OMP | 处理 |
|---|---|---|
| SessionStart | `session_start`、`session_switch`、`session_branch` | 启动／恢复来源区分，按 matcher 执行；主会话上下文经 `before_agent_start.systemPrompt` |
| UserPromptSubmit | `input`；print/json 的 `before_agent_start` | 真实用户文本；排除 extension 来源及状态命令 |
| PreToolUse | `tool_call` | 阻断、可信 `additionalContext`、`updatedInput` |
| PostToolUse | `tool_result` | 仅成功结果；可信通知，不把错误当成功 |
| Stop | `session_stop` | 仅主会话真正结束；不使用 `turn_end` 或子代理结束 |

当前已知的 17 个 host Hook 全部在白名单中，包括 `coordinator-tracker` 宿主 Stop Hook；不运行 Coordinator 的 `beforeRun`、`afterRun`、`beforeNode` 等进程内 Hook。精确清单由 `/maestro-hooks status` 展示。

`task` 映射为 Claude `Agent`，支持单任务和 `tasks[]`。按子任务执行，`agent`／`task` 投影为 `subagent_type`／`prompt`，更新精确还原，保留批次顺序及其他字段。不凭空把 OMP `task` 当作 Maestro `general-purpose`：Maestro 未映射的 agent 保持其原规则；需要自定义类别时配置 Maestro 自己的 `specInjection.mapping`。

hashline edit 对每个实际目标执行检查，不把派生 `path`／`paths` 写回执行参数；当前 catalog 不改写 edit。未来 evaluator 若要求不能无损转换的 edit `updatedInput`，明确失败，不伪装支持。多个 Hook 按来源顺序执行，后续 Hook 看见前序更新。

## 状态、重载和卸载

```text
/maestro-hooks init
/maestro-hooks status
/maestro-hooks reload
```

显示来源、Maestro 版本、Hook／matcher 清单、已调用次数、加载错误、原生桥接冲突。计数是 CLI 调用次数，不代表 evaluator 一定注入（Maestro 可因 toggle／workspace 合法 no-op）。配置错误后仍可执行恢复命令；重载清除旧上下文，以 resume 语义初始化，不重复 startup-only 副作用。

停用：配置 `"enabled": false` 后重载。卸载：在安装项目执行 `omp plugin uninstall omp-maestro-flow-hooks --local`，清除自己设置的环境变量即可；不移除 Maestro／其他宿主配置。初始化生成的 JSON 会保留，确认其他项目／profile 不再使用后可自行删除。

## 安全与失败策略

- `cwd` 来自事件会话；`session_id` 使用真实 OMP session ID，主／子会话隔离，恢复稳定，与 Maestro 通知文件关联一致。
- 顶层／嵌套 `additionalContext`、嵌套 `updatedInput`、顶层／嵌套 `permissionDecision`、`decision`／`reason`、退出码 2 生效。告警不升级为阻断；其他非零退出为基础设施错误，不冒充业务拒绝。`ask` 没有足够宿主协议时明确报错。
- Maestro CLI 不在 PATH、配置中的安装路径已失效或 Node 无法启动时，会话启动时显示并保存一条告警，暂停 Maestro 桥接；**正常对话和所有工具继续工作**，方便让 AI 安装或修复依赖。状态显示 `enabled: false`、`disabledReason`，不伪装 Hook 已运行，也不逐条消息重复告警。修复后执行 `/maestro-hooks reload` 恢复；不自动安装依赖或改写配置。
- 上述依赖缺失以外的基础设施错误仍在 UI／状态中可见；PreToolUse fail-closed，后续用户提交也停止直至重载恢复。真实 evaluator 的退出码 2／明确 deny 仍阻断工具，不因缺失依赖降级策略而放行。已执行的 PostToolUse 不能回滚，错误通过可信上下文通知。Stop 基础设施错误不制造无限继续。
- 使用原生 `tool_call`／`tool_result.additionalContext`，不是普通工具输出；生命周期使用 `systemPrompt`。Stop 仅明确阻断时继续一次，`stop_hook_active` 防循环；只有遥测副作用时不唤醒模型。
- 原生 `claudeHooks.enabled` 打开即报冲突，不静默叠加；同会话重复插件实例也拒绝。不能识别任意第三方手写扩展的行为，不声称能检测所有外部桥接。
- 默认每次 Hook 5 秒、整个事件 20 秒，可设置 `timeoutMs`／`eventBudgetMs`，最大 20 秒，低于 OMP 默认 30 秒处理时限。stdout／stderr 并行读取、合计 1 MiB 限制；超时杀进程树（Windows `taskkill /T /F`，POSIX process group）。
- 取消：Stop 使用事件 signal；session shutdown／agent end 中止仍运行的工具 Hook。当前 OMP 没有给普通事件公开每次调用的 AbortSignal；用户取消到 `agent_end` 之前存在有限延迟，最多受上述预算约束。Maestro 自己有意启动的后台搜索服务不作为孤儿进程杀掉。
- 插件日志只记录错误类型，不记录 prompt、密钥、stdout 或完整工具输入。Maestro 自己的分析／日志／通知副作用仍按原实现保存，使用前应检查其配置。
- 当前 Maestro evaluator 不需要 `transcript_path`，不生成伪 transcript，也不创建持久敏感副本。工具响应投影为对象，不把 content 数组当作 Claude response；当前 delegate-monitor 实际只读 session 通知，不读取 tool_response。

## 验证与已知限制

```sh
npm test
npm run smoke
npm pack --dry-run
```

`npm test` 使用真实本机 Maestro evaluator，覆盖告警、阻断、通知隔离／读一次、批量及默认单任务规范注入、协议／命令边界、超时／取消／输出限制。`smoke` 自动创建临时隔离目录，真实项目级安装插件并启动 OMP RPC／print，使用本地确定性 HTTP provider 驱动真实工具；结束后清理目录，不使用用户模型凭据或改写用户配置。

已实测：Windows x64，OMP 二进制 `18.12.6`，Maestro `0.5.92`，Node `24.22.1`。接口对照本机 npm 源码 `18.12.4` 及上游 `v18.12.6`。macOS／Linux 尚未实机验证；已提供三平台 CI 回归矩阵，但未把未执行的 CI 当作通过。

没有真实模型凭据的端到端结论。smoke 证明真实 evaluator 告警进入 OMP `developer`／`agent` 可信消息并到达下一次 provider 请求；本机 OpenAI-compatible 测试后端最终 HTTP 序列化为 `user` 角色，此 provider 差异不由插件修补或伪造。真实模型的指令遵循仍需配置凭据后自行验证。

ACP／直接 SDK prompt 未公开可靠的用户来源事件；检测到 ACP 启动时插件明确报错，不声称 UserPromptSubmit 完整兼容。print/json 的外部 SDK 自动注入若绕过 `input` 也无法可靠识别，不应用于此类自动化宿主。OMP 单工具取消信号缺口见上文。

Maestro `0.5.92` 的 `hooks run` 会吞掉部分 evaluator 内部异常并退出 0；桥接不能从成功退出且空 stdout 区分合法 no-op 与内部吞错。保留其 evaluator 语义，不改安装目录；需要 Maestro 上游提供可观测错误协议才能消除此限制。该版本 spec-validator CLI 使用 warn 默认值；不会虚称其 CLI block 分支已验证。

参考：[Maestro 源码](https://github.com/catlog22/maestro-flow)、[OMP Extension](https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md)、[PR #6473 当前代码](https://github.com/can1357/oh-my-pi/pull/6473/files)、[Issue #6446](https://github.com/can1357/oh-my-pi/issues/6446)、[Issue #1433](https://github.com/can1357/oh-my-pi/issues/1433)。PR #6473 调查时仍 open，仅覆盖工具前后事件，不能代替这里的生命周期桥接。
