'use strict'
/**
 * 信任栅栏逃生门（DSH_DISABLE_TRUST_FENCE=1）。
 *
 * 关掉 dsh 的浏览器信任栅栏与会话（token/cookie）鉴权，共四处：
 *  - 主机端 /api 的 Host/Origin/cross-site 校验（dsh-client-connection lib/index.js）；
 *  - 主机端浏览器会话鉴权 BrowserAuth.isAuthenticated（同包）；
 *  - 浏览器端把本页当成 loopback，让 settings（模型 / 凭证页）在远程浏览器也可用
 *    （dsh-client-connection lib/client.js）；
 *  - 把 __DSH_TRUST_FENCE_OFF__ 注入页面全局（dsh-client-modules），供客户端读取。
 *
 * 已安装插件自带的 /sidebar 路由由容器启动脚本 plugin-fence/patch-plugin-fence.cjs 处理。
 * 安全提示：关掉后没有任何鉴权层，只应放在自己的反代 / VPN 之后。
 *
 * 单一职责、自包含：本脚本不引用 scripts/ 下的任何其他脚本。清单见 docs/scripts.md。
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const NAME = 'patch-trust-fence'
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
    pkg: '@deepseek-ai/dsh-client-connection',
    replacements: [
      // Browser-trust fence bypass (opt-in: DSH_DISABLE_TRUST_FENCE=1). Disables
      // the Host/Origin/cross-site checks so any client that can reach the port
      // may call the /api — use only behind your own auth.
      [
        'function isTrustedApiRequest(request, trustedHosts) {',
        'function isTrustedApiRequest(request, trustedHosts) {\n\tif (process.env.DSH_DISABLE_TRUST_FENCE === "1") return true;',
      ],
      // Browser-session (cookie/token) auth bypass — the second half of the same
      // opt-in. Since 0.1.3-alpha.1 the /api and the index page additionally
      // demand a valid browser session: a launch ?token= on the root URL mints
      // a signed cookie, and a trusted-but-unauthenticated request otherwise
      // gets 401 even when the Host/Origin fence is off — which is what shows up
      // as "token parameter" authentication for a non-loopback browser. Every
      // auth decision funnels through BrowserAuth.isAuthenticated
      // (requestRejection for the API/channels/WebSocket, authorizeIndex for
      // serving index.html), so under DSH_DISABLE_TRUST_FENCE=1 it always passes
      // and the whole GUI opens without any token/cookie — use only behind your
      // own auth.
      [
        '\tisAuthenticated(request) {\n\t\tconst authority = requestAuthority(request.headers);',
        '\tisAuthenticated(request) {\n\t\tif (process.env.DSH_DISABLE_TRUST_FENCE === "1") return true;\n\t\tconst authority = requestAuthority(request.headers);',
      ],
    ],
  },
  {
    pkg: '@deepseek-ai/dsh-client-connection',
    file: 'lib/client.js',
    replacements: [
      [
        'isLoopback: transport?.ownsHost === true || pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),',
        'isLoopback: transport?.ownsHost === true || pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname) || globalThis.__DSH_TRUST_FENCE_OFF__ === true,',
      ],
    ],
  },
  {
    pkg: '@deepseek-ai/dsh-client-modules',
    replacements: [
      [
        "\t\tvalue: graph\n\t});",
        "\t\tvalue: graph\n\t});\n\trows.push({\n\t\tkind: \"global\",\n\t\tname: \"__DSH_TRUST_FENCE_OFF__\",\n\t\tvalue: process.env.DSH_DISABLE_TRUST_FENCE === \"1\"\n\t});",
        void 0,
        'name: "__DSH_TRUST_FENCE_OFF__"',
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
