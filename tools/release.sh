#!/usr/bin/env bash
# 按 plain/_worker.js 里的 CORE_VERSION 发布内核 Release：
#   - _worker.js        由明文混淆生成的内核（随机短名 + 转义字符串 + 惰性噪音，可直接部署）
#   - _worker.plain.js  明文内核（可读、可审计，混淆核与它逐 AST 等价）
#   - pages.zip         Cloudflare Pages 直传包（仓库里有才带）
#   - SHA256SUMS.txt    校验和
#
# 版本号唯一来源：plain/_worker.js 的 `const CORE_VERSION = "x.y.z"`。
# Release 的 tag 是「版本号-明文内核内容哈希」（如 2026.10.17.2-9f86d08188）：
#   后缀取 plain/_worker.js 内容的 sha256 前 10 位，只换混淆种子 / 只改文档都不会变；
#   CORE_VERSION 或内核代码变了才会发新 Release，旧版本保留，不会因为同名 tag 已存在而跳过；
#   内核内容相同则重复运行幂等（tag 相同 → 跳过）。
# 产物里的版本常量名可能被随机化，所以不再按固定名字 grep；写文件前会用
# tools/build-kernel.mjs --check 校验「产物 = 明文 + 种子」（依赖已安装时）。
#
# 用法：
#   bash tools/release.sh --check      # 输出 TAG=版本号-内容哈希、EXISTS=0/1（供 GH Actions 读取）
#   bash tools/release.sh --dry-run    # 本地演练，不调用 gh
#   bash tools/release.sh              # 真正创建 Release（需要 gh + GH_TOKEN）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MODE="${1:-publish}"
TAG_PREFIX="${TAG_PREFIX:-}"
NOTES="${NOTES_FILE:-}"

# gh 默认会猜仓库（本仓库有两个 remote 时会猜到 upstream），这里显式指定 origin
REPO="${GH_REPO:-${GITHUB_REPOSITORY:-}}"
if [ -z "$REPO" ]; then
  REPO="$(git remote get-url origin | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##')"
fi

read_version() {
  node -e '
    const fs = require("fs");
    const plain = fs.readFileSync("plain/_worker.js", "utf8");
    const core = fs.readFileSync("_worker.js", "utf8");
    const p = plain.match(/const CORE_VERSION = "([^"]+)"/);
    if (!p) { console.error("plain/_worker.js 里找不到 CORE_VERSION"); process.exit(1); }
    if (core.length < 1000) { console.error("_worker.js 缺失或异常（构建产物没提交？）"); process.exit(1); }
    console.log(p[1]);
  '
}

VERSION="$(read_version)" || { echo "::error::读取内核版本失败" >&2; exit 1; }
# 发布对象取自 HEAD，所以后缀也哈希「已提交的明文内核」：
# 只换混淆种子 / 只改文档不会变，内核代码（含 CORE_VERSION）变了才变。
COMMIT="$(git rev-parse --short HEAD)"
KERNEL_SHA="$(git show HEAD:plain/_worker.js | sha256sum | cut -c1-10)"
TAG="${TAG_PREFIX}${VERSION}-${KERNEL_SHA}"

if [ "$MODE" = "--check" ]; then
  if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
    echo "TAG=$TAG"
    echo "EXISTS=1"
  else
    echo "TAG=$TAG"
    echo "EXISTS=0"
  fi
  exit 0
fi

if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "Release $TAG 已存在，跳过（幂等）"
  exit 0
fi

# 发布前再确认一次：仓库里的 _worker.js / pages.zip 必须等于「明文 + 当前种子」的产物。
# 依赖没装（本地裸跑）时跳过，CI 里一定装了。
if [ -d tools/node_modules/@babel/parser ]; then
  echo "校验产物与明文一致…"
  node tools/build-kernel.mjs --check
else
  echo "（未安装 tools 依赖，跳过 build-kernel --check）"
fi

DIST="dist"
rm -rf "$DIST"
mkdir -p "$DIST"
# 从 HEAD 取内容而不是工作区文件：本地 core.autocrlf 会把换行改成 CRLF，
# 直接 cp 会让本地发布和 CI 发布产生不同哈希。发布对象永远是"已提交的内容"。
git show HEAD:_worker.js > "$DIST/_worker.js"
git show HEAD:plain/_worker.js > "$DIST/_worker.plain.js"
if git cat-file -e HEAD:pages.zip 2>/dev/null; then
  git show HEAD:pages.zip > "$DIST/pages.zip"
fi

node -e '
  const fs = require("fs"), path = require("path"), crypto = require("crypto");
  const files = process.argv.slice(1);
  const lines = files.map((f) => {
    const h = crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
    return `${h}  ${path.basename(f)}`; // 校验和按资产名写，不含 dist/ 前缀
  });
  fs.writeFileSync("dist/SHA256SUMS.txt", lines.join("\n") + "\n");
' "$DIST/_worker.js" "$DIST/_worker.plain.js" "$DIST/pages.zip"

if [ -n "$NOTES" ] && [ -f "$NOTES" ]; then
  NOTES_FILE="$NOTES"
else
  NOTES_FILE="$(mktemp)"
  cat > "$NOTES_FILE" <<EOF
## 内核 $VERSION ($KERNEL_SHA)

配套面板版本：**$VERSION**（面板会拿 \`coreVersion\` 与自己的发布版本比对，不一致就提示"内核需要更新"）。

| 资产 | 用途 |
| --- | --- |
| \`_worker.js\` | 由明文混淆生成的内核（随机短名 + 转义字符串 + 惰性噪音），**推荐部署**（Workers 直接上传，或放进 Pages 直传包） |
| \`_worker.plain.js\` | 明文内核：仅格式化 + 语义重命名，混淆核与它逐 AST 等价 |
| \`pages.zip\` | Cloudflare Pages 直接上传用（根目录只有 \`_worker.js\`） |
| \`SHA256SUMS.txt\` | 上述文件的 SHA-256 |

### 校验与来源

- 本次发布来自 \`core-only\` 分支提交 \`$COMMIT\`；tag 后缀 \`$KERNEL_SHA\` 是已提交明文内核 \`plain/_worker.js\` 的内容哈希（sha256 前 10 位，按仓库里的内容计算，不受本地换行符影响）。
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
  echo "[dry-run] gh release create $TAG --title '内核 $VERSION ($KERNEL_SHA)' --notes-file $NOTES_FILE ..."
  echo "--- 发布说明 ---"
  cat "$NOTES_FILE"
  exit 0
fi

gh release create "$TAG" --repo "$REPO" \
  "$DIST/_worker.js" \
  "$DIST/_worker.plain.js" \
  "$DIST/pages.zip" \
  "$DIST/SHA256SUMS.txt" \
  --title "内核 $VERSION ($KERNEL_SHA)" \
  --notes-file "$NOTES_FILE" \
  --target "$(git rev-parse HEAD)" \
  --latest

echo "已发布：$(gh release view "$TAG" --repo "$REPO" --json url --jq .url)"
