# AGENTS.md

> 本文件是给 **AI 编程智能体 / 新开发者** 的项目手册。所有改动必须遵守下述「硬性约束」；「最佳实践」是质量门槛，评审与自检时逐条对照。文档以中文维护。

## 1. 项目简介

**dsh-docker** —— 基于 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 上游源码（`dsh-v*` 发布标签）构建 DeepSeek Harness Docker 镜像的部署仓库：

- `Dockerfile`：多阶段构建（pnpm workspace 安装 → `build:lib` + `build:web` → 注入补丁）。
- `patch-dsh.cjs`：**唯一的定制入口（hook）**——构建时对上游源码 checkout 的编译产物做幂等补丁注入；所有对 DSH 行为/UI 的定制都写在这里。
- `patch-plugin-fence.cjs`：容器启动时的运行时插件信任栅栏补丁（`DSH_DISABLE_TRUST_FENCE=1` 时生效）。
- `README.md`：镜像用法 + 每个构建时增强的说明（改动 UI/行为后同步补一条）。

完整的增强清单见 `README.md`。

## 2. 硬性约束（违反即视为错误，必须遵守）

1. **绝不直接修改上游源码**：`deepseek-harness` 是上游仓库（本机验证 checkout 在 `/opt/dsh`）。不得手改其任何**被 git 跟踪**的文件，不得向上游提交改动。
2. **一切 DSH 定制只经 `patch-dsh.cjs` 注入**：补丁目标只能写编译产物（各包 `lib/*.js` / `apps/web/dist` 等 **gitignored** 产物），且必须**幂等**（重复运行不改变结果）。本地 `/opt/dsh` 只作为补丁的验证目标，其 `lib/*` 产物的变化来自脚本运行，而非手改。
3. **改动必须带文档**：新增/修改一个增强，同步更新 `README.md`；涉及 UI 行为规范，同步写入本文件「4. 移动端 UI 规范」或新增小节。
4. **补丁要可感知失败**：补丁锚点（包名 / 编译产物里的固定串 / css map 的类名 key）在注入前必须校验存在，缺失就**抛错终止**（构建即失败），绝不静默跳过——上游升级导致结构变化时，构建会响亮地提示需要更新补丁。

## 3. 补丁应用与验证流程（每次改动必循）

1. **改 `patch-dsh.cjs`**：在 `targets` 数组新增目标（简单串替换用 `replacements`，CSS/结构注入用 `custom`，参照既有 `hideOnMobile` / `appendCssSuffix` helper）。
2. **应用到验证 checkout**：`node patch-dsh.cjs /opt/dsh`（脚本自带 `node --check` 语法校验）。
3. **在 GUI 上验证**：运行中的 GUI（`http://127.0.0.1:3080`）直接从各包 `lib/client.js` 伺服 `/plugins/@deepseek-ai/<pkg>/client.js`（内容哈希 rev + `no-cache`），**改完刷新页面即生效，无需重建 web**。用 playwright（headless chromium，`/root/.npm/_npx/*/node_modules/playwright`）在目标视口做 DOM/计算样式断言。
4. **幂等复检**：再次运行 `node patch-dsh.cjs /opt/dsh`，确认文件内容不再变化。

## 4. 移动端 UI 规范

本仓库对 dsh 移动端（手机 / 窄视口）UI 的定制，均通过 `patch-dsh.cjs` 在构建时注入 CSS 媒体查询（类名从各包自身 css map 解析，哈希无关）。既有规范：

- **侧边栏折叠后收到左上角，不占据页面宽度**：移动端（视口 < 1024px，对应上游 `SIDEBAR_AUTO_COLLAPSE`）侧边栏折叠后，不得以 56px 全高竖栏占据页面左侧一条宽度；应**收起到左上角的角标按钮**（36×36，圆角，图标为展开面板图标），中心内容占满整页宽度。桌面端（≥1024px）行为与上游一致（56px rail）。实现见 `patch-dsh.cjs` 中 `@deepseek-ai/dsh-client-ui-layout`（折叠时 grid 强制 `0 / 1fr / 0`，`!important` 覆盖内联样式）与 `@deepseek-ai/dsh-client-ui-sidebar`（折叠 rail 变固定角标、隐藏其余 rail 控件）两个目标。
- **手机端隐藏模型名称与思考等级**：避免与读写策略按钮重叠（`@deepseek-ai/dsh-client-ui-model-selection`）。
- **手机端隐藏「下载 session log」按钮**（`@deepseek-ai/dsh-session-log-export`）。

新增移动端 UI 定制时：断点优先与上游布局逻辑对齐（如 1024px 折叠断点）；隐藏类名用 `hideOnMobile`，结构性规则用 `appendCssSuffix`；并在此节补一条规范。

## 5. 提交流程（必循，每次改动都按此执行）

1. **按功能点拆分 commit**：一次改动先拆成若干逻辑独立、主题清晰的小 commit（如：patch 改动 / README / AGENTS.md 各一个），每笔 commit 都能独立审查；**禁止**把所有改动揉成一个大 commit。
2. **功能分支**：从 `main` 切出 `feat/<简述>`（如 `feat/mobile-sidebar-corner`），在分支上逐个提交。**不要在 `main` 上直接提交改动**（纯 `**.md` 文档例外，见第 6 条）。
3. **发起 PR**：推送分支后 `gh pr create --base main --head <分支>`；PR 标题用 `feat:` / `fix:` / `docs:` 前缀（本仓库 squash 合并后 PR 标题即成为 main 上的提交信息），描述列出改动清单。
4. **合并并删除分支**：确认通过后用 `gh pr merge --squash --delete-branch`（本仓库**仅允许 squash 合并**，见仓库 Settings → Merge button；`--delete-branch` 会同时删除本地与远端分支）。合并后无需再手动删分支。
5. **清理多余分支**：定期核对并删除已合并交付的陈旧分支——远端 `git push origin --delete <分支>`（先用 `gh pr list --state merged` 确认已交付），本地 `git fetch --prune`（或 `git remote prune origin`）清除陈旧跟踪引用。
6. **文档例外**：纯 `**.md` 改动不会触发 CI 镜像构建（`.github/workflows/build.yml` 的 `paths-ignore` 忽略 `**.md`），可免 PR 直接提交到 `main`；其余改动一律走第 1–4 条。

## 6. 常见任务速查

- **给 GUI 加一条移动端 CSS 定制**：确认断点 → 在 `patch-dsh.cjs` 用 `hideOnMobile` / `appendCssSuffix` 增加 target → 跑脚本 → 刷新 GUI 验证 → 幂等复检 → 更新 `README.md` + 本文件第 4 节。
- **升级上游 dsh 版本**：改 `VERSION` 并触发 workflow（`workflow_dispatch` 传版本，或由定时任务自动检最新 `dsh-v*`）；若构建在补丁锚点处失败，按报错更新 `patch-dsh.cjs` 后再构建。
