# deepseek-harness 镜像

基于 [deepseek-harness 仓库源码](https://github.com/deepseek-ai/deepseek-harness)（`dsh-v*` 发布标签）在镜像内构建的 DeepSeek Harness Docker 镜像：pnpm workspace 安装依赖、编译所有包与 Web 前端，再注入本仓库的运行时补丁（`patch-dsh.cjs`）。基础镜像为 `node:24-trixie-slim`（Debian 13 + Node 24），默认监听 `0.0.0.0`，配合 Docker 端口映射开箱即用。镜像由 GitHub Actions 定时检查上游最新发布标签并自动构建推送到腾讯云 CCR。

镜像：`sgccr.ccs.tencentyun.com/misaka-network/deepseek-harness`（`:latest` / `:<版本>`）　上游：<https://github.com/deepseek-ai/deepseek-harness>

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
| `DSH_RETRY` | 请求失败重试次数 | `30` |
| `DSH_RETRY_INITIAL_DELAY_MS` | 重试退避初始延迟（毫秒） | `500` |
| `DSH_RETRY_MAX_DELAY_MS` | 重试退避上限（毫秒） | `10000` |
| `DSH_RETRY_JITTER_RATIO` | 重试退避抖动比例（0–1） | `0.1` |
| `DSH_RETRYABLE_CODES` | 追加可重试的错误码（逗号分隔），如 `PI_AI_ERROR,HTTP_408`。网关的自定义报错文案若被归入不可重试的兜底错误码，加进来即可参与同一套退避重试 | 无 |
| `DSH_STREAM_IDLE_TIMEOUT_MS` | 模型流式空闲超时（毫秒）：流多久没有新数据就中断本次请求。慢网关 / 深度思考期间无 keepalive 帧的模型可调大 | `300000`（5 分钟） |
| `DSH_SSE_REQUIRE_DONE` | 设为 `0` 容忍网关省略 SSE `[DONE]` 结束帧（详见下文「其他构建时增强」） | 严格 |
| `DSH_TOKEN_METER_CHARS_PER_TOKEN` | Token 估算字符密度（详见下文「其他构建时增强」） | `4` |
| `UA` | 覆盖请求模型供应商的 User-Agent | `deepseek-harness/<版本> (+url)` |
| `DSH_HOST` | `0.0.0.0` 或 `127.0.0.1`（仅本机） | `0.0.0.0` |
| `DSH_TRUSTED_HOSTS` | 信任的访问地址（空格/逗号分隔）：局域网 IP、域名、反向代理地址。`/api` 与插件路由（`/sidebar/*`）都会放行 | 无（容器自身的局域网 IP 自动受信） |
| `DSH_DISABLE_TRUST_FENCE` | 设为 `1` 彻底关闭信任栅栏，**同时作用于 `/api` 和已安装插件的路由（如 `/sidebar/*`）**；无鉴权，仅在你自己的反代 / 鉴权后使用 | 无 |

### 任意模型 / 任意供应商都可设置思考等级（推理等级）

镜像内置了对 dsh 的思考等级（模型选择器里的「推理等级」）增强：任何模型都会暴露思考等级选项，不再要求模型供应商声明推理能力。

- **手写声明（自定义 OpenAI 兼容网关等）或目录中未声明推理能力的模型**：显示通用等级梯子 `Off / Medium / High / XHigh / Max`，**默认 High**（无 "Default" 选项），选择后按原样发送给供应商（如 `reasoning_effort` 等 wire 参数）。
- **目录中已声明推理能力的模型**（如 DeepSeek 官方、OpenAI 等）：仍只显示其真实支持的等级，行为不变。
- **已明确标注不支持推理的目录模型**：不显示思考等级选项（避免把不支持的参数发给模型）。

该增强通过 `patch-dsh.cjs` 在构建时注入 dsh 的 LLM 核心与 pi-ai 适配器，无需额外配置。

### 四种内置智能体模式的提示词已翻译为中文

镜像构建时会把 dsh 自带的四种智能体预设（`code` / `cordis` / `minimal` / `standard`）里面向模型的英文提示词替换为中文，包括：

- 各预设的角色设定（persona），并额外追加一句「除非用户明确要求其他语言，全程使用中文思考和回复」；
- 计划模式（plan mode）的规则段落（`standard` / `code` / `cordis` 三个预设）；
- `minimal` 预设中持久化 bash 工具的描述。

这样基于这些预设运行的会话拿到的是中文系统提示词，模型会更倾向用中文思考与回复。`{{model}}` / `{{cwd}}` 等占位符保持原样，YAML 结构逐段保留；补丁幂等，可重复执行。该翻译同样通过 `patch-dsh.cjs` 在构建时完成，无需额外配置。

### 其他构建时增强

- **SSE `[DONE]` 容错**：部分 OpenAI 兼容网关代理的非 OpenAI 后端会在没有字面 `[DONE]` 帧的情况下干净地结束流式响应，上游会将其判定为 `STREAM_CLOSED` 终态错误；设置 `DSH_SSE_REQUIRE_DONE=0` 可关闭上游严格校验（默认保持严格）。
- **Token 估算密度可配**：上游把 token 估算硬编码为 4 字符/token；代码密集或中文对话、非 DeepSeek 模型在该密度下误差很大。设置 `DSH_TOKEN_METER_CHARS_PER_TOKEN` 可调整（调大则自动压缩更晚触发，调小则更早）。

