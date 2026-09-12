'use strict'
/**
 * /auto-plan 命令（dsh-plan-mode）。
 *
 * 与 /plan 一样进入计划模式，但模型调用 exit_plan_mode 时直接批准、不再弹评审确认卡片，
 * 退出计划模式后继续执行计划。auto 标记从会话日志折叠（command/run + plan/mode），所以
 * 重启 / fork 后可恢复；普通 /plan 行为不变，/plan off 与 /auto-plan off 均可退出。
 *
 * 命令文案跟随上游的双语机制（浏览器端按 locale 取字典），所以本脚本同时改两处产物：
 *   1. 宿主 `@deepseek-ai/dsh-plan-mode`：注册 /auto-plan 命令（英文描述常量）；
 *   2. 浏览器 `@deepseek-ai/dsh-client-ui-commands`：上游用「宿主描述 === en 字典值」
 *      判定一条宿主命令是否可翻译（`HOST_DESCRIPTION_KEYS` + `command` 命名空间字典），
 *      故补上 `description.auto-plan` 的 zh/en 两条字典与映射，中文界面即显示中文描述。
 *
 * 单一职责、自包含：本脚本不引用 scripts/ 下的任何其他脚本。清单见 docs/scripts.md。
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const NAME = 'patch-auto-plan'

/**
 * /auto-plan 的英文命令描述（单一来源）：宿主侧 `commands.register` 写入它，浏览器端
 * ui-commands 拿它和 `en["description.auto-plan"]` 逐字比对，命中才翻译成中文。
 */
const AUTO_PLAN_DESCRIPTION = 'Enter or leave auto-approving plan mode'
/** /auto-plan 的中文命令描述（`command` 命名空间字典值，措辞与 /plan 的「进入或退出计划模式」对齐）。 */
const AUTO_PLAN_DESCRIPTION_ZH = '进入或退出自动批准的计划模式'
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
      [
        '\t\t\t});\n\t\t});\n\t\tctx.tools.register(defineTool({',
        '\t\t\t});\n\t\tcommandCtx.commands.register({\n\t\t\tname: "auto-plan",\n\t\t\tdescription: "' + AUTO_PLAN_DESCRIPTION + '",\n\t\t\tinput: {\n\t\t\t\thint: "[off|message]",\n\t\t\t\timages: true\n\t\t\t},\n\t\t\thandler: ({ agent, rawInput, attachments }) => {\n\t\t\t\tconst message = rawInput.trim();\n\t\t\t\tif (message === "off" && attachments.length > 0) return {\n\t\t\t\t\tkind: "error",\n\t\t\t\t\ttext: "Image attachments cannot accompany /auto-plan off."\n\t\t\t\t};\n\t\t\t\tif (message === "off") return this.set(agent, false) === "committed" ? {\n\t\t\t\t\tkind: "success",\n\t\t\t\t\ttext: "Plan mode off."\n\t\t\t\t} : {\n\t\t\t\t\tkind: "success",\n\t\t\t\t\ttext: "Leaving plan mode (applies from the next step)."\n\t\t\t\t};\n\t\t\t\tconst outcome = this.set(agent, true);\n\t\t\t\tif (message !== "" || attachments.length > 0) agent.steer(createUserMessage({\n\t\t\t\t\tcontent: [...attachments, ...message === "" ? [] : [{\n\t\t\t\t\t\ttype: "text",\n\t\t\t\t\t\ttext: message\n\t\t\t\t\t}]],\n\t\t\t\t\tsource: { kind: "user" }\n\t\t\t\t}));\n\t\t\t\treturn {\n\t\t\t\t\tkind: "success",\n\t\t\t\t\ttext: outcome === "committed" ? "Auto plan mode on — plans auto-approve. Use /plan off to leave." : "Entering auto plan mode — plans auto-approve (applies from the next step). Use /plan off to leave."\n\t\t\t\t};\n\t\t\t}\n\t\t});\n\t\t});\n\t\tctx.tools.register(defineTool({',
      ],
    ],
  },
  {
    // /auto-plan's copy follows the active locale. Upstream ui-commands owns
    // the `command` namespace and localizes ONE host command description by
    // name, but only when the descriptor equals its own en dictionary value
    // (`hostDescription`); a name absent from HOST_DESCRIPTION_KEYS keeps its
    // verbatim English descriptor, which is what /auto-plan did in a Chinese
    // GUI. Register the same pair here: the zh/en dictionary entries feed
    // `this.t(key)` and the map entry opts the host command into it. The en
    // value must stay byte-identical to AUTO_PLAN_DESCRIPTION above (it is the
    // comparison operand), while the zh value is what a Chinese GUI shows.
    pkg: '@deepseek-ai/dsh-client-ui-commands',
    subpath: './client',
    replacements: [
      [
        '\t\t\t"description.plan": "进入或退出计划模式",',
        '\t\t\t"description.plan": "进入或退出计划模式",\n\t\t\t"description.auto-plan": "' + AUTO_PLAN_DESCRIPTION_ZH + '",',
      ],
      [
        '\t\t\t"description.plan": "Enter or leave plan mode",',
        '\t\t\t"description.plan": "Enter or leave plan mode",\n\t\t\t"description.auto-plan": "' + AUTO_PLAN_DESCRIPTION + '",',
      ],
      [
        '\t\t\t["plan", "description.plan"]',
        '\t\t\t["plan", "description.plan"],\n\t\t\t["auto-plan", "description.auto-plan"]',
      ],
    ],
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
