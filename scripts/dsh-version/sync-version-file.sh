#!/bin/sh
# 把仓库根目录的 VERSION 文件同步到目标 dsh 版本。
#
# 职责单一：让 VERSION 反映「已发现的上游版本」。有变化就写入、提交并推送，没有变化就只报告。
# 本脚本不构建镜像、不判断是否需要构建——那是调用方（.github/workflows/build.yml）的事；
# 定时轮询一旦发现版本变更就先执行本脚本，因此 VERSION 会在构建开始前前进。
# 单一职责、自包含：本脚本不引用 scripts/ 下的任何其他脚本。
#
# 用法：sync-version-file.sh <version>
# 输出约定：stdout **只**打印 `changed=true|false`（调用方直接追加到 $GITHUB_OUTPUT），
# 一切给人看的说明都走 stderr——git 的输出尤其不能进 stdout。
set -e

version="${1:-}"
if [ -z "$version" ]; then
  echo "usage: sync-version-file.sh <version>" >&2
  exit 1
fi

cd "$(git rev-parse --show-toplevel)"

current="$(cat VERSION 2>/dev/null || true)"
if [ "$version" = "$current" ]; then
  echo "VERSION already at $version" >&2
  echo "changed=false"
  exit 0
fi

printf '%s\n' "$version" > VERSION
git add VERSION
git -c user.name='github-actions[bot]' \
    -c user.email='github-actions[bot]@users.noreply.github.com' \
    commit -q -m "build: bump dsh to $version" >&2
git push -q origin "HEAD:${GITHUB_REF_NAME:-$(git rev-parse --abbrev-ref HEAD)}" >&2
echo "VERSION $current -> $version (committed and pushed)" >&2
echo "changed=true"
