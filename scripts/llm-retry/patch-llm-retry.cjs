'use strict'
/**
 * 请求重试与 User-Agent 运行时开关（dsh-llm）。
 *
 * 上游把重试次数、退避参数写死或只允许按供应商配置；这里改成读取环境变量（补丁注入的是
 * process.env 读取，重启容器即生效，无需重建镜像）：
 *   DSH_RETRY                      失败重试次数（默认 30）
 *   DSH_RETRY_INITIAL_DELAY_MS     退避初始延迟（默认 500）
 *   DSH_RETRY_MAX_DELAY_MS         退避上限（默认 10000）
 *   DSH_RETRY_JITTER_RATIO         退避抖动比例（默认 0.1）
 *   DSH_RETRYABLE_CODES            追加可重试错误码（逗号分隔）
 *   UA                             覆盖发给模型供应商的 User-Agent
 *
 * 单一职责、自包含：本脚本不引用 scripts/ 下的任何其他脚本。清单见 docs/scripts.md。
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const NAME = 'patch-llm-retry'
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
      // Failure retry count (upstream default 2 pre-rc.8, 5 since rc.8).
      [
        'const DEFAULT_MAX_RETRIES = 5;',
        'const DEFAULT_MAX_RETRIES = Number(process.env.DSH_RETRY ?? 30);',
      ],
      // Retry backoff schedule defaults (upstream: 500ms initial, 10s cap, 10%
      // jitter). Upstream only exposes them per-provider via config files;
      // these give the deployment global runtime-tunable defaults.
      [
        'const DEFAULT_INITIAL_DELAY_MS = 500;',
        'const DEFAULT_INITIAL_DELAY_MS = Number(process.env.DSH_RETRY_INITIAL_DELAY_MS ?? 500);',
      ],
      [
        'const DEFAULT_MAX_DELAY_MS = 1e4;',
        'const DEFAULT_MAX_DELAY_MS = Number(process.env.DSH_RETRY_MAX_DELAY_MS ?? 1e4);',
      ],
      [
        'const DEFAULT_JITTER_RATIO = .1;',
        'const DEFAULT_JITTER_RATIO = Number(process.env.DSH_RETRY_JITTER_RATIO ?? .1);',
      ],
      // Provider request User-Agent (was always `deepseek-harness/<version> (+url)`).
      [
        '`${identity.product}/${identity.version} (+${identity.url})`',
        'process.env.UA ?? `${identity.product}/${identity.version} (+${identity.url})`',
      ],
      // Extra retryable failure codes beyond the built-in set (EMPTY_RESPONSE,
      // RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT): comma-separated. The gateway
      // adapters classify unmatched provider errors as NON-retryable fallback
      // codes (pi-ai's PI_AI_ERROR, deepseek's HTTP_<status>); adding such a
      // code here -- e.g. DSH_RETRYABLE_CODES="PI_AI_ERROR,HTTP_408" -- makes
      // it retry with the same backoff as transient failures.
      [
        'const DEFAULT_RETRYABLE_CODES = Object.freeze([',
          'const DSH_EXTRA_RETRYABLE_CODES = String(process.env.DSH_RETRYABLE_CODES ?? "")\n' +
          '\t.split(",").map((code) => code.trim()).filter(Boolean);\n' +
          'const DEFAULT_RETRYABLE_CODES = Object.freeze([\n' +
          '\t...DSH_EXTRA_RETRYABLE_CODES,',
        void 0,
        '\t...DSH_EXTRA_RETRYABLE_CODES,',
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
