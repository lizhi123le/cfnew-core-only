# 精简内核 · 明文化版本

[![kernel-pipeline](https://github.com/lizhi123le/cfnew-core-only/actions/workflows/sync-upstream.yml/badge.svg)](https://github.com/lizhi123le/cfnew-core-only/actions/workflows/sync-upstream.yml)

`plain/_worker.js` 是内核的**可读源**：仓库根目录的 `_worker.js` 与 `pages.zip` 都由它生成。

- 解码方向（上游 → 明文）只做了三件事：格式化、按语义重命名标识符、补充中文注释。
- 编码方向（明文 → 发布产物）由 `tools/build-kernel.mjs` 混淆：**随机短名 + 字符串转义 + 惰性噪音**，
  混淆核与明文 **AST alpha 等价**，所有字符串值逐个相同。
- **没有改动任何逻辑**，明文与产物都可直接当 Worker 上传部署（单文件 ES module，仅依赖 `cloudflare:sockets`）。
- 配套面板：[byJoey/cfnew-panel](https://github.com/byJoey/cfnew-panel)（公网面板 <https://cfnew.xy.kg/>）。

## 为什么可以认为它是等价的

三条独立校验，都能在本地复跑。

### 1. AST alpha 等价性（严格证明）

```powershell
cd tools
npm install          # 只装 @babel/parser|traverse|generator
node build-kernel.mjs --check
# ✅ 产物可重现：_worker.js 与 pages.zip 和明文 + 种子一致
#    （alpha 等价 + 字符串值一致 + 版本一致 + 默认导出 + 噪音惰性）
```

`build-kernel` 内部把「混淆核」（不含噪音）和明文里所有绑定按声明顺序改名成 `c0、c1、…`，
去掉注释与字面量写法后逐字符比较。归一化一致 ⇒ 两份代码只差名字/转义/格式，语义严格相同。
只想手工核对时：`node obfuscate.mjs --core --stdout > core.js`，再拿 `core.js` 和明文跑 `verify-alpha`。

### 2. 面板官方测试套件（真实接口回归）

cfnew-panel 自带 55 项测试，可用环境变量换成任意内核。本仓库把同一套测试**同时跑在明文和混淆产物上**：

```powershell
cd cfnew-panel
$env:CFNEW_TEST_CORE='D:/Users/sisyphus/Desktop/cfnew-core-only/plain/_worker.js'
node --test src/test/*.test.mjs      # tests 55 / pass 55

$env:CFNEW_TEST_CORE='D:/Users/sisyphus/Desktop/cfnew-core-only/_worker.js'
node --test src/test/*.test.mjs      # 混淆产物同样 55 / 55
```

覆盖的内容（即"不和前端冲突"的实际含义）：

- 首页返回 `hello`，`/sub` 等页面/订阅路由已从内核移除（404）；
- `/{UUID}/api/config` 与 `/{自定义路径 d}/api/config` 的读写，字段白名单、清空、非法输入、旧字段 `customIP` 兼容；
- 六种客户端（base64 / clash / singbox / surge / loon / quanx）订阅在面板侧生成、节点流量仍直连 Worker；
- 优选 IP API 增删查（含 `{"all":true}` 清空）、非 TLS 行跳过、IPv6/端口/备注保留；
- `/region`、`/test-api`、XHTTP 短路径与 `stream-one`、WebSocket 升级、家宽开关 `jk`；
- 面板到 Worker 的转发/鉴权/缓存/绑定（`w` 变量）与 403/503 失败关闭行为。

### 3. 反向重建（编码方向）

仓库里的 `_worker.js` 和 `pages.zip` 就是由 `plain/_worker.js` + `tools/obfuscate.seed.json` 生成的：
`obfuscate.mjs` 用种子 PRNG 生成随机短名、把字符串改写成 `\xHH` / `\uHHHH`、追加惰性噪音；
`build-kernel.mjs` 在写文件前逐项校验（alpha、字符串值、版本、导出、噪音惰性）。
**默认每次构建都会换新种子**，所以重复构建产物不同；本次使用的种子写进 `tools/obfuscate.seed.json`，
`--check` 用记录里的种子复现，CI 因此能逐字节校验。想要可复现构建时用 `--reuse-seed` 或 `--seed N`。

## CI 守护（两个工作流，共用 `tools/check.sh`）

整个仓库只有两个工作流，公有仓库不计分钟数。校验逻辑只有一份 `tools/check.sh`
（五道门槛：align 自测 + 混淆自测 + 产物可重现 + 面板 55 项 × 2），本地也能直接跑：

| 工作流 | job | 何时跑 | 内容 |
| --- | --- | --- | --- |
| `sync-upstream.yml` | `verify` | **仓库被修改**：push 到 `core-only`、PR | ① `deobfuscate.mjs` 重跑后 `plain/_worker.js` 无 diff（防手改漂移）；② `tools/check.sh` 五道门槛 |
| `sync-upstream.yml` | `sync` | **每周一 04:23 UTC**、手动 dispatch | merge `byJoey/cfnew@core-only` → prettier → `align.mjs` 平移命名 → 重建明文 → `build-kernel.mjs` 重新混淆 → `tools/check.sh` → 通过才推送 → `release.sh` 发布 Release → 未命名函数开 issue |
| `obfuscate.yml` | `verify` | push / PR（改动 `plain/**`、`_worker.js`、`pages.zip`、`tools/**`） | `self-test-obfuscate.mjs` + `build-kernel.mjs --check`：产物必须能由明文 + 种子逐字节重现 |
| `obfuscate.yml` | `rebuild` | 手动 dispatch | 由明文重新生成并**替换** `_worker.js` 与 `pages.zip`；可勾选同时换随机种子、自动提交回 `core-only` |

发布不需要单独的工作流：同步任务里直接调用 `tools/release.sh`（幂等，同名 tag 直接跳过）。所以
`sync → 重新混淆 → 校验 → 发布` 是同一条 job 里的顺序步骤，任何一步失败都不会推送、也不会发布。

## 发布

内核 Release 的 tag 就是版本号本身（如 `2026.10.17.2`），和面板的 `PANEL_VERSION` / 内核的 `CORE_VERSION` 一致，方便直接对照：

| 资产 | 用途 |
| --- | --- |
| `_worker.js` | 由 `plain/_worker.js` 混淆生成（随机短名/转义/噪音），推荐部署 |
| `_worker.plain.js` | 明文内核（就是本目录的 `_worker.js`），混淆核与它逐 AST 等价 |
| `pages.zip` | Cloudflare Pages 直接上传包（根目录只有 `_worker.js`，同由明文生成） |
| `SHA256SUMS.txt` | 上面三个文件的 SHA-256 |

面板 fixture 与 `_worker.js` 的哈希差异只作为 notice 提示（面板可能已升到新内核），不阻断构建；语义是否仍一致以 `tools/check.sh` 里面板 55 项（明文 + 混淆产物各一遍）的结果为准。

## 接口契约（改这个文件时别动这些）

| 路由（`a = /{uuid}`，`s = /{自定义路径 d}`） | 方法 | 说明 |
| --- | --- | --- |
| `/` | GET | 纯文本 `hello`（无 Upgrade 头时） |
| `a/api/config`、`s/api/config` | GET | 全量配置 + `uuid` + `coreVersion` + `kvEnabled` |
| `a/api/config`、`s/api/config` | POST | 保存配置；请求上限 1 MiB，`yx` ≤ 262144 字符，其它字段 ≤ 16384；成功返回 `{success, message, config}` |
| `a/api/preferred-ips`、`s/api/preferred-ips` | GET/POST/DELETE | 优选 IP 管理，需 KV 且配置 `ae=yes`，否则 503/403 |
| `a/region`、`s/region` | GET | `region / detectionMethod / manualRegion / ci / timestamp` |
| `a/test-api`、`s/test-api` | GET | `detectedRegion / message`（连通性测试） |
| 任意路径 + `Upgrade: websocket` | — | VLESS / Trojan 代理入口 |
| `a`、`/{uuid 前 8 位}`、`/{tp}` 上的 POST（`ex=yes`） | POST | XHTTP `stream-one`（HTTP/2） |

- KV：配置存键 `c`（JSON），保存时间戳写 `c_ver`；缓存 30 秒，`POST` 后主动失效。
- 配置字段（保存白名单，共 32 个）：`freeCpu wk ev et ex ech tp customDNS customECHDomain alpn d p yx yxURL s homepage scu ena epd epi egi ae rm qj dkby yxby ipv4 ipv6 ispMobile ispUnicom ispTelecom jk`。
- 版本：`CORE_VERSION` 必须与面板发布版本一致（当前 `2026.10.17.2`），否则面板提示"内核需要更新"。
- 混淆只改名字与字符串写法：**属性名/JSON 字段名/字符串值/KV 键都不变**；`cloudflare:sockets` 的 import 原文保留（面板测试靠正则打桩）。

## 已知取舍

- 闭包内的**状态变量**在明文里仍保留上游短名（`k`/`N`/`$`/`M`/`F` 等），方便和压缩版逐行对照；
  发布产物默认 `--mangle=all`，所有绑定都会换成随机短名。
- 协议解析类函数的命名是按语义推断的（作者原始源码未公开），例如 `parseVlessHeader`、`dialSocks5`、
  `pipeWithFreeGuard` 都是还原时的命名，不是上游原名。
- 字符串转义按体积预算分配：默认 `escape=budget` / `target-size=39500`，先隐藏路由与配置字段，
  剩余预算分给随机字符串和噪音；产物固定单行并落在 32–42 KB（当前 39,432 字节）。
  想更小用 `--target-size=38000`，想显式控制用 `--escape=partial|none`（不再保证体积区间）。
- 噪音是几段未引用的函数声明，加载时不执行，与正文拼在同一行；不需要时 `--noise=0`。
- 上游发布新版本后，重跑 `tools/deobfuscate.mjs` 即可（映射表在 `tools/names.json`，按格式化行号对齐）。
- 想要「用混淆库参数化」的产物，可以 `--engine=javascript-obfuscator --jo-preset=auto|light|balanced` 切换引擎
  （参数写进 `tools/obfuscator.config.json`）；`auto` 会自动搜索 `stringArrayThreshold` 把体积控制在 37±5 KB，
  `light` / `balanced` 是不做体积控制的纯 JO 预设。它无法再做 alpha 静态证明，门槛改为运行时契约探针 + 面板 55 项，
  且 `balanced` 有字符串解码开销，默认仍用零开销的内置引擎。

## 目录

```
_worker.js                        # 混淆产物（随机短名/转义/噪音，由 build-kernel 生成，勿手改）
_worker.pretty.js                 # prettier 格式化后的压缩产物（行号基准）
plain/_worker.js                  # 明文化版本（可读源，本文档描述的文件）
pages.zip                         # Cloudflare Pages 直传包（由混淆产物打包，勿手改）
tools/names.json                  # 行号 → 语义名（align.mjs 自动平移，可手工补）
tools/comments.json               # 行号 → 注释
tools/obfuscate.seed.json         # 最近一次构建用的种子/引擎/参数（默认每次构建更新）
tools/deobfuscate.mjs             # 解码：压缩产物 → 明文（重命名 + 注释）
tools/obfuscate.mjs               # 混淆：明文 → 随机短名 + 字符串转义 + 惰性噪音
tools/build-kernel.mjs            # 混淆工作流：plain/_worker.js → _worker.js + pages.zip（五道门槛）
tools/pages-zip.mjs               # 确定性 ZIP 写入/读取（pages.zip 用）
tools/align.mjs                   # 上游升级后自动对齐行号（结构指纹 + LCS）
tools/verify-alpha.mjs            # AST alpha 等价性校验（对混淆核使用）
tools/check.sh                    # 一道命令跑完五道硬门槛（CI 与本地共用）
tools/release.sh                  # 按 CORE_VERSION 发布 Release
tools/self-test-align.mjs         # align 回归自测（造"升级版"验证命名继承）
tools/self-test-obfuscate.mjs     # 混淆链路回归自测（随机性/字符串值/噪音/ZIP）
tools/structure.mjs               # 查看结构辅助命名（--functions 看嵌套）

.github/workflows/sync-upstream.yml # 上游 → 明文（解码、校验、发布）
.github/workflows/obfuscate.yml     # 明文 → 发布产物（混淆、校验、替换 _worker.js + pages.zip）

```
