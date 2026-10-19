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
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import { buildReverseMap, obfuscate, mulberry32, assertInertNoise, deriveSeed, normalizeSeed, DEFAULT_PATHS } from './obfuscate.mjs';
import { obfuscateWithJavaScriptObfuscator } from './engine-javascript-obfuscator.mjs';
import { probeRuntime } from './build-kernel.mjs';
import { canonicalize } from './verify-alpha.mjs';
import { createZip, readZipEntries } from './pages-zip.mjs';
import {
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
  sizeRange: { min: 32000, max: 42000 },
});
const joAutoBytes = Buffer.byteLength(joAuto.code);
ok(joAuto.code.split('\n').length === 1, 'auto 预设产物单行');
ok(joAutoBytes >= 32000 && joAutoBytes <= 42000, `auto 产物 ${joAutoBytes} 字节在 37±5 KB 内（阈值 ${joAuto.stats.threshold}，探测 ${joAuto.stats.runs} 次）`);
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
const budgetOpts = { plainSource, prettySource, names, seed, mangle: 'all', escape: 'budget', targetBytes: 39500, noiseBytes: 4096 };
const budget = obfuscate(budgetOpts);
const budgetBytes = Buffer.byteLength(budget.code);
ok(!budget.code.includes('\n'), '产物体内没有换行（保持原有单行格式）');
ok(budgetBytes >= 32000 && budgetBytes <= 42000, `体积 ${budgetBytes} 字节在 37±5 KB 区间（32..42 KB）`);
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
ok((visibility.exact.get('port') || 0) > 0, '结构扫描能如实报告 port/region 等整词属性名');
ok((visibility.exact.get('region') || 0) > 0, '结构扫描能如实报告 region 等整词属性名');

console.log('');
if (failures) {
  console.error(`❌ 混淆自测 ${failures} 项失败`);
  process.exit(1);
}
console.log('✅ 混淆自测全部通过');
