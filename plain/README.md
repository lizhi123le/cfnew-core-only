# 精简内核 · 明文化版本

[![kernel-pipeline](https://github.com/lizhi123le/cfnew-core-only/actions/workflows/sync-upstream.yml/badge.svg)](https://github.com/lizhi123le/cfnew-core-only/actions/workflows/sync-upstream.yml)

`plain/_worker.js` 是本仓库 `_worker.js`（`core-only` 分支发布产物）的**可读明文版本**：

- 只做了三件事：格式化、按语义重命名标识符、补充中文注释。
- **没有改动任何逻辑**，可直接当 Worker 上传部署（单文件 ES module，仅依赖 `cloudflare:sockets`）。
- 配套面板：[byJoey/cfnew-panel](https://github.com/byJoey/cfnew-panel)（公网面板 <https://cfnew.xy.kg/>）。

## 为什么可以认为它是等价的

两条独立校验，都能在本地复跑：

### 1. AST alpha 等价性（严格证明）

```powershell
cd tools
npm install          # 只装 @babel/parser|traverse|generator
node verify-alpha.mjs ../_worker.js ../plain/_worker.js
# ✅ alpha 等价：仅标识符/注释/格式不同，逻辑一致（归一化 46,132 字符完全一致）
```

做法：把两份源码里所有作用域绑定按声明顺序改名成 `c0、c1、…`，去掉注释与字面量原始写法，再逐字符比较语法树。归一化结果一致 ⇒ 两份代码只差名字，语义严格相同（不是"看着差不多"，是 AST 级相等）。

### 2. 面板官方测试套件（真实接口回归）

cfnew-panel 自带 55 项测试，默认用 `test/core-fixture.mjs`（与本仓库 `_worker.js` 字节一致）跑，可用环境变量换成任意内核：

```powershell
cd cfnew-panel
$env:CFNEW_TEST_CORE='D:/Users/sisyphus/Desktop/cfnew-core-only/plain/_worker.js'
node --test src/test/*.test.mjs
# tests 55 / pass 55 / fail 0
```

覆盖的内容（即"不和前端冲突"的实际含义）：

- 首页返回 `hello`，`/sub` 等页面/订阅路由已从内核移除（404）；
- `/{UUID}/api/config` 与 `/{自定义路径 d}/api/config` 的读写，字段白名单、清空、非法输入、旧字段 `customIP` 兼容；
- 六种客户端（base64 / clash / singbox / surge / loon / quanx）订阅在面板侧生成、节点流量仍直连 Worker；
- 优选 IP API 增删查（含 `{"all":true}` 清空）、非 TLS 行跳过、IPv6/端口/备注保留；
- `/region`、`/test-api`、XHTTP 短路径与 `stream-one`、WebSocket 升级、家宽开关 `jk`；
- 面板到 Worker 的转发/鉴权/缓存/绑定（`w` 变量）与 403/503 失败关闭行为。

## CI 守护（.github/workflows/sync-upstream.yml）

整个仓库只有一个工作流，公有仓库不计分钟数。校验逻辑只有一份 `tools/check.sh`（本地也能直接跑），两个 job 共用：

| job | 何时跑 | 内容 |
| --- | --- | --- |
| `verify` | **仓库被修改**：push 到 `core-only`、PR | ① `deobfuscate.mjs` 重跑后 `plain/_worker.js` 无 diff（防手改漂移）；② `tools/check.sh`：align 自测 + alpha 等价 + 面板 55 项 |
| `sync` | **每周一 04:23 UTC**、手动 dispatch | merge `byJoey/cfnew@core-only` → prettier → `align.mjs` 平移命名 → 重建明文 → `tools/check.sh` → 通过才推送 → `release.sh` 发布 Release → 未命名函数开 issue |

发布不需要单独的工作流：同步任务里直接调用 `tools/release.sh`（幂等，同名 tag 直接跳过）。所以 `sync → 发布 → 校验` 是同一条 job 里的顺序步骤，任何一步失败都不会推送、也不会发布。

没有"每天固定时间"的巡检：要么仓库有变更（`verify`），要么到了每周同步时间（`sync`），否则什么都不跑。原 `verify-kernel`、`release-kernel` 两个工作流都已并入 `sync-upstream.yml`。

## 发布

内核 Release 的 tag 就是版本号本身（如 `2026.10.17.2`），和面板的 `PANEL_VERSION` / 内核的 `CORE_VERSION` 一致，方便直接对照：

| 资产 | 用途 |
| --- | --- |
| `_worker.js` | 官方压缩/混淆内核，推荐部署 |
| `_worker.plain.js` | 明文内核（就是本目录的 `_worker.js`），与上一行逐 AST 等价 |
| `pages.zip` | Cloudflare Pages 直接上传包 |
| `SHA256SUMS.txt` | 上面三个文件的 SHA-256 |

面板 fixture 与 `_worker.js` 的哈希差异只作为 notice 提示（面板可能已升到新内核），不阻断构建；语义是否仍一致以 `tools/check.sh` 里面板 55 项的测试结果为准。

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

## 已知取舍

- 闭包内的**状态变量**仍保留上游短名（`k`/`N`/`$`/`M`/`F` 等），这样能和压缩版逐行对照，改动时更容易确认没有偏离；
- 协议解析类函数的命名是按语义推断的（作者原始源码未公开），例如 `parseVlessHeader`、`dialSocks5`、`pipeWithFreeGuard` 都是还原时的命名，不是上游原名；
- 上游发布新版本后，重跑 `tools/deobfuscate.mjs` 即可（映射表在脚本里的 `NAMES`，按格式化行号对齐）。

## 目录

```
_worker.js                        # 上游压缩产物（原样，勿改）
_worker.pretty.js                 # prettier 格式化后的压缩产物（行号基准）
plain/_worker.js                  # 明文化版本（本文档描述的文件）
tools/names.json                  # 行号 → 语义名（align.mjs 自动平移，可手工补）
tools/comments.json               # 行号 → 注释
tools/deobfuscate.mjs             # 生成明文化版本（重命名 + 注释）
tools/align.mjs                   # 上游升级后自动对齐行号（结构指纹 + LCS）
tools/verify-alpha.mjs            # AST alpha 等价性校验
tools/check.sh                    # 一道命令跑完 alpha + 面板 55 项（CI 与本地共用）
tools/release.sh                  # 按 CORE_VERSION 发布 Release
tools/self-test-align.mjs         # align 回归自测（造"升级版"验证命名继承）
tools/structure.mjs               # 查看结构辅助命名（--functions 看嵌套）

.github/workflows/sync-upstream.yml # 唯一流水线：push/PR 校验 + 每周同步/发布（原 verify 已并入）

```
