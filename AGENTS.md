# AGENTS.md

> 本文件是给 **AI 编程智能体 / 新开发者** 的项目手册。所有改动必须遵守下述「硬性约束」；「最佳实践」是质量门槛，评审与自检时逐条对照。文档以中文维护。

## 1. 项目简介

**dsh-docker** —— 基于 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 上游源码（`dsh-v*` 发布标签）构建 DeepSeek Harness Docker 镜像的部署仓库：

- `Dockerfile`：多阶段构建（pnpm workspace 安装 → `native/system` 的原生扩展与 landlock 启动器 + `build:lib` + `build:web` → 按固定顺序执行 `scripts/` 下的构建时补丁）。
- `scripts/<功能>/`：**所有 hook 脚本**，一个功能一个目录；每个脚本单一职责、自包含（脚本之间不互相引用），构建时补丁只写编译产物。
- `docs/scripts.md`：**脚本清单**——列出每个脚本的作用、注入对象、环境变量与运行时机；新增 / 改名 / 删除脚本必须同步登记。
- `VERSION`：当前镜像构建自哪个上游 dsh 版本，由 `.github/workflows/build.yml` 定时轮询自动维护。
- `README.md`：镜像用法 + 每个构建时增强的说明（改动 UI/行为后同步补一条）。

## 2. 硬性约束（违反即视为错误，必须遵守）

1. **绝不直接修改上游源码**：`deepseek-harness` 是上游仓库（本机验证 checkout 在 `/opt/dsh`）。不得手改其任何**被 git 跟踪**的文件，不得向上游提交改动。
2. **一切 DSH 定制只经 `scripts/` 下的补丁脚本注入**：补丁目标只能写编译产物（各包 `lib/*.js` / `apps/web/dist` 等 **gitignored** 产物）或上游随包发布、运行时读取的预设 YAML，且必须**幂等**（重复运行不改变结果）。本地 `/opt/dsh` 只作为补丁的验证目标，其 `lib/*` 产物的变化来自脚本运行，而非手改。
3. **脚本单一职责、自包含、不互相引用**：一个脚本只做一件事；不得 `require` / `source` `scripts/` 下的其他脚本（共享的辅助逻辑各自复制一份，刻意用少量重复换取零耦合）；新增、改名、删除脚本必须同步更新 `docs/scripts.md`，构建时脚本还要在 `Dockerfile` 的固定顺序列表里登记。
4. **改动必须带文档**：新增/修改一个增强，同步更新 `README.md`；涉及 UI 行为规范，同步写入本文件「4. 移动端 UI 规范」或新增小节。
5. **补丁要可感知失败**：补丁锚点（包名 / 编译产物里的固定串 / css map 的类名 key）在注入前必须校验存在，缺失就**抛错终止**（构建即失败），绝不静默跳过——上游升级导致结构变化时，构建会响亮地提示需要更新补丁。

## 3. 补丁应用与验证流程（每次改动必循）

1. **改对应功能的脚本**：`scripts/<功能>/patch-<功能>.cjs`。简单串替换用 `replacements` 条目 `[from, to, all?, marker?]`（`from` 默认需唯一，`all` 为真时允许零次以上；`marker` 默认取 `to`，命中即视为已应用）；CSS / 结构注入用 `custom`，参照既有 `hideOnMobile` / `appendCssSuffix` helper。**同一个文件被多个脚本处理时，各自必须用 `marker` 判定「已应用」**，保证幂等且与执行顺序无关。
2. **应用到验证 checkout**：`node scripts/<功能>/patch-<功能>.cjs /opt/dsh`（脚本自带 `node --check` 语法校验）；再跑一次确认只输出 `already applied`、文件零改动。**锚点跟随 `VERSION` 指向的上游版本**：本机 `/opt/dsh` 可能还是旧版本，已经为更新版本改写锚点的脚本在旧 checkout 上会响亮报错——那是版本错位，不是补丁坏了。为更新版本改锚点时，用同版本产物验证：`npm pack @deepseek-ai/<pkg>@<version>` 取各包编译产物，拼一个合成工作区（`packages/<tier>/<name>/package.json` + `lib/*.js`，预设类改动再从上游 tag 取对应 YAML）跑一遍最省事；最终以 CI 构建为准。
3. **在 GUI 上验证**：运行中的 GUI（`http://127.0.0.1:3080`）直接从各包 `lib/client.js` 伺服 `/plugins/@deepseek-ai/<pkg>/client.js`（内容哈希 rev + `no-cache`），**改完刷新页面即生效，无需重建 web**。用 playwright（headless chromium，`/root/.npm/_npx/*/node_modules/playwright`）在目标视口做 DOM/计算样式断言。
4. **幂等复检**：再次运行该脚本，确认文件内容不再变化。

## 4. 手机端 UI 规范

本仓库对 dsh 手机端（手机 / 窄视口）UI 的定制，全部放在**一个脚本** `scripts/mobile-ui/patch-mobile-ui.cjs` 里（手机端优化视为一个功能，按规则增删条目，不拆新脚本），通过在构建时注入 CSS 媒体查询实现（类名从各包自身 css map 解析，哈希无关）。既有规范：

- **侧边栏折叠后收到左上角，不占据页面宽度**：移动端（视口 < 1024px，对应上游 `SIDEBAR_AUTO_COLLAPSE`）侧边栏折叠后，不得以 56px 全高竖栏占据页面左侧一条宽度；应**收起到左上角的角标按钮**（36×36，圆角，图标为展开面板图标），中心内容占满整页宽度。桌面端（≥1024px）行为与上游一致（56px rail）。实现是同脚本的两条规则：`dsh-client-ui-layout`（折叠时 grid 强制 `0 / 1fr / 0`，`!important` 覆盖内联样式）与 `dsh-client-ui-sidebar`（折叠 rail 变固定角标、隐藏其余 rail 控件）。
- **角标必须可点开、可拖动**：角标是收起后唯一的展开入口，必须真的点得到——`position:fixed` + `z-index:30` 让它脱离 0 宽列的裁剪并浮在中心列之上。定位一律走 `:root` 上的 `--dsh-fab-x/-y`（默认 8px/8px）：位置由同脚本注入 `dsh-client-ui-sidebar` client bundle 的拖动逻辑维护（文档级 `pointerdown` 委托 + 6px 移动阈值，小于阈值仍是点击展开，超过阈值才算拖动并吞掉随后的 click），存 `localStorage['dsh-docker:mobile-fab']`，并在视口内限幅。
- **类名必须按「所属 css 串」解析**：一个 bundle 可能打包多个 CSS module（`ui-sidebar` 里 `HeaderLeadingControls` 与 `SidebarRoot` 各一份），只按「类名出现在目标 css 串里」判定 map 归属；归属不唯一 / 键缺失直接报错。**取错 map 会生成 `.undefined` 选择器让规则静默失效**（曾导致手机上角标不存在、侧边栏点不开）。
- **注入规则要能识别与替换**：每条注入规则带 `/*dsh-docker:mobile-ui:<name>*/` marker，重跑按 marker 原地替换（内容收敛到当前实现），并清理历史实现留下的 `.undefined` 规则，因此从旧坏产物重建能自愈。
- **手机端隐藏模型名称与思考等级**：避免与读写策略按钮重叠（`dsh-client-ui-model-selection`）。
- **手机端隐藏 session log 导出入口**（`dsh-session-log-export`）：0.1.5-rc.1 起上游把它从独立下载按钮改成会话头部「更多操作」菜单，脚本用 `anyOf` 别名同时兼容 `moreButton` 与 `sessionLogButton` 两个 css 键名。

新增移动端 UI 定制时：断点优先与上游布局逻辑对齐（如 1024px 折叠断点）；隐藏类名用 `hideOnMobile`（键名会随上游改名时传 `{ anyOf: true }` 别名），结构性规则用 `cssRule`（自带 marker，重跑原地替换）；在 `mobile-ui` 脚本里加一条规则、更新 `docs/scripts.md` 的说明，并在此节补一条规范。

## 5. 品牌资源（favicon）规范

- **favicon 为固定红色 `#E60012`**：浏览器标签页 / PWA 图标（0.1.7 起是 `/favicon.svg` 供浅色 + `/favicon-dark.svg` 供深色，由 `index.html` 里两个带 `media` 的 `<link>` 选择）的鲸鱼标一律是红标，浅色与深色配色方案下都一样——**深色配色必须显式覆盖**，只改浅色那颗会让深色模式仍是白标。上游表达深色配色的方式有过两种布局，脚本两条路径都必须保留：0.1.7 起独立产物 `favicon-dark.svg` 的 `fill="#fff"`；0.1.6 及更早是 `favicon.svg` 内联 `<style>` 媒体查询里的 `fill: #fff`（CSS 优先级高于 `<path>` 表现属性）。
- **只改构建产物**：补丁对象是 `apps/web/dist/favicon.svg` 与 `apps/web/dist/favicon-dark.svg`（gitignored，由 `dsh web` 作为静态资源伺服），上游被 git 跟踪的源文件 `apps/web/public/favicon*.svg` 不动；颜色常量写在 `scripts/red-favicon/patch-red-favicon.cjs` 里，不引入环境变量。改色值只需改该脚本的 `RED` 常量，并在 `docs/scripts.md` 与 `README.md` 同步。
- **布局变化要可感知**：脚本先按产物识别布局（有 `favicon-dark.svg` 走新版、否则找内联 CSS 锚点），两种都对不上直接报错（构建失败）；收尾还要对**全部** favicon 产物做一次「红标就位 + 默认色零残留」复检，避免半打补丁或上游再改布局时静默留下白标。

## 6. 提交流程（必循，每次改动都按此执行）

1. **按功能点拆分 commit**：一次改动先拆成若干逻辑独立、主题清晰的小 commit（如：脚本拆分 / Dockerfile / 工作流 / 文档各一个），每笔 commit 都能独立审查；**禁止**把所有改动揉成一个大 commit。
2. **功能分支**：从 `main` 切出 `feat/<简述>`（如 `feat/scripts-layout`），在分支上逐个提交。**不要在 `main` 上直接提交改动**（纯 `**.md` 文档例外，见第 6 条）。
3. **发起 PR**：推送分支后 `gh pr create --base main --head <分支>`；PR 标题用 `feat:` / `fix:` / `docs:` 前缀（本仓库 squash 合并后 PR 标题即成为 main 上的提交信息），描述列出改动清单。
4. **合并并删除分支**：确认通过后用 `gh pr merge --squash --delete-branch`（本仓库**仅允许 squash 合并**，见仓库 Settings → Merge button；`--delete-branch` 会同时删除本地与远端分支）。合并后无需再手动删分支。
5. **清理多余分支**：定期核对并删除已合并交付的陈旧分支——远端 `git push origin --delete <分支>`（先用 `gh pr list --state merged` 确认已交付），本地 `git fetch --prune`（或 `git remote prune origin`）清除陈旧跟踪引用。
6. **文档例外**：纯 `**.md` 改动不会触发 CI 镜像构建（`.github/workflows/build.yml` 的 `paths-ignore` 忽略 `**.md`），可免 PR 直接提交到 `main`；其余改动一律走第 1–4 条。

## 7. 常见任务速查

- **给 GUI 加一条手机端 CSS 定制**：确认断点 → 在 `scripts/mobile-ui/patch-mobile-ui.cjs` 的 `targets` 里加一条（隐藏类名用 `hideOnMobile`，结构性规则用 `cssRule` + 自己的 marker；需要运行时行为就注入 client bundle 里，参考角标拖动那段）→ 跑脚本 → 刷新 GUI 验证（含拖动/点击等交互）→ 幂等复检 → 更新 `docs/scripts.md` 的说明 + 本文件第 4 节（**不新建脚本**）。
- **新增 / 改名 / 删除 hook 脚本**：保持单一职责与自包含（不引用其他脚本）；同步 `docs/scripts.md` 清单；构建时脚本还要改 `Dockerfile` 的顺序列表。
- **换 favicon 颜色**：改 `scripts/red-favicon/patch-red-favicon.cjs` 的 `RED` 常量（浅色 `fill="#000"`、深色 `fill="#fff"` 或旧布局内联 CSS `fill: #fff;` 的锚点都要覆盖）→ 跑脚本 → 刷新 GUI 验证（浅色与深色两种配色方案都要看）→ 幂等复检 → 同步 `docs/scripts.md` 与 `README.md` + 本文件第 5 节。
- **换语音识别模型镜像站**：改 `scripts/speech-model-mirror/patch-speech-model-mirror.cjs` 的 `MIRROR_ORIGIN` 常量（锚点是编译产物里 `modelOrigin` 的默认值：`lib/index.js` 与 `lib/worker.js` 各一处，下载地址 = `modelOrigin` + `runtime/assets.json` 的 pathname）→ 跑脚本 → 用产物里的默认值拼地址、比对该清单的字节数与 sha256 → 幂等复检 → 同步 `docs/scripts.md` 与 `README.md`。
- **升级上游 dsh 版本**：定时轮询（`.github/workflows/build.yml`）发现上游新 `dsh-v*` 标签后，先由 `scripts/dsh-version/sync-version-file.sh` 把版本写进 `VERSION` 并提交推送，再构建镜像；手动触发用 `workflow_dispatch` 传版本（同样会先同步 `VERSION`）。若构建在补丁锚点处失败，按报错更新对应脚本后再构建。
