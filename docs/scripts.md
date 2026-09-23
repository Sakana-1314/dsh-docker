# 脚本清单

本仓库所有 hook 脚本都放在 `scripts/` 下，**一个功能一个目录**。每个脚本**单一职责、自包含**：不引用 `scripts/` 下的任何其他脚本，需要共享的逻辑各自复制一份（刻意用少量重复换取零耦合）。新增、改名、删除脚本时，必须同步更新本文件。

## 目录约定

- `scripts/<功能>/`：一个功能一个目录，目录里放该功能的脚本与配置载荷，例如 `scripts/bind-host/bind-0.0.0.0.patch.yml`。
- 构建时补丁脚本命名 `patch-<功能>.cjs`，由 `Dockerfile` **按固定顺序显式调用**（下表顺序即执行顺序，也决定产物顺序）；运行时脚本由入口脚本调用；CI 脚本命名 `*.sh`。
- 手机端的多条 UI 规则视为**一个功能**，统一放在 `scripts/mobile-ui/patch-mobile-ui.cjs`，不再按规则拆脚本。
- `config/` 目录已废弃：dsh 的配置补丁层作为载荷放回对应功能目录。

## 构建时补丁脚本

镜像构建阶段执行（`Dockerfile` 的 build stage），只改**编译产物**（各包 `lib/*.js`、`apps/web/dist`，以及上游随包发布的预设 YAML），全部幂等。

| 脚本 | 作用 | 注入对象 | 环境变量 |
|---|---|---|---|
| `scripts/llm-retry/patch-llm-retry.cjs` | 请求重试与退避参数改为运行时环境变量，并支持覆盖 User-Agent、追加可重试错误码 | `dsh-llm` | `DSH_RETRY`、`DSH_RETRY_INITIAL_DELAY_MS`、`DSH_RETRY_MAX_DELAY_MS`、`DSH_RETRY_JITTER_RATIO`、`DSH_RETRYABLE_CODES`、`UA` |
| `scripts/default-directory/patch-default-directory.cjs` | 目录选择器默认从容器工作目录起，而不是 `$HOME` | `dsh-host-directory-picker-browse` | `DSH_DEFAULT_DIRECTORY` |
| `scripts/trust-fence/patch-trust-fence.cjs` | 信任栅栏移除：主机端 `/api` 的 Host/Origin 校验、浏览器会话（token/cookie）鉴权、浏览器端 loopback 判定，并把开关注入页面全局 | `dsh-client-connection`（host + browser）、`dsh-client-modules` | `DSH_DISABLE_TRUST_FENCE` |
| `scripts/auto-plan/patch-auto-plan.cjs` | 新增 `/auto-plan` 命令：计划模式退出时自动批准，跳过评审确认卡片；并把命令文案登记进上游双语机制（中文界面显示中文），兼容两种识别方式——0.1.6 起按定义标识（`definitionId` + `BUILTINS` / `HOST_FACES`，补 label/description/token 字典），0.1.5 及更早按描述文案（`HOST_DESCRIPTION_KEYS`） | `dsh-plan-mode`、`dsh-client-ui-commands` | 无 |
| `scripts/welcome-notice/patch-welcome-notice.cjs` | 默认跳过首次进入 GUI 的内测声明弹窗 | `dsh-client-modules`、`dsh-client-ui-settings-models` | `DSH_SHOW_WELCOME_NOTICE` |
| `scripts/red-favicon/patch-red-favicon.cjs` | favicon（浏览器标签页 / PWA 图标）换成红色版：鲸鱼标由浅色模式的 `#000`、深色模式的 `#fff` 统一改为固定红 `#E60012`。深色配色兼容两种上游布局——0.1.7 起是独立产物 `favicon-dark.svg`（`fill="#fff"`），0.1.6 及更早是 `favicon.svg` 内联 `<style>` 媒体查询里的 `fill: #fff;`；两种都对不上就报错（只改 Web 构建产物，源文件 `apps/web/public/favicon*.svg` 不动） | `apps/web/dist/favicon.svg`、`apps/web/dist/favicon-dark.svg`（0.1.7 起） | 无 |
| `scripts/mobile-ui/patch-mobile-ui.cjs` | 手机端 UI 优化，五条规则一个脚本：隐藏输入框的模型名与思考等级（< 560px）、隐藏会话头部的 session log 导出入口（< 560px）、折叠侧边栏不占页面宽度（< 1024px）、折叠侧边栏收起到左上角 **44×44 品牌红实心角标**（< 1024px，收起态只留角标：新建会话 / 全局面板列表即插件入口 / 工作区 / 页脚 / 设置全部隐藏）、角标可拖动且位置持久化（< 1024px，`:root` 的 `--dsh-fab-x/-y` + `localStorage['dsh-docker:mobile-fab']`，轻点仍是展开）。类名取「属于目标 css 串」的那个 css map（一个 bundle 可能含多个），注入的 CSS/JS 段带 marker 可原地替换并清理旧坏规则 | `dsh-client-ui-model-selection`、`dsh-session-log-export`、`dsh-client-ui-layout`、`dsh-client-ui-sidebar` | 无 |
| `scripts/speech-model-mirror/patch-speech-model-mirror.cjs` | 语音识别（本地 SenseVoice 转写）的模型**优先**从国内可直连的镜像站 `https://hf-mirror.com` 下载（转写模型 int8 / fp32、`tokens.txt`、Silero VAD）。改的是编译产物里 origin 默认值，兼容两种上游布局：0.1.7-rc.1 起是多源 `modelOrigins` 默认数组（运行时并行探测优选、其余回退），把镜像**挪到首位**、官方站留作回退；0.1.7-alpha.2 及更早是单源 `modelOrigin`，直接换成镜像。下载地址 = origin + 清单 `runtime/assets.json` 的 pathname | `dsh-experimental-speech-to-text-sensevoice`（`lib/index.js`、`lib/worker.js`） | 无 |

锚点跟随 `VERSION` 指向的上游版本：上游改了结构，脚本会立即报错终止（构建失败），按报错更新对应脚本的锚点即可。

补丁条目格式：`[from, to, all?, marker?]`。`from` 默认必须在文件里恰好出现一次（`all` 为真时允许零次以上）；`marker` 默认取 `to`，命中即视为已应用并跳过；锚点缺失时脚本抛错，构建随即失败——上游升级导致结构变化时会响亮地提示需要更新补丁。

## 运行时脚本

| 脚本 | 作用 | 触发条件 |
|---|---|---|
| `scripts/container-entrypoint/docker-entrypoint.sh` | 容器入口编排：准备 DSH home、把环境变量翻译成 `dsh web` 参数、按需调用运行时补丁 | 容器启动（Dockerfile `ENTRYPOINT`） |
| `scripts/plugin-fence/patch-plugin-fence.cjs` | 给已安装 profile 插件自带的信任栅栏注入同一个环境变量旁路（核心 `/api` 由 `trust-fence` 在构建时处理） | `DSH_DISABLE_TRUST_FENCE=1` |

## 配置载荷（非可执行）

| 文件 | 作用 | 使用方 |
|---|---|---|
| `scripts/bind-host/bind-0.0.0.0.patch.yml` | 让 Web 服务监听 `0.0.0.0`（dsh CLI 拒绝该值，因此作为 cordis patch 层应用），供 Docker 端口映射访问 | `docker-entrypoint.sh` 的 `--patch` 参数 |

## CI 脚本

| 脚本 | 作用 | 调用方 |
|---|---|---|
| `scripts/dsh-version/resolve-version.sh` | 把显式输入或上游最新 `dsh-v*` 标签解析成 `ref` / `version` 两行输出 | `.github/workflows/build.yml`「解析 dsh 版本」；`Dockerfile` 构建阶段解析 `DSH_REF` |
| `scripts/dsh-version/sync-version-file.sh` | 把 `VERSION` 同步到目标版本：有变化就写入、提交并推送，输出 `changed=true/false` | `.github/workflows/build.yml`「同步 VERSION 文件」 |

## 新增脚本约定

1. **单一职责**：一个脚本只做一件事（一个增强 / 一次解析 / 一次同步），不要把顺手也要改的东西塞进来；手机端的多条 UI 规则属于同一个功能，加规则就加在 `mobile-ui` 脚本里。
2. **自包含**：不得 `require` / `source` `scripts/` 下的其他脚本；共享的辅助逻辑各自复制。
3. **失败要响亮**：锚点、类名、结构匹配不上时直接报错退出，绝不静默跳过。
4. **幂等**：重复运行结果不变；需要时用 `marker` 明确"已应用"的判据。
5. **登记**：新增 / 改名 / 删除脚本同步更新本文件；构建时脚本还要在 `Dockerfile` 的顺序列表里登记。
6. **只碰编译产物**：绝不手改上游被 git 跟踪的源码；构建时补丁只能写各包 `lib/*.js`、`apps/web/dist`，或上游随包发布、运行时读取的预设 YAML。
