'use strict'
/**
 * 手机端隐藏会话头部的「下载 session log」按钮（视口 < 560px）。
 *
 * 单一职责、自包含：本脚本不引用 scripts/ 下的任何其他脚本。清单见 docs/scripts.md。
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const NAME = 'patch-mobile-session-log'
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
* CSS-module mobile-hiding patch for a client bundle: the compiled client.js
* inlines the component's CSS module as a string with content-hashed class
* names; this appends a @media (max-width:560px) rule hiding the given class
* keys (resolved from the bundle's own css map, so hashes never break it).
* The key names themselves drift across upstream versions, so they are passed
* as accepted aliases: every key present in the css map is hidden, and at least
* one must be present (otherwise the control is gone and this patched must be
* updated).
* @param pkg - the workspace package to patch (its lib/client.js).
* @param classKeys - accepted css-map keys whose elements hide on phones.
*/
function hideOnMobile(pkg, classKeys) {
  return {
    pkg,
    file: 'lib/client.js',
    custom(entry, src, log) {
      const cssMatch = src.match(/const css = ("[^"]*");/)
      if (!cssMatch) throw new Error(`${NAME}: ${pkg} css const not found`)
      const mapMatch = src.match(/module_css_default = \{([\s\S]*?)\};/)
      const entries = new Map(
        [...(mapMatch?.[1] ?? '').matchAll(/"([^"]+)": "([^"]+)"/g)].map((m) => [m[1], m[2]]),
      )
      const keys = classKeys.filter((key) => entries.has(key))
      if (keys.length === 0) {
        throw new Error(`${NAME}: ${pkg} has none of the css classes ${classKeys.join(',')} in the css map`)
      }
      const suffix = `@media (max-width:560px){${keys.map((key) => `.${entries.get(key)}`).join(',')}{display:none}}`
      if (cssMatch[1].includes(suffix)) {
        log(`already applied in ${path.relative(root, entry)}`)
        return src
      }
      const newCss = cssMatch[1].slice(0, -1) + suffix + '"'
      return src.replace(cssMatch[0], `const css = ${newCss};`)
    },
  }
}
const targets = [
  {
    // Mobile: hide the session-log download affordance in the session header.
    // 0.1.5-rc.1 起它从独立的下载按钮变成「更多操作」菜单（唯一的条目就是下载日志），
    // css map 的类名键也从 sessionLogButton 变成 moreButton；两者都指向同一个头部控件，
    // 所以这里同时兼容两个键名，命中哪个就隐藏哪个。
    ...hideOnMobile('@deepseek-ai/dsh-session-log-export', ['moreButton', 'sessionLogButton']),
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
