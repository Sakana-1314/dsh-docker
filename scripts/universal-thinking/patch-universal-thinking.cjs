'use strict'
/**
 * 通用推理等级（universal thinking levels）。
 *
 * 任何模型都会暴露「推理等级」选项，不再要求供应商声明推理能力：
 *  - dsh-llm：未声明 reasoning 的模型拿到 off/medium/high/xhigh/max 阶梯，且默认 High
 *    （选择器里不再出现 "Default"）；
 *  - dsh-llm-pi-ai：给目录之外的模型补通用 thinkingLevelMap（minimal/low 置 null 表示不
 *    支持，其余档位按原样发给供应商），并把档位显示名改成 xhigh -> XHigh。
 *
 * 环境变量：无（行为内建）。与 patch-llm-retry 共用 DEFAULT_RETRYABLE_CODES 锚点，两个
 * 脚本各带 marker，保证幂等且与执行顺序无关。
 *
 * 单一职责、自包含：本脚本不引用 scripts/ 下的任何其他脚本。清单见 docs/scripts.md。
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const NAME = 'patch-universal-thinking'
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

// 补丁目标文件：包内 exports["."] 的 default/import 或 main 指向的编译产物。
function entryFile(pkgDir, name) {
  const pj = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  const def = pj.exports?.['.']?.default ?? pj?.exports?.['.']?.import ?? pj.main
  if (typeof def !== 'string' || def.length === 0) {
    throw new Error(NAME + ': cannot resolve the entry file of "' + name + '"')
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
    pkg: '@deepseek-ai/dsh-llm',
    replacements: [
      // Universal reasoning ladder: models whose adapter declares NO reasoning
      // capability still get off/medium/high/xhigh/max instead of hiding the
      // control. Same junction as the retryable-code hook (patch-llm-retry),
      // which is why both carry their own marker instead of relying on the
      // whole "to" text being contiguous after the other one ran.
      [
        'const DEFAULT_RETRYABLE_CODES = Object.freeze([',
        'const UNIVERSAL_REASONING_LEVELS = Object.freeze([\n' +
          '\tObject.freeze({ id: "off", name: "Off" }),\n' +
          '\tObject.freeze({ id: "medium", name: "Medium" }),\n' +
          '\tObject.freeze({ id: "high", name: "High" }),\n' +
          '\tObject.freeze({ id: "xhigh", name: "XHigh" }),\n' +
          '\tObject.freeze({ id: "max", name: "Max" })\n' +
          ']);\n' +
        'const DEFAULT_RETRYABLE_CODES = Object.freeze([',
        void 0,
        'const UNIVERSAL_REASONING_LEVELS = Object.freeze([',
      ],
      // Fill the reasoning metadata for models without any (universal ladder
      // with a FORCED default of High -- the picker then offers no "Default"
      // entry and every selection/request carries high unless changed).
      // Since 0.1.2-alpha.2 the surrounding function nests one level deeper
      // (the defaultMaxTokens validation block was added before it), so the
      // compiled indent is 3 tabs, not 2.
      [
        'const reasoning = resolved.reasoning;\n\t\t\tif (reasoning === void 0) return info;',
        'const reasoning = resolved.reasoning;\n' +
          '\t\t\tif (reasoning === void 0) return {\n' +
          '\t\t\t\t...info,\n' +
          '\t\t\t\treasoning: {\n' +
          '\t\t\t\t\tefforts: UNIVERSAL_REASONING_LEVELS.map((effort) => ({ ...effort })),\n' +
          '\t\t\t\t\tdefaultEffort: "high"\n' +
          '\t\t\t\t}\n' +
          '\t\t\t};',
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
    ],
  },
]
for (const { pkg, file, replacements, custom } of targets) {
  const dir = findPackageDir(pkg)
  const entry = path.resolve(dir, file ?? entryFile(dir, pkg))
  const display = path.relative(root, entry)
  let src = fs.readFileSync(entry, 'utf8')
  src = custom === void 0 ? applyReplacements(display, src, replacements) : custom(entry, src, log)
  fs.writeFileSync(entry, src)

  // 打完补丁的产物必须仍能通过语法检查。
  const check = spawnSync(process.execPath, ['--check', entry], { stdio: 'inherit' })
  if (check.status !== 0) process.exit(check.status ?? 1)
  log('patched ' + display)
}
