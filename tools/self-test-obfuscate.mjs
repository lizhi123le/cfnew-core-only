/**
 * 混淆链路（obfuscate.mjs / pages-zip.mjs）的回归自测，`tools/check.sh` 会跑。
 *
 * 覆盖 9 组：
 *   1. 解码参数完整可逆：names.json 每条都能在 _worker.pretty.js 找到声明
 *   2. 反向改名与残留检查：混淆核里不能残留任何语义名绑定
 *   3. AST alpha 等价：混淆核 ≡ 明文（仅名字/转义/注释/格式不同）
 *   4. 字符串值一致：所有字面量值逐个相同（面板 API 路径与配置字段名不会被改）
 *   5. 随机性：同种子可重现、换种子产物变化但语义不变
 *   6. 三种 mangle 模式：all / mapped / upstream 都可用
 *   7. 噪音与 import 契约：噪音只有惰性函数声明；`cloudflare:sockets` 的转义形态可由测试副本还原后打桩
 *   8. pages.zip 写入 / 读取往返（含二进制与 UTF-8 条目名、字节级确定性）
 *   9. javascript-obfuscator 可选引擎：可重现、import 复原、运行时探针通过
 *  10. 体积预算与单行格式：默认 budget 模式落在 37±5 KB、产物体内无换行
 *  11. 关键词：auto 硬性隐藏/检查、manual 期望隐藏、字符串值不变
 *  12. harden.config.json：体积写法解析、CLI/环境变量/配置文件优先级
 *  13. 单行开关与体积搜索：oneLine=false 多行、预算搜索选参数、不可达预算失败
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import { buildReverseMap, obfuscate, mulberry32, assertInertNoise, deriveSeed, normalizeSeed, DEFAULT_PATHS } from './obfuscate.mjs';
import { obfuscateWithJavaScriptObfuscator } from './engine-javascript-obfuscator.mjs';
import { buildArtifacts, probeRuntime } from './build-kernel.mjs';
import { parseSizeSpec, formatSizeSpec, loadHardenParams } from './harden-config.mjs';
import { canonicalize } from './verify-alpha.mjs';
import { createZip, readZipEntries } from './pages-zip.mjs';
import {
  findForbiddenKeywords,
  findKeywordLeaks,
  findKeywordLeaksInModuleSpecifiers,
  scanKeywordVisibility,
  hideKeywordsInCode,
  loadKeywordLists,
  normalizeModuleSpecifiers,
} from './keywords.mjs';

const traverse = _traverse.default || _traverse;
const TOOLS = import.meta.dirname;
const names = JSON.parse(fs.readFileSync(path.join(TOOLS, 'names.json'), 'utf8'));
const plainSource = fs.readFileSync(DEFAULT_PATHS.plain, 'utf8');
const prettySource = fs.readFileSync(DEFAULT_PATHS.pretty, 'utf8');

// 面板测试用这个正则把 cloudflare:sockets 换成桩函数，产物必须保持这条 import 的原文形态。
const IMPORT_PATTERN = /import\s*\{\s*connect as ([A-Za-z_$][\w$]*)\s*\}\s*from\s*"cloudflare:sockets";/;

let failures = 0;
function ok(condition, label, detail) {
  if (condition) {
    console.log(`  ✅ ${label}`);
  } else {
    failures += 1;
    console.error(`  ❌ ${label}${detail ? `\n     ${detail}` : ''}`);
  }
}

function stringValues(code) {
  const values = [];
  const walk = (node) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'StringLiteral') values.push(node.value);
    for (const key of Object.keys(node)) {
      if (['loc', 'start', 'end', 'extra'].includes(key)) continue;
      const child = node[key];
      if (Array.isArray(child)) child.forEach(walk);
      else if (child && typeof child.type === 'string') walk(child);
    }
  };
  walk(parse(code, { sourceType: 'module' }).program);
  return values;
}

console.log('== 1. 解码参数（names.json ↔ _worker.pretty.js）==');
const { reverse, untouched, conflicts } = buildReverseMap({ prettySource, names });
ok(conflicts.length === 0, `反向映射无冲突（${reverse.size} 条）`, conflicts.join('；'));
ok(untouched.length === 0, 'names.json 每一行都在 _worker.pretty.js 命中了声明', untouched.map((u) => `L${u.line}=${u.semantic}`).join(', '));
ok(reverse.size === Object.keys(names).length, '每条语义名都有唯一反向映射');

const seed = 0x5eed1234;
const base = obfuscate({
  plainSource,
  prettySource,
  names,
  seed,
  mangle: 'all',
  escape: 'all',
  noiseBytes: 2048,
});

console.log('== 2. 随机改名与残留检查 ==');
const leftovers = [];
traverse(parse(base.core, { sourceType: 'module' }), {
  Identifier(p) {
    if (p.isBindingIdentifier() && reverse.has(p.node.name)) leftovers.push(p.node.name);
  },
});
const plainVersion = (plainSource.match(/CORE_VERSION\s*=\s*"([^"]+)"/) || [])[1] ?? null;
ok(leftovers.length === 0, '混淆核里没有残留的语义名绑定', leftovers.slice(0, 10).join(', '));
ok(base.version === plainVersion, `读到内核版本 ${base.version}（明文 ${plainVersion}）`);
ok(Boolean(base.versionBinding), `版本常量短名 ${base.versionBinding}`);
ok(base.stats.renamed > 100, `重命名了 ${base.stats.renamed} 个绑定`);
ok(base.stats.missingBindings.length === 0, '每个反向映射都找到了作用域绑定');

console.log('== 3. AST alpha 等价 ==');
ok(canonicalize(plainSource) === canonicalize(base.core), '混淆核 ≡ 明文（仅名字/转义/注释/格式不同）');

console.log('== 4. 字符串值一致（面板接口契约）==');
const plainStrings = stringValues(plainSource);
const coreStrings = stringValues(base.core);
ok(coreStrings.length === plainStrings.length, `字符串数量一致（${coreStrings.length}）`);
ok(JSON.stringify(coreStrings) === JSON.stringify(plainStrings), '所有字符串字面量值逐个相同');
const routes = ['hello', '/api/config', '/api/preferred-ips', '/region', '/test-api'];
for (const route of routes) ok(coreStrings.includes(route), `路径/常量仍保留：${route}`);
ok(base.stats.escapedStrings > 100, `转义了 ${base.stats.escapedStrings} 个字符串`);

console.log('== 5. 随机性（种子）==');
const sameSeed = obfuscate({ plainSource, prettySource, names, seed, mangle: 'all', escape: 'all', noiseBytes: 2048 });
ok(sameSeed.code === base.code, '同一种子两次产物逐字节相同');
const otherSeed = obfuscate({ plainSource, prettySource, names, seed: seed ^ 0xffff, mangle: 'all', escape: 'all', noiseBytes: 2048 });
ok(otherSeed.code !== base.code, '换种子后产物不同');
ok(canonicalize(otherSeed.core) === canonicalize(plainSource), '换种子后仍与明文 alpha 等价');
ok(JSON.stringify(stringValues(otherSeed.core)) === JSON.stringify(plainStrings), '换种子后字符串值仍逐个相同');
ok(deriveSeed({ plainSource, prettySource, names }) === deriveSeed({ plainSource, prettySource, names }), '源码哈希派生的种子稳定');

console.log('== 6. 三种 mangle 模式 ==');
const mapped = obfuscate({ plainSource, prettySource, names, seed: normalizeSeed(7), mangle: 'mapped', escape: 'none', noiseBytes: 0 });
ok(canonicalize(mapped.core) === canonicalize(plainSource), 'mapped 模式 alpha 等价');
ok(mapped.stats.renamed === reverse.size, `mapped 模式只换 ${mapped.stats.renamed} 个声明`);
const upstream = obfuscate({ plainSource, prettySource, names, seed: normalizeSeed(7), mangle: 'upstream', escape: 'none', noiseBytes: 0 });
ok(canonicalize(upstream.core) === canonicalize(plainSource), 'upstream 模式 alpha 等价');
ok(upstream.versionBinding === reverse.get('CORE_VERSION').orig, `upstream 模式还原上游版本常量名 ${upstream.versionBinding}`);
ok(upstream.code !== mapped.code, 'upstream 与 mapped 的命名不同');

console.log('== 7. 噪音与 import 契约 ==');
assertInertNoise(base.noise);
ok(base.code.startsWith(base.core), '产物 = 混淆核 + 噪音（前缀一致）');
ok(base.stats.noiseBytes > 0, `噪音 ${base.stats.noiseBytes} 字节`);
const noiseAst = parse(base.noise, { sourceType: 'module' });
ok(noiseAst.program.body.every((stmt) => stmt.type === 'FunctionDeclaration'), '噪音顶层只有函数声明（不会执行）');
ok(!base.code.includes('cloudflare:sockets'), '产物里的模块说明符已被转义');
ok(Boolean(normalizeModuleSpecifiers(base.code).code.match(IMPORT_PATTERN)), '测试副本还原后能匹配面板打桩 import');
ok(
  Boolean(normalizeModuleSpecifiers(upstream.core).code.match(IMPORT_PATTERN)) &&
    Boolean(normalizeModuleSpecifiers(mapped.core).code.match(IMPORT_PATTERN)),
  '其他模式同样可在测试副本里还原模块说明符'
);

console.log('== 8. pages.zip 写入 / 读取往返 ==');
const textEntry = { name: '_worker.js', data: base.code };
const binaryEntry = { name: '目录/说明.txt', data: Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]) };
const zip = createZip([textEntry, binaryEntry]);
const entries = readZipEntries(zip);
ok(entries.length === 2, `条目数 ${entries.length}`);
ok(entries[0].name === '_worker.js' && entries[0].data.toString('utf8') === base.code, '文本条目内容一致');
ok(entries[1].name === '目录/说明.txt' && entries[1].data.equals(binaryEntry.data), 'UTF-8 条目名 + 二进制内容一致');
ok(createZip([textEntry, binaryEntry]).equals(zip), 'ZIP 字节级确定性');

console.log('== 9. javascript-obfuscator 可选引擎 ==');
const joSeed = 0x1a2b3c4d;
const joAuto = obfuscateWithJavaScriptObfuscator({
  source: plainSource,
  seed: joSeed,
  preset: 'auto',
  targetBytes: 39500,
  sizeRange: { min: 32000, max: 44000 },
});
const joAutoBytes = Buffer.byteLength(joAuto.code);
ok(joAuto.code.split('\n').length === 1, 'auto 预设产物单行');
ok(joAutoBytes >= 32000 && joAutoBytes <= 44000, `auto 产物 ${joAutoBytes} 字节在 32..44 KB 内（阈值 ${joAuto.stats.threshold}，探测 ${joAuto.stats.runs} 次）`);
ok(IMPORT_PATTERN.test(joAuto.code), 'auto 预设保留 cloudflare:sockets import 原文');
const joAutoProbe = await probeRuntime({ code: joAuto.code, version: plainVersion });
ok(joAutoProbe.coreVersion === plainVersion, `auto 运行时探针 coreVersion=${joAutoProbe.coreVersion}`);

const jo = obfuscateWithJavaScriptObfuscator({ source: plainSource, seed: joSeed, preset: 'light' });
ok(jo.code.length > 0, `light 预设产物 ${Buffer.byteLength(jo.code)} 字节（javascript-obfuscator ${jo.version}）`);
ok(IMPORT_PATTERN.test(jo.code), 'light 预设的 import 已复原（面板测试可打桩）');
const joProbe = await probeRuntime({ code: jo.code, version: plainVersion });
ok(joProbe.coreVersion === plainVersion, `light 运行时探针 coreVersion=${joProbe.coreVersion}`);
ok(typeof joProbe.region === 'string' && joProbe.region.length > 0, `/region 探针返回 region=${joProbe.region}`);
const joAgain = obfuscateWithJavaScriptObfuscator({ source: plainSource, seed: joSeed, preset: 'light' });
ok(joAgain.code === jo.code, '同一 seed 产物逐字节相同');
const joBalanced = obfuscateWithJavaScriptObfuscator({ source: plainSource, seed: joSeed, preset: 'balanced' });
ok(joBalanced.code !== jo.code, 'balanced 预设产物不同');
ok(IMPORT_PATTERN.test(joBalanced.code), 'balanced 预设同样保留 import 原文');
ok(jo.options.renameProperties === false, '强制 renameProperties=false（保护面板 JSON 字段名）');

console.log('== 10. 体积预算与单行格式 ==');
const budgetOpts = { plainSource, prettySource, names, seed, mangle: 'all', escape: 'budget', targetBytes: 44000, noiseBytes: 4096 };
const budget = obfuscate(budgetOpts);
const budgetBytes = Buffer.byteLength(budget.code);
ok(!budget.code.includes('\n'), '产物体内没有换行（保持原有单行格式）');
ok(budgetBytes >= 32000 && budgetBytes <= 44000, `体积 ${budgetBytes} 字节在约 43 KB 区间（32..44 KB）`);
ok(budgetBytes <= budgetOpts.targetBytes, `体积不超过目标 ${budgetOpts.targetBytes}`);
ok(canonicalize(budget.core) === canonicalize(plainSource), '预算模式下混淆核仍与明文 alpha 等价');
ok(JSON.stringify(stringValues(budget.core)) === JSON.stringify(plainStrings), '预算模式下字符串值仍逐个相同');
ok(!budget.code.includes('/api/config') && !budget.code.includes('/region'), '路由字符串已转义隐藏');
assertInertNoise(budget.noise);
ok(budget.stats.noiseBytes >= 0, `噪音 ${budget.stats.noiseBytes} 字节（关键词/敏感串占用预算时可为 0）`);
ok(obfuscate(budgetOpts).code === budget.code, '预算模式同一 seed 逐字节可重现');

console.log('== 11. 关键词隐藏与检查 ==');
const keywordLists = loadKeywordLists();
ok(keywordLists.auto.length > 0, `硬性禁止词表 ${keywordLists.auto.length} 条`);
ok(keywordLists.manual.length > 0, `期望隐藏词表 ${keywordLists.manual.length} 条`);
const keywordProbe = hideKeywordsInCode('const a = "cfnew vless config";', ['cfnew', 'vless', 'config']);
ok(keywordProbe.hidden > 0, `合成样本隐藏了 ${keywordProbe.hidden} 段`);
ok(findKeywordLeaks(keywordProbe.code, ['cfnew', 'vless', 'config']).length === 0, '隐藏后检查不到明文');
const parsedProbe = parse(keywordProbe.code, { sourceType: 'module' });
let probeValue = null;
traverse(parsedProbe, { StringLiteral(p) { probeValue = p.node.value; } });
ok(probeValue === 'cfnew vless config', '隐藏没有改变字符串值');
ok(findKeywordLeaks('const a = "cfnew";', ['cfnew']).length === 1, '检查能发现明文关键词');
ok(findForbiddenKeywords('const o={port:1};', ['port']).length > 0, '硬性门禁能发现属性名里的明文');
ok(findForbiddenKeywords('typeof x;export{}', ['type', 'port']).length === 0, '硬性门禁放行 JS 关键字内部的子串');
ok(findKeywordLeaks(base.core, keywordLists.auto).length === 0, 'escape=all 产物无硬性泄露');
ok(findKeywordLeaks(budget.core, keywordLists.auto).length === 0, 'budget 产物无硬性泄露');
ok(findKeywordLeaks(budget.code, keywordLists.auto).length === 0, '带噪音的最终产物无硬性泄露');
const moduleHits = findKeywordLeaksInModuleSpecifiers(budget.code, keywordLists.auto);
ok(moduleHits.length === 0, '模块说明符里的关键词也已隐藏');
ok(!budget.code.includes('cloudflare:sockets'), '发布产物不含明文 cloudflare:sockets');
const normalizedForTest = normalizeModuleSpecifiers(budget.code);
ok(normalizedForTest.code !== budget.code, '测试副本对模块说明符做了还原');
ok(/from"cloudflare:sockets"/.test(normalizedForTest.code), '还原后能匹配面板测试的打桩正则');
const identProbe = hideKeywordsInCode('import{connect as X}from"cloudflare:sockets";', ['connect'], {
  includeImportIdentifiers: true,
});
ok(!identProbe.code.includes('connect'), 'import 绑定名 connect 已用 Unicode 转义隐藏');
const identAst = parse(identProbe.code, { sourceType: 'module' });
const identSpec = identAst.program.body[0].specifiers[0];
ok(identSpec.imported.name === 'connect', 'Unicode 转义后绑定名仍是 connect');
ok(
  /import\{connect as X\}from"cloudflare:sockets"/.test(normalizeModuleSpecifiers(identProbe.code).code),
  '测试副本能还原 import 绑定名'
);
ok(identProbe.code.startsWith('import'), 'import 关键字保留（JS 语法不可转义）');
ok(identProbe.code.includes('from'), 'from 关键字保留（JS 语法不可转义）');
ok(findKeywordLeaks(budget.code, ['connect'], { includeImportIdentifiers: true }).length === 0, '产物里 connect 已隐藏');
const randomSrc = 'import{connect as X}from"cloudflare:sockets";';
const randomWords = ['connect', 'cloudflare', 'sock'];
const randomA = hideKeywordsInCode(randomSrc, randomWords, {
  includeModuleSpecifiers: true,
  includeImportIdentifiers: true,
  randomize: true,
  rng: mulberry32(0x11111111),
});
const randomB = hideKeywordsInCode(randomSrc, randomWords, {
  includeModuleSpecifiers: true,
  includeImportIdentifiers: true,
  randomize: true,
  rng: mulberry32(0x22222222),
});
ok(randomA.code !== randomB.code, '不同种子生成不同的随机转义形态');
ok(
  normalizeModuleSpecifiers(randomA.code).code ===
    normalizeModuleSpecifiers(randomB.code).code,
  '随机转义后还原值相同'
);
const visibility = scanKeywordVisibility(budget.code, keywordLists.auto);
ok((visibility.exact.get('port') || 0) === 0, '结构扫描：port 整词属性名已全部转义（0 处）');
ok((visibility.exact.get('region') || 0) === 0, '结构扫描：region 整词属性名已全部转义（0 处）');
ok([...visibility.structural.values()].reduce((sum, n) => sum + n, 0) === 0, '结构扫描：标识符/属性名里没有残留');
ok([...visibility.keyword.values()].reduce((sum, n) => sum + n, 0) > 0, '语法关键字内的子串单独归类（import/typeof）');
ok(findForbiddenKeywords(budget.code, keywordLists.auto).length === 0, '最终产物通过硬性词表门禁');
ok(findForbiddenKeywords(base.code, keywordLists.auto).length === 0, 'escape=all 产物通过硬性词表门禁');

// 标识符转义：每个词转 2–3 个字符，解码后名字与属性键完全不变。
const identSrc = 'const port=1;const region="x";const o={port,region};function f(port){return port+o.region;}';
const identHidden = hideKeywordsInCode(identSrc, ['port', 'region'], { includeIdentifiers: true });
ok(!/port|region/i.test(identHidden.code), '标识符/属性名里的 port、region 已不可见');
const identBack = parse(identHidden.code, { sourceType: 'module' });
const backNames = [];
traverse(identBack, {
  Identifier(p) { backNames.push(p.node.name); },
});
ok(backNames.includes('port') && backNames.includes('region'), '转义后标识符解码仍是 port / region（语义不变）');
ok(identHidden.code.length - identSrc.length < 160, `每个词 2 个字符起步只增加 ${identHidden.code.length - identSrc.length} 字节`);

// 随机加码：同一份源码，不同种子下转义的位置/形态不同，但解码后的名字不变。
const manySrc = 'const port=1,region=2,ech=3,alpn=4,hostname="h",address="a",connect=5,toString=6;';
const manyWords = ['port', 'region', 'ech', 'alpn', 'ost', 'dres', 'onnec'];
const manyA = hideKeywordsInCode(manySrc, manyWords, {
  includeIdentifiers: true,
  identifierExtraBudget: 200,
  rng: mulberry32(0x12345678),
});
const manyB = hideKeywordsInCode(manySrc, manyWords, {
  includeIdentifiers: true,
  identifierExtraBudget: 200,
  rng: mulberry32(0x87654321),
});
ok(manyA.code !== manyB.code, '不同种子下标识符转义位置/形态不同');
ok(manyA.chars > manyA.hidden, `预算内随机多转了 ${manyA.chars - manyA.hidden} 个字符（1–2 个随机）`);
const manyBack = [];
traverse(parse(manyA.code, { sourceType: 'module' }), { Identifier(p) { manyBack.push(p.node.name); } });
ok(manyBack.includes('port') && manyBack.includes('region') && manyBack.includes('hostname'), '随机转义后名字仍全部还原');

console.log('== 12. harden.config.json 参数解析 ==');
const sizeCases = [
  ['320000', { kind: 'bytes', value: 320000 }],
  ['320k', { kind: 'bytes', value: 327680 }],
  ['1m', { kind: 'bytes', value: 1048576 }],
  ['75%', { kind: 'percent', value: 75 }],
  ['0', null],
  ['0%', null],
  [0, null],
];
for (const [input, expected] of sizeCases) {
  ok(
    JSON.stringify(parseSizeSpec(input)) === JSON.stringify(expected),
    `体积写法 ${JSON.stringify(input)} → ${JSON.stringify(expected)}`,
  );
}
let invalidSizeThrew = false;
try {
  parseSizeSpec('abc');
} catch {
  invalidSizeThrew = true;
}
ok(invalidSizeThrew, '非法体积写法会报错');
ok(formatSizeSpec({ kind: 'percent', value: 75 }) === '75%', '百分比格式化');
ok(formatSizeSpec({ kind: 'bytes', value: 327680 }) === '327680', '绝对字节格式化');
ok(formatSizeSpec(null) === '', '0/缺省格式化为空');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfnew-harden-'));
const tmpConfig = path.join(tmpDir, 'harden.config.json');
fs.writeFileSync(
  tmpConfig,
  JSON.stringify({ targetBytes: '320k', targetZipBytes: '1m', maxRuns: 5, oneLine: false }),
);
const cfgParams = loadHardenParams({ opts: new Map([['config', tmpConfig]]), flags: new Set(), env: {} });
ok(
  cfgParams.targetBytes.value === 327680 && cfgParams.targetZipBytes.value === 1048576,
  '配置文件提供体积目标',
);
ok(cfgParams.maxRuns === 5 && cfgParams.oneLine === false, '配置文件提供 maxRuns / oneLine');
ok(cfgParams.provided.oneLine === true, '配置文件里的 oneLine 被视为显式提供');
const envParams = loadHardenParams({
  opts: new Map([['config', tmpConfig]]),
  flags: new Set(),
  env: { CFNEW_TARGET_BYTES: '75%', CFNEW_MAX_RUNS: '9', CFNEW_ONE_LINE: '1' },
});
ok(
  envParams.targetBytes.kind === 'percent' && envParams.targetBytes.value === 75,
  '环境变量覆盖配置文件（百分比）',
);
ok(envParams.maxRuns === 9 && envParams.oneLine === true, '环境变量覆盖 maxRuns / oneLine');
const cliParams = loadHardenParams({
  opts: new Map([
    ['config', tmpConfig],
    ['target-bytes', '100k'],
    ['target-zip', '0'],
    ['one-line', 'false'],
  ]),
  flags: new Set(),
  env: { CFNEW_TARGET_BYTES: '75%' },
});
ok(cliParams.targetBytes.value === 102400, 'CLI 优先于环境变量与配置文件');
ok(
  cliParams.targetZipBytes === null && cliParams.provided.targetZipBytes === true,
  '显式 0 = 关闭该限制（仍算已提供）',
);
ok(cliParams.oneLine === false, 'CLI --one-line=false 生效');
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log('== 13. 单行开关与体积预算搜索 ==');
const multiline = obfuscate({
  plainSource,
  prettySource,
  names,
  seed,
  mangle: 'all',
  escape: 'budget',
  targetBytes: 39500,
  noiseBytes: 512,
  oneLine: false,
});
ok(multiline.code.includes('\n'), 'oneLine=false 产物包含换行');
ok(canonicalize(multiline.core) === canonicalize(plainSource), '多行混淆核仍与明文 alpha 等价');
ok(JSON.stringify(stringValues(multiline.core)) === JSON.stringify(plainStrings), '多行产物字符串值逐个相同');

const hardenFor = (targetBytes, maxRuns = 6) => ({
  targetBytes,
  targetZipBytes: null,
  maxRuns,
  oneLine: true,
  provided: { targetBytes: true, targetZipBytes: false, maxRuns: true, oneLine: true },
});
const baseBuild = {
  plainSource,
  prettySource,
  names,
  seed,
  engine: 'builtin',
  joPreset: 'auto',
  mangle: 'all',
  escape: 'budget',
  noiseBytes: 4096,
  targetBytes: 39500,
  sizeRange: { min: 32000, max: 44000 },
};
const tight = await buildArtifacts({ ...baseBuild, harden: hardenFor({ kind: 'bytes', value: 44000 }, 4) });
ok(Buffer.byteLength(tight.code) <= 44000, `预算搜索把产物压到 ${Buffer.byteLength(tight.code)} ≤ 44000 字节`);
ok(
  tight.selection.configured && tight.selection.runs >= 1 && tight.selection.runs <= 4,
  `搜索次数 ${tight.selection.runs} 不超过 maxRuns=4`,
);
const legacy = await buildArtifacts({ ...baseBuild }); // 不传 harden：保持旧的 32..44 KB 区间
ok(
  !legacy.selection.configured && legacy.selection.legacySizeGate,
  '未配置 harden 时仍走旧的体积区间检查',
);
ok(
  Buffer.byteLength(legacy.code) >= 32000 && Buffer.byteLength(legacy.code) <= 44000,
  `未配置 harden 时产物 ${Buffer.byteLength(legacy.code)} 字节仍在 32..44 KB`,
);
const pct = await buildArtifacts({ ...baseBuild, harden: hardenFor({ kind: 'percent', value: 100 }) });
ok(
  Buffer.byteLength(pct.code) <= Math.floor((pct.selection.firstMetrics.rawBytes * 100) / 100),
  '百分比预算按首次混淆产物解析并达标',
);
let budgetThrew = false;
try {
  // 硬性词表转义后混淆核约 43.7 KB，低于它的预算不可能达成。
  await buildArtifacts({ ...baseBuild, harden: hardenFor({ kind: 'bytes', value: 39000 }, 2) });
} catch (error) {
  budgetThrew = /体积预算无法满足/.test(error.message);
}
ok(budgetThrew, '不可达预算会失败并说明原因');

console.log('');
if (failures) {
  console.error(`❌ 混淆自测 ${failures} 项失败`);
  process.exit(1);
}
console.log('✅ 混淆自测全部通过');
