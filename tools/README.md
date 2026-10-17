# tools —— 解码（明文化）、对齐与自动同步

这套脚本把上游压缩内核还原成可读代码，**用机器证明**还原没有改动逻辑，并在每周自动同步上游。
纯本地、无网络（除 `npm install` 依赖外），Node 22 运行。

```powershell
cd tools
npm install          # @babel/parser / traverse / generator（精确版本，保证输出稳定）
```

## 文件关系

```
_worker.js  ──prettier──▶  _worker.pretty.js  ──deobfuscate──▶  plain/_worker.js
 (压缩产物，上游发布)        (行号基准)                          (明文化版本，可部署)
                                    ▲
                       names.json / comments.json（键=行号）
                                    ▲
                         align.mjs：上游升级后自动平移行号
```

`names.json` 的键是 **`_worker.pretty.js` 里的行号**，值是新名字；`comments.json` 同理。
用行号当锚点是因为压缩产物只有 2 行，prettier 格式化后每个函数/声明各占稳定的一行起头，
行号天然唯一，人工核对和 `git diff` 都直观。改名交给 babel 的作用域分析（`scope.rename`），
不做文本替换，所以不会碰到同名遮蔽、字符串误替换之类的问题。

## 脚本清单

| 脚本 | 作用 |
| --- | --- |
| `deobfuscate.mjs` | 读 `_worker.pretty.js` + `names.json` + `comments.json`，做**作用域安全**重命名并插注释，生成 `plain/_worker.js`；结束时报告命名覆盖率，未命名的函数逐条列出（L行号 + 原始短名） |
| `align.mjs` | **上游升级后的自动对齐**：给新旧两版每个实体（导入项/模块常量/函数）算结构指纹（抹掉标识符、剔除内层函数），对新旧序列做 LCS，把旧名字平移到新行号；无法匹配的新函数进报告待人工命名 |
| `verify-alpha.mjs` | **等价校验**：两份源码所有绑定统一改名为 `c0、c1…`，抹掉注释/位置/字面量写法后逐字符比较。一致即证明「只有名字不同，语义严格相同」 |
| `check.sh` | 一道命令跑完三道硬门槛：align 自测 + alpha 等价 + 面板 55 项测试（CI 的 verify / sync 都调它，本地也可直接用） |
| `release.sh` | 按 `plain/_worker.js` 的 `CORE_VERSION` 打包并发布 GitHub Release：`_worker.js`、`_worker.plain.js`、`pages.zip`、`SHA256SUMS.txt`；同名 tag 幂等跳过 |
| `self-test-align.mjs` | align 的回归自测：造一个"行号整体下移 + 版本号变更"的假升级版，断言命名 100% 继承、无新增待命名（`check.sh` 会跑） |
| `structure.mjs` | 看结构辅助命名：默认打印顶层声明（kind/名字/参数/行号/首行摘要），加 `--functions` 打印全部函数（含嵌套层级） |

## 日常使用

```powershell
# 重新生成 + 自检
node deobfuscate.mjs
node verify-alpha.mjs ../_worker.js ../plain/_worker.js

# 三道硬门槛（align 自测 + alpha + 面板 55 项，CI 用的也是这个）
bash check.sh

# 看结构，给新函数起名
node structure.mjs                 # 顶层声明
node structure.mjs --functions     # 全部函数（含嵌套）
```

退出码：`verify-alpha` / `self-test-align` 失败返回 1（CI 靠它们把关），`align` 恒为 0（允许部分命名，调用方看 `PENDING_NAMES=`）。

## 上游发新版时的流程

日常已由 [`.github/workflows/sync-upstream.yml`](../.github/workflows/sync-upstream.yml) 每周一自动完成：

```
merge 上游 core-only
  → prettier 重新生成 _worker.pretty.js（新行号基准）
  → align.mjs 把旧命名平移到新行号（结构指纹 + LCS，内层函数增删不影响外层命名）
  → deobfuscate.mjs 生成新的 plain/_worker.js
  → verify-alpha（alpha 等价，硬性门槛）
  → 面板 55 项接口测试（硬性门槛）
  → 全部通过才 commit + push；有未命名函数则开 issue 列出待命名行号
```

手动执行同一套流程：

1. 用新的 `_worker.js` 覆盖仓库根目录，重新 prettier：
   `npx --yes prettier@3.9.10 --parser babel --print-width 100 _worker.js > _worker.pretty.new.js`
2. `node align.mjs --old ../_worker.pretty.js --new ../_worker.pretty.new.js --report align-report.md`
3. 把 `_worker.pretty.new.js` 改名为 `_worker.pretty.js`，跑 `node deobfuscate.mjs`
4. `bash check.sh`（alpha 等价 + 面板 55 项）
5. 报告里"需要人工命名"的行号补进 `names.json`（可选加 `comments.json`），再回到第 3 步。
> 注意：`plain/_worker.js` 必须由脚本生成，不要手改——CI 的"确定性重建"步骤会重跑 `deobfuscate.mjs`
> 并 `git diff --exit-code`，手改会直接判红。要改行为就改 `names.json`（名字/注释）或上游内核本身。

## 发布 Release

`release.sh` 负责打开发布包并创建 GitHub Release，版本号取自 `plain/_worker.js` 的 `CORE_VERSION`，
并与 `_worker.js` 的版本常量交叉核对（不一致直接失败，避免发错版本）：

```bash
bash tools/release.sh --check     # 输出 TAG=... EXISTS=0/1（CI 用它做幂等判断）
bash tools/release.sh --dry-run   # 本地演练：只看产物和发布说明
bash tools/release.sh             # 真正发布（需要 gh 已登录 / GH_TOKEN）
```

资产：`_worker.js`（压缩/混淆）、`_worker.plain.js`（明文）、`pages.zip`、`SHA256SUMS.txt`；
tag 就是版本号本身（如 `2026.10.17.2`），已存在则跳过。

> 发布动作已并入 `sync-upstream.yml` 的 `sync` job（里面直接调用本脚本），
> 所以不需要单独的工作流；手动改完内核后想发布，dispatch 一次 `sync` 并勾 `force` 即可（同名 tag 会跳过）。
