'use strict'
/**
 * 侧边栏品牌名称轮播（DSH_BRAND_ROTATION / DSH_BRAND_ROTATION_MS）。
 *
 * 左上角 logo 右侧的品牌名在给定文案之间轮播（默认 "DeepSeek Harness" 与 "探索未至之境"，
 * 每 4000ms 一次，带淡入淡出）：
 *  - 主机端把文案与间隔注入 __DSH_BRAND_ROTATION__ / __DSH_BRAND_ROTATION_MS__ 页面全局
 *    （dsh-client-modules）；
 *  - official 构建 profile 下替换 dsh-client-ui-brand-official 的固定字标；
 *  - 其余 profile 下替换 dsh-client-ui-sidebar 里 "DSH Local Build" 兜底文案。
 * 渲染全在浏览器端，改环境变量后刷新页面即生效。
 *
 * 单一职责、自包含：本脚本不引用 scripts/ 下的任何其他脚本。清单见 docs/scripts.md。
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const NAME = 'patch-brand-rotation'
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
function brandRotationSource(fnName) {
  return [
    `\t\tfunction ${fnName}() {`,
    '\t\t\tconst [brandIndex, setBrandIndex] = (0, react.useState)(0);',
    '\t\t\tconst [brandFaded, setBrandFaded] = (0, react.useState)(false);',
    '\t\t\t(0, react.useEffect)(() => {',
    '\t\t\t\tconst timer = window.setInterval(() => {',
    '\t\t\t\t\tsetBrandFaded(true);',
    '\t\t\t\t}, DSH_BRAND_ROTATION_MS);',
    '\t\t\t\treturn () => window.clearInterval(timer);',
    '\t\t\t}, []);',
    '\t\t\t(0, react.useEffect)(() => {',
    '\t\t\t\tif (!brandFaded) return;',
    '\t\t\t\tconst swap = window.setTimeout(() => {',
    '\t\t\t\t\tsetBrandIndex((index) => (index + 1) % DSH_BRAND_ROTATION.length);',
    '\t\t\t\t\tsetBrandFaded(false);',
    '\t\t\t\t}, DSH_BRAND_FADE_MS);',
    '\t\t\t\treturn () => window.clearTimeout(swap);',
    '\t\t\t}, [brandFaded]);',
    '\t\t\treturn (0, react_jsx_runtime.jsx)("span", {',
    '\t\t\t\tstyle: {',
    '\t\t\t\t\tdisplay: "inline-flex",',
    '\t\t\t\t\talignItems: "center",',
    '\t\t\t\t\twhiteSpace: "nowrap",',
    '\t\t\t\t\tminWidth: 0,',
    '\t\t\t\t\topacity: brandFaded ? 0 : 1,',
    '\t\t\t\t\ttransition: `opacity ${DSH_BRAND_FADE_MS}ms ease`',
    '\t\t\t\t},',
    '\t\t\t\tchildren: DSH_BRAND_ROTATION[brandIndex % DSH_BRAND_ROTATION.length]',
    '\t\t\t});',
    '\t\t}',
    '\t\tconst DSH_BRAND_ROTATION = Array.isArray(globalThis.__DSH_BRAND_ROTATION__) && globalThis.__DSH_BRAND_ROTATION__.length > 0',
    '\t\t\t? globalThis.__DSH_BRAND_ROTATION__',
    '\t\t\t: ["DeepSeek Harness", "探索未至之境"];',
    '\t\tconst DSH_BRAND_ROTATION_MS = Number.isFinite(globalThis.__DSH_BRAND_ROTATION_MS__) && globalThis.__DSH_BRAND_ROTATION_MS__ > 0',
    '\t\t\t? globalThis.__DSH_BRAND_ROTATION_MS__',
    '\t\t\t: 4000;',
    '\t\tconst DSH_BRAND_FADE_MS = 200;',
  ].join('\n')
}
const targets = [
  {
    pkg: '@deepseek-ai/dsh-client-modules',
    replacements: [
      [
        "\treturn rows;",
        "\trows.push({\n\t\tkind: \"global\",\n\t\tname: \"__DSH_BRAND_ROTATION__\",\n\t\tvalue: String(process.env.DSH_BRAND_ROTATION ?? \"DeepSeek Harness|探索未至之境\").split(\"|\").map((text) => text.trim()).filter(Boolean)\n\t});\n\trows.push({\n\t\tkind: \"global\",\n\t\tname: \"__DSH_BRAND_ROTATION_MS__\",\n\t\tvalue: Number(process.env.DSH_BRAND_ROTATION_MS ?? 4000)\n\t});\n\treturn rows;",
        void 0,
        'name: "__DSH_BRAND_ROTATION__"',
      ],
    ],
  },
  {
    // Sidebar brand name rotation: the official wordmark occupant
    // (OfficialBrandName in dsh-client-ui-brand-official) becomes a rotating
    // text span that cycles the name next to the logo between the product name
    // and the deployment slogan ("探索未至之境") every DSH_BRAND_ROTATION_MS
    // with a short crossfade. Texts/interval come from the host-injected
    // __DSH_BRAND_ROTATION__ / __DSH_BRAND_ROTATION_MS__ globals (driven by
    // the DSH_BRAND_ROTATION / DSH_BRAND_ROTATION_MS env vars at serve time);
    // the in-bundle defaults below already deliver the product/slogan pair.
    pkg: '@deepseek-ai/dsh-client-ui-brand-official',
    file: 'lib/client.js',
    replacements: [
      // Pull the React hooks face into the bundle scope (only jsx-runtime was
      // required before) for useState/useEffect.
      [
        '\t\tlet react_jsx_runtime = require("react/jsx-runtime");',
        '\t\tlet react_jsx_runtime = require("react/jsx-runtime");\n\t\tlet react = require("react");',
      ],
      // Replace the fixed wordmark artwork with the rotating name text.
      [
        '\t\tfunction OfficialBrandName() {\n\t\t\treturn (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.BrandWordmark, { includeMark: false });\n\t\t}',
        '\t\t/**\n' +
          '\t\t* Deployment brand rotation (patched by dsh-docker scripts/brand-rotation/patch-brand-rotation.cjs):\n' +
          '\t\t* the sidebar name text cycles through DSH_BRAND_ROTATION every\n' +
          '\t\t* DSH_BRAND_ROTATION_MS milliseconds with a short crossfade.\n' +
          '\t\t* Values come from the host-injected __DSH_BRAND_ROTATION__ /\n' +
          '\t\t* __DSH_BRAND_ROTATION_MS__ globals when present; the in-bundle\n' +
          '\t\t* defaults below are the product / deployment-slogan pair.\n' +
          '\t\t*/\n' +
          brandRotationSource('OfficialBrandName'),
        void 0,
        'DSH_BRAND_ROTATION = Array.isArray(globalThis.__DSH_BRAND_ROTATION__)',
      ],
    ],
  },
  {
    // Sidebar brand name rotation for generic (non-official) builds: the
    // shipped official occupant (dsh-client-ui-brand-official) only registers
    // under the "official" client build profile, so every other build shows
    // the SidebarRoot fallback "DSH Local Build" instead. Swap that fallback
    // for the same rotating text span as the official occupant, so the name
    // next to the logo rotates between the product name and the deployment
    // slogan in EVERY build profile. A custom handler because the fallback's
    // commit-hash badge reads `{}.DSH_CLIENT_COMMIT_HASH` in generic builds
    // but an inlined hash literal in official-profile builds — a regex matches
    // both forms.
    pkg: '@deepseek-ai/dsh-client-ui-sidebar',
    file: 'lib/client.js',
    custom(entry, src, log) {
      if (!src.includes('function SidebarBrandRotation')) {
        const anchor = '\t\tconst SCROLLBAR_LINGER_MS = 2e3;'
        const count = src.split(anchor).length - 1
        if (count !== 1) throw new Error(`${NAME}: ui-sidebar SCROLLBAR_LINGER_MS anchor found ${count} times`)
        const doc = '\t\t/**\n' +
          '\t\t* Deployment brand rotation for generic (non-official) builds\n' +
          '\t\t* (patched by dsh-docker scripts/brand-rotation/patch-brand-rotation.cjs): the sidebar name text\n' +
          '\t\t* cycles through DSH_BRAND_ROTATION every DSH_BRAND_ROTATION_MS\n' +
          '\t\t* milliseconds with a short crossfade. Mirrors the official\n' +
          '\t\t* occupant in dsh-client-ui-brand-official.\n' +
          '\t\t*/\n'
        src = src.replace(anchor, `${anchor}\n\n${doc}${brandRotationSource('SidebarBrandRotation')}`)
      } else {
        log(`brand rotation component already present in ${path.relative(root, entry)}`)
      }
      // Since 0.1.2-alpha.2 the generic-build fallback renders through the
      // i18n key t("brand.localBuild") as a ternary: a plain span when
      // buildVersion is absent, otherwise localBuildBrand + version badge.
      const fallbackRe = /fallback: buildVersion === void 0 \? \(0, react_jsx_runtime\.jsx\)\("span", \{\s*className: SidebarRoot_module_css_default\.fallbackBrandName,\s*children: t\("brand\.localBuild"\)\s*\}\)\s*: \(0, react_jsx_runtime\.jsxs\)\("span", \{\s*className: SidebarRoot_module_css_default\.localBuildBrand,\s*children: \[[\s\S]*?\]\s*\}\)/
      if (src.includes('fallback: (0, react_jsx_runtime.jsx)(SidebarBrandRotation, {})')) {
        log(`fallback already swapped in ${path.relative(root, entry)}`)
      } else {
        if (!fallbackRe.test(src)) throw new Error(NAME + ': ui-sidebar fallback pattern not found')
        src = src.replace(fallbackRe, 'fallback: (0, react_jsx_runtime.jsx)(SidebarBrandRotation, {})')
      }
      return src
    },
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
