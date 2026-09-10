'use strict'
/**
 * 固定浏览器标签标题格式「会话标题 - DeepSeek」。
 *
 * dsh-client-ui-layout 的 DocumentTitle 用固定产品名 "DeepSeek" 覆盖上游按构建期常量传入
 * 的标题，并把分隔符从全角破折号改成连字符；同时把构建产物 apps/web/dist/index.html 的
 * 初始 <title> 固定成 DeepSeek，避免水合前闪旧标题。
 *
 * 单一职责、自包含：本脚本不引用 scripts/ 下的任何其他脚本。清单见 docs/scripts.md。
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const NAME = 'patch-page-title'
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
    pkg: '@deepseek-ai/dsh-client-ui-layout',
    file: 'lib/client.js',
    replacements: [
      [
        'function DocumentTitle({ title, productTitle }) {\n\t\t\t(0, react.useEffect)(() => {',
        'function DocumentTitle({ title, productTitle }) {\n\t\t\tproductTitle = "DeepSeek";\n\t\t\t(0, react.useEffect)(() => {',
      ],
      [
        'document.title = title === void 0 ? productTitle : `${title} — ${productTitle}`;',
        'document.title = title === void 0 ? productTitle : `${title} - ${productTitle}`;',
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

// 构建后的 Web 外壳初始 <title>：编译产物里的 DocumentTitle 由上面的补丁在运行时驱动，
// apps/web/dist/index.html 的初始标题则由 `pnpm run build:web` 烧进产物。这里把它固定成
// 同一个产品名 DeepSeek，避免水合前闪一下构建期的旧标题（不同 profile 文本不同，所以直接
// 替换整个 <title> 元素）。宽容：Web 外壳还没构建时（只跑了 build:lib）跳过。
const webIndexHtml = path.join(root, 'apps/web/dist/index.html')
if (fs.existsSync(webIndexHtml)) {
  const html = fs.readFileSync(webIndexHtml, 'utf8')
  const fixed = html.replace(/<title>[^<]*<\/title>/, '<title>DeepSeek</title>')
  if (fixed !== html) {
    fs.writeFileSync(webIndexHtml, fixed)
    log('pinned the built web shell <title> to DeepSeek')
  } else {
    log('built web shell <title> already pinned')
  }
} else {
  log('apps/web/dist/index.html not built yet - skipping its <title> patch')
}
