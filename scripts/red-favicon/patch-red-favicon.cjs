'use strict'
/**
 * favicon 换成红色版本：apps/web/dist/favicon.svg 里的鲸鱼标由默认黑（浅色模式）/
 * 白（深色模式）改为固定红 #E60012，两种配色方案下都是红标。
 *
 * 只改 Web 构建产物（apps/web/dist/favicon.svg，gitignored；由 dsh web 作为静态资源
 * 伺服在 /favicon.svg，即浏览器标签页 / PWA 图标），上游被 git 跟踪的源文件
 * apps/web/public/favicon.svg 不动。锚点缺失、产物结构异常都报错退出（构建即失败）。
 *
 * 单一职责、自包含：本脚本不引用 scripts/ 下的任何其他脚本。清单见 docs/scripts.md。
 */
const fs = require('node:fs')
const path = require('node:path')

const NAME = 'patch-red-favicon'
const RED = '#E60012'

const root = path.resolve(process.argv[2] ?? process.env.DSH_SOURCE_DIR ?? '')
if (!root || !fs.existsSync(path.join(root, 'package.json'))) {
  console.error(NAME + ': pass the built source checkout dir as argv[1] (or set DSH_SOURCE_DIR)')
  process.exit(1)
}
const log = (message) => console.log(NAME + ': ' + message)

const entry = path.join(root, 'apps', 'web', 'dist', 'favicon.svg')
const display = path.relative(root, entry)
if (!fs.existsSync(entry)) {
  console.error(NAME + ': favicon build artifact not found: ' + display + ' (run `pnpm run build:web` first)')
  process.exit(1)
}

// 两个颜色锚点各须出现且只出现一次：浅色模式是 <path> 上的 fill 表现属性，深色模式是
// <style> 里的 CSS（CSS 优先级更高，只改属性会让深色模式仍显示白标）。
const replacements = [
  ['fill="#000"', 'fill="' + RED + '"'],
  ['fill: #fff;', 'fill: ' + RED + ';'],
]

let src = fs.readFileSync(entry, 'utf8')
// 已应用判据要求两个锚点都已替换：只命中一处（半打补丁的产物）仍会走替换流程并如实报错，
// 不会静默跳过留下混合配色。
if (replacements.every(([, to]) => src.includes(to))) {
  log('already applied in ' + display)
} else {
  for (const [from, to] of replacements) {
    const count = src.split(from).length - 1
    if (count !== 1) {
      console.error(NAME + ': expected exactly one occurrence (found ' + count + ') in ' + display + ':\n  ' + from)
      process.exit(1)
    }
    src = src.replace(from, to)
  }

  // 结构复检：svg 根与唯一的 <path> 都在，且旧颜色已清干净。
  for (const [label, ok] of [
    ['<svg root', src.includes('<svg ') && src.includes('</svg>')],
    ['single <path>', src.split('<path').length - 1 === 1],
    ['red fill applied', src.includes('fill="' + RED + '"') && src.includes('fill: ' + RED + ';')],
    ['baseline fill removed', !src.includes('fill="#000"') && !src.includes('fill: #fff;')],
  ]) {
    if (!ok) {
      console.error(NAME + ': patched ' + display + ' failed the ' + label + ' check')
      process.exit(1)
    }
  }

  fs.writeFileSync(entry, src)
  log('patched ' + display)
}
