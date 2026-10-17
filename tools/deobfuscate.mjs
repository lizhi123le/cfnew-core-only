/**
 * 把压缩内核还原成可读明文：仅做标识符重命名 + 格式化 + 注释，不改变任何逻辑。
 *
 * 输入：_worker.pretty.js（prettier 格式化后的原始压缩代码，行号即映射键）
 * 输出：plain/_worker.js
 *
 * 安全性：tools/verify-alpha.mjs 会做 alpha 等价性校验——若重命名后除名字外
 * AST 完全一致，则输出与原始内核语义严格等价。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import _generate from '@babel/generator';

const traverse = _traverse.default || _traverse;
const generate = _generate.default || _generate;

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, '_worker.pretty.js');
const OUT_DIR = path.join(ROOT, 'plain');
const OUT = path.join(OUT_DIR, '_worker.js');

// prettier 格式化文件中的行号 → 新名字
const NAMES = {
  1: 'cloudflareConnect',
  2: 'CORE_VERSION',
  3: 'kvConfigCache',
  4: 'sha256Cache',
  5: 'CORS_HEADERS',
  12: 'jsonResponse',
  22: 'withCorsHeaders',
  30: 'readKvConfigCached',
  42: 'workerModule',
  51: 'createFreeCpuGuard',
  84: 'createRequestHandler',
  86: 'decodeBase64Text',
  159: 'parseBooleanFlag',
  169: 'yesNo',
  172: 'mergeWithDefaults',
  199: 'firstDefined',
  204: 'readEnvAliases',
  246: 'effectiveConfig',
  250: 'randomFallbackEndpoint',
  338: 'isUuid',
  341: 'isIpAddress',
  350: 'normalizeAlpn',
  355: 'persistConfig',
  370: 'getConfigValue',
  373: 'setConfigValue',
  376: 'pickEndpointByRegion',
  385: 'regionFallbackList',
  400: 'regionPriority',
  405: 'sortEndpointsByRegion',
  415: 'parseHostPort',
  429: 'handleWebSocketUpgrade',
  459: 'releaseWriter',
  465: 'abortSession',
  477: 'enqueueUpload',
  481: 'flushUpload',
  560: 'openTunnel',
  567: 'connectRemote',
  573: 'detachSocket',
  581: 'handleRemoteClosed',
  609: 'bridgeRemoteToClient',
  664: 'toUint8Array',
  673: 'concatBytes',
  679: 'createUploadQueue',
  684: 'compactQueue',
  687: 'shiftQueue',
  725: 'createWebSocketSender',
  736: 'flushBuffer',
  746: 'scheduleFlush',
  790: 'connectSocketRaw',
  794: 'connectSocket',
  804: 'raceConnect',
  824: 'uuidToBytes',
  836: 'uuidBytesMatch',
  858: 'parseVlessHeader',
  910: 'createUploadStream',
  914: 'enqueueChunk',
  925: 'writeChunk',
  940: 'createDownloadStream',
  997: 'dnsOverHttpsQuery',
  1010: 'dialProxy',
  1018: 'readExact',
  1026: 'takeBuffered',
  1063: 'stripBrackets',
  1067: 'dialSocks5',
  1123: 'streamWithPrefix',
  1150: 'parseOutboundSpec',
  1183: 'parseTrojanHeader',
  1235: 'sha256',
  1304: 'rotateRight32',
  1324: 'trojanPathFields',
  1327: 'estimateHeaderBytes',
  1333: 'readHeaderParam',
  1348: 'hasValidXhttpLength',
  1355: 'randomAlphaNumeric',
  1361: 'sleep',
  1364: 'timingSafeEqual',
  1380: 'concatArrays',
  1388: 'hexToBytes',
  1397: 'allocateBytes',
  1400: 'readGrpcFrames',
  1471: 'writeStreamToWriter',
  1472: 'writeChunked',
  1499: 'pipeToWriter',
  1523: 'pipeThroughTransform',
  1606: 'pipeWithFreeGuard',
  1628: 'resolveDestination',
  1631: 'connectDirect',
  1632: 'connectViaProxy',
  1633: 'resolvePreferredAddress',
  1665: 'limitConcurrency',
  1669: 'releaseSlot',
  1706: 'fetchWithLimit',
  1713: 'decodeEarlyDataHeader',
  1724: 'closeWebSocket',
  1729: 'handlePreferredIpsApi',
  1872: 'applyRuntimeConfig',
  1915: 'reloadPreferredFromKv',
  1941: 'parsePreferredList',
  1961: 'serializePreferredList',
  1971: 'isDomainName',
  1974: 'routeRequest',
  1991: 'isApiPath',
};

// 段落注释（插在对应函数/常量前面）
const COMMENTS = {
  2: '内核版本号：面板据此判断是否需要提示更新，必须与面板发布版本一致。',
  3: 'env → KV 配置缓存的弱映射（30 秒），避免每个请求都读 KV。',
  4: 'SHA-256 结果缓存（上限 32 条），用于 Trojan 密码哈希。',
  5: '所有 JSON 响应用到的 CORS 头。',
  12: '统一 JSON 响应：附带 CORS 头并禁止缓存。',
  22: '给已有 Response 补 CORS 头（透传 body/status）。',
  30: '读取 KV 中的配置（键 c）；force=true 时跳过缓存（配置保存后立即回读）。',
  42: 'Worker 模块入口，所有异常收敛为 502 JSON。',
  51: 'Free CPU 保护：单连接累计 384 KiB 或 96 个数据块后主动断开，让客户端重连。',
  84: '根据 env 构造请求处理器；env 的别名解析与配置快照都在这里完成。',
  86: '解码 base64 默认值（仅用于内联默认配置，不是加密）。',
  159: '把 env / KV 里的字符串解析成布尔（yes/no、true/false、1/0）。',
  169: '布尔转 yes/no，写回 config API 时保持字段格式。',
  172: '把 KV/环境变量的局部配置合并到默认值上，只取白名单字段。',
  199: '按顺序返回第一个非空值（用于 env 多别名）。',
  204: '把环境变量别名表（U/u、ET/et 等）映射成内部配置字段。',
  246: '最终生效配置 = 环境变量 + KV 覆盖。',
  250: '无可用优选地址时随机取一个官方域名兜底。',
  338: 'UUID 格式校验。',
  341: 'IPv4/IPv6 字面量校验。',
  350: 'ALPN 白名单归一化（h3 / h2 / http/1.1 及其组合）。',
  355: '把当前配置写回 KV，并写入 c_ver 版本戳。',
  370: '读配置字段（带默认值）。',
  373: '写配置字段并立即持久化。',
  376: '按地区挑选入口地址，避免落到邻居地区的边缘节点。',
  385: '地区邻居表：命中不到本地区时按此顺序回退。',
  400: '生成完整地区优先级序列。',
  405: '按地区优先级给候选地址排序。',
  415: '解析 host[:port]、[v6]:port 形式。',
  429: '处理 WebSocket 升级：解析 VLESS / Trojan 首包后建立隧道。',
  560: '建立到目标（或 ProxyIP / SOCKS5）的隧道，并双向转发数据。',
  664: '把各种二进制视图统一成 Uint8Array。',
  673: '拼接两个字节数组。',
  679: '上传缓冲队列：按块/字节上限排队，供远端写入。',
  725: 'WebSocket 批量发送器：攒够一定字节或超时后一次性 send。',
  790: '直连 TCP/UDP（cloudflare:sockets）。',
  794: '连接失败时回退到直接 connect。',
  804: '并发竞速拨号，取最快建立的连接。',
  824: 'UUID 字符串转 16 字节。',
  836: '校验 VLESS 首包里的 UUID 字节。',
  858: '解析 VLESS 请求头（版本、UUID、附加信息、命令、目标地址）。',
  910: '上传流：计费 Free 预算后写入远端。',
  940: '下载流：从远端读回并计入 Free 预算。',
  997: 'DNS over HTTPS 查询（默认 223.5.5.5），用于 UDP:53 转发。',
  1010: '出站拨号：直连、SOCKS5 或 HTTP(S) 代理。',
  1063: '去掉 IPv6 地址外面的方括号。',
  1067: 'SOCKS5 握手与 CONNECT。',
  1123: '给流加前缀（VLESS 响应的 2 字节头）。',
  1150: '解析出站配置字符串（socks5://、http://、https://）。',
  1183: '解析 Trojan 请求头并校验密码哈希。',
  1235: '同步 SHA-256（带缓存）。',
  1304: '32 位循环右移。',
  1324: '从 UUID 推导 XHTTP 短路径的字段与参数名。',
  1327: '估算请求头参数的长度（用于校验 xhttp 首包）。',
  1333: '从请求头里读指定参数。',
  1348: '校验 xhttp 的 ed 长度参数是否在合理区间。',
  1355: '生成随机字母数字串（xhttp 参数随机值）。',
  1361: 'sleep。',
  1364: '定长常量时间比较（Trojan 密码）。',
  1380: '拼接多个 Uint8Array。',
  1388: '十六进制转字节。',
  1397: '分配指定长度的 Uint8Array。',
  1400: '读取 gRPC 帧（HTTP/2 stream-one）。',
  1471: '把 ReadableStream 写入 WritableStream。',
  1499: '把上传流接到 writer 上。',
  1523: '通过 TransformStream 转发并计费。',
  1606: '带 Free 预算的管道：超预算时关闭两端。',
  1628: '解析实际连接目标：ProxyIP / 优选地址 / 自定义域名。',
  1665: '连接数上限保护，超过返回 429。',
  1706: '带上限的 fetch（XHTTP 转发）。',
  1713: '解码 early-data base64url 头。',
  1724: '安全关闭 WebSocket。',
  1729: '优选 IP 管理 API（GET/POST/DELETE），需 KV 且开启「允许 API 管理」。',
  1872: '把配置应用到闭包状态（协议开关、ProxyIP、地区、优选列表等）。',
  1915: '从 KV 重新加载优选列表到内存。',
  1941: '解析优选列表字符串（逗号/换行分隔，# 备注）。',
  1961: '把优选列表序列化回字符串。',
  1971: '域名格式校验。',
  1974: '路由入口：首页 / 配置 API / 优选 API / 地区 / XHTTP / WebSocket。',
  1991: '判断路径是否命中某个 API 前缀（UUID 或自定义路径）。',
};

const code = fs.readFileSync(SRC, 'utf8');
const ast = parse(code, { sourceType: 'module' });

const pending = [];
const applied = new Set();
const stmtComments = new Map(); // VariableDeclaration 节点 → 注释数组

traverse(ast, {
  'FunctionDeclaration|VariableDeclarator|ImportSpecifier'(p) {
    const node = p.node;
    const line = node.loc.start.line;
    const newName = NAMES[line];
    if (!newName) return;
    let oldName;
    if (p.isFunctionDeclaration()) oldName = node.id && node.id.name;
    else if (p.isImportSpecifier()) oldName = node.local && node.local.name;
    else if (node.id && node.id.type === 'Identifier') oldName = node.id.name;
    if (!oldName) return;
    const scope = p.isFunctionDeclaration() ? p.scope.parent : p.scope;
    const binding = scope.getBinding(oldName);
    if (!binding) {
      console.error(`! 找不到绑定 ${oldName} (line ${line})`);
      return;
    }
    if (COMMENTS[line]) {
      if (p.isVariableDeclarator() && p.parentPath.isVariableDeclaration()) {
        const stmt = p.parentPath;
        if (!stmtComments.has(stmt.node)) stmtComments.set(stmt.node, { path: stmt, texts: [] });
        stmtComments.get(stmt.node).texts.push(COMMENTS[line]);
      } else {
        p.addComment('leading', COMMENTS[line], false);
      }
    }
    pending.push({ scope: binding.scope, oldName, newName, line });
    applied.add(line);
  },
});

for (const k of Object.keys(NAMES)) if (!applied.has(Number(k))) console.error(`! 行 ${k} 未命中任何声明（期望 ${NAMES[k]}）`);

for (const { path: stmt, texts } of stmtComments.values()) {
  for (const text of [...texts].reverse()) stmt.addComment('leading', text, true);
}

// 由外层到内层重命名，避免父作用域改名影响子作用域绑定
pending.sort((a, b) => a.line - b.line);
for (const item of pending) {
  const binding = item.scope.getBinding(item.oldName);
  if (!binding) continue;
  item.scope.rename(item.oldName, item.newName);
}

const banner = `/**
 * Cloudflare Worker 内核 —— 精简版（core-only）明文化版本
 *
 * 来源：byJoey/cfnew 分支 core-only 的发布产物 _worker.js（版本 ${'2026.10.17.2'}）
 * 处理：仅格式化 + 按语义重命名标识符 + 加注释，未改动任何逻辑。
 * 校验：与原始压缩内核 AST alpha 等价，并通过 cfnew-panel 全部测试。
 *
 * 配套面板：https://cfnew.xy.kg/  （源码 byJoey/cfnew-panel）
 * 接口约定（面板调用）：/{UUID 或自定义路径}/api/config、/api/preferred-ips、/region、/test-api，
 * 以及根路径 "hello"。改动本文件时请保持这些路径与字段不变。
 *
 * 闭包内的短名状态变量（k/N/$/M/F 等）保留上游原名，方便与压缩版逐行对照。
 */
`;

const out = banner + generate(ast, { comments: true, jsescOption: { minimal: true }, retainLines: false, compact: false }).code + '\n';
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, out);
console.log(`已写出 ${OUT} (${out.length} 字符)`);
