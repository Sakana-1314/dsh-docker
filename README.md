# deepseek-harness 镜像

基于 [deepseek-harness 仓库源码](https://github.com/deepseek-ai/deepseek-harness)（`dsh-v*` 发布标签）在镜像内构建的 DeepSeek Harness Docker 镜像：pnpm workspace 安装依赖、编译原生 system 扩展（flock / landlock 沙箱启动器）与所有包、Web 前端，再注入本仓库的构建时补丁（`scripts/` 下一个功能一个的单一职责脚本，清单见 [`docs/scripts.md`](docs/scripts.md)）。基础镜像为 `node:24-trixie-slim`（Debian 13 + Node 24），默认监听 `0.0.0.0`，配合 Docker 端口映射开箱即用。镜像由 GitHub Actions 定时检查上游最新发布标签并自动构建推送到腾讯云 CCR；**定时轮询发现上游版本变更时，工作流会先把新版本写进 `VERSION` 并提交推送，再构建镜像**（`:<版本>` 标签与 `VERSION` 始终对应当前构建的上游版本）。

镜像：`sgccr.ccs.tencentyun.com/misaka-network/deepseek-harness`（`:latest` / `:<版本>`）　上游：<https://github.com/deepseek-ai/deepseek-harness>

## 仓库结构

```
scripts/<功能>/                     所有 hook 脚本，一个功能一个目录；每个脚本单一职责、自包含（脚本之间不互相引用）
  patch-<功能>.cjs                  构建时补丁：由 Dockerfile 按固定顺序调用，只改编译产物
  bind-host/*.patch.yml             配置载荷（dsh 的 cordis patch 层，非可执行）
  container-entrypoint/             容器入口编排脚本
  plugin-fence/                     容器启动时的运行时补丁
  dsh-version/*.sh                  CI 脚本：解析上游版本 / 同步 VERSION
docs/scripts.md                     脚本清单：每个脚本的作用、注入对象、环境变量与运行时机
Dockerfile                          多阶段构建（构建阶段依次执行 scripts/ 下的补丁脚本）
.github/workflows/build.yml         定时轮询上游 dsh 版本 → 更新 VERSION → 构建并推送镜像
VERSION                             当前镜像构建自哪个上游 dsh 版本（由工作流自动维护）
```

新增脚本前先读 [`docs/scripts.md`](docs/scripts.md) 的「新增脚本约定」：单一职责、自包含、失败要响亮、幂等，并在清单里登记。

## 使用

### 部署

`docker-compose.yml`：

```yaml
services:
  dsh:
    image: sgccr.ccs.tencentyun.com/misaka-network/deepseek-harness:latest
    container_name: dsh
    restart: unless-stopped
    ports:
      - "3080:3080"
    environment:
      DEEPSEEK_API_KEY: "sk-..."
    volumes:
      - ./workspace:/workspace      # 工作目录
      - ./dsh-home:/root/.dsh   # 插件 / 配置 / 凭证 / 存储
```

```bash
docker compose up -d
```

打开 <http://localhost:3080>。

或 `docker run`：

```bash
docker run -d --name dsh \
  -p 3080:3080 \
  -e DEEPSEEK_API_KEY=sk-... \
  -v "$PWD/workspace:/workspace" \
  -v "$PWD/dsh-home:/root/.dsh" \
  sgccr.ccs.tencentyun.com/misaka-network/deepseek-harness:latest
```

自建镜像（从上游源码构建，`DSH_REF` 为发布标签 / 分支 / commit，默认最新 `dsh-v*` 标签）：

```bash
docker build -t deepseek-harness:local .
docker build --build-arg DSH_REF=dsh-v0.1.0-rc.7 -t deepseek-harness:local .
```

### 需要配置的环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek API Key（必填，也可写进 `./dsh-home/.env`） | 无 |
| `DSH_PORT` | 监听端口 | `3080` |
| `DSH_DEFAULT_DIRECTORY` | 默认工作目录 | `/workspace`（容器当前目录） |
| `DSH_PERMISSION_MODE` | 部署级文件读写策略：`workspace-write`（沙箱限制在工作区内）/ `danger-full-access`（不限制，审批同时放行） | `workspace-write` |
| `DSH_RETRY` | 请求失败重试次数 | `30` |
| `DSH_RETRY_INITIAL_DELAY_MS` | 重试退避初始延迟（毫秒） | `500` |
| `DSH_RETRY_MAX_DELAY_MS` | 重试退避上限（毫秒） | `10000` |
| `DSH_RETRY_JITTER_RATIO` | 重试退避抖动比例（0–1） | `0.1` |
| `DSH_RETRYABLE_CODES` | 追加可重试的错误码（逗号分隔），如 `PI_AI_ERROR,HTTP_408`。网关的自定义报错文案若被归入不可重试的兜底错误码，加进来即可参与同一套退避重试 | 无 |
| `UA` | 覆盖请求模型供应商的 User-Agent | `deepseek-harness/<版本> (+url)` |
| `DSH_HOST` | `0.0.0.0` 或 `127.0.0.1`（仅本机） | `0.0.0.0` |
| `DSH_TRUSTED_HOSTS` | 信任的访问地址（空格/逗号分隔）：局域网 IP、域名、反向代理地址。`/api` 与插件路由（`/sidebar/*`）都会放行 | 无（容器自身的局域网 IP 自动受信） |
| `DSH_DISABLE_TRUST_FENCE` | 设为 `1` 彻底关闭信任栅栏**与浏览器会话（token/cookie）鉴权**，同时作用于 `/api`、已安装插件的路由（如 `/sidebar/*`）以及 0.1.3 起新增的会话认证——关闭后远程浏览器访问 `/api` 与首页不再要求携带 `?token=` 换取 cookie（不再 401），并解锁远程浏览器访问 settings（模型 / 凭证设置页，默认仅限 `localhost` 可用，远程显示「加载提供方目录失败」）；无鉴权，仅在你自己的反代 / 鉴权后使用 | 无 |
| `DSH_SHOW_WELCOME_NOTICE` | 设为 `1` 恢复首次进入 GUI 时的内测声明弹窗；默认（不设置）已通过构建时补丁跳过该弹窗 | 无 |
| `DSH_BRAND_ROTATION` | 侧边栏左上角品牌名称轮播的文案列表，用 `|` 分隔，如 `DeepSeek Harness\|探索未至之境` | `DeepSeek Harness\|探索未至之境` |
| `DSH_BRAND_ROTATION_MS` | 品牌名称轮播切换间隔（毫秒） | `4000` |

### 任意模型 / 任意供应商都可设置思考等级（推理等级）

镜像内置了对 dsh 的思考等级（模型选择器里的「推理等级」）增强：任何模型都会暴露思考等级选项，不再要求模型供应商声明推理能力。

- **手写声明（自定义 OpenAI 兼容网关等）或目录中未声明推理能力的模型**：显示通用等级梯子 `Off / Medium / High / XHigh / Max`，**默认 High**（无 "Default" 选项），选择后按原样发送给供应商（如 `reasoning_effort` 等 wire 参数）。
- **目录中已声明推理能力的模型**（如 DeepSeek 官方、OpenAI 等）：仍只显示其真实支持的等级，行为不变。
- **已明确标注不支持推理的目录模型**：不显示思考等级选项（避免把不支持的参数发给模型）。

该增强通过 `scripts/universal-thinking/patch-universal-thinking.cjs` 在构建时注入 dsh 的 LLM 核心与 pi-ai 适配器，无需额外配置。

### `/auto-plan` 命令：计划退出自动批准

镜像通过 `scripts/auto-plan/patch-auto-plan.cjs` 为 `dsh-plan-mode` 注入 `/auto-plan` 命令：与 `/plan` 一样进入计划模式（`plan:policy` 引导、模型探索并制定计划），但当模型调用 `exit_plan_mode` 时**跳过用户评审确认卡片直接批准**，退出计划模式并继续执行计划——省去一次手动确认。`/auto-plan off` 与 `/plan off` 均可退出；auto 标记由会话日志折叠（`command/run` 记录），重启 / fork 后可恢复。普通 `/plan` 的行为完全不变（仍弹评审确认），在已激活计划会话中用 `/auto-plan` 或 `/plan` 可在两种模式间切换。

命令描述跟随界面语言：上游浏览器端只翻译「名字在映射表里、且宿主描述与 en 字典逐字相同」的宿主命令（`ui-commands` 的 `HOST_DESCRIPTION_KEYS` + `command` 命名空间字典）。`/auto-plan` 是本仓库注入的命令，默认不在那张表里，因此中文界面下 `/` 菜单只会显示它的英文描述。补丁脚本为此同时给 `dsh-client-ui-commands` 的浏览器产物登记 `description.auto-plan`（zh/en 两份字典 + 映射），中文界面显示「进入或退出自动批准的计划模式」，英文界面与其余第三方命令行为不变；描述英文串在脚本里是单一常量，宿主侧注册值与浏览器端用于比对的字典值始终一致。该增强通过 `scripts/auto-plan/patch-auto-plan.cjs` 在构建时完成，无需额外配置。

### 侧边栏品牌名称轮播

镜像通过 `scripts/brand-rotation/patch-brand-rotation.cjs` 把左上角 logo 右侧的品牌名从固定字标改为文本，在 `DeepSeek Harness` 与 `探索未至之境` 之间轮播（默认每 4 秒切换，带淡入淡出）。文案与间隔可用 `DSH_BRAND_ROTATION`（`|` 分隔）/ `DSH_BRAND_ROTATION_MS` 环境变量调整；official 与通用（非 official）构建 profile 两条渲染路径都已覆盖，渲染在浏览器端完成，改环境变量后刷新页面即生效。

### 手机端 UI 优化

镜像通过 `scripts/mobile-ui/patch-mobile-ui.cjs`（一个脚本、四条规则）优化窄视口下的 GUI：

- **隐藏输入框里的模型名与思考等级**（视口 < 560px）：该座位在窄屏会与同一行的读写策略按钮重叠；
- **隐藏会话头部的 session log 导出入口**（视口 < 560px）：0.1.5-rc.1 起上游把它从独立下载按钮改成「更多操作」菜单，两个版本的类名都兼容；
- **折叠后的侧边栏不占页面宽度**（视口 < 1024px，对应上游 `SIDEBAR_AUTO_COLLAPSE`）：折叠时把三列 grid 强制成 `0 / 1fr / 0`（`!important` 压过组件内联样式），中心内容占满整页；
- **折叠后的侧边栏收起到左上角角标**（视口 < 1024px）：36×36 圆角角标，其余 rail 控件（新建会话、工作区、页脚）隐藏，角标直接显示展开图标（触屏没有 hover）；点击角标展开，再次折叠即回到角标。

后两条共同构成一条规范：折叠后不占页面宽度。桌面端（≥1024px）行为与上游一致（56px rail）。所有隐藏类名与选择器都从各包自身 css map 解析（哈希无关），无需改上游源码。

### 启动时自动初始化 profiles 目录

容器启动时会自动创建 `${DSH_HOME:-$HOME/.dsh}/profiles` 目录。这样即使把一个空的宿主机目录挂载到 `/root/.dsh`，首次启动也不会因为 profiles 目录不存在而提示错误；已有目录和其中的插件配置不会受到影响。

### 文件读写策略（沙箱）

镜像在构建阶段编译了上游 `native/system` 的两个原生二进制：会话写租约用的 POSIX flock 扩展，以及 Linux 沙箱用的静态 musl Landlock 启动器（`bin/landlock-run`）。两者都是上游仓库里 gitignored 的构建产物，源码构建必须自己编译——否则 addon 缺失会让会话在启动时直接抛 `Cannot find module .../bin/glibc/system.node`，沙箱则因为没有可用后端而拒绝执行命令（镜像内不装 bwrap，Linux 侧只有 Landlock 这一档；容器内探测结果为 `fully enforced`）。

因此容器默认的 `workspace-write` 策略是真正生效的：命令对工作区（`/workspace`）之外的写入由内核拒绝。若要让容器本身充当隔离边界（例如已用只读挂载、独立用户等收紧权限），可设 `DSH_PERMISSION_MODE=danger-full-access` 关闭沙箱（审批策略随之变为自动放行）。

### 预装 Claude Code CLI

镜像预装了 [Claude Code](https://code.claude.com/)（通过 `npm install -g @anthropic-ai/claude-code` 安装，跟随最新 release；npm 包与官方原生安装是同一份二进制，但不依赖 claude.ai 的地区可用性），容器内 `claude` 命令可直接使用，方便把它作为 sub agent 工具调用：

- **认证**：设置 `ANTHROPIC_API_KEY` 环境变量即可免登录使用；也可以把宿主机已有的 `~/.claude` 目录挂载进容器（`-v ~/.claude:/root/.claude`）复用登录态。认证与配置存放在 `/root/.claude`、`/root/.claude.json`，与 `/root/.dsh` 挂载互不影响。
- **版本更新**：npm 全局安装不自动更新（镜像里的 `DISABLE_AUTOUPDATER=1` 保持关闭），版本随重新构建镜像更新；容器内可随时用 `claude update` 手动升级。
- **验证**：构建时执行 `claude --version` 确认安装成功。
