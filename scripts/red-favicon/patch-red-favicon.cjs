'use strict'
/**
 * favicon 换成红色版本：apps/web/dist 下的鲸鱼标由上游默认色（浅色黑 / 深色白）改为固定红
 * #E60012，浅色与深色配色方案下都是红标。
 *
 * 深色配色在上游有两种表达方式，两种都要覆盖（0.1.7 改了布局，两条路径都留着：
 * 手动触发构建旧版本时补丁照样能用）：
 *  - 0.1.7 起：深色拆成独立产物 favicon-dark.svg（`fill="#fff"`），index.html 用两个带 media
 *    的 <link> 分别引 favicon.svg（light）与 favicon-dark.svg（dark）；
 *  - 0.1.6 及更早：只有一个 favicon.svg，深色是文件内联 <style> 媒体查询里的 CSS 声明
 *    （`fill: #fff;`，CSS 优先级高于 <path> 的表现属性，只改属性会让深色模式仍是白标）。
 * 两种都对不上时直接报错终止（构建即失败），绝不静默放过深色配色。
 *
 * 只改 Web 构建产物（apps/web/dist/favicon*.svg，gitignored；由 dsh web 作为静态资源伺服在
 * /favicon.svg 与 /favicon-dark.svg，即浏览器标签页 / PWA 图标），上游被 git 跟踪的源文件
 * apps/web/public/favicon*.svg 不动。锚点缺失、产物结构异常都报错退出（构建即失败）。
 *
 * 单一职责、自包含：本脚本不引用 scripts/ 下的任何其他脚本。清单见 docs/scripts.md。
 */
const fs = require('node:fs')
const path = require('node:path')

const NAME = 'patch-red-favicon'
const RED = '#E60012'
// 上游默认配色锚点：半打补丁的产物、上游又换布局都会留下这里面的某一项，收尾复检据此报错。
const DEFAULTS = ['fill="#000"', 'fill="#fff"', 'fill: #000;', 'fill: #fff;']

const root = path.resolve(process.argv[2] ?? process.env.DSH_SOURCE_DIR ?? '')
if (!root || !fs.existsSync(path.join(root, 'package.json'))) {
  console.error(NAME + ': pass the built source checkout dir as argv[1] (or set DSH_SOURCE_DIR)')
  process.exit(1)
}
const log = (message) => console.log(NAME + ': ' + message)
const fail = (message) => {
  console.error(NAME + ': ' + message)
  process.exit(1)
}

const distDir = path.join(root, 'apps', 'web', 'dist')
const lightFile = path.join(distDir, 'favicon.svg')
const darkFile = path.join(distDir, 'favicon-dark.svg')
if (!fs.existsSync(lightFile)) {
  fail('favicon build artifact not found: ' + path.relative(root, lightFile) + ' (run `pnpm run build:web` first)')
}

// 产物结构复检：svg 根与唯一的 <path>（每次写入前跑）。
function structureProblem(display, src) {
  const problems = []
  if (!(src.includes('<svg ') && src.includes('</svg>'))) problems.push('no <svg> root')
  if (src.split('<path').length - 1 !== 1) problems.push('expected exactly one <path>')
  return problems.length === 0 ? null : display + ' failed: ' + problems.join('; ')
}

// 配色复检：红标就位、默认色一处不剩（只在收尾时跑——旧布局下本脚本要分两条 job 改同一个
// 文件，中途态必然还留着另一个锚点，不能按终态要求它）。
function colourProblem(display, src) {
  const problems = []
  const left = DEFAULTS.filter((anchor) => src.includes(anchor))
  if (left.length > 0) problems.push('default fill left: ' + left.join(' / '))
  if (!src.includes(RED)) problems.push('no ' + RED + ' fill')
  return problems.length === 0 ? null : display + ' failed: ' + problems.join('; ')
}

// 布局识别：浅色锚点两种布局下都在 favicon.svg 的 <path> 上；深色锚点二选一——有
// favicon-dark.svg 就是新布局（锚点在那个文件里），否则是旧布局（锚点仍是同文件的内联 CSS；
// 已打过补丁的旧产物该处已是红 CSS，同样按旧布局处理，幂等复检才能只输出 already applied）。
const lightSrc = fs.readFileSync(lightFile, 'utf8')
const jobs = [[lightFile, 'fill="#000"', 'fill="' + RED + '"']]
if (fs.existsSync(darkFile)) {
  jobs.push([darkFile, 'fill="#fff"', 'fill="' + RED + '"'])
} else if (lightSrc.includes('fill: #fff;') || lightSrc.includes('fill: ' + RED + ';')) {
  jobs.push([lightFile, 'fill: #fff;', 'fill: ' + RED + ';'])
} else {
  fail('no dark-mode favicon anchor: neither apps/web/dist/favicon-dark.svg nor `fill: #fff;` in '
    + 'apps/web/dist/favicon.svg -- upstream changed the favicon layout, update this script')
}

for (const [file, from, to] of jobs) {
  const display = path.relative(root, file)
  let src = fs.readFileSync(file, 'utf8')
  // 已应用判据：红色就位且本条的默认色锚点已消失。只命中一处（半打补丁的产物）仍会走替换
  // 流程并如实报错，不会静默跳过留下混合配色。
  if (src.includes(to) && !src.includes(from)) {
    log('already applied in ' + display)
    continue
  }
  const count = src.split(from).length - 1
  if (count !== 1) {
    fail('expected exactly one occurrence (found ' + count + ') in ' + display + ':\n  ' + from)
  }
  src = src.replace(from, to)

  const problem = structureProblem(display, src)
  if (problem) fail(problem)
  fs.writeFileSync(file, src)
  log('patched ' + display)
}

// 收尾复检：**全部** favicon 产物统一过检——包括本次没写入的文件（新布局下深色文件仍是白标、
// 上游又换了深色的表达方式，都会在这里响亮失败，绝不静默留下白标）。
for (const file of [lightFile, darkFile]) {
  if (!fs.existsSync(file)) continue
  const display = path.relative(root, file)
  const src = fs.readFileSync(file, 'utf8')
  const problem = structureProblem(display, src) ?? colourProblem(display, src)
  if (problem) fail(problem)
}
