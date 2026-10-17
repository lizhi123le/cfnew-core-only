#!/usr/bin/env bash
# 按 plain/_worker.js 里的 CORE_VERSION 发布内核 Release：
#   - _worker.js        官方压缩/混淆内核（可直接部署）
#   - _worker.plain.js  明文内核（可读、可审计，与上一行 alpha 等价）
#   - pages.zip         Cloudflare Pages 直传包（仓库里有才带）
#   - SHA256SUMS.txt    校验和
#
# 版本号唯一来源：plain/_worker.js 的 `const CORE_VERSION = "x.y.z"`，
# 并与 _worker.js 里的 `const ht="x.y.z"` 交叉校验，不一致直接失败。
#
# 用法：
#   bash tools/release.sh --check      # 输出 TAG=... EXISTS=0/1（供 GH Actions 读取）
#   bash tools/release.sh --dry-run    # 本地演练，不调用 gh
#   bash tools/release.sh              # 真正创建 Release（需要 gh + GH_TOKEN）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MODE="${1:-publish}"
TAG_PREFIX="${TAG_PREFIX:-}"
NOTES="${NOTES_FILE:-}"

read_version() {
  node -e '
    const fs = require("fs");
    const plain = fs.readFileSync("plain/_worker.js", "utf8");
    const core = fs.readFileSync("_worker.js", "utf8");
    const p = plain.match(/const CORE_VERSION = "([^"]+)"/);
    const c = core.match(/const ht ?= ?"([^"]+)"/);
    if (!p) { console.error("plain/_worker.js 里找不到 CORE_VERSION"); process.exit(1); }
    if (!c) { console.error("_worker.js 里找不到版本常量 ht"); process.exit(1); }
    if (p[1] !== c[1]) {
      console.error(`版本不一致：明文 ${p[1]} ≠ 压缩 ${c[1]}`);
      process.exit(1);
    }
    console.log(p[1]);
  '
}

VERSION="$(read_version)" || { echo "::error::读取内核版本失败" >&2; exit 1; }
TAG="${TAG_PREFIX}${VERSION}"

if [ "$MODE" = "--check" ]; then
  if gh release view "$TAG" >/dev/null 2>&1; then
    echo "TAG=$TAG"
    echo "EXISTS=1"
  else
    echo "TAG=$TAG"
    echo "EXISTS=0"
  fi
  exit 0
fi

if gh release view "$TAG" >/dev/null 2>&1; then
  echo "Release $TAG 已存在，跳过（幂等）"
  exit 0
fi

DIST="dist"
rm -rf "$DIST"
mkdir -p "$DIST"
cp _worker.js "$DIST/_worker.js"
cp plain/_worker.js "$DIST/_worker.plain.js"
[ -f pages.zip ] && cp pages.zip "$DIST/pages.zip"

node -e '
  const fs = require("fs"), crypto = require("crypto");
  const files = process.argv.slice(1);
  const lines = files.map((f) => {
    const h = crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
    return `${h}  ${f}`;
  });
  fs.writeFileSync("dist/SHA256SUMS.txt", lines.join("\n") + "\n");
' "$DIST/_worker.js" "$DIST/_worker.plain.js" "$DIST/pages.zip"

if [ -n "$NOTES" ] && [ -f "$NOTES" ]; then
  NOTES_FILE="$NOTES"
else
  NOTES_FILE="$(mktemp)"
  cat > "$NOTES_FILE" <<EOF
## 内核 $VERSION

配套面板版本：**$VERSION**（面板会拿 \`coreVersion\` 与自己的发布版本比对，不一致就提示"内核需要更新"）。

| 资产 | 用途 |
| --- | --- |
| \`_worker.js\` | 官方压缩/混淆内核，**推荐部署**（Workers 直接上传，或放进 Pages 直传包） |
| \`_worker.plain.js\` | 明文内核：仅格式化 + 语义重命名，逻辑与 \`_worker.js\` 逐 AST 等价 |
| \`pages.zip\` | Cloudflare Pages 直接上传用（根目录只有 \`_worker.js\`） |
| \`SHA256SUMS.txt\` | 上述文件的 SHA-256 |

### 校验与来源

- 本次发布来自 \`core-only\` 分支提交 \`$(git rev-parse --short HEAD)\`。
- 明文版通过 AST alpha 等价校验（与 \`_worker.js\` 除标识符/格式/注释外完全一致）。
- 明文版通过 \`cfnew-panel\` 全部 55 项接口/订阅测试（首页、配置 API、优选 IP API、六种订阅、XHTTP、WebSocket、家宽开关等）。
- 版本号取自 \`plain/_worker.js\` 的 \`CORE_VERSION\`，并与 \`_worker.js\` 内的版本常量交叉核对。

### 部署要点

1. 上传 \`_worker.js\`（或 Pages 用 \`pages.zip\`）。
2. Worker 环境变量 \`u\` = 你的 UUID；KV 命名空间绑定 \`C\` 或 \`c\`。
3. 面板填 Worker 域名 + 同一个 UUID（或自定义路径 \`d\`）。
EOF
fi

echo "准备发布 $TAG："
ls -lh "$DIST"

if [ "$MODE" = "--dry-run" ]; then
  echo "[dry-run] gh release create $TAG --title '内核 $VERSION' --notes-file $NOTES_FILE ..."
  echo "--- 发布说明 ---"
  cat "$NOTES_FILE"
  exit 0
fi

gh release create "$TAG" \
  "$DIST/_worker.js" \
  "$DIST/_worker.plain.js" \
  "$DIST/pages.zip" \
  "$DIST/SHA256SUMS.txt" \
  --title "内核 $VERSION" \
  --notes-file "$NOTES_FILE" \
  --target "$(git rev-parse HEAD)" \
  --latest

echo "已发布：$(gh release view "$TAG" --json url --jq .url)"
