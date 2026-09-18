'use strict'
/**
 * /auto-plan 命令（dsh-plan-mode）。
 *
 * 与 /plan 一样进入计划模式，但模型调用 exit_plan_mode 时直接批准、不再弹评审确认卡片，
 * 退出计划模式后继续执行计划。auto 标记从会话日志折叠（command/run + plan/mode），所以
 * 重启 / fork 后可恢复；普通 /plan 行为不变，/plan off 与 /auto-plan off 均可退出。
 *
 * 命令文案跟随上游的双语机制（浏览器端按 locale 取字典），所以本脚本同时改两处产物：
 *   1. 宿主 `@deepseek-ai/dsh-plan-mode`：注册 /auto-plan 命令（英文描述常量 + 专属
 *      `definitionId`，供浏览器端按定义而非文案识别它）；
 *   2. 浏览器 `@deepseek-ai/dsh-client-ui-commands`：把 /auto-plan 登记进该包的
 *      「内建命令」表。上游 0.1.6 起改按**定义**识别内建命令（`BUILTINS` 按
 *      `definitionId` 匹配 + `HOST_FACES` 给菜单面），不再比对描述文案，因此需要补
 *      label / description / token 三组 zh/en 字典、BUILTINS 映射与 HOST_FACES 菜单面；
 *      0.1.5-rc.2 及更早则是按**文案**识别（`HOST_DESCRIPTION_KEYS` + 描述逐字比对），
 *      对应旧的三条注入。两种形态都在这里处理，构建旧 ref 也不会失败。
 *
 * 单一职责、自包含：本脚本不引用 scripts/ 下的任何其他脚本。清单见 docs/scripts.md。
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const NAME = 'patch-auto-plan'

/**
 * /auto-plan 的英文命令描述（单一来源）：既是 `en["description.auto-plan"]` 字典值
 * （0.1.6 起浏览器端直接按 key 取用），也是 0.1.5 及更早「描述逐字比对」机制的比较操作数。
 */
const AUTO_PLAN_DESCRIPTION = 'Enter or leave auto-approving plan mode'
/** /auto-plan 的中文命令描述（`command` 命名空间字典值，措辞与 /plan 的「进入或退出计划模式」对齐）。 */
const AUTO_PLAN_DESCRIPTION_ZH = '进入或退出自动批准的计划模式'
/**
 * /auto-plan 的定义标识（0.1.6 起浏览器端按定义而非文案识别内建命令）。/auto-plan 与
 * /plan 由同一个包注册，必须使用**不同**的 id：`builtinCommandName` 是 find 首个匹配，
 * 共用 id 会让 /auto-plan 被认成 /plan、显示计划的名字与描述。`brandString` 在运行时是
 * 恒等函数，故直接写字符串字面量（0.1.5 及更早的包没有该导入，写它反而会 ReferenceError；
 * 旧版 registry 只挑已知字段，多出的 definitionId 被忽略）。
 */
const AUTO_PLAN_DEFINITION_ID = '@deepseek-ai/dsh-plan-mode#auto-plan'
/** /auto-plan 在菜单里的标题（0.1.6 起 `label.*` 字典，与 /plan 的「计划」并列）。 */
const AUTO_PLAN_LABEL = 'Auto Plan'
const AUTO_PLAN_LABEL_ZH = '自动计划'
/** /auto-plan 的输入别名（0.1.6 起 `token.*` 字典，供本地化词法解析回定义）。 */
const AUTO_PLAN_TOKEN = 'auto-plan'
const AUTO_PLAN_TOKEN_ZH = '自动计划'
const root = path.resolve(process.argv[2] ?? process.env.DSH_SOURCE_DIR ?? '')
if (!root || !fs.existsSync(path.join(root, 'package.json'))) {
  console.error(NAME + ': pass the built source checkout dir as argv[1] (or set DSH_SOURCE_DIR)')
  process.exit(1)
}
const log = (message) => console.log(NAME + ': ' + message)

// 在工作区里按包名定位唯一的包目录（packages/<tier>/<name> / apps/* / vendor/*）。
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
    throw new Error(NAME + ': expected exactly one workspace dir for "' + name + '", found ' + candidates.length)
  }
  return candidates[0]
}

// 补丁目标文件：包内 exports[subpath] 的 default/import 或（宿主产物）main 指向的编译产物。
// subpath 默认 '.' 取宿主产物；浏览器产物用 './client'（`files` 里的 lib/client.js）。
function entryFile(pkgDir, name, subpath = '.') {
  const pj = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  const entry = pj.exports?.[subpath] ?? (subpath === '.' ? { default: pj.main } : undefined)
  const def = entry?.default ?? entry?.import
  if (typeof def !== 'string' || def.length === 0) {
    throw new Error(NAME + ': cannot resolve the "' + subpath + '" entry file of "' + name + '"')
  }
  return path.resolve(pkgDir, def)
}

// 逐条替换，单次生效且幂等：条目为 [from, to, all?, marker?]。
//   from   默认必须在文件里恰好出现一次（all 为真时允许 0 次以上，全部替换）；
//   marker 默认取 to，命中即视为本补丁已应用，直接跳过；
//   锚点不匹配则以非零码退出（构建即失败），绝不静默跳过。
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
/**
 * 注入 /auto-plan 的菜单文案（`command` 命名空间），兼容上游两种识别机制：
 *   - 0.1.6 起（`HOST_FACES` 存在）：按**定义**识别——字典要补齐 label/description/token
 *     三组 zh/en，`BUILTINS` 要加 definitionId 映射，`HOST_FACES` 要加菜单面（含图标）；
 *   - 0.1.5 及更早（`HOST_DESCRIPTION_KEYS` 存在）：按**文案**识别——只需 en/zh 的
 *     description 字典与 `[name, key]` 映射对，en 值须与宿主描述逐字相同。
 * 每条注入独立判「已应用」（用各自独有的 marker），锚点缺失或已应用状态不完整都报错。
 * @param entry - 编译产物绝对路径。
 * @param src - 当前文件内容。
 * @param log - 统一日志函数。
 * @returns 注入后的文件内容。
 */
function patchUiCommands(entry, src, log) {
  const display = path.relative(root, entry)
  const newMechanism = src.includes('const HOST_FACES = new Map([')
  if (!newMechanism && !src.includes('HOST_DESCRIPTION_KEYS')) {
    throw new Error(NAME + ': ' + display + ' matches neither the >=0.1.6 (HOST_FACES) nor the <=0.1.5 (HOST_DESCRIPTION_KEYS) localization shape')
  }
  const tab = '\t\t\t'
  // [anchor, marker, insertion]: marker is the exact injected text in this
  // entry, so a half-applied file is never mistaken for a finished injection.
  let additions
  if (newMechanism) {
    // Mirror the /plan menu face's own icon expression so a renamed primitives
    // binding cannot desync this injection from the surrounding code. Greedy
    // `.+` is confined to one line, so it captures the whole icon expression.
    const face = /\t\t\thostFace\("plan", (.+)\),/.exec(src)
    if (face === null) throw new Error(NAME + ': ' + display + ' has no hostFace("plan", ...) entry to mirror')
    // The zh dictionary is the key-set source of truth and en is checked
    // complete against it, so every key lands in both tables; token.* also
    // feeds the localized-spelling aliases, which iterate Object.keys(BUILTINS).
    const keys = [
      ['label', AUTO_PLAN_LABEL, AUTO_PLAN_LABEL_ZH, '"label.plan": ', '"计划"', '"Plan"'],
      ['description', AUTO_PLAN_DESCRIPTION, AUTO_PLAN_DESCRIPTION_ZH, '"description.plan": ', '"进入或退出计划模式"', '"Enter or leave plan mode"'],
      ['token', AUTO_PLAN_TOKEN, AUTO_PLAN_TOKEN_ZH, '"token.plan": ', '"计划"', '"plan"'],
    ]
    additions = keys.flatMap(([name, en, zh, prefix, zhPlan, enPlan]) => [
      [tab + prefix + zhPlan + ',', '"' + name + '.auto-plan": "' + zh + '"', '\n' + tab + '"' + name + '.auto-plan": "' + zh + '",'],
      [tab + prefix + enPlan + ',', '"' + name + '.auto-plan": "' + en + '"', '\n' + tab + '"' + name + '.auto-plan": "' + en + '",'],
    ])
    additions.push(
      // Identity map (quoted key: the name contains a hyphen) + menu face.
      [
        tab + 'plan: "@deepseek-ai/dsh-plan-mode",',
        '"auto-plan": "' + AUTO_PLAN_DEFINITION_ID + '"',
        '\n' + tab + '"auto-plan": "' + AUTO_PLAN_DEFINITION_ID + '",',
      ],
      [face[0], 'hostFace("auto-plan"', '\n' + tab + 'hostFace("auto-plan", ' + face[1] + '),'],
    )
  } else {
    additions = [
      [tab + '"description.plan": "进入或退出计划模式",', '"description.auto-plan": "' + AUTO_PLAN_DESCRIPTION_ZH + '"', '\n' + tab + '"description.auto-plan": "' + AUTO_PLAN_DESCRIPTION_ZH + '",'],
      [tab + '"description.plan": "Enter or leave plan mode",', '"description.auto-plan": "' + AUTO_PLAN_DESCRIPTION + '"', '\n' + tab + '"description.auto-plan": "' + AUTO_PLAN_DESCRIPTION + '",'],
      [
        tab + '["plan", "description.plan"]',
        '["auto-plan", "description.auto-plan"]',
        ',\n' + tab + '["auto-plan", "description.auto-plan"]',
      ],
    ]
  }
  for (const [anchor, marker, insertion] of additions) {
    if (src.includes(marker)) continue
    const count = src.split(anchor).length - 1
    if (count !== 1) {
      console.error(NAME + ': expected exactly one occurrence (found ' + count + ') in ' + display + ':\n  ' + anchor)
      process.exit(1)
    }
    src = src.replace(anchor, anchor + insertion)
  }
  return src
}

const targets = [
  {
    // /auto-plan command: enter the same plan mode as /plan but mark the
    // session auto-approving — `exit_plan_mode` returns { approved: true }
    // immediately instead of raising the user review question, so the plan is
    // carried out without a confirmation step. The marker is folded from the
    // session log (`command/run` name + `plan/mode` active flips), so resume
    // and fork restore it with no live mirror, and it never touches
    // /auto-plan (see README). Since 0.1.2-alpha.2 the logged mode is an
    // event projection (planProjectionDefinition) instead of a standalone
    // foldPlanMode + planUnitStateSchema, so the foldAutoPlan helper is
    // injected before the projection definition; the /plan command closure
    // and the exit tool body kept their 0.1.1-rc.2 compiled shape.
    pkg: '@deepseek-ai/dsh-plan-mode',
    replacements: [
      // foldAutoPlan helper, injected right before the plan projection
      // definition.
      [
        'const planProjectionDefinition = {',
        '/**\n * /auto-plan marker folded from the session log: true while the last\n * plan-family command was a successful `auto-plan` entry and no later\n * event exited plan mode or selected the reviewed `/plan` mode.\n */\nfunction foldAutoPlan(events, end = events?.length ?? 0) {\n\tlet auto = false;\n\tlet index = 0;\n\tfor (const event of events ?? []) {\n\t\tif (index >= end) break;\n\t\tindex++;\n\t\tif (event.type === "plan/mode") {\n\t\t\tif (event.data.active !== true) auto = false;\n\t\t} else if (event.type === "command/run") {\n\t\t\tif (event.data.name === "auto-plan") auto = (event.data.args ?? "").trim() !== "off";\n\t\t\telse if (event.data.name === "plan") auto = false;\n\t\t}\n\t}\n\treturn auto;\n}\nconst planProjectionDefinition = {',
      ],
      // exit_plan_mode: in an auto session, approve without the user review.
      // The fold reads the committed log through agent.session.snapshotEvents()
      // — since dsh 0.1.3 the Session class exposes no `.events` property, so
      // `agent.session.events` is undefined and foldAutoPlan(undefined) threw
      // "Cannot read properties of undefined (reading 'length')", bricking
      // every plan-mode exit (auto-plan and /plan alike).
      [
        '\t\t\t\tconst interaction = ctx.get("userQuestions");',
        '\t\t\t\tif (foldAutoPlan(agent.session.snapshotEvents())) {\n\t\t\t\t\tthis.pendingIntents.set(agent.session, { active: false, narrate: false });\n\t\t\t\t\treturn { approved: true };\n\t\t\t\t}\n\t\t\t\tconst interaction = ctx.get("userQuestions");',
      ],
      // /auto-plan command, registered beside /plan inside the same child.
      // `definitionId` (0.1.6+) is what the browser side matches to recognize a
      // built-in command; a plain string literal is enough because the brand is
      // compile-time only (`brandString` is the identity at runtime) and 0.1.5
      // and earlier ignore the field.
      [
        '\t\t\t});\n\t\t});\n\t\tctx.tools.register(defineTool({',
        '\t\t\t});\n\t\tcommandCtx.commands.register({\n\t\t\tdefinitionId: "' + AUTO_PLAN_DEFINITION_ID + '",\n\t\t\tname: "auto-plan",\n\t\t\tdescription: "' + AUTO_PLAN_DESCRIPTION + '",\n\t\t\tinput: {\n\t\t\t\thint: "[off|message]",\n\t\t\t\timages: true\n\t\t\t},\n\t\t\thandler: ({ agent, rawInput, attachments }) => {\n\t\t\t\tconst message = rawInput.trim();\n\t\t\t\tif (message === "off" && attachments.length > 0) return {\n\t\t\t\t\tkind: "error",\n\t\t\t\t\ttext: "Image attachments cannot accompany /auto-plan off."\n\t\t\t\t};\n\t\t\t\tif (message === "off") return this.set(agent, false) === "committed" ? {\n\t\t\t\t\tkind: "success",\n\t\t\t\t\ttext: "Plan mode off."\n\t\t\t\t} : {\n\t\t\t\t\tkind: "success",\n\t\t\t\t\ttext: "Leaving plan mode (applies from the next step)."\n\t\t\t\t};\n\t\t\t\tconst outcome = this.set(agent, true);\n\t\t\t\tif (message !== "" || attachments.length > 0) agent.steer(createUserMessage({\n\t\t\t\t\tcontent: [...attachments, ...message === "" ? [] : [{\n\t\t\t\t\t\ttype: "text",\n\t\t\t\t\t\ttext: message\n\t\t\t\t\t}]],\n\t\t\t\t\tsource: { kind: "user" }\n\t\t\t\t}));\n\t\t\t\treturn {\n\t\t\t\t\tkind: "success",\n\t\t\t\t\ttext: outcome === "committed" ? "Auto plan mode on — plans auto-approve. Use /plan off to leave." : "Entering auto plan mode — plans auto-approve (applies from the next step). Use /plan off to leave."\n\t\t\t\t};\n\t\t\t}\n\t\t});\n\t\t});\n\t\tctx.tools.register(defineTool({',
      ],
    ],
  },
  {
    // /auto-plan's copy follows the active locale. Upstream ui-commands owns
    // the `command` namespace and localizes built-in Host command faces; the
    // recognition mechanism differs by version (see patchUiCommands above):
    // >=0.1.6 matches the descriptor's `definitionId` against BUILTINS and
    // localizes label/description/token through HOST_FACES, while <=0.1.5
    // matched the description text against HOST_DESCRIPTION_KEYS. Either way an
    // unregistered command keeps its verbatim English descriptor, which is what
    // /auto-plan did in a Chinese GUI before this patch.
    pkg: '@deepseek-ai/dsh-client-ui-commands',
    subpath: './client',
    custom(entry, src, log) {
      return patchUiCommands(entry, src, log)
    },
  },
]
for (const { pkg, file, subpath, replacements, custom } of targets) {
  const dir = findPackageDir(pkg)
  const entry = path.resolve(dir, file ?? entryFile(dir, pkg, subpath))
  const display = path.relative(root, entry)
  let src = fs.readFileSync(entry, 'utf8')
  src = custom === void 0 ? applyReplacements(display, src, replacements) : custom(entry, src, log)
  fs.writeFileSync(entry, src)

  // 打完补丁的产物必须仍能通过语法检查。
  const check = spawnSync(process.execPath, ['--check', entry], { stdio: 'inherit' })
  if (check.status !== 0) process.exit(check.status ?? 1)
  log('patched ' + display)
}
