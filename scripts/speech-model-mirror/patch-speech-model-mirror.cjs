'use strict'
/**
 * 语音识别（本地 SenseVoice 转写）的模型下载优先走国内可直连的镜像站：
 * 模型（int8 / fp32）、tokens.txt、Silero VAD 三份 pinned 资源都优选用 https://hf-mirror.com。
 *
 * 上游把下载地址组成成 `origin + 清单里的 pathname`（`runtime/assets.json` 只锁路径/字节数/
 * sha256，其中的 origin 不参与下载），而 origin 来自编译产物里 schema 的默认值：
 *
 *  - **0.1.7-rc.1 起（多源）**：`modelOrigins` 默认 `["https://huggingface.co", "https://hf-mirror.com"]`，
 *    运行时会并行 HEAD 探测各源、优先用先响应的那个，其余留作回退；`modelOrigin` 变成可选
 *    （显式配置时只用那一个）。此时上游**已经自带镜像回退**，本补丁只把默认数组里镜像挪到
 *    第一位：国内直连时探测首源即镜像，不必先等官方站超时/失败再回退；
 *  - **0.1.7-alpha.2 及更早（单源）**：只有 `modelOrigin`，默认 `"https://huggingface.co"`，
 *    本补丁把它换成镜像站。
 *
 * 两种布局都覆盖，两个产物（宿主侧 `lib/index.js` 与私有 worker `lib/worker.js`）都改；都不匹配
 * 就报错终止（构建即失败）。只改编译产物（`lib/*.js`，构建时由 pnpm build:lib 产出），不碰上游
 * 被 git 跟踪的 src/config.ts 与 runtime/assets.json。
 *
 * 单一职责、自包含：本脚本不引用 scripts/ 下的任何其他脚本。清单见 docs/scripts.md。
 */
const fs = require('node:fs')
const path = require('node:path')

const NAME = 'patch-speech-model-mirror'
const PACKAGE = '@deepseek-ai/dsh-experimental-speech-to-text-sensevoice'
const UPSTREAM_ORIGIN = 'https://huggingface.co'
const MIRROR_ORIGIN = 'https://hf-mirror.com'

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

const pkgDir = findPackageDir(PACKAGE)
const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))

// 两个补丁目标都从包自身 exports 解析，跟随上游改名：入口（宿主侧）与 ./worker（私有 worker）。
function entryFile(field) {
  const def = pkg.exports?.[field]?.default ?? pkg.exports?.[field]?.import ?? pkg?.[field === '.' ? 'main' : field]
  if (typeof def !== 'string' || def.length === 0) {
    fail('cannot resolve the "' + field + '" entry file of ' + PACKAGE)
  }
  const file = path.resolve(pkgDir, def)
  if (!fs.existsSync(file)) {
    fail('compiled artifact not found: ' + path.relative(root, file) + ' (run `pnpm run build:lib` first)')
  }
  return file
}

// 单源布局：`modelOrigin: ...default("https://huggingface.co")` -> 默认值换成镜像站。
const legacyFrom = 'default("' + UPSTREAM_ORIGIN + '")'
const legacyTo = 'default("' + MIRROR_ORIGIN + '")'
// 多源布局：默认数组 ["https://huggingface.co", "https://hf-mirror.com"] -> 镜像挪到首位
// （官方站保留为回退，国内直连时不必先等它探测超时）。
const multiFrom = 'default(["' + UPSTREAM_ORIGIN + '", "' + MIRROR_ORIGIN + '"])'
const multiTo = 'default(["' + MIRROR_ORIGIN + '", "' + UPSTREAM_ORIGIN + '"])'

for (const file of [entryFile('.'), entryFile('./worker')]) {
  const display = path.relative(root, file)
  let src = fs.readFileSync(file, 'utf8')

  if (src.includes(multiTo)) {
    // 多源布局，且镜像已经在首位。
    log('already applied in ' + display)
  } else if (src.includes(multiFrom)) {
    const count = src.split(multiFrom).length - 1
    if (count !== 1) fail('expected exactly one occurrence (found ' + count + ') in ' + display + ':\n  ' + multiFrom)
    src = src.replace(multiFrom, multiTo)
    fs.writeFileSync(file, src)
    log('patched ' + display + ' (multi-origin: mirror first)')
  } else if (src.includes(legacyTo) && !src.includes(legacyFrom)) {
    // 单源布局，且默认值已是镜像站。
    log('already applied in ' + display)
  } else if (src.includes(legacyFrom)) {
    const count = src.split(legacyFrom).length - 1
    if (count !== 1) fail('expected exactly one occurrence (found ' + count + ') in ' + display + ':\n  ' + legacyFrom)
    src = src.replace(legacyFrom, legacyTo)
    fs.writeFileSync(file, src)
    log('patched ' + display + ' (single origin: mirror default)')
  } else {
    fail(display + ' has neither the multi-origin default ' + multiFrom + ' nor the single-origin default '
      + legacyFrom + ' -- upstream changed the model origin layout, update this script')
  }

  // 收尾复检：镜像站在产物里（默认值之一/唯一），且默认值里不再「官方站优先于镜像站」。
  const current = fs.readFileSync(file, 'utf8')
  if (!current.includes(MIRROR_ORIGIN)) fail(display + ' has no ' + MIRROR_ORIGIN + ' after patching')
  if (current.includes(multiFrom)) fail(display + ' still defaults to huggingface.co before the mirror')
  if (current.includes('default("' + UPSTREAM_ORIGIN + '")')) {
    fail(display + ' still defaults to huggingface.co -- update this script for the new layout')
  }
}
