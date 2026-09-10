'use strict'
// Runtime patch for the browser-trust fence inside INSTALLED PROFILE PLUGINS.
// 运行时脚本：容器启动时由 scripts/container-entrypoint/docker-entrypoint.sh 调用。
// 单一职责、自包含：本脚本不引用 scripts/ 下的任何其他脚本。清单见 docs/scripts.md。
//
// dsh's core /api fence can be switched off with DSH_DISABLE_TRUST_FENCE=1
// (see scripts/trust-fence/patch-trust-fence.cjs, applied at image build
// time). Third-party web plugins — dsh-better-sidebar and other bundles that
// mount their own /sidebar routes — copy the same fence into their own
// compiled code, but several of them do not read that environment variable,
// so on remote/LAN access they keep answering 403 even when the core /api has
// been opened up.
//
// This script is the runtime counterpart: profile plugins live in the DSH home
// volume (/root/.dsh/profiles/<name>/node_modules), so they can only be
// patched at container start, not at image build time. When
// DSH_DISABLE_TRUST_FENCE=1 is set, the entrypoint runs this script and
// injects the same env-var bypass into every installed plugin whose compiled
// code contains the trust-fence signature, so the fence is disabled
// uniformly — core /api and plugin routes alike.
//
// Idempotent: an already-patched file (the bypass is already present) is left
// untouched; a plugin update that restores the pristine code is patched again
// at the next container start. A file that parses with a different fence
// shape is skipped with a warning, never guessed at.

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')

if (process.env.DSH_DISABLE_TRUST_FENCE !== '1') {
  console.log('patch-plugin-fence: DSH_DISABLE_TRUST_FENCE != 1, nothing to do')
  process.exit(0)
}

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const profilesDir = path.join(DSH_HOME, 'profiles')

// Exact compiled signature of the fence dsh plugins copy (dsh-better-sidebar
// has it verbatim in lib/index.js). We inject the same first-line bypass that
// scripts/trust-fence/patch-trust-fence.cjs injects into the core, so the two
// fences behave identically.
const NEEDLE = 'function isTrustedApiRequest(request, trustedHosts) {'
const BYPASS_PREFIX =
  '\n\tif (process.env.DSH_DISABLE_TRUST_FENCE === "1") return true;'
const ALREADY_PATCHED_MARK = 'DSH_DISABLE_TRUST_FENCE'

/** Yield every package directory under a profile's node_modules (unscoped + @scope/*). */
function* packageDirs(nodeModulesDir) {
  if (!fs.existsSync(nodeModulesDir)) return
  for (const entry of fs.readdirSync(nodeModulesDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === '.pnpm') continue
    if (entry.name.startsWith('@')) {
      const scopeDir = path.join(nodeModulesDir, entry.name)
      if (!fs.statSync(scopeDir).isDirectory()) continue
      for (const scoped of fs.readdirSync(scopeDir)) {
        if (scoped.startsWith('.')) continue
        yield path.join(scopeDir, scoped)
      }
    } else {
      yield path.join(nodeModulesDir, entry.name)
    }
  }
}

let patchedCount = 0
let skippedCount = 0

for (const profile of fs.readdirSync(profilesDir)) {
  const nodeModulesDir = path.join(profilesDir, profile, 'node_modules')
  for (const pkgDir of packageDirs(nodeModulesDir)) {
    const entry = path.join(pkgDir, 'lib', 'index.js')
    if (!fs.existsSync(entry)) continue
    let src
    try {
      src = fs.readFileSync(entry, 'utf8')
    } catch {
      continue // broken symlink / unreadable package — not ours to patch
    }
    if (!src.includes(NEEDLE)) continue
    if (src.includes(ALREADY_PATCHED_MARK)) {
      console.log(`patch-plugin-fence: already patched ${entry}`)
      continue
    }
    const count = src.split(NEEDLE).length - 1
    if (count !== 1) {
      console.error(
        `patch-plugin-fence: expected exactly one occurrence (found ${count}) in ${entry}:\n  ${NEEDLE}`,
      )
      skippedCount++
      continue
    }
    fs.writeFileSync(entry, src.replace(NEEDLE, NEEDLE + BYPASS_PREFIX))

    // The patched file must still parse.
    const check = spawnSync(process.execPath, ['--check', entry], { stdio: 'inherit' })
    if (check.status !== 0) {
      console.error(`patch-plugin-fence: syntax check failed for ${entry}`)
      process.exit(check.status ?? 1)
    }
    console.log(`patch-plugin-fence: patched ${entry}`)
    patchedCount++
  }
}

console.log(
  `patch-plugin-fence: done (${patchedCount} patched, ${skippedCount} skipped)`,
)
