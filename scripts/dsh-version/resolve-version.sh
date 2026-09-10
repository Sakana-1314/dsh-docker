#!/bin/sh
# 解析要构建的 dsh 版本（CI 工作流与 Dockerfile 构建阶段共用）。
#
# 职责单一：把「显式输入」或「上游最新发布标签」解析成 ref / version 两行输出，不写文件、不建
# 镜像、不碰 git 工作区。单一职责、自包含：本脚本不引用 scripts/ 下的任何其他脚本。
#
# 用法：resolve-version.sh [<ref|version|latest|空>]
#   latest / 空        -> 取上游最新 dsh-v* 发布标签
#   dsh-v0.1.3-alpha.1 -> ref=dsh-v0.1.3-alpha.1, version=0.1.3-alpha.1
#   0.1.3-alpha.1      -> 自动补成 ref=dsh-v0.1.3-alpha.1
#   分支 / commit      -> 原样作为 ref，version 同值（无法从 ref 推断版本时以 ref 代称）
#
# 输出（stdout，可直接追加到 $GITHUB_OUTPUT）：
#   ref=<git ref>
#   version=<版本号>
set -e

UPSTREAM=https://github.com/deepseek-ai/deepseek-harness.git
raw="${1:-}"
[ "$raw" = "latest" ] && raw=""

if [ -n "$raw" ]; then
  case "$raw" in
    dsh-v*) ref="$raw"; ver="${raw#dsh-v}" ;;
    [0-9]*.[0-9]*.*) ref="dsh-v$raw"; ver="$raw" ;;
    *) ref="$raw"; ver="$raw" ;;
  esac
else
  ref="$(git ls-remote --tags "$UPSTREAM" 'refs/tags/dsh-v*' \
    | sed 's|.*refs/tags/||' | grep -v '\^{}' | sort -V | tail -1)"
  ver="${ref#dsh-v}"
fi

if [ -z "$ref" ]; then
  echo "error: no dsh release tag resolved from $UPSTREAM" >&2
  exit 1
fi

echo "ref=$ref"
echo "version=$ver"
