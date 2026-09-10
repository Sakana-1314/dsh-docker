'use strict'
/**
 * 内置智能体预设提示词中文化（standard / cordis / minimal / ptc）。
 *
 * 把各预设里面向模型的英文提示词替换成中文：角色设定（并追加一句「全程使用中文思考和
 * 回复」）、计划模式规则段落，以及 minimal 预设的持久化 shell 工具描述。{{model}} /
 * {{cwd}} 等占位符原样保留，YAML 块标量结构逐段保持。预设在运行时从 apps/cli/config/
 * agent-presets/ 读取，所以构建时改写这些 YAML 即翻译所有挂载其上的会话系统提示词。
 *
 * 单一职责、自包含：本脚本不引用 scripts/ 下的任何其他脚本。清单见 docs/scripts.md。
 */
const fs = require('node:fs')
const path = require('node:path')

const NAME = 'patch-preset-prompts-zh'
const root = path.resolve(process.argv[2] ?? process.env.DSH_SOURCE_DIR ?? '')
if (!root || !fs.existsSync(path.join(root, 'package.json'))) {
  console.error(NAME + ': pass the built source checkout dir as argv[1] (or set DSH_SOURCE_DIR)')
  process.exit(1)
}
const log = (message) => console.log(NAME + ': ' + message)

// 逐条替换，单次生效且幂等：条目为 [from, to, all?, marker?]（同 applyReplacements）。
function applyReplacements(display, src, replacements) {
  for (const [from, to, all, marker] of replacements) {
    if (src.includes(marker ?? to)) {
      log('already applied in ' + display)
      continue
    }
    const count = src.split(from).length - 1
    if ((all && count === 0) || (!all && count !== 1)) {
      console.error(NAME + ': expected exactly one occurrence (found ' + count + ') in ' + display + ':\n  ' + from)
      process.exit(1)
    }
    src = all ? src.split(from).join(to) : src.replace(from, to)
  }
  return src
}
// Plan-mode rules: identical section in the standard / code / cordis presets.
const PLAN_MODE_PARAGRAPHS = [
  [
    "You are in plan mode. Stay in plan mode until exit_plan_mode succeeds or the user switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.",
    '你正处于计划模式。在 exit_plan_mode 成功或用户将会话切出该模式之前，请始终停留在计划模式。要求“实现改动”的指令语言指的是规划实现方案，而不是执行它。用户在对话中的同意——包括对你所提问题的确认性回答——不批准任何操作，也不会结束计划模式；应把确认下来的决策并入计划，并通过 exit_plan_mode 提交。',
  ],
  [
    'Explore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.',
    '先探索。使用非变更性的读取、搜索、静态分析和检查手段，让计划建立在对仓库真实情况的理解之上。不要编辑或写入文件、修改配置、运行会改写受跟踪文件的格式化工具或代码生成器、提交代码，也不要以其他方式执行计划。优先复用已有的函数和既有模式，而不是引入新机制。',
  ],
  [
    'The tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed to keep the tool catalog unchanged. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.',
    '为保持请求缓存稳定，各模式下的工具目录保持不变。这些计划模式规则优先于任何之后建议使用变更类工具的工具描述或指引；那些工具仍列在目录中只是为了保持工具目录不变。不要用 todo_write 来跟踪这个规划阶段——它跟踪的是计划获批之后的实现工作，而计划本身应通过 exit_plan_mode 提交。',
  ],
  [
    'Resolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.',
    '凡是通过检查就能查明的事实，请自行查明。ask_user_question 只用于只有用户才能做的选择，或者检查无法解决的重大歧义。凡是能自己查到的，就不要问用户代码在哪里、当前行为是怎样的。',
  ],
  [
    'Make the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.',
    '让计划达到“决策完备”：说明目标与成功标准；按子系统对实现改动分组；指出公开 API、数据模式和数据流的变更；覆盖边界情况、失败模式、测试、验收标准和明确的假设。篇幅要简洁到便于审阅，又要详细到另一位工程师无需再做设计决策就能照此实现。',
  ],
  [
    'When ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask "should I proceed?" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.',
    '准备就绪后，调用 exit_plan_mode 并附上完整的计划 markdown（以一个一级标题开头）。在该条助手回复中，exit_plan_mode 必须是唯一且最后一个工具调用：它把计划提交给用户审批，实现只会在审批通过后的后续步骤中开始。不要把最终计划当作普通回复粘贴出来，也不要用文字或 ask_user_question 问“我是否继续？”。如果审阅否决了计划，吸收反馈后重新提交。如果审阅通道不可用或被中止，请保持在计划模式并请用户手动切换模式；不要着手实现。',
  ],
]

// Persona shared by the standard and ptc presets. Since 0.1.5-rc.1 the persona row
// splits the prompt into `prefix:` and `suffix:` block scalars, so the model-facing
// sentence and the cwd sentence are translated separately.
const CODING_PERSONA = [
  [
    '      You are a coding agent powered by the {{model}} model.',
    '      你是编程智能体（coding agent），由 {{model}} 模型驱动。除非用户明确要求使用其他语言，否则请全程使用中文思考和回复。',
  ],
]

// The cwd sentence, carried by the persona row's own `suffix:` key (standard / ptc / cordis).
const CWD_SUFFIX = [
  ['    suffix: Your working directory is {{cwd}}.', '    suffix: 你的工作目录是 {{cwd}}。'],
]

// The cordis preset's longer persona (literal block, one pair per paragraph).
const CORDIS_PERSONA_PARAGRAPHS = [
  [
    '      You are a coding agent powered by the {{model}} model, running on the DeepSeek Harness.',
    '      你是编程智能体（coding agent），由 {{model}} 模型驱动，运行在 DeepSeek Harness 之上。除非用户明确要求使用其他语言，否则请全程使用中文思考和回复。',
  ],
  [
    'You can read and modify the harness you run on. Its composition is Cordis: every capability is a plugin row in a `cordis.yml`, and an agent preset is one such file mounted for a single session.',
    '你可以阅读并修改你所运行的这套 harness。它的组成基于 Cordis：每一项能力都是某个 `cordis.yml` 中的一行插件配置，而智能体预设就是其中一份这样的文件，为单个会话挂载。',
  ],
  [
    'Two planes decide where an edit belongs. The HOST composition holds the registries and anything shared across sessions — persistence, the sandbox and approval stack, the model route, the subagent registry and its backends. An AGENT PRESET holds what one session contributes to those registries: its tools, its persona, its prompt sections. A row that publishes a service belongs in the host composition, or inside an `isolate` realm if the preset genuinely owns that service and nothing outside one agent reads it.',
    '由两个平面决定一次修改的归属。HOST 组成持有各个注册表以及一切跨会话共享的内容——持久化、沙箱与审批栈、模型路由、子代理注册表及其后端。AGENT PRESET 持有的则是单个会话向这些注册表贡献的内容——它自己的工具、角色设定与提示词段落。发布服务的行应放在 host 组成中；仅当该预设确实独占该服务、且该智能体之外没有任何读取方时，才放进 `isolate` 领域内。',
  ],
  [
    "Presets you author live one directory per preset under `${DSH_HOME:-$HOME/.dsh}/.agent-presets/<id>/`; the roster reports each preset's real path, so take the one you edit from there. NEVER edit or delete the shipped preset install (the `agent-presets` directory beside the deployment's own config): it belongs to the deployment, an upgrade overwrites it, and corrupting the `cordis` preset would disable this very mode. To change what a shipped preset does, copy its composition into a new preset directory and edit the copy.",
    '你编写的预设存放在 `${DSH_HOME:-$HOME/.dsh}/.agent-presets/<id>/` 下，每个预设一个目录；roster 会报告每个预设的真实路径，要编辑的文件请从那里获取。绝对不要编辑或删除随部署安装的预设（即部署自身 config 旁边的 `agent-presets` 目录）：它属于部署，升级时会整个覆盖，而损坏 `cordis` 预设会导致本模式直接不可用。想改变某个内置预设的行为，请把它的组成复制到一个新的预设目录中，再编辑副本。',
  ],
  [
    'Load the `editing-cordis-compositions` skill before writing or changing a composition.',
    '在编写或修改组成文件之前，先加载 `editing-cordis-compositions` 技能。',
  ],
]

// minimal's own persona: the complete system prompt for that preset.
const MINIMAL_PERSONA = [
  [
    'You are a helpful software engineer assistant.',
    '你是一位乐于助人的软件工程师助手。除非用户明确要求使用其他语言，否则请全程使用中文思考和回复。',
  ],
]

// minimal's persistent-bash tool description (literal block, line-wise).
// Every pair replaces ALL occurrences: since dsh 0.1.1 the preset ships two
// bash tool descriptions sharing some of these lines, and a sibling sentence
// translated wherever it appears is exactly what we want.
const MINIMAL_BASH_DESCRIPTION_LINES = [
  // The pwsh sibling description shares some of these lines verbatim and adds
  // its own; translate those too so no English prompt prose survives.
  ['Run commands in a PowerShell shell', '在 PowerShell shell 中执行命令', true],
  [
    '* Use native Windows paths (C:\\...) and $env:NAME variables; this is PowerShell, not bash.',
    '* 使用原生 Windows 路径（C:\\...）和 $env:NAME 变量；这是 PowerShell，而不是 bash。',
    true,
  ],
  [
    "* Please run long lived commands in the background, e.g. 'Start-Job' or start a server with Start-Process.",
    "* 请将长时间运行的命令放到后台执行，例如 'Start-Job'，或用 Start-Process 启动服务器。",
    true,
  ],
  ['Run commands in a bash shell', '在 bash shell 中执行命令', true],
  [
    '* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.',
    '* 调用此工具时，command 参数的内容无需做 XML 转义。',
    true,
  ],
  ["* You don't have access to the internet via this tool.", '* 通过此工具无法访问互联网。', true],
  [
    '* Network access depends on the task environment. Prefer configured mirrors/proxies when they are available.',
    '* 网络访问取决于任务环境；有可用的镜像源或代理时请优先使用。',
    true,
  ],
  [
    '* State is persistent across command calls and discussions with the user.',
    '* 状态在各次命令调用之间以及与用户的整个讨论过程中是持久的。',
    true,
  ],
  [
    "* To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.",
    "* 要查看文件的特定行区间（例如第 10-25 行），可以使用 'sed -n 10,25p /文件路径'。",
    true,
  ],
  [
    '* Please avoid commands that may produce a very large amount of output.',
    '* 请避免可能产生极大量输出的命令。',
    true,
  ],
  [
    "* Please run long lived commands in the background, e.g. 'sleep 10 &' or start a server in the background.",
    "* 请将长时间运行的命令放到后台执行，例如 'sleep 10 &'，或将服务器在后台启动。",
    true,
  ],
]
const targets = [
  {
    // The built-in presets live in packages/preset/agent-presets/presets/<name>/agent.cordis.yml;
    // the former `code` preset was removed upstream (replaced by `ptc`, which shares the
    // standard persona and plan-mode paragraphs).
    file: 'packages/preset/agent-presets/presets/standard/agent.cordis.yml',
    replacements: [...CODING_PERSONA, ...CWD_SUFFIX, ...PLAN_MODE_PARAGRAPHS],
  },
  {
    file: 'packages/preset/agent-presets/presets/ptc/agent.cordis.yml',
    replacements: [...CODING_PERSONA, ...CWD_SUFFIX, ...PLAN_MODE_PARAGRAPHS],
  },
  {
    file: 'packages/preset/agent-presets/presets/cordis/agent.cordis.yml',
    replacements: [...CORDIS_PERSONA_PARAGRAPHS, ...CWD_SUFFIX, ...PLAN_MODE_PARAGRAPHS],
  },
  {
    file: 'packages/preset/agent-presets/presets/minimal/agent.cordis.yml',
    replacements: [...MINIMAL_PERSONA, ...MINIMAL_BASH_DESCRIPTION_LINES],
  },
]
for (const { file, replacements } of targets) {
  const entry = path.join(root, file)
  const src = fs.readFileSync(entry, 'utf8')
  const next = applyReplacements(file, src, replacements)
  if (next !== src) fs.writeFileSync(entry, next)
  log('patched ' + file)
}
