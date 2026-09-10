'use strict'
/**
 * 手机端折叠侧边栏不占页面宽度（视口 < 1024px，对应上游 SIDEBAR_AUTO_COLLAPSE）。
 *
 * 折叠时把三列 grid 强制成 0 / 1fr / 0（!important 压过组件内联样式），让中间内容占满整页
 * 宽度；左上角角标由 mobile-sidebar-corner 负责。桌面端保持上游行为（56px rail）。
 *
 * 单一职责、自包含：本脚本不引用 scripts/ 下的任何其他脚本。清单见 docs/scripts.md。
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const NAME = 'patch-mobile-collapsed-layout'
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
/**
* CSS-module media-query patch for a client bundle: appends a generated
* `@media` block to the inlined CSS-module string of the package's compiled
* client.js. Hashed class names come from the bundle's own css map
* (`*_module_css_default`), so the emitted selectors never break across dsh
* builds. Handles both compiled shapes (`const css = ("...")` and
* `const css = "..."`) and escaped quotes inside the CSS via an
* escape-aware scan for the string's real closing quote. Idempotent: skips
* when `marker` already appears in the css string.
* @param pkg - the workspace package to patch (its lib/client.js).
* @param marker - hash-independent substring proving the media query is
*   already applied (checked against the css string).
* @param build - (classes) => the `@media` suffix text to append; `classes`
*   maps css-map keys to their hashed class names.
*/
function appendCssSuffix(pkg, marker, build) {
  return {
    pkg,
    file: 'lib/client.js',
    custom(entry, src, log) {
      const start = src.indexOf('const css = ')
      if (start < 0) throw new Error(`${NAME}: ${pkg} css const not found`)
      let p = start + 'const css = '.length
      if (src[p] === '(') p++
      if (src[p] !== '"') throw new Error(`${NAME}: ${pkg} css const has no opening quote`)
      p++
      let end = -1
      for (let k = p; k < src.length; k++) {
        if (src[k] === '\\') { k++; continue }
        if (src[k] === '"') { end = k; break }
      }
      if (end < 0) throw new Error(`${NAME}: ${pkg} css const has no closing quote`)
      if (src.slice(p, end).includes(marker)) {
        log(`already applied in ${path.relative(root, entry)}`)
        return src
      }
      const mapMatch = src.match(/module_css_default = \{([\s\S]*?)\};/)
      if (!mapMatch) throw new Error(`${NAME}: ${pkg} css map not found`)
      const classes = new Map(
        [...mapMatch[1].matchAll(/"([^"]+)": "([^"]+)"/g)].map((m) => [m[1], m[2]]),
      )
      const suffix = build(classes)
      return src.slice(0, end) + suffix + src.slice(end)
    },
  }
}
const targets = [
  {
    // Mobile: the collapsed sidebar must collapse to a top-left corner button
    // instead of a full-height 56px rail that reserves a strip of the page.
    // Half 1 (this entry): on narrow viewports a COLLAPSED frame must not keep
    // the rail column -- force the grid to 0 / 1fr / 0 (!important beats the
    // component's inline grid-template-columns) so the center column spans the
    // whole width. The media-query breakpoint matches SIDEBAR_AUTO_COLLAPSE
    // (1024) in dsh-client-ui-layout's columns.ts; data-sidebar-collapsed is
    // set by AppFrame whenever the sidebar is collapsed, in every profile.
    ...appendCssSuffix(
      '@deepseek-ai/dsh-client-ui-layout',
      '[data-sidebar-collapsed]{grid-template-columns:0',
      (c) => `@media (max-width:1023px){.${c.get('frame')}[data-sidebar-collapsed]{grid-template-columns:0 minmax(0,1fr) 0 !important}}`,
    ),
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
