'use strict'
/**
 * 语音识别（本地 SenseVoice 转写）的模型下载地址由 HuggingFace 官方站换成国内可直连的镜像站：
 * 模型（int8 / fp32）、tokens.txt、Silero VAD 三份 pinned 资源都从 https://hf-mirror.com 取。
 *
 * 上游把下载地址组成成 `modelOrigin + 清单里的 pathname`：
 * packages/experimental/speech-to-text-sensevoice/lib/index.js 里
 * `new URL(asset.url).pathname` 被拼到 `config.modelOrigin` 之后再去 fetch，
 * runtime/assets.json 里的 origin 不参与下载（它只是「路径 + 字节数 + sha256」的锁定清单），
 * 而 modelOrigin 的**默认值**编译在 lib 产物里 —— 所以本补丁只改这两处默认值：
 *   - lib/index.js：宿主侧 provider（真正发起下载的一方）
 *   - lib/worker.js：私有 worker 里的同一份 schema 默认值
 * 上游的 `modelOrigin` 配置项保留原样：用户仍可在 dsh 配置里覆盖成任意 Hugging Face 兼容源
 * （含私有镜像），本补丁只改默认值，让开箱即用的下载走国内镜像站。
 *
 * 只改编译产物（包内 lib/*.js，由构建时的 pnpm build:lib 产出），不碰上游被 git 跟踪的
 * src/config.ts 与 runtime/assets.json；锚点缺失、出现次数异常、产物里还有别的 huggingface.co
 * 引用都报错退出（构建即失败），绝不静默跳过。
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

const from = 'default("' + UPSTREAM_ORIGIN + '")'
const to = 'default("' + MIRROR_ORIGIN + '")'

for (const file of [entryFile('.'), entryFile('./worker')]) {
  const display = path.relative(root, file)
  let src = fs.readFileSync(file, 'utf8')

  // 已应用判据：镜像默认值就位且上游默认值已消失（幂等复检只输出 already applied）。
  if (src.includes(to) && !src.includes(from)) {
    log('already applied in ' + display)
  } else {
    const count = src.split(from).length - 1
    if (count !== 1) {
      fail('expected exactly one occurrence (found ' + count + ') in ' + display + ':\n  ' + from)
    }
    src = src.replace(from, to)
    fs.writeFileSync(file, src)
    log('patched ' + display)
  }

  // 复检：镜像是唯一剩下的 origin；产物里若还有别的 huggingface.co 引用（上游新增了下载路径 /
  // 兜底源），说明本补丁已不完整，响亮失败让维护者按新结构更新脚本。
  const current = fs.readFileSync(file, 'utf8')
  if (!current.includes(to)) fail(display + ' has no ' + MIRROR_ORIGIN + ' default after patching')
  if (current.includes('huggingface.co')) {
    fail(display + ' still references huggingface.co -- upstream added another origin, update this script')
  }
}
