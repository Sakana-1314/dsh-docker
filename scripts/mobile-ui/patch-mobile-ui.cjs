'use strict'
/**
 * 手机端（视口 < 1024px / < 560px）UI 优化集合。
 *
 * 手机端定制按「一个功能」对待，五条规则都在本脚本里，共用三个 helper：
 *  1. 隐藏输入框里的模型名与思考等级（视口 < 560px，dsh-client-ui-model-selection）：
 *     该座位在窄屏会与同一行的读写策略按钮重叠；
 *  2. 隐藏会话头部的 session log 导出入口（视口 < 560px，dsh-session-log-export）：
 *     0.1.5 起是「更多操作」菜单按钮 moreButton，更早是 sessionLogButton，两个键名都兼容；
 *  3. 折叠后的侧边栏不占页面宽度（视口 < 1024px，dsh-client-ui-layout）：折叠时把三列
 *     grid 强制成 0 / 1fr / 0（!important 压过组件内联样式）；
 *  4. 折叠后的侧边栏收起到左上角角标（视口 < 1024px，dsh-client-ui-sidebar）：44x44 品牌红
 *     实心角标 + 隐藏其余 rail 控件（新建会话、全局面板列表即插件入口、工作区、页脚、设置），
 *     展开图标直接显示（触屏没有 hover）。角标用 `--dsh-fab-x/-y` 定位，拖动逻辑见第 5 条；
 *  5. 角标可拖动（视口 < 1024px，dsh-client-ui-sidebar）：按住角标拖到任意位置，
 *     位置存 localStorage（`dsh-docker:mobile-fab`）并写成 `:root` 上的
 *     `--dsh-fab-x/-y`，所以重渲染/切会话都不丢；位移小于阈值仍是「点击展开」，
 *     超过阈值才当拖动并把随后的 click 吞掉，避免误触展开。
 *  3 与 4 共同构成一条规范：折叠后不占页面宽度。桌面端（>=1024px）保持上游行为。
 *
 * 类名与选择器都从**该 bundle 自身 css 串所属的** css map 解析（哈希无关）：产物里可能有
 * 多个 `*_module_css_default`（如 ui-sidebar 的 HeaderLeadingControls 与 SidebarRoot），
 * 只按「类名出现在该 css 串里」判定归属，归属不唯一/键缺失都报错退出。
 * 注入的规则带稳定 marker 注释，重跑时按 marker 原地替换（同时清掉旧版本注入的
 * `.undefined` 规则），因此幂等且能从历史坏产物里自愈。
 * 单一职责、自包含：本脚本不引用 scripts/ 下的任何其他脚本。清单见 docs/scripts.md。
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const NAME = 'patch-mobile-ui'
// 角标（悬浮窗）用品牌红实心 + 白图标：上游给的默认态是「白底、无边框、无阴影」的
// 28/36px 图标按钮，在会话内容上几乎看不见（见 README 的对比图说明）。这里换成醒目的
// 品牌红 + 投影，鼠标悬停略提亮、按下轻微缩小，作为收起后唯一的展开入口足够显眼。
const FAB_SIZE = 44
const FAB_FILL = '#E60012'
const FAB_FILL_HOVER = '#C50010'
const FAB_ICON = '#FFFFFF'
const FAB_SHADOW = '0 4px 14px rgba(0,0,0,.32),0 0 0 1px rgba(0,0,0,.04)'
const root = path.resolve(process.argv[2] ?? process.env.DSH_SOURCE_DIR ?? '')
if (!root || !fs.existsSync(path.join(root, 'package.json'))) {
  console.error(NAME + ': pass the built source checkout dir as argv[1] (or set DSH_SOURCE_DIR)')
  process.exit(1)
}
const log = (message) => console.log(NAME + ': ' + message)

// 注入规则的稳定 marker（纯 ASCII、无引号，可安全放进 JS 字符串字面量里）。
const MARKER = {
  modelSeat: '/*dsh-docker:mobile-ui:model-seat*/',
  sessionLog: '/*dsh-docker:mobile-ui:session-log*/',
  sidebarGrid: '/*dsh-docker:mobile-ui:sidebar-grid*/',
  sidebarFab: '/*dsh-docker:mobile-ui:sidebar-fab*/',
  fabDrag: '/*dsh-docker:mobile-ui:fab-drag*/',
  fabDragEnd: '/*dsh-docker:mobile-ui:fab-drag:end*/',
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

// 补丁目标文件：包内 exports["."] 的 default/import 或 main 指向的编译产物。
function entryFile(pkgDir, name) {
  const pj = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  const def = pj.exports?.['.']?.default ?? pj?.exports?.['.']?.import ?? pj.main
  if (typeof def !== 'string' || def.length === 0) {
    throw new Error(NAME + ': cannot resolve the entry file of "' + name + '"')
  }
  return path.resolve(pkgDir, def)
}

// 取 bundle 里 `const css = "..."` 那段 CSS 字符串的原文（含转义，未解码）与前后边界。
// 编译产物有两种写法：`const css = ("...")` 与 `const css = "..."`，且串内可能有转义引号。
function cssLiteral(src, pkg) {
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
  return { start: p, end }
}

// 解析 bundle 里的 CSS 类名映射。产物可能声明多个 `*_module_css_default`（一个 bundle 里
// 打包了多个组件的 CSS module），因此**不能取第一个**：按「类名出现在目标 css 串里」判定
// 归属，要求恰好一个 map 命中，否则报错（取错 map 会生成 `.undefined` 选择器，规则静默失效）。
function cssMapFor(src, cssText, pkg) {
  const maps = [...src.matchAll(/(\w*module_css_default)\s*=\s*\{([\s\S]*?)\};/g)].map((m) => ({
    name: m[1],
    entries: new Map([...m[2].matchAll(/"([^"]+)": "([^"]+)"/g)].map((x) => [x[1], x[2]])),
  }))
  if (maps.length === 0) throw new Error(`${NAME}: ${pkg} css map not found`)
  const owners = maps.filter((map) => [...map.entries.values()].some((cls) => cssText.includes('.' + cls)))
  if (owners.length !== 1) {
    throw new Error(
      `${NAME}: ${pkg} css map ownership is ambiguous (${owners.length} candidates: ` +
      `${owners.map((o) => o.name).join(', ') || 'none'}); the css string must belong to exactly one module map`,
    )
  }
  return owners[0]
}

// 从 `from` 起找到第一个 `{` 并配对到它的收尾 `}`，返回收尾后的下标（用于整块替换规则）。
function blockEnd(text, from) {
  const open = text.indexOf('{', from)
  if (open < 0) throw new Error(`${NAME}: no '{' after marker at ${from}`)
  let depth = 0
  for (let k = open; k < text.length; k++) {
    if (text[k] === '{') depth++
    else if (text[k] === '}') {
      depth--
      if (depth === 0) return k + 1
    }
  }
  throw new Error(`${NAME}: unbalanced braces after marker at ${from}`)
}

// 清掉历史版本注入的坏规则：早期实现取错 css map，注入了 `.undefined` 选择器（整条规则无效）。
// 这些规则没有 marker，只能按「1023px 媒体查询块里含 .undefined」识别；上游自身的 1023px
// 媒体查询不存在（本脚本注入的是唯一来源），因此这里只可能删到自己注入的东西。
function stripLegacyRules(cssText) {
  const needle = '@media (max-width:1023px)'
  let out = cssText
  let removed = 0
  let from = 0
  for (;;) {
    const at = out.indexOf(needle, from)
    if (at < 0) break
    const end = blockEnd(out, at)
    if (out.slice(at, end).includes('.undefined')) {
      out = out.slice(0, at) + out.slice(end)
      removed++
      from = at
    } else {
      from = end
    }
  }
  return { css: out, removed }
}

// 带 marker 的规则 upsert：已存在就整块替换（保证规则内容收敛到当前实现），否则追加。
function upsertRule(cssText, marker, rule) {
  const at = cssText.indexOf(marker)
  if (at < 0) return cssText + marker + rule
  const end = blockEnd(cssText, at)
  return cssText.slice(0, at) + marker + rule + cssText.slice(end)
}

// 一条 hide 规则：窄视口下隐藏给定 css 键对应的元素（键名随上游改名时可用 anyOf 传别名）。
function hideOnMobile(pkg, classKeys, options) {
  const anyOf = options?.anyOf === true
  const marker = options?.marker ?? MARKER.modelSeat
  return {
    pkg,
    file: 'lib/client.js',
    custom(entry, src, log) {
      const { start, end } = cssLiteral(src, pkg)
      let cssText = src.slice(start, end)
      const map = cssMapFor(src, cssText, pkg)
      const keys = anyOf ? classKeys.filter((key) => map.entries.has(key)) : classKeys
      const missing = keys.filter((key) => !map.entries.has(key))
      if (keys.length === 0 || missing.length > 0) {
        const detail = anyOf ? 'has none of the css classes' : 'is missing css classes'
        throw new Error(`${NAME}: ${pkg} ${detail} ${classKeys.join(',')} (map ${map.name})`)
      }
      const rule = `@media (max-width:560px){${keys.map((key) => `.${map.entries.get(key)}`).join(',')}{display:none}}`
      const next = upsertRule(cssText, marker, rule)
      if (next === cssText) {
        log(`already applied in ${path.relative(root, entry)}`)
        return src
      }
      return src.slice(0, start) + next + src.slice(end)
    },
  }
}

// 一条结构化规则：给某个包的 client.css 追加 / 原地替换一段带 marker 的媒体查询。
function cssRule(pkg, marker, build) {
  return {
    pkg,
    file: 'lib/client.js',
    custom(entry, src, log) {
      const { start, end } = cssLiteral(src, pkg)
      let cssText = src.slice(start, end)
      const legacy = stripLegacyRules(cssText)
      if (legacy.removed > 0) {
        cssText = legacy.css
        log(`removed ${legacy.removed} stale .undefined rule(s) left by an older build in ${path.relative(root, entry)}`)
      }
      const map = cssMapFor(src, cssText, pkg)
      const rule = build(map.entries, map.name)
      const next = upsertRule(cssText, marker, rule)
      if (next === cssText) {
        log(`already applied in ${path.relative(root, entry)}`)
        return src
      }
      return src.slice(0, start) + next + src.slice(end)
    },
  }
}

// 角标拖动逻辑：注入到 sidebar 的 client bundle 末尾。用文档级委托监听，元素后挂载也能生效；
// 位置写 `:root` 上的 --dsh-fab-x/-y（CSS 规则读它），因此 React 重渲染不会丢；
// 移动超过阈值才算拖动，并把紧随其后的那次 click 吞掉，轻点仍然是「展开侧边栏」。
function fabDragSource(entities) {
  return [
    MARKER.fabDrag,
    ';(() => {',
    `\tconst ROOT = ${JSON.stringify(entities.root)};`,
    `\tconst COLLAPSED = ${JSON.stringify(entities.collapsed)};`,
    "\tconst STORE = 'dsh-docker:mobile-fab';",
    "\tconst MOBILE = '(max-width:1023px)';",
    '\tconst THRESHOLD = 6;',
    `\tconst FALLBACK_SIZE = ${FAB_SIZE};`,
    '\tif (globalThis.__dshMobileFabDragInstalled) return;',
    '\tglobalThis.__dshMobileFabDragInstalled = true;',
    '\tconst rootStyle = document.documentElement.style;',
    '\tconst isMobile = () => window.matchMedia(MOBILE).matches;',
    '\tconst fab = (node) => {',
    `\t\tconst el = node && node.closest ? node.closest('.' + ROOT + '.' + COLLAPSED) : null;`,
    '\t\treturn el && isMobile() ? el : null;',
    '\t};',
    '\tconst clamp = (x, y) => {',
    '\t\tconst el = document.querySelector(\'.\' + ROOT + \'.\' + COLLAPSED);',
    '\t\tconst size = el && el.offsetWidth ? el.offsetWidth : FALLBACK_SIZE;',
    "\t\tconst maxX = Math.max(4, window.innerWidth - size - 4);",
    "\t\tconst maxY = Math.max(4, window.innerHeight - size - 4);",
    '\t\treturn { x: Math.min(Math.max(4, x), maxX), y: Math.min(Math.max(4, y), maxY) };',
    '\t};',
    '\tconst place = (x, y) => {',
    '\t\tconst p = clamp(x, y);',
    "\t\trootStyle.setProperty('--dsh-fab-x', p.x + 'px');",
    "\t\trootStyle.setProperty('--dsh-fab-y', p.y + 'px');",
    '\t\treturn p;',
    '\t};',
    '\tconst current = () => {',
    "\t\tconst x = parseFloat(rootStyle.getPropertyValue('--dsh-fab-x'));",
    "\t\tconst y = parseFloat(rootStyle.getPropertyValue('--dsh-fab-y'));",
    '\t\treturn { x: Number.isFinite(x) ? x : 8, y: Number.isFinite(y) ? y : 8 };',
    '\t};',
    '\ttry {',
    '\t\tconst saved = JSON.parse(localStorage.getItem(STORE) || "null");',
    '\t\tif (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) place(saved.x, saved.y);',
    '\t} catch {}',
    '\tlet drag = null;',
    '\tlet swallowClick = false;',
    "\tdocument.addEventListener('pointerdown', (event) => {",
    '\t\tconst el = fab(event.target);',
    '\t\tif (!el || event.button !== 0) return;',
    '\t\tconst p = current();',
    '\t\tdrag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, baseX: p.x, baseY: p.y, moved: false, el };',
    "\t\tdocument.addEventListener('pointermove', onMove, { passive: false });",
    "\t\tdocument.addEventListener('pointerup', onUp, true);",
    "\t\tdocument.addEventListener('pointercancel', onUp, true);",
    '\t}, true);',
    '\tfunction onMove(event) {',
    '\t\tif (!drag || event.pointerId !== drag.pointerId) return;',
    '\t\tconst dx = event.clientX - drag.startX;',
    '\t\tconst dy = event.clientY - drag.startY;',
    '\t\tif (!drag.moved && Math.hypot(dx, dy) < THRESHOLD) return;',
    '\t\tdrag.moved = true;',
    '\t\tif (event.cancelable) event.preventDefault();',
    '\t\tplace(drag.baseX + dx, drag.baseY + dy);',
    '\t}',
    '\tfunction onUp(event) {',
    '\t\tif (!drag || event.pointerId !== drag.pointerId) return;',
    "\t\tdocument.removeEventListener('pointermove', onMove, { passive: false });",
    "\t\tdocument.removeEventListener('pointerup', onUp, true);",
    "\t\tdocument.removeEventListener('pointercancel', onUp, true);",
    '\t\tconst moved = drag.moved;',
    '\t\tdrag = null;',
    '\t\tif (!moved) return;',
    '\t\tconst p = current();',
    '\t\ttry { localStorage.setItem(STORE, JSON.stringify(p)); } catch {}',
    '\t\tswallowClick = true;',
    '\t\tsetTimeout(() => { swallowClick = false; }, 0);',
    '\t}',
    "\tdocument.addEventListener('click', (event) => {",
    '\t\tif (!swallowClick) return;',
    '\t\tswallowClick = false;',
    '\t\tevent.stopPropagation();',
    '\t\tevent.preventDefault();',
    '\t}, true);',
    "\twindow.addEventListener('resize', () => {",
    '\t\tconst p = current();',
    '\t\tplace(p.x, p.y);',
    '\t});',
    '\t})();',
    MARKER.fabDragEnd,
  ].join('\n')
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
    // Mobile: hide the model name + thinking level in the composer's model seat
    // so the seat never overlaps the sibling read/write policy buttons in the
    // tool row on phones.
    ...hideOnMobile('@deepseek-ai/dsh-client-ui-model-selection', ['triggerLabel', 'triggerEffort'], { marker: MARKER.modelSeat }),
  },
  {
    // Mobile: hide the session-log export affordance in the session header
    // (a plain download button before 0.1.5-rc.1, the header "more actions" menu
    // after); the two css-map keys point at the same header control.
    ...hideOnMobile('@deepseek-ai/dsh-session-log-export', ['moreButton', 'sessionLogButton'], { anyOf: true, marker: MARKER.sessionLog }),
  },
  {
    // Mobile: the collapsed sidebar must collapse to a top-left corner button
    // instead of a full-height 56px rail that reserves a strip of the page.
    // Half 1 (this entry): on narrow viewports a COLLAPSED frame must not keep
    // the rail column -- force the grid to 0 / 1fr / 0 (!important beats the
    // component's inline grid-template-columns) so the center column spans the
    // whole width. The media-query breakpoint matches SIDEBAR_AUTO_COLLAPSE
    // (1024) in dsh-client-ui-layout's columns.ts; data-sidebar-collapsed is
    // set by AppFrame whenever the sidebar is collapsed, in every profile.
    ...cssRule(
      '@deepseek-ai/dsh-client-ui-layout',
      MARKER.sidebarGrid,
      (classes) => `@media (max-width:1023px){.${classes.get('frame')}[data-sidebar-collapsed]{grid-template-columns:0 minmax(0,1fr) 0 !important}}`,
    ),
  },
  {
    // Mobile: half 2 of the same rule -- on narrow viewports the collapsed rail
    // becomes a 36x36 fixed button tucked into the corner. Its position comes
    // from --dsh-fab-x/-y (set by the drag handler below, default 8px/8px), so
    // a dragged fab stays put across re-renders. The other rail controls (new
    // session, workspace region, footer) hide until the sidebar expands, and
    // the toggle shows its panel icon (touch has no hover to reveal it) as the
    // open affordance. touch-action:none keeps a touch drag from scrolling.
    ...cssRule(
      '@deepseek-ai/dsh-client-ui-sidebar',
      MARKER.sidebarFab,
      (c) => `@media (max-width:1023px){.${c.get('root')}.${c.get('collapsed')}{position:fixed;left:var(--dsh-fab-x,12px);top:var(--dsh-fab-y,12px);width:44px;height:44px;padding:0;z-index:60;overflow:visible;border-radius:12px;touch-action:none;background:${FAB_FILL};color:${FAB_ICON};border:0;box-shadow:${FAB_SHADOW};align-items:center;justify-content:center}.${c.get('root')}.${c.get('collapsed')}:hover{background:${FAB_FILL_HOVER}}.${c.get('root')}.${c.get('collapsed')}:active{transform:scale(.94)}.${c.get('root')}.${c.get('collapsed')} .${c.get('logoRow')}{height:auto;margin:0;padding:0;justify-content:center;align-items:center;overflow:visible}.${c.get('root')}.${c.get('collapsed')} .${c.get('newSession')},.${c.get('root')}.${c.get('collapsed')} .${c.get('panelList')},.${c.get('root')}.${c.get('collapsed')} .${c.get('regionArea')},.${c.get('root')}.${c.get('collapsed')} .${c.get('footArea')},.${c.get('root')}.${c.get('collapsed')} .${c.get('settingsArea')}{display:none}.${c.get('root')}.${c.get('collapsed')} .${c.get('toggle')}{width:100%;height:100%;border-radius:12px;color:inherit}.${c.get('root')}.${c.get('collapsed')} .${c.get('toggle')}:hover{background:transparent}.${c.get('root')}.${c.get('collapsed')} .${c.get('toggle')} .${c.get('panelIcon')}{display:inline;width:22px;height:22px}.${c.get('root')}.${c.get('collapsed')} .${c.get('toggle')} .${c.get('railMark')}{display:none}}`,
    ),
  },
  {
    // Mobile: rule 5 -- make that fab draggable (positions persist in
    // localStorage + :root custom properties); a tap still expands the sidebar.
    pkg: '@deepseek-ai/dsh-client-ui-sidebar',
    file: 'lib/client.js',
    custom(entry, src, log) {
      const display = path.relative(root, entry)
      const { start, end } = cssLiteral(src, '@deepseek-ai/dsh-client-ui-sidebar')
      const map = cssMapFor(src, src.slice(start, end), '@deepseek-ai/dsh-client-ui-sidebar')
      const entities = { root: map.entries.get('root'), collapsed: map.entries.get('collapsed') }
      for (const [key, value] of Object.entries(entities)) {
        if (typeof value !== 'string') {
          throw new Error(`${NAME}: @deepseek-ai/dsh-client-ui-sidebar has no css class "${key}" (map ${map.name})`)
        }
      }
      const injected = fabDragSource(entities)
      // 已注入过就按 marker 整块替换（角标尺寸/阈值等实现细节改了，产物也要跟着更新），
      // 而不是简单跳过；首次则插在 sourceMappingURL 之前。替换范围含「前导换行 → 块尾」，
      // 保证重复运行收敛到同一个字节序列（幂等）。
      const sourceMap = src.indexOf('//# sourceMappingURL=')
      const at = src.indexOf(MARKER.fabDrag)
      if (at >= 0) {
        const lead = src.lastIndexOf('\n', at) >= 0 ? src.lastIndexOf('\n', at) : at
        // 结束 marker 是后加的：历史产物只有起始 marker，其块一直延伸到 sourceMappingURL
        // （或文件末尾），按同样范围替换即可升级。
        const stop = src.indexOf(MARKER.fabDragEnd, at)
        const tail = stop >= 0 ? stop + MARKER.fabDragEnd.length : (sourceMap >= 0 ? sourceMap : src.length)
        const next = src.slice(0, lead) + '\n' + injected + src.slice(tail)
        if (next === src) {
          log(`already applied in ${display}`)
          return src
        }
        return next
      }
      return sourceMap < 0 ? src + '\n' + injected : src.slice(0, sourceMap) + injected + '\n' + src.slice(sourceMap)
    },
  },
]

for (const { pkg, file, replacements, custom } of targets) {
  const dir = findPackageDir(pkg)
  const entry = path.resolve(dir, file ?? entryFile(dir, pkg))
  const display = path.relative(root, entry)
  const before = fs.readFileSync(entry, 'utf8')
  const after = custom === void 0 ? applyReplacements(display, before, replacements) : custom(entry, before, log)
  if (after === before) continue // 无变化：custom() 已按 marker 报过 already applied
  fs.writeFileSync(entry, after)

  // 打完补丁的产物必须仍能通过语法检查。
  const check = spawnSync(process.execPath, ['--check', entry], { stdio: 'inherit' })
  if (check.status !== 0) process.exit(check.status ?? 1)
  log('patched ' + display)
}
