# tools —— 解码（明文化）与对齐校验脚本

这套脚本把上游压缩内核还原成可读代码，并**用机器证明**还原过程没有改动逻辑。
四个脚本都是纯本地、无网络（除 `npm install` 依赖外），Node 22 运行。

```powershell
cd tools
npm install          # @babel/parser / traverse / generator（精确版本，保证输出稳定）
```

## 三个文件的关系

```
_worker.js  ──prettier──▶  _worker.pretty.js  ──deobfuscate──▶  plain/_worker.js
 (压缩产物，上游发布)        (行号基准，还原脚本的输入)            (明文化版本，可部署)
                                        ▲
                              NAMES / COMMENTS 以「行号」为键对齐
```

`NAMES` 的键是 **`_worker.pretty.js` 里的行号**，值是新名字；`COMMENTS` 同理。
之所以用行号当锚点：压缩产物只有 2 行，prettier 格式化后每个函数/声明各占稳定的一行起头，
行号天然唯一，人工核对和 `git diff` 都直观。改名本身交给 babel 的作用域分析（`scope.rename`），
不做文本替换，因此不会碰上同名遮蔽、字符串误替换之类的问题。

## 脚本清单

| 脚本 | 作用 |
| --- | --- |
| `deobfuscate.mjs` | 读取 `_worker.pretty.js`，按 `NAMES` 做**作用域安全**重命名、按 `COMMENTS` 插注释，生成 `plain/_worker.js`；结束时报告命名覆盖率，未命名的函数逐条列出（L行号 + 原始短名），方便上游发新版时补映射 |
| `verify-alpha.mjs` | **对齐校验**：把两份源码的所有绑定按声明顺序改名为 `c0、c1…`，抹掉注释/位置/字面量写法后逐字符比较。一致即证明「只有名字不同，语义严格相同」 |
| `skeleton.mjs` | 打印顶层结构（函数/常量、参数、行号、体积、首行摘要），起名时先看这个 |
| `functions.mjs` | 打印全部函数（含嵌套层级、行号），定位某个内部函数用 |

## 日常使用

```powershell
# 重新生成 + 自检（改过 NAMES 或换了新内核后）
node deobfuscate.mjs
node verify-alpha.mjs ../_worker.js ../plain/_worker.js

# 只看结构
node skeleton.mjs ../_worker.pretty.js
node functions.mjs ../_worker.pretty.js
```

退出码：`verify-alpha` 不一致时返回 1（CI 靠它把关），其余脚本一律 0。

## 上游发新版时的对齐流程

1. 用新的 `_worker.js` 覆盖仓库根目录，重新 prettier：
   `npx prettier@3 --parser babel --print-width 100 _worker.js > _worker.pretty.js`
2. `node skeleton.mjs ../_worker.pretty.js` 与 `node functions.mjs ../_worker.pretty.js`，
   对比旧结构找新增/删除/挪动的函数。
3. 在原 `NAMES` / `COMMENTS` 里按**新行号**修正或补充（脚本会先打印"行 X 未命中任何声明"，
   说明旧映射里的某行在新版本已失效；同时覆盖率报告会列出还没命名的新函数）。
4. `node deobfuscate.mjs && node verify-alpha.mjs ../_worker.js ../plain/_worker.js`，
   通过即语义等价。
5. 提交后 CI（`.github/workflows/verify.yml`）会再跑一遍 alpha 校验和面板 55 项接口测试。

> 注意：`plain/_worker.js` 必须由脚本生成，不要手改——CI 的"确定性重建"步骤会重跑 `deobfuscate.mjs`
> 并 `git diff --exit-code`，手改会直接判红。要改行为就改脚本里的映射（名字/注释）或上游内核本身。
