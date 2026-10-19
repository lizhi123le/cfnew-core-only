# tools —— 解码（明文化）、混淆（发布）、对齐与自动同步

这套脚本把上游压缩内核还原成可读代码，**用机器证明**还原没有改动逻辑；反过来，也能把
`plain/_worker.js`（唯一的可读源）重新混淆成可发布的 `_worker.js` 与 `pages.zip`：

- **随机短名**：所有绑定用种子 PRNG 生成的新名字，换种子即整体变样；
- **字符串转义**：`"/api/config"` 之类的字面量改写成随机混合的 `\xHH` / `\uHHHH`，运行时值不变；
- **惰性噪音**：文件末尾追加约 4 KiB 从未被引用的函数声明与随机注释，加载时不执行。

同时用四层校验保证「不破坏功能逻辑和面板接口」：AST alpha 等价、字符串值逐个一致、
版本常量交叉校验、以及把 cfnew-panel 的 55 项测试分别跑在明文和混淆产物上。

纯本地、无网络（除 `npm install` 依赖和面板测试 clone 外），Node 22 运行。

```powershell
cd tools
npm install          # @babel/parser / traverse / generator（精确版本，保证输出稳定）
```

## 文件关系

```
_worker.pretty.js ──deobfuscate──▶ plain/_worker.js ──obfuscate──▶ _worker.js ──pages-zip──▶ pages.zip
 (行号基准)                        (可读源，改这里)                 (随机短名/转义/噪音)         (Pages 直传包)
        ▲                                ▲                                  ▲
        │                                └─ names.json / comments.json     obfuscate.seed.json（随机种子）
        └────────── tools/align.mjs：上游升级后自动平移行号 ◀── 上游 _worker.js
```

- **解码方向**（上游 → 明文）：prettier → `deobfuscate.mjs`，只做「格式化 + 重命名 + 注释」。
- **编码方向**（明文 → 发布产物）：`build-kernel.mjs` = `obfuscate.mjs` + 校验 + `pages-zip.mjs`。
  反向改名用的仍是**同一套解码参数**：`names.json` 给出「行号 → 语义名」，`_worker.pretty.js`
  给出「行号 → 上游短名」。默认模式只把它当作「哪些声明需要处理」的清单，实际替换成随机短名。
- `names.json` 的键是 **`_worker.pretty.js` 里的行号**，值是新名字；`comments.json` 同理。
  用行号当锚点是因为压缩产物只有 1 行，prettier 格式化后每个函数/声明各占稳定的一行起头，
  行号天然唯一，人工核对和 `git diff` 都直观。改名交给 babel 的作用域分析（`scope.rename`），
  不做文本替换，所以不会碰到同名遮蔽、字符串误替换之类的问题。
- **`plain/_worker.js` 是本仓库的可读源，可以带本地改动**：日常校验只检查「产物能由明文重现」
  （`build-kernel --check`），不会反向要求明文等于 `deobfuscate(_worker.pretty.js)`。
  只有同步上游时才以**上游 `_worker.js`**为 prettier 输入，解出上游明文后用 `git merge-file`
  与本仓库明文做三方合并（base=旧上游明文，ours=本仓库明文，theirs=新上游明文），
  本地改动与上游改动都保留；冲突则中止同步、交人工处理。

## 混淆参数

| 参数 | 取值 | 默认 | 说明 |
| --- | --- | --- | --- |
| `--engine` | `builtin` / `javascript-obfuscator` | `builtin` | 混淆引擎；写模式会记录进 seed 文件，`--check` 自动沿用 |
| `--jo-preset` | `auto` / `light` / `balanced` | `auto` | javascript-obfuscator 预设：auto 按体积预算自动调参 |
| `--seed` | 0..4294967295 | 每次构建新随机种子 | 指定后使用固定种子。同种子逐字节可重现 |
| `--reuse-seed` | 开关（build-kernel） | — | 写模式不换种子，沿用 `tools/obfuscate.seed.json` 里的种子（可复现构建） |
| `--randomize` | 开关（build-kernel） | — | 强制换新种子；**写模式默认已经如此**，保留它是为了脚本里显式表达 |
| `--mangle` | `all` / `mapped` / `upstream` | `all` | builtin 引擎：`all` 换全部绑定；`mapped` 只换解码参数覆盖的 102 个声明；`upstream` 还原上游短名 |
| `--escape` | `budget` / `all` / `partial` / `none` | `budget` | builtin 引擎：`budget` 按体积目标分配转义；`all/partial/none` 为显式控制（不保证体积区间） |
| `--target-size` | 20000..200000 | `39500` | budget 模式的目标体积（内容字节数）；落在 37±5 KB 区间 |
| `--size-min` / `--size-max` | 整数 | `32000` / `42000` | budget 模式允许的体积区间，越界直接构建失败 |
| `--noise` | 非负整数（字节） | `4096` | builtin 引擎：噪音上限（budget 模式下受剩余预算限制）；`0` 关闭 |

环境变量：`CFNEW_ENGINE`、`CFNEW_JO_PRESET`、`CFNEW_SEED`、`CFNEW_REUSE_SEED`、`CFNEW_MANGLE`、
`CFNEW_ESCAPE`、`CFNEW_TARGET_SIZE`、`CFNEW_NOISE`。

**默认每次构建都会换新随机种子**（两个引擎一致），所以重复执行 `node build-kernel.mjs` 会得到不同的产物。
每次使用的种子会写进 `tools/obfuscate.seed.json`（连同引擎/预设/体积参数），`--check` 用这份记录重新生成，
因此 CI 仍然能逐字节校验「提交的产物 = 明文 + 记录里的参数」。
想要可复现/不换种子时用 `--reuse-seed`（或显式 `--seed N`）。

预算策略：先转义路由（`/...`），再转义配置字段名，剩余预算一半给随机字符串、一半给噪音；
产物始终是**单行**（噪音也拼在同一行），默认约 39.4 KB。

## 引擎：内置（默认） vs javascript-obfuscator

| 引擎 / 预设 | 产物大小 | 字符串处理 | 运行时开销 | 能证明什么 |
| --- | --- | --- | --- | --- |
| `builtin`（默认） | 39,432 B（单行，37±5 KB） | 随机 `\xHH` / `\uHHHH` 转义 | 无 | alpha 等价 + 字符串值一致 + 运行时探针 |
| `javascript-obfuscator` `auto`（默认） | 约 39.3 KB（单行，37±5 KB） | `stringArrayThreshold` 自动搜索（当前 0.03） | 少量字符串数组解码 | 运行时探针 + 面板 55 项 |
| `javascript-obfuscator` `light` | 80,117 B | 全部 `\uXXXX` 转义，无字符串数组 | 无解码 | 运行时探针 + 面板 55 项 |
| `javascript-obfuscator` `balanced` | 46,014 B | 字符串数组 + base64 | 每次字符串访问解码 | 运行时探针 + 面板 55 项 |

`auto` 预设的流程：JO 混淆 → 把 `obj['x']` / `{'x': v}` 还原成点号/标识符键（语义等价，省约 5 KB）→
按作用域链 + 引用频率重新分配短名（JO 自身命名约多 2.5 KB）→ 从小到大试 `stringArrayThreshold`，
取不超过 `--target-size` 的最大值。`light` / `balanced` 是纯 JO 预设，不做体积控制。

`javascript-obfuscator`（BSD-2-Clause，devDependency 固定 `5.9.0`）用官方参数实现改名/字符串数组/死代码等；
预设只是参数起点，任意官方参数都可以写进 `tools/obfuscator.config.json` 覆盖
（优先级：基线 → 预设 → 配置文件 → 调用方）。强制边界：

- `renameProperties` 必须 `false`：面板配置字段名是 JSON 属性名，改名会直接破坏接口；
- `controlFlowFlattening` 关闭：每请求都会多一层状态机，和 Cloudflare 免费 CPU 预算冲突；
- `selfDefending` / `debugProtection` 关闭：依赖 Function 构造与调试器检测，Workers 运行时不可靠。

另外官方混淆器会把 `import ... from "cloudflare:sockets"` 的说明符一起转义/搬进数组；
适配层 `engine-javascript-obfuscator.mjs` 会先复原成明文，之后关键词隐藏再按词表转义，
测试副本（`prepare-test-core.mjs`）负责在打桩前还原。

切换引擎（写模式会把 engine/preset 记进 seed 文件）：

```powershell
node build-kernel.mjs --engine=javascript-obfuscator --jo-preset=auto
node build-kernel.mjs --engine=javascript-obfuscator --jo-preset=light
node build-kernel.mjs --engine=javascript-obfuscator --jo-preset=balanced
node build-kernel.mjs --engine=builtin            # 切回默认
```

想细调官方参数时，在 `tools/obfuscator.config.json` 里覆盖预设（只写想改的键）：

```json
{
  "identifierNamesGenerator": "hexadecimal",
  "stringArrayThreshold": 0.9,
  "splitStrings": true,
  "stringArrayEncoding": ["base64"]
}
```

（该文件可选；存在即生效，危险参数会在构建前被拦截。）

代价：外部引擎的产物**无法再用 AST alpha 做静态证明**（字符串数组/控制流会改变 AST），
因此门槛改为「运行时契约探针 + 面板 55 项测试」；`balanced` 还有每次字符串访问的解码开销。

## 关键词：指定隐藏 / 期望隐藏 / 检查

词表放在仓库根目录（每行一个，空行与 `#` 注释忽略）：

- `sensitive_words_auto.txt`：**指定隐藏**。字符串/模板/模块说明符里命中即强制转义；构建结束时再检查一次，
  只要还有明文残留就直接失败。
- `sensitive_words_manual.txt`：**期望隐藏**。同样优先转义；仍有残留只打印 WARN，不阻塞构建。

实现见 `tools/keywords.mjs`：只转义命中的字符（`type` → `\x74ype`），字符串值不变，
比整串转义省体积；`build-kernel.mjs` 在写文件前调用 `findKeywordLeaks` 复查。

范围：字符串字面量、模板静态片段、import/export 模块说明符、import 绑定名。
发布产物会把 `cloudflare:sockets` 的说明符和 `connect` 绑定名都转义
（`cloudflare:\x73...`、`\u0063onnect`）；面板测试用正则打桩，因此 `check.sh` 先用
`tools/prepare-test-core.mjs` 生成「只还原这些语法书写形式」的等价副本，再跑测试；
`build-kernel` 的运行时探针也会自动还原。`import` / `from` / `as` 是 JS 语法关键字，
无法转义，构建日志会固定提示。

构建日志怎么读：

- `隐藏 N 段（M 个词）`：已转义的字符串/模板/模块说明符/import 绑定名；
- `可隐藏位置泄露 0`：上述可隐藏位置的检查结果（应为 0，非 0 直接失败）；
- `结构内整词可见：...`：标识符/属性名（如面板字段 `port`/`region`、运行时 API `.connect`），
  是代码结构或面板契约，不能改名，**未计入泄露**；
- `子串命中：...`：更长单词的一部分（如 `import` 含 `port`），**未计入泄露**；
- `语法关键字固定保留：import / from / as`。

词表路径可用 `CFNEW_KEYWORDS_AUTO` / `CFNEW_KEYWORDS_MANUAL` 覆盖。

## 面板接口为什么不会被破坏

混淆只动「标识符名字」和「字符串的书写方式」，不动任何值：

- 属性名 / JSON 字段名（`freeCpu`、`yx`、`d`、`jk` 等）是对象键，`scope.rename` 不碰；
- 路由与常量（`hello`、`/api/config`、`/api/preferred-ips`、`/region`、`/test-api`、KV 键 `c`、`c_ver`）
  都是字符串字面量，转义后解码值完全相同；
- `import { connect as X } from "cloudflare:sockets"` 的模块说明符在发布产物里按词表转义，
  测试副本会还原成原文，cfnew-panel 的测试才能用正则把它替换成桩函数；
- 噪音只有顶层函数声明，从不被调用；随机名避开了源码里出现的所有标识符与保留字，不可能遮蔽全局。

`build-kernel.mjs` 会强制比对「明文与混淆核的全部字符串字面量值」，`check.sh` 再把面板 55 项测试
同时跑在明文和 `_worker.js` 上。

## 脚本清单

| 脚本 | 作用 |
| --- | --- |
| `deobfuscate.mjs` | **解码**：读 `_worker.pretty.js` + `names.json` + `comments.json`，做作用域安全重命名并插注释，生成 `plain/_worker.js` |
| `obfuscate.mjs` | **内置混淆引擎**：明文 → 随机短名 + 字符串转义 + 惰性噪音。改名前记录每个引用的绑定，改名后逐个复核，任何「引用被捕获 / 被遮蔽」都会拒绝输出；`--core` 可只输出混淆核供 alpha 校验 |
| `prepare-test-core.mjs` | 给面板测试生成等价副本：只把 import/export 模块说明符还原成原文（字符串值不变），供打桩正则使用 |
| `keywords.mjs` | **关键词**：读取根目录 `sensitive_words_auto.txt`（硬性禁止）与 `sensitive_words_manual.txt`（期望隐藏），把字符串/模板里命中的字符转义成 `\xHH` / `\uHHHH`；`findKeywordLeaks` 供构建闸门复查 |
| `engine-javascript-obfuscator.mjs` | **可选混淆引擎**：封装 `javascript-obfuscator`（预设 light/balanced、`tools/obfuscator.config.json` 参数覆盖、危险参数拦截、import 说明符复原） |
| `build-kernel.mjs` | **混淆工作流**：`plain/_worker.js` → `_worker.js` + `pages.zip`。builtin 引擎过 alpha/字符串值/版本/导出/噪音/单行体积六道门槛；两种引擎都过「运行时契约探针」；`--check` 只校验、`--dry-run` 只看差异；默认每次换种子，`--reuse-seed` 复用记录里的种子 |
| `pages-zip.mjs` | 确定性 ZIP 写入/读取（固定 DOS 时间戳、零依赖）；内容不变时不重写 `pages.zip` |
| `align.mjs` | **上游升级后的自动对齐**：给新旧两版每个实体算结构指纹（标识符全部抹成 `_`），做 LCS 平移名字；无法匹配的新函数进报告待人工命名 |
| `verify-alpha.mjs` | **等价校验**：两份源码所有绑定统一改名为 `c0、c1…`，抹掉注释/位置/字面量写法后逐字符比较。对**混淆核**（不含噪音）使用；`build-kernel --check` 已内置 |
| `check.sh` | 一道命令跑完五道硬门槛：align 自测 + 混淆自测 + 产物可重现（含关键词检查）+ 面板 55 项（明文）+ 面板 55 项（混淆产物） |
| `release.sh` | 按 `plain/_worker.js` 的 `CORE_VERSION` 打包并发布 Release；发布前会跑 `build-kernel --check` |
| `merge-upstream.sh` | **同步上游**：先把上游 `_worker.js` / `pages.zip` 提交为解码输入，再合并上游分支。`README.md` 冲突段落保留本仓库版本、`.gitignore` 取双方并集、`.github/` 始终保留本仓库版本（不并入上游 CI），其余文件冲突中止并交人工 |
| `self-test-align.mjs` | align 的回归自测：造「行号整体下移 + 版本号变更」的假升级版，断言命名 100% 继承 |
| `self-test-obfuscate.mjs` | 混淆链路自测：反向映射、alpha、字符串值、种子确定性、三种 mangle、噪音惰性、import 原文、ZIP 往返、javascript-obfuscator 引擎、体积预算与单行格式 |
| `structure.mjs` | 看结构辅助命名：默认打印顶层声明，加 `--functions` 打印全部函数（含嵌套层级） |

## 日常使用

```powershell
# 改完 plain/_worker.js 之后：重新混淆并替换 _worker.js + pages.zip
node build-kernel.mjs               # 默认每次换新随机种子（两个引擎都一样）
node build-kernel.mjs --reuse-seed  # 沿用记录里的种子，做可复现构建
node build-kernel.mjs --dry-run     # 只看差异，不写文件（默认用记录里的种子）
node build-kernel.mjs --check       # 只校验：现有产物必须能由明文 + 记录里的种子逐字节重现（CI 用）
node build-kernel.mjs --seed 12345  # 显式指定种子（会记录，之后 --check 用这个种子）
node build-kernel.mjs --target-size=38000          # 体积目标（默认 39500，允许 32..42 KB）
node build-kernel.mjs --size-min=33000 --size-max=41000   # 自定义允许区间
node build-kernel.mjs --escape=partial --noise=2048       # 显式控制转义/噪音（不再保证体积区间）

# 手工确认混淆核与明文等价（不含噪音）
node obfuscate.mjs --core --stdout > core.js
node verify-alpha.mjs core.js ../plain/_worker.js

# 五道硬门槛（CI 用的也是这个）
bash check.sh

# 看结构，给新函数起名
node structure.mjs                 # 顶层声明
node structure.mjs --functions     # 全部函数（含嵌套）
```

退出码：`verify-alpha` / `self-test-*` / `build-kernel --check` 失败返回 1（CI 靠它们把关），
`build-kernel` 成功返回 0（写入与否看内容是否变化），`align` 恒为 0（允许部分命名，调用方看 `PENDING_NAMES=`）。

## 明文改动后的约定

- **只改 `plain/_worker.js`**，不要手改 `_worker.js` / `pages.zip`：它们是构建产物，
  CI 会重跑 `build-kernel.mjs --check` 并要求逐字节一致。
- 明文里**新增**的函数/变量没有解码映射，默认 `--mangle=all` 会照样给它们随机短名；
  如果切到 `--mangle=mapped`，新增声明会保留原名。
- 改了行为就同步升 `CORE_VERSION`；`build-kernel.mjs` 会从 AST 校验产物里的版本值。
- 换随机种子会改变所有名字/转义/噪音，产物整体变样但语义不变；默认每次构建自动换，
  想固定就用 `--reuse-seed` / `--seed N`。

## 上游发新版时的流程

解码方向由 [`.github/workflows/sync-upstream.yml`](../.github/workflows/sync-upstream.yml) 每周一自动完成，
编码方向由 [`.github/workflows/obfuscate.yml`](../.github/workflows/obfuscate.yml) 单独跑：

```
tools/merge-upstream.sh（上游 _worker.js/pages.zip 先单独提交为解码输入；
  README.md / .gitignore 的冲突按本仓库自有内容自动解决；.github/ 保持本仓库版本，
  不并入上游 workflow；其余冲突中止交人工）
  → prettier 重新生成 _worker.pretty.js（新行号基准）
  → align.mjs 把旧命名平移到新行号（结构指纹 + LCS，内层函数增删不影响外层命名）
  → deobfuscate.mjs 生成新的 plain/_worker.js
  → build-kernel.mjs 重新混淆出 _worker.js + pages.zip（随机短名 + 转义 + 噪音）
  → check.sh（align 自测 + 混淆自测 + 产物可重现 + 面板 55 项 × 2，硬性门槛）
  → 全部通过才 commit + push；有未命名函数则开 issue 列出待命名行号
```

手动执行同一套流程：

1. 用新的 `_worker.js` 覆盖仓库根目录，重新 prettier：
   `npx --yes prettier@3.9.10 --parser babel --print-width 100 _worker.js > _worker.pretty.new.js`
2. `node align.mjs --old ../_worker.pretty.js --new ../_worker.pretty.new.js --report align-report.md`
3. 把 `_worker.pretty.new.js` 改名为 `_worker.pretty.js`，跑 `node deobfuscate.mjs`
4. `node build-kernel.mjs`（重新混淆）+ `bash check.sh`
5. 报告里「需要人工命名」的行号补进 `names.json`（可选加 `comments.json`），再回到第 3 步。
   > 注意：`plain/_worker.js` 必须由脚本生成，不要手改——CI 的「确定性重建」步骤会重跑 `deobfuscate.mjs`
   > 并 `git diff --exit-code`，手改会直接判红。要改行为就改 `names.json`（名字/注释）或上游内核本身。

## 发布 Release

`release.sh` 负责打开发布包并创建 GitHub Release，版本号取自 `plain/_worker.js` 的 `CORE_VERSION`，
tag 再拼上 `plain/_worker.js` 的内容哈希（sha256 前 10 位，对已提交内容计算，不受本地换行符影响）：
版本号不变、内核代码变了也能发新版本，只换混淆种子或只改文档则不会重复发版。发布前会跑
`build-kernel.mjs --check`，确保 `_worker.js` / `pages.zip` 与明文 + 种子一致：

```bash
bash tools/release.sh --check     # 输出 TAG=... EXISTS=0/1（CI 用它做幂等判断）
bash tools/release.sh --dry-run   # 本地演练：只看产物和发布说明
bash tools/release.sh             # 真正发布（需要 gh 已登录 / GH_TOKEN）
```

资产：`_worker.js`（随机混淆内核）、`_worker.plain.js`（明文）、`pages.zip`、`SHA256SUMS.txt`；
tag 是「版本号-明文内核内容哈希」（如 `2026.10.17.2-9f86d08188`），标题显示为 `内核 2026.10.17.2 (9f86d08188)`：
CORE_VERSION 或内核代码变了才会发新 Release（旧版本保留），内核内容相同则跳过（幂等）。

> 发布动作已并入 `sync-upstream.yml` 的 `sync` job（里面直接调用本脚本）。
