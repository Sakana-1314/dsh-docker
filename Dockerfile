# syntax=docker/dockerfile:1

ARG NODE_VERSION=24
ARG DEBIAN_VARIANT=trixie

# ---- build stage: build dsh from the deepseek-harness monorepo source ----
FROM node:${NODE_VERSION}-${DEBIAN_VARIANT}-slim AS build

# node-gyp toolchain + git for the source clone (build stage only; not part of
# the final image).
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# dsh source to build: a git ref (release tag `dsh-v*`, branch, or commit) of
# https://github.com/deepseek-ai/deepseek-harness. `latest` (default) resolves
# the newest `dsh-v*` release tag at build time.
ARG DSH_REF=latest
RUN if [ "$DSH_REF" = "latest" ]; then \
      REF="$(git ls-remote --tags https://github.com/deepseek-ai/deepseek-harness.git 'refs/tags/dsh-v*' | sed 's|.*refs/tags/||' | grep -v '\^{}' | sort -V | tail -1)"; \
      echo "dsh: resolved latest release tag $REF"; \
    else \
      REF="$DSH_REF"; \
    fi \
    && test -n "$REF" \
    && git init -q /src \
    && git -C /src remote add origin https://github.com/deepseek-ai/deepseek-harness.git \
    && git -C /src fetch -q --depth 1 origin "$REF" \
    && git -C /src checkout -q FETCH_HEAD

# pnpm (pinned to the repository's packageManager field, pnpm@11.7.0).
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

WORKDIR /src

# Install the full workspace (lifecycle scripts such as node-pty are already
# reviewed by pnpm-workspace.yaml's allowBuilds) and compile every package
# (tsc + tsdown, host & client faces) plus the Web shell (vite).
RUN pnpm install --frozen-lockfile
RUN pnpm run build:lib && pnpm run build:web

# Patch the compiled LLM core + trust fence + default directory + universal
# thinking levels (env-driven; see patch-dsh.cjs).
COPY patch-dsh.cjs /tmp/patch-dsh.cjs
RUN node /tmp/patch-dsh.cjs /src \
    && rm /tmp/patch-dsh.cjs

# ---- runtime stage ----
FROM node:${NODE_VERSION}-${DEBIAN_VARIANT}-slim

# Common development tools, in ONE early layer BEFORE the dsh COPY below, so it
# stays cached across dsh source updates (only the dsh layers change, keeping
# pulls small).
# `node`/`npm` already come from the base image. `gh` is always the latest
# release from its official GitHub releases (resolved at build time via the
# `releases/latest` redirect), with tarball checksum verification, so a
# corrupted download or a failed version lookup fails the build loudly.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git \
        build-essential \
        python3 python3-pip python3-venv python3-dev \
        curl ca-certificates wget \
        openssh-client \
        ripgrep jq unzip procps \
    && cd /tmp \
    && ARCH="$(dpkg --print-architecture)" \
    && GH_VERSION="$(curl -fsSIL -L --retry 5 --retry-all-errors -o /dev/null -w '%{url_effective}' https://github.com/cli/cli/releases/latest | sed -E 's|.*/tag/v([0-9.]+)/?.*|\1|')" \
    && case "$GH_VERSION" in \
         [0-9]*.[0-9]*.[0-9]*) echo "Resolved gh CLI version: $GH_VERSION" ;; \
         *) echo "error: failed to resolve the latest gh release (got '$GH_VERSION')" >&2; exit 1 ;; \
       esac \
    && curl -fsSL --retry 5 --retry-all-errors "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_checksums.txt" -o gh_checksums.txt \
    && curl -fsSL --retry 5 --retry-all-errors "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${ARCH}.tar.gz" -o "gh_${GH_VERSION}_linux_${ARCH}.tar.gz" \
    && grep "gh_${GH_VERSION}_linux_${ARCH}.tar.gz" gh_checksums.txt | sha256sum -c - \
    && tar -xzf "gh_${GH_VERSION}_linux_${ARCH}.tar.gz" \
    && cp "gh_${GH_VERSION}_linux_${ARCH}/bin/gh" /usr/local/bin/gh \
    && chmod +x /usr/local/bin/gh \
    && rm -rf "gh_${GH_VERSION}_linux_${ARCH}.tar.gz" "gh_${GH_VERSION}_linux_${ARCH}" gh_checksums.txt \
    && gh --version \
    && rm -rf /var/lib/apt/lists/*

# Claude Code CLI (native install, latest release) — preinstalled so it can be
# used as a subagent tool. The native installer puts the launcher at
# /root/.local/bin/claude; symlink it into a standard PATH location. The
# background auto-updater is disabled via DISABLE_AUTOUPDATER (below) so the
# version only changes when the image is rebuilt (`claude update` still works).
RUN curl -fsSL https://claude.ai/install.sh | bash \
    && ln -s /root/.local/bin/claude /usr/local/bin/claude \
    && claude --version

# Copy the built + patched source tree: the dsh CLI (apps/cli), every workspace
# package (compiled lib bundles) and the built Web shell (apps/web/dist).
# These layers change on every dsh source update.
COPY --from=build /src /opt/dsh

# `dsh` on PATH (symlink to the source-built CLI bin) and pnpm for `dsh plugin`
# (plugin management forwards to pnpm).
RUN ln -s /opt/dsh/apps/cli/lib/bin.js /usr/local/bin/dsh \
    && npm install -g "pnpm@11.7.0" --no-audit --no-fund \
    && npm cache clean --force \
    && dsh --version

# Patch overlay (binds the Web server to 0.0.0.0) + entrypoint.
COPY config/bind-0.0.0.0.patch.yml /etc/dsh/bind-0.0.0.0.patch.yml
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# Runtime plugin-fence patch (runs at container start when DSH_DISABLE_TRUST_FENCE=1).
COPY patch-plugin-fence.cjs /usr/local/bin/patch-plugin-fence.cjs
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV DSH_HOME=/root/.dsh \
    NODE_ENV=production \
    DISABLE_AUTOUPDATER=1

# Runs as root.
WORKDIR /workspace
EXPOSE 3080

ENTRYPOINT ["docker-entrypoint.sh"]