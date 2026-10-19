#!/usr/bin/env bash
# 一次性跑完五道硬门槛，供 CI 与本地共用：
#   1. align.mjs 回归自测（行号平移 + 版本变更后命名仍全部继承）
#   2. 混淆链路自测（反向映射 / alpha / 字符串值 / 随机性 / 噪音 / ZIP）
#   3. 混淆产物与明文一致（_worker.js、pages.zip 可由 plain/_worker.js + 种子重现）
#   4. cfnew-panel 全部 55 项接口/订阅测试（内核指向明文版）
#   5. 同样的 55 项测试跑在混淆产物上（证明随机改名/转义/噪音没有破坏面板契约）
#
# 用法：
#   bash tools/check.sh              # 用作者仓库最新 main 的面板
#   PANEL_DIR=/tmp/panel bash tools/check.sh   # 复用已 clone 的面板
#   PANEL_REPO=<url> bash tools/check.sh       # 换面板来源
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "== 1/5 align 回归自测 =="
node tools/self-test-align.mjs

echo "== 2/5 混淆链路自测（反向映射 + alpha + 字符串值 + 随机性 + ZIP）=="
node tools/self-test-obfuscate.mjs

echo "== 3/5 混淆产物可由明文重现 =="
node tools/build-kernel.mjs --check

echo "== 4/5 面板接口契约（明文内核）=="
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

echo "== 5/5 面板接口契约（混淆产物 _worker.js）=="
# 发布产物把 cloudflare:sockets 里的 sock 转义了；面板测试用正则打桩，需要原文说明符。
# 这里生成一份只还原模块说明符的等价副本给测试，发布产物本身不变。
TEST_CORE="$(mktemp)"
node tools/prepare-test-core.mjs "$ROOT/_worker.js" "$TEST_CORE"
(
  cd "$PANEL"
  CFNEW_TEST_CORE="$TEST_CORE" node --test src/test/*.test.mjs
)
rm -f "$TEST_CORE"

echo "== 全部通过 =="
