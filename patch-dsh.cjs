'use strict'
// Build-time patch for dsh's compiled packages, applied to a SOURCE checkout.
//
// dsh is built from the deepseek-harness monorepo (pnpm workspace): each
// package's compiled bundle lives in-package (packages/<tier>/<name>/lib).
// This script locates each target package by name (no reliance on npm's
// global-install layout, which pnpm's isolation does not reproduce), patches
// its built bundle in place, and bakes in `process.env.*` READs (not literal
// values) so the value is resolved at RUNTIME: changing the env var and
// restarting the container works without rebuilding.

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(process.argv[2] ?? process.env.DSH_SOURCE_DIR ?? '')
if (!root || !fs.existsSync(path.join(root, 'package.json'))) {
  console.error('patch-dsh: pass the built source checkout dir as argv[1] (or set DSH_SOURCE_DIR)')
  process.exit(1)
}

// Workspace package dirs live under packages/<tier>/<name> (or apps/*, vendor/*).
function findPackageDir(name) {
  const candidates = []
  for (const sub of ['packages', 'apps', 'vendor']) {
    const base = path.join(root, sub)
    if (!fs.existsSync(base)) continue
    for (const tier of fs.readdirSync(base)) {
      const tierDir = path.join(base, tier)
      if (!fs.statSync(tierDir).isDirectory()) continue
      let dirs = [tierDir]
      if (sub === 'packages') {
        dirs = fs.readdirSync(tierDir)
          .filter((d) => fs.statSync(path.join(tierDir, d)).isDirectory())
          .map((d) => path.join(tierDir, d))
      }
      for (const dir of dirs) {
        const pj = path.join(dir, 'package.json')
        if (!fs.existsSync(pj)) continue
        try {
          if (JSON.parse(fs.readFileSync(pj, 'utf8')).name === name) candidates.push(dir)
        } catch {}
      }
    }
  }
  if (candidates.length !== 1) {
    throw new Error(`patch-dsh: expected exactly one workspace dir for "${name}", found ${candidates.length}`)
  }
  return candidates[0]
}

// The compiled entry a patch rewrites: the package's `exports["."]` default or
// `main`, resolved relative to the package dir (lib/index.js for these hosts).
function entryFile(pkgDir, name) {
  const pj = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  const def = pj.exports?.['.']?.default ?? pj?.exports?.['.']?.import ?? pj.main
  if (typeof def !== 'string' || def.length === 0) {
    throw new Error(`patch-dsh: cannot resolve the entry file of "${name}"`)
  }
  return path.resolve(pkgDir, def)
}

const targets = [
  {
    pkg: '@deepseek-ai/dsh-llm',
    replacements: [
      // Failure retry count (upstream default 2 pre-rc.8, 5 since rc.8).
      [
        'const DEFAULT_MAX_RETRIES = 5;',
        'const DEFAULT_MAX_RETRIES = Number(process.env.DSH_RETRY ?? 30);',
      ],
      // Retry backoff schedule defaults (upstream: 500ms initial, 10s cap, 10%
      // jitter). Upstream only exposes them per-provider via config files;
      // these give the deployment global runtime-tunable defaults.
      [
        'const DEFAULT_INITIAL_DELAY_MS = 500;',
        'const DEFAULT_INITIAL_DELAY_MS = Number(process.env.DSH_RETRY_INITIAL_DELAY_MS ?? 500);',
      ],
      [
        'const DEFAULT_MAX_DELAY_MS = 1e4;',
        'const DEFAULT_MAX_DELAY_MS = Number(process.env.DSH_RETRY_MAX_DELAY_MS ?? 1e4);',
      ],
      [
        'const DEFAULT_JITTER_RATIO = .1;',
        'const DEFAULT_JITTER_RATIO = Number(process.env.DSH_RETRY_JITTER_RATIO ?? .1);',
      ],
      // Provider request User-Agent (was always `deepseek-harness/<version> (+url)`).
      [
        '`${identity.product}/${identity.version} (+${identity.url})`',
        'process.env.UA ?? `${identity.product}/${identity.version} (+${identity.url})`',
      ],
      // Extra retryable failure codes beyond the built-in set (EMPTY_RESPONSE,
      // RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT): comma-separated. The gateway
      // adapters classify unmatched provider errors as NON-retryable fallback
      // codes (pi-ai's PI_AI_ERROR, deepseek's HTTP_<status>); adding such a
      // code here -- e.g. DSH_RETRYABLE_CODES="PI_AI_ERROR,HTTP_408" -- makes
      // it retry with the same backoff as transient failures.
      //
      // Universal reasoning ladder: any model whose adapter declares NO
      // reasoning capability still exposes a thinking-level ladder
      // (off/medium/high/xhigh/max, default high), so the model picker's
      // 推理等级 control is available for every model and every provider.
      //
      // Both hooks splice around the same 'const DEFAULT_RETRYABLE_CODES'
      // line, so they are ONE replacement entry: two entries sharing this
      // junction would each break the other's already-applied detection.
      [
        'const DEFAULT_RETRYABLE_CODES = Object.freeze([',
        'const UNIVERSAL_REASONING_LEVELS = Object.freeze([\n' +
          '\tObject.freeze({ id: "off", name: "Off" }),\n' +
          '\tObject.freeze({ id: "medium", name: "Medium" }),\n' +
          '\tObject.freeze({ id: "high", name: "High" }),\n' +
          '\tObject.freeze({ id: "xhigh", name: "XHigh" }),\n' +
          '\tObject.freeze({ id: "max", name: "Max" })\n' +
          ']);\n' +
          'const DSH_EXTRA_RETRYABLE_CODES = String(process.env.DSH_RETRYABLE_CODES ?? "")\n' +
          '\t.split(",").map((code) => code.trim()).filter(Boolean);\n' +
          'const DEFAULT_RETRYABLE_CODES = Object.freeze([\n' +
          '\t...DSH_EXTRA_RETRYABLE_CODES,',
      ],
      // Fill the reasoning metadata for models without any (universal ladder
      // with a FORCED default of High -- the picker then offers no "Default"
      // entry and every selection/request carries high unless changed).
      [
        'const reasoning = resolved.reasoning;\n\t\tif (reasoning === void 0) return info;',
        'const reasoning = resolved.reasoning;\n' +
          '\t\tif (reasoning === void 0) return {\n' +
          '\t\t\t...info,\n' +
          '\t\t\treasoning: {\n' +
          '\t\t\t\tefforts: UNIVERSAL_REASONING_LEVELS.map((effort) => ({ ...effort })),\n' +
          '\t\t\t\tdefaultEffort: "high"\n' +
          '\t\t\t}\n' +
          '\t\t};',
      ],
    ],
  },
  {
    pkg: '@deepseek-ai/dsh-client-connection',
    replacements: [
      // Browser-trust fence bypass (opt-in: DSH_DISABLE_TRUST_FENCE=1). Disables
      // the Host/Origin/cross-site checks so any client that can reach the port
      // may call the /api — use only behind your own auth.
      [
        'function isTrustedApiRequest(request, trustedHosts) {',
        'function isTrustedApiRequest(request, trustedHosts) {\n\tif (process.env.DSH_DISABLE_TRUST_FENCE === "1") return true;',
      ],
    ],
  },
  {
    pkg: '@deepseek-ai/dsh-host-directory-picker-browse',
    replacements: [
      // Default directory: follow the container cwd (/workspace via WORKDIR)
      // instead of $HOME (which gosu points at /home/dsh). Overridable via env.
      [
        'const home = homedir()',
        'const home = process.env.DSH_DEFAULT_DIRECTORY ?? process.cwd()',
      ],
    ],
  },
  {
    pkg: '@deepseek-ai/dsh-llm-pi-ai',
    replacements: [
      // Friendlier display names for the reasoning ladder (xhigh -> Extra High).
      [
        'import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";',
        'import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";\n' +
          '/** Display names for the reasoning ladder. */\n' +
          'const REASONING_LEVEL_NAMES = Object.freeze({\n' +
          '\toff: "Off",\n' +
          '\tminimal: "Minimal",\n' +
          '\tlow: "Low",\n' +
          '\tmedium: "Medium",\n' +
          '\thigh: "High",\n' +
          '\txhigh: "XHigh",\n' +
          '\tmax: "Max"\n' +
          '});',
      ],
      // Universal thinking for models pi-ai knows nothing about (hand-declared
      // providers, models without a catalog reasoning flag): instead of marking
      // them non-reasoning (`reasoning: false`, which hides the 推理等级 control
      // and suppresses every reasoning wire knob), give them a universal
      // thinkingLevelMap matching the universal ladder (off/medium/high/xhigh/max).
      // minimal/low are pinned to null (unsupported) because pi-ai reads an
      // ABSENT key as supported for the five base levels; medium/high/xhigh/max
      // map to their own wire spelling, so a chosen level is sent as-is
      // (`reasoning_effort` etc.) and the provider decides. "off" stays absent
      // from the map so no-level sends nothing. The `universal` marker lets
      // reasoningInfo force the High default (no "Default" entry in the picker).
      [
        'if (efforts === void 0) return { reasoning: base?.reasoning ?? false };',
        'if (efforts === void 0) {\n' +
          '\t\tif (base?.reasoning === false) return { reasoning: false };\n' +
          '\t\tif (base?.reasoning === true) return { reasoning: true };\n' +
          '\t\treturn {\n' +
          '\t\t\treasoning: true,\n' +
          '\t\t\tthinkingLevelMap: {\n' +
          '\t\t\t\tminimal: null,\n' +
          '\t\t\t\tlow: null,\n' +
          '\t\t\t\tmedium: "medium",\n' +
          '\t\t\t\thigh: "high",\n' +
          '\t\t\t\txhigh: "xhigh",\n' +
          '\t\t\t\tmax: "max"\n' +
          '\t\t\t},\n' +
          '\t\t\tuniversal: true\n' +
          '\t\t};\n' +
          '\t}',
      ],
      // Use the friendlier names in the picker metadata (must run BEFORE the
      // reasoningInfo rewrite below, which matches the post-name-mapping text).
      [
        'name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`',
        'name: REASONING_LEVEL_NAMES[level] ?? `${level.charAt(0).toUpperCase()}${level.slice(1)}`',
      ],
      // Force the High default for universal models (a configured profile-level
      // reasoning still wins); the "Default" option disappears once a default
      // effort is present.
      [
        'if (!model.reasoning) return {};\n\treturn { reasoning: {\n\t\tefforts: getSupportedThinkingLevels(model).map((level) => ({\n\t\t\tid: ReasoningEffortId(level),\n\t\t\tname: REASONING_LEVEL_NAMES[level] ?? `${level.charAt(0).toUpperCase()}${level.slice(1)}`\n\t\t})),\n\t\t...defaultLevel === void 0 ? {} : { defaultEffort: ReasoningEffortId(defaultLevel) }\n\t} };',
        'if (!model.reasoning) return {};\n\tconst effectiveDefault = defaultLevel ?? (model.universal === true ? "high" : void 0);\n\treturn { reasoning: {\n\t\tefforts: getSupportedThinkingLevels(model).map((level) => ({\n\t\t\tid: ReasoningEffortId(level),\n\t\t\tname: REASONING_LEVEL_NAMES[level] ?? `${level.charAt(0).toUpperCase()}${level.slice(1)}`\n\t\t})),\n\t\t...effectiveDefault === void 0 ? {} : { defaultEffort: ReasoningEffortId(effectiveDefault) }\n\t} };',
      ],
      // Stream idle watchdog default (upstream 5 minutes): how long a model
      // stream may stay silent before the request is abandoned as
      // LLM_STREAM_IDLE_TIMEOUT. Upstream exposes it only per-provider via
      // config files, never in the UI; slow gateways / long thinking phases
      // without keepalive frames need a bigger value.
      [
        'const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 3e5;',
        'const DEFAULT_STREAM_IDLE_TIMEOUT_MS = Number(process.env.DSH_STREAM_IDLE_TIMEOUT_MS ?? 3e5);',
      ],
    ],
  },
  {
    pkg: '@deepseek-ai/dsh-llm-deepseek',
    replacements: [
      // Same stream idle watchdog default for the DeepSeek direct route.
      [
        'const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 3e5;',
        'const DEFAULT_STREAM_IDLE_TIMEOUT_MS = Number(process.env.DSH_STREAM_IDLE_TIMEOUT_MS ?? 3e5);',
      ],
      // SSE [DONE] tolerance (opt-out of upstream strictness with
      // DSH_SSE_REQUIRE_DONE=0): some OpenAI-compatible gateways proxying
      // non-OpenAI backends end the stream cleanly without the literal
      // "[DONE]" data frame; upstream turns every such well-formed completion
      // into a terminal STREAM_CLOSED error. Default stays strict.
      [
        'throw new LlmError("SSE stream ended without [DONE]", "STREAM_CLOSED");',
        'if (process.env.DSH_SSE_REQUIRE_DONE === "0") return;\n\tthrow new LlmError("SSE stream ended without [DONE]", "STREAM_CLOSED");',
      ],
    ],
  },
  {
    // Token estimation density (upstream hardcodes 4 chars/token and accepts
    // no configuration): drives auto-compaction pressure. Code-heavy or CJK
    // conversations and non-DeepSeek models misestimate badly at 4; raise it
    // (fewer estimated tokens per char -> compaction later) or lower it to
    // compact earlier.
    pkg: '@deepseek-ai/dsh-token-meter',
    replacements: [
      [
        'const CHARS_PER_TOKEN = 4;',
        'const CHARS_PER_TOKEN = Number(process.env.DSH_TOKEN_METER_CHARS_PER_TOKEN ?? 4);',
      ],
    ],
  },
  {
    // Mobile: hide the model name + thinking level in the composer's model seat
    // so the seat never overlaps the sibling read/write policy buttons in the
    // tool row on phones. The compiled client bundle inlines the CSS module as
    // a string with content-hashed class names, so the media-query suffix is
    // built from the triggerLabel/triggerEffort classes found in that same
    // bundle -- hash-independent and safe across dsh builds.
    ...hideOnMobile('@deepseek-ai/dsh-client-ui-model-selection', ['triggerLabel', 'triggerEffort']),
  },
  {
    // Mobile: hide the session-log download button in the session header.
    ...hideOnMobile('@deepseek-ai/dsh-session-log-export', ['sessionLogButton']),
  },
]

/**
* CSS-module mobile-hiding patch for a client bundle: the compiled client.js
* inlines the component's CSS module as a string with content-hashed class
* names; this appends a @media (max-width:560px) rule hiding the given class
* keys (resolved from the bundle's own css map, so hashes never break it).
* @param pkg - the workspace package to patch (its lib/client.js).
* @param classKeys - css-map keys whose elements hide on phones.
*/
function hideOnMobile(pkg, classKeys) {
  return {
    pkg,
    file: 'lib/client.js',
    custom(entry, src, log) {
      const cssMatch = src.match(/const css = ("[^"]*");/)
      if (!cssMatch) throw new Error(`patch-dsh: ${pkg} css const not found`)
      const mapMatch = src.match(/module_css_default = \{([\s\S]*?)\};/)
      const classes = (mapMatch?.[1] ?? '')
        .match(new RegExp(`"(${classKeys.join('|')})": "([^"]+)"`, 'g')) ?? []
      const entries = new Map(classes.map((m) => {
        const hit = m.match(/"([^"]+)": "([^"]+)"/)
        return [hit[1], hit[2]]
      }))
      if (classKeys.some((key) => !entries.has(key))) {
        throw new Error(`patch-dsh: ${pkg} missing css classes ${classKeys.join(',')} in the css map`)
      }
      const suffix = `@media (max-width:560px){${classKeys.map((key) => `.${entries.get(key)}`).join(',')}{display:none}}`
      if (cssMatch[1].includes(suffix)) {
        log(`already applied in ${path.relative(root, entry)}`)
        return src
      }
      const newCss = cssMatch[1].slice(0, -1) + suffix + '"'
      return src.replace(cssMatch[0], `const css = ${newCss};`)
    },
  }
}

// Apply one exact-string replacement list to a file's source, once-only and
// idempotent: each `from` must occur exactly once unless the patch is already
// in place. Every `to` contains its `from` verbatim (the anchor is a prefix of
// the patched text), so seeing the full `to` means this entry ran before --
// skip even though `from` itself still occurs once inside it.
function applyReplacements(display, src, replacements) {
  // An entry may carry a third element (truthy) to replace EVERY occurrence
  // of `from` instead of requiring exactly one -- for prose upstream
  // duplicates across sibling tools (e.g. minimal preset's bash descriptions).
  for (const [from, to, all] of replacements) {
    if (src.includes(to)) {
      console.log(`patch-dsh: already applied in ${display}: ${from.slice(0, 60)}...`)
      continue
    }
    const count = src.split(from).length - 1
    if ((all && count === 0) || (!all && count !== 1)) {
      console.error(
        `patch-dsh: expected exactly one occurrence (found ${count}) in ${display}:\n  ${from}`,
      )
      process.exit(1)
    }
    src = all ? src.split(from).join(to) : src.replace(from, to)
  }
  return src
}

for (const { pkg, replacements, custom, file } of targets) {
  const dir = findPackageDir(pkg)
  const entry = path.resolve(dir, file ?? entryFile(dir, pkg))
  let src = fs.readFileSync(entry, 'utf8')
  if (custom !== undefined) {
    src = custom(entry, src, (msg) => console.log(`patch-dsh: ${msg}`))
  } else {
    src = applyReplacements(path.relative(root, entry), src, replacements)
  }
  fs.writeFileSync(entry, src)

  // The patched file must still parse.
  const check = spawnSync(process.execPath, ['--check', entry], { stdio: 'inherit' })
  if (check.status !== 0) process.exit(check.status ?? 1)

  console.log(`patch-dsh: patched ${path.relative(root, entry)}`)
}

// ── Agent-preset prompt translation (code / cordis / minimal / standard) ────
//
// dsh ships four agent presets (the four "modes" a session can run under) whose
// model-facing prompt prose is authored in English: each preset's persona
// (`text`), the plan-mode rules (`section`) where present, and `minimal`'s
// persistent-bash tool description. The shipped presets are read at RUNTIME
// from apps/cli/config/agent-presets/ (beside the compiled profile-boot), so
// rewriting these YAML files at build time translates every session mounted on
// them — giving the model a Chinese system prompt so it tends to think and
// answer in Chinese. Placeholders like {{model}} / {{cwd}} are kept verbatim;
// paragraph-wise replacement preserves the YAML block-scalar shape exactly.
// Unlike the code targets above, these pairs do NOT nest `from` inside `to` —
// the includes(to) skip in applyReplacements is what makes them idempotent.

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

// Persona shared by the standard and code presets (folded single-line scalar).
const CODING_PERSONA = [
  [
    'You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.',
    '你是编程智能体（coding agent），由 {{model}} 模型驱动。你的工作目录是 {{cwd}}。除非用户明确要求使用其他语言，否则请全程使用中文思考和回复。',
  ],
]

// The cordis preset's longer persona (literal block, one pair per paragraph).
const CORDIS_PERSONA_PARAGRAPHS = [
  [
    'You are a coding agent powered by the {{model}} model, running on the DeepSeek Harness. Your working directory is {{cwd}}.',
    '你是编程智能体（coding agent），由 {{model}} 模型驱动，运行在 DeepSeek Harness 之上。你的工作目录是 {{cwd}}。除非用户明确要求使用其他语言，否则请全程使用中文思考和回复。',
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
    '* You do have access to a mirror of common linux and python packages via apt and pip.',
    '* 可以通过 apt 和 pip 使用常用 Linux 与 Python 软件包的镜像源。',
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

const presetTargets = [
  {
    file: 'apps/cli/config/agent-presets/standard/agent.cordis.yml',
    replacements: [...CODING_PERSONA, ...PLAN_MODE_PARAGRAPHS],
  },
  {
    file: 'apps/cli/config/agent-presets/code/agent.cordis.yml',
    replacements: [...CODING_PERSONA, ...PLAN_MODE_PARAGRAPHS],
  },
  {
    file: 'apps/cli/config/agent-presets/cordis/agent.cordis.yml',
    replacements: [...CORDIS_PERSONA_PARAGRAPHS, ...PLAN_MODE_PARAGRAPHS],
  },
  {
    file: 'apps/cli/config/agent-presets/minimal/agent.cordis.yml',
    replacements: [...MINIMAL_PERSONA, ...MINIMAL_BASH_DESCRIPTION_LINES],
  },
]

for (const { file, replacements } of presetTargets) {
  const entry = path.join(root, file)
  const src = fs.readFileSync(entry, 'utf8')
  fs.writeFileSync(entry, applyReplacements(file, src, replacements))
  console.log(`patch-dsh: translated agent-preset prompts in ${file}`)
}