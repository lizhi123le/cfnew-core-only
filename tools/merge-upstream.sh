#!/usr/bin/env bash
# 同步上游：把上游分支合并进当前分支，并自动解决「本仓库自有文件」的冲突。
#
# 上游 core-only 只有 README.md / _worker.js / pages.zip 三个文件，本仓库在这三个文件上
# 都有自己的内容，直接 merge 会反复冲突，所以按文件分别处理：
#
#   _worker.js / pages.zip  先把上游版本取成本地提交（解码输入）。合并时双方内容相同，
#                           不再是「双方都改过」，不会冲突；随后由 build-kernel 重新生成。
#   README.md               三方合并：重叠段落保留本仓库版本（本仓库有「从明文重新混淆」
#                           等自有说明），上游新增或无关的文档改动照常并入。
#   .gitignore              双方都新增时取并集；有共同基线时同样做三方合并。
#
# 其余文件（以及修改/删除类冲突）一律不猜：中止合并、退出非零，交人工处理，
# 绝不静默丢掉上游改动。
#
# 用法：
#   bash tools/merge-upstream.sh upstream/core-only
#
# 调用前工作区必须是干净的，且已配置 git user.name / user.email（CI 由 workflow 设置）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

UPSTREAM_REF="${1:-}"
if [ -z "$UPSTREAM_REF" ]; then
  echo "用法: bash tools/merge-upstream.sh <upstream-ref>" >&2
  exit 2
fi

# upstream/core-only 里只取分支名，用于提交信息
UPSTREAM_NAME="${UPSTREAM_REF#*/}"
SHA="$(git rev-parse --short "$UPSTREAM_REF")"

if [ -n "$(git status --porcelain)" ]; then
  echo "::error::工作区有未提交的改动，先 commit 或 stash 再同步" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ── 1) 上游压缩内核先落盘并单独提交（本次解码的输入）──────────────────────────
git checkout "$UPSTREAM_REF" -- _worker.js
if git cat-file -e "$UPSTREAM_REF:pages.zip" 2>/dev/null; then
  git checkout "$UPSTREAM_REF" -- pages.zip
fi
if ! git diff --cached --quiet; then
  git commit -m "chore: 取上游压缩产物 $SHA 作为解码输入"
else
  echo "上游压缩产物与本仓库一致，无需单独提交"
fi

# ── 2) 合并上游分支 ──────────────────────────────────────────────────────────
echo "== 合并 $UPSTREAM_REF @ $SHA =="
if git merge --no-edit "$UPSTREAM_REF" -m "merge: 上游 $UPSTREAM_NAME @ $SHA"; then
  exit 0
fi

if ! git rev-parse -q --verify MERGE_HEAD >/dev/null; then
  echo "::error::git merge 失败但没有生成合并状态，请查看上面的输出" >&2
  exit 1
fi

# ── 3) 只自动解决已知的「本仓库自有文件」，其他冲突保持原样 ────────────────────
git diff --name-only --diff-filter=U > "$WORK/conflicts"

resolved=""
unresolved=""
while IFS= read -r path; do
  [ -n "$path" ] || continue
  # 修改/删除类冲突不是「两边都有内容」，不猜，交人工
  if ! git cat-file -e ":2:$path" 2>/dev/null || ! git cat-file -e ":3:$path" 2>/dev/null; then
    unresolved="$unresolved $path"
    continue
  fi
  case "$path" in
    README.md)
      # 冲突段落保留本仓库版本（--ours），上游非冲突改动照常并入
      git show ":2:$path" > "$WORK/ours"
      if git cat-file -e ":1:$path" 2>/dev/null; then
        git show ":1:$path" > "$WORK/base"
        git show ":3:$path" > "$WORK/theirs"
        git merge-file --ours "$WORK/ours" "$WORK/base" "$WORK/theirs"
      fi
      cp "$WORK/ours" "$path"
      git add -- "$path"
      resolved="$resolved README.md（重叠段落保留本仓库版本）"
      ;;
    .gitignore)
      git show ":2:$path" > "$WORK/ours"
      if git cat-file -e ":1:$path" 2>/dev/null; then
        git show ":1:$path" > "$WORK/base"
        git show ":3:$path" > "$WORK/theirs"
        git merge-file --ours "$WORK/ours" "$WORK/base" "$WORK/theirs"
      else
        # add/add：双方各自新增，忽略规则取并集（保留本仓库顺序，去掉完全重复行）
        git show ":3:$path" > "$WORK/theirs"
        cat "$WORK/ours" "$WORK/theirs" > "$WORK/all"
        awk 'NF && !seen[$0]++' "$WORK/all" > "$WORK/ours"
      fi
      cp "$WORK/ours" "$path"
      git add -- "$path"
      resolved="$resolved .gitignore（双方规则取并集）"
      ;;
    *)
      unresolved="$unresolved $path"
      ;;
  esac
done < "$WORK/conflicts"

if [ -n "$unresolved" ]; then
  echo "::error::上游改动与下列文件冲突，需要手动解决后重新运行:$unresolved" >&2
  git merge --abort || true
  exit 1
fi

git commit --no-edit
echo "== 已自动解决文档冲突并完成合并:$resolved =="

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo ""
    echo "### 上游合并的自动冲突处理"
    echo ""
    echo "- 处理文件：${resolved# }"
    echo "- README.md：重叠段落保留本仓库版本，上游其他文档改动并入"
    echo "- .gitignore：保留双方全部忽略规则"
    echo "- 上游压缩产物已作为解码输入单独提交，随后由 build-kernel 重新生成"
  } >> "$GITHUB_STEP_SUMMARY"
fi
