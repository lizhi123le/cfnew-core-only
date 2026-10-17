#!/usr/bin/env bash
# 一次性跑完三道硬门槛，供 CI 与本地共用：
#   1. align.mjs 回归自测（行号平移 + 版本变更后命名仍全部继承）
#   2. 明文内核与压缩内核 AST alpha 等价
#   3. cfnew-panel 全部 55 项接口/订阅测试（内核指向明文版）
#
# 用法：
#   bash tools/check.sh              # 用作者仓库最新 main 的面板
#   PANEL_DIR=/tmp/panel bash tools/check.sh   # 复用已 clone 的面板
#   PANEL_REPO=<url> bash tools/check.sh       # 换面板来源
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "== 1/3 align 回归自测 =="
node tools/self-test-align.mjs

echo "== 2/3 明文与压缩内核 alpha 等价 =="
node tools/verify-alpha.mjs _worker.js plain/_worker.js

echo "== 3/3 面板接口契约 =="
if [ -n "${PANEL_DIR:-}" ]; then
  PANEL="$PANEL_DIR"
  if [ ! -d "$PANEL" ]; then
    git clone --depth 1 "${PANEL_REPO:-https://github.com/byJoey/cfnew-panel.git}" "$PANEL"
  fi
else
  PANEL="$(mktemp -d)/panel"
  git clone --depth 1 "${PANEL_REPO:-https://github.com/byJoey/cfnew-panel.git}" "$PANEL"
fi

(
  cd "$PANEL"
  CFNEW_TEST_CORE="$ROOT/plain/_worker.js" node --test src/test/*.test.mjs
)

echo "== 全部通过 =="
