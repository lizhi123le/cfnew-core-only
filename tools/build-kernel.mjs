/**
 * 混淆工作流：一份明文 → 两份可发布产物，并保证产物「可重现、可校验、可替换」。
 *
 *   plain/_worker.js ──引擎──▶ _worker.js ──pages-zip──▶ pages.zip
 *
 * 两个引擎：
 *   builtin（默认）          ：babel 作用域改名 + 随机短名 + 字符串转义 + 惰性噪音；
 *   javascript-obfuscator    ：可选依赖，用它的参数（--jo-preset / tools/obfuscator.config.json）混淆。
 *
 * 硬门槛（任何一条不过都不会写文件）：
 *   1. 语法/部署：产物可解析、保留 default 导出；
 *   2. 面板契约：内置运行时探针（默认导出、`/`=hello、未知路径 404、`/api/config` 的
 *      coreVersion 与配置字段、`/region` 字段），并保留面板测试打桩所需的 import 原文；
 *   3. builtin 引擎额外做：混淆核与明文 AST alpha 等价、全部字符串字面量值逐个相同、
 *      噪音只含惰性函数声明；
 *   4. 版本：产物运行时返回的 coreVersion 必须等于明文 CORE_VERSION；
 *   5. 可重现：--check 模式下重算结果必须与仓库里的文件逐字节一致。
 *
 * 引擎与种子记录在 tools/obfuscate.seed.json（{ seed, engine, joPreset }），
 * 所以 --check 不需要额外参数就能复现。
 *
 * 用法：
 *   node tools/build-kernel.mjs                     # 用当前引擎/种子重建并替换
 *   node tools/build-kernel.mjs --check             # 只校验可重现（CI 用）
 *   node tools/build-kernel.mjs --dry-run           # 只看差异
 *   node tools/build-kernel.mjs --randomize         # 换随机种子后重建
 *   node tools/build-kernel.mjs --engine=javascript-obfuscator --jo-preset=balanced
 *   node tools/build-kernel.mjs --seed 12345
 *
 * 环境变量：CFNEW_ENGINE / CFNEW_JO_PRESET / CFNEW_SEED / CFNEW_MANGLE / CFNEW_ESCAPE /
 *           CFNEW_NOISE / CFNEW_JO_CONFIG，以及路径覆盖 CFNEW_PLAIN / CFNEW_PRETTY /
 *           CFNEW_NAMES / CFNEW_OUT / CFNEW_ZIP
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parse } from '@babel/parser';
import { createZip, readZipEntries } from './pages-zip.mjs';
import {
  assertInertNoise,
  deriveSeed,
  loadSeedRecord,
  normalizeSeed,
  obfuscate,
  parseCliArgs,
  randomSeed,
  resolveObfuscationOptions,
  saveSeedRecord,
  DEFAULT_PATHS,
  SEED_PATH,
} from './obfuscate.mjs';
import { JO_PRESETS, joDependencyVersion, obfuscateWithJavaScriptObfuscator } from './engine-javascript-obfuscator.mjs';
import { canonicalize } from './verify-alpha.mjs';
import {
  findKeywordLeaks,
  findKeywordLeaksInModuleSpecifiers,
  hideKeywordsInCode,
  loadKeywordLists,
  normalizeModuleSpecifiers,
  scanKeywordVisibility,
} from './keywords.mjs';

const TOOLS = import.meta.dirname;
const ROOT = path.resolve(TOOLS, '..');

const PATHS = {
  plain: DEFAULT_PATHS.plain,
  pretty: DEFAULT_PATHS.pretty,
  names: path.join(TOOLS, 'names.json'),
  out: DEFAULT_PATHS.out,
  zip: path.join(ROOT, 'pages.zip'),
};

const WORKER_ENTRY = '_worker.js';
const KEYWORDS = loadKeywordLists();
const JS_SYNTAX_WORDS = new Set(['import', 'from', 'as', 'export', 'default']);
const SEED_FILE = process.env.CFNEW_SEED_FILE || SEED_PATH;
const PROBE_UUID = '8f0c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f';
const ENGINES = new Set(['builtin', 'javascript-obfuscator']);
const IMPORT_PATTERN = /import\s*\{\s*connect as ([^}]+)\}\s*from\s*["']cloudflare:sockets["']\s*;?/;

const normalizeEol = (text) => text.replace(/\r\n/g, '\n');
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const humanBytes = (n) => `${n.toLocaleString('en-US')} 字节`;

const readText = (p) => {
  if (!fs.existsSync(p)) throw new Error(`找不到文件：${p}`);
  return fs.readFileSync(p, 'utf8');
};

function firstDiff(a, b) {
  let i = 0;
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
  const context = (s) => JSON.stringify(s.slice(Math.max(0, i - 50), i + 100));
  return `第 ${i} 个字符\n  现有: ${context(a)}\n  应生: ${context(b)}`;
}

/** 收集一段源码里所有字符串字面量的值（按出现顺序）。 */
function collectStringValues(code) {
  const values = [];
  const ast = parse(code, { sourceType: 'module' });
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
  walk(ast.program);
  return values;
}

function readPlainVersion(plainSource) {
  for (const stmt of parse(plainSource, { sourceType: 'module' }).program.body) {
    if (stmt.type !== 'VariableDeclaration') continue;
    for (const d of stmt.declarations) {
      if (d.id.type === 'Identifier' && d.id.name === 'CORE_VERSION' && d.init && d.init.type === 'StringLiteral') {
        return d.init.value;
      }
    }
  }
  return null;
}

function hasDefaultExport(ast) {
  return ast.program.body.some(
    (stmt) =>
      stmt.type === 'ExportDefaultDeclaration' ||
      (stmt.type === 'ExportNamedDeclaration' &&
        stmt.specifiers.some((s) => s.type === 'ExportSpecifier' && s.exported && s.exported.name === 'default')),
  );
}

/**
 * 运行时契约探针：把 `cloudflare:sockets` 换成桩（与 cfnew-panel 测试同一套正则），
 * 用 data URL 直接加载产物，按真实请求验证「面板依赖的接口」。
 * 对 builtin 与 javascript-obfuscator 两种引擎都适用。
 */
export async function probeRuntime({ code, version }) {
  // 产物可能转义了模块说明符；打桩前先统一还原成原文。
  const normalizedCode = normalizeModuleSpecifiers(code).code;
  const match = normalizedCode.match(IMPORT_PATTERN);
  if (!match) throw new Error('找不到 cloudflare:sockets 的 import（cfnew-panel 测试靠它打桩）');
  const localName = match[1].trim();
  const stubbed = normalizedCode.replace(
    match[0],
    `const ${localName} = () => { throw new Error('probe: cloudflare:sockets 不可用'); };`,
  );
  if (stubbed === code) throw new Error('import 打桩失败');

  let worker;
  try {
    const url = 'data:text/javascript;base64,' + Buffer.from(stubbed).toString('base64');
    worker = (await import(url)).default;
  } catch (error) {
    throw new Error(`产物无法作为 module worker 加载：${error.message}`);
  }
  if (!worker || typeof worker.fetch !== 'function') throw new Error('产物没有 default.fetch');

  const env = { u: PROBE_UUID };
  const request = (p, init) => worker.fetch(new Request('https://probe.invalid' + p, init), env);

  const hello = await request('/');
  if (hello.status !== 200 || (await hello.text()) !== 'hello') {
    throw new Error(`GET / 没有返回 hello（status=${hello.status}）`);
  }

  const missing = await request('/__cfn_probe_missing__');
  if (missing.status !== 404) throw new Error(`未知路径返回 ${missing.status}，期望 404`);

  const configRes = await request(`/${PROBE_UUID}/api/config`);
  if (configRes.status !== 200) throw new Error(`/api/config 返回 ${configRes.status}`);
  const config = await configRes.json();
  const coreVersion = config.coreVersion ?? (config.config && config.config.coreVersion);
  if (version && coreVersion !== version) throw new Error(`运行时 coreVersion=${coreVersion} ≠ 明文 ${version}`);
  for (const key of ['freeCpu', 'wk', 'ev']) {
    if (!(key in config)) throw new Error(`/api/config 响应缺字段 ${key}`);
  }

  const regionRes = await request(`/${PROBE_UUID}/region`);
  if (regionRes.status !== 200) throw new Error(`/region 返回 ${regionRes.status}`);
  const region = await regionRes.json();
  for (const key of ['region', 'detectionMethod', 'timestamp']) {
    if (!(key in region)) throw new Error(`/region 响应缺字段 ${key}`);
  }

  return { coreVersion, configKeys: Object.keys(config).length, region: region.region };
}

/** 生成两份产物的内存版本；不改动磁盘。 */
export async function buildArtifacts({
  plainSource,
  prettySource,
  names,
  seed,
  engine,
  joPreset,
  mangle,
  escape,
  noiseBytes,
  targetBytes,
  sizeRange,
}) {
  if (engine === 'javascript-obfuscator') {
    const result = obfuscateWithJavaScriptObfuscator({
      source: plainSource,
      seed,
      preset: joPreset,
      targetBytes,
      sizeRange,
    });

    // 关键词隐藏（JO 引擎在所选预设之外再兜一层）：只转义命中的字符，值不变。
    const keywordHide = hideKeywordsInCode(result.code, [...KEYWORDS.auto, ...KEYWORDS.manual], {
      includeModuleSpecifiers: true,
      includeImportIdentifiers: true,
    });
    const resultCode = keywordHide.code;
    const code = resultCode.endsWith('\n') ? resultCode : `${resultCode}\n`;
    const totalBytes = Buffer.byteLength(result.code);
    const version = readPlainVersion(plainSource);
    if (!version) throw new Error('明文里找不到 `const CORE_VERSION = "..."`');

    if (result.stats.preset === 'auto') {
      if (result.code.includes('\n')) throw new Error('产物不是单行格式（内部错误）');
      if (totalBytes < sizeRange.min || totalBytes > sizeRange.max) {
        throw new Error(`产物体积 ${totalBytes} 字节不在 ${sizeRange.min}..${sizeRange.max} 内`);
      }
    }

    const ast = parse(code, { sourceType: 'module' });
    if (!hasDefaultExport(ast)) throw new Error('产物没有 default 导出，Workers/Pages 无法加载');
    const hardLeaks = findKeywordLeaks(code, KEYWORDS.auto, { includeModuleSpecifiers: true, includeImportIdentifiers: true });
    if (hardLeaks.length) {
      throw new Error(
        `产物里仍有硬性禁止词以明文出现：${hardLeaks.map((l) => l.word).join(', ')}。` +
          '这些位置无法用字符串转义隐藏（例如模块说明符/正则/标识符），请调整词表或换 builtin 引擎。'
      );
    }
    const expectedLeaks = findKeywordLeaks(code, KEYWORDS.manual, { includeModuleSpecifiers: true, includeImportIdentifiers: true });
    if (expectedLeaks.length) {
      console.warn(`⚠️ 期望隐藏词仍可见：${expectedLeaks.map((l) => l.word).join(', ')}`);
    }
    const moduleHits = findKeywordLeaksInModuleSpecifiers(code, KEYWORDS.auto);
    const visibility = scanKeywordVisibility(code, KEYWORDS.auto);
    const structural = [...visibility.structural]
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
    const exactVisible = [...visibility.exact]
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12);
    const exactTotal = [...visibility.exact].reduce((sum, [, count]) => sum + count, 0);
    const probe = await probeRuntime({ code, version });

    const zip = createZip([{ name: WORKER_ENTRY, data: Buffer.from(code, 'utf8') }]);
    return {
      code,
      zip,
      version,
      versionBinding: null,
      engine,
      joPreset,
      dependency: result.version,
      seed,
      probe,
      stats: {
        engine,
        joPreset,
        seed,
        dependency: result.version,
        joStats: result.stats,
        keywords: {
          hidden: keywordHide.hidden,
          words: keywordHide.words,
          hardLeaks,
          expectedLeaks,
          moduleHits,
          structural,
          exactVisible,
          exactTotal,
          syntaxWords: KEYWORDS.auto.filter((word) => JS_SYNTAX_WORDS.has(word)),
        },
        targetBytes,
        coreBytes: totalBytes,
        noiseBytes: 0,
        totalBytes,
        escapedStrings: 0,
        skippedStrings: 0,
        mapped: 0,
        renamed: 0,
        declarations: 0,
        unmappedSemantics: [],
        missingBindings: [],
        untouched: [],
      },
      hashes: { worker: sha256(code), zip: sha256(zip) },
    };
  }

  const result = obfuscate({ plainSource, prettySource, names, seed, mangle, escape, noiseBytes, targetBytes });
  if (!result.version) throw new Error('明文里找不到 `const CORE_VERSION = "..."`，无法交叉校验版本');
  if (!result.versionBinding) throw new Error('明文里找不到 CORE_VERSION 对应的绑定，无法校验产物版本常量');

  const code = `${result.code}\n`;
  const totalBytes = Buffer.byteLength(result.code);

  // 门槛 0：体积与单行格式（budget 模式下强制 37±5 KB 默认区间）
  if (result.stats.escape === 'budget') {
    if (result.code.includes('\n')) throw new Error('产物不是单行格式（内部错误）');
    if (totalBytes < sizeRange.min || totalBytes > sizeRange.max) {
      throw new Error(
        `产物体积 ${totalBytes} 字节，超出目标区间 ${sizeRange.min}..${sizeRange.max}（37±5 KB）。` +
          '可调整 --target-size / --size-min / --size-max，或减少噪音与转义。',
      );
    }
  }

  // 门槛 1：混淆核与明文 alpha 等价（字符串转义/改名都不改变 AST 语义）
  const normalizedPlain = canonicalize(plainSource);
  const normalizedCore = canonicalize(result.core);
  if (normalizedPlain !== normalizedCore) {
    throw new Error(`混淆核与明文不 alpha 等价：\n   ${firstDiff(normalizedPlain, normalizedCore)}`);
  }

  // 门槛 2：所有字符串值必须逐个相同 —— 面板 API 路径、配置字段名、协议字符串都在这里兜底
  const plainStrings = collectStringValues(plainSource);
  const coreStrings = collectStringValues(result.core);
  if (plainStrings.length !== coreStrings.length) {
    throw new Error(`字符串数量不一致：明文 ${plainStrings.length} 个，产物 ${coreStrings.length} 个`);
  }
  for (let i = 0; i < plainStrings.length; i++) {
    if (plainStrings[i] !== coreStrings[i]) {
      throw new Error(`第 ${i} 个字符串字面量值被改变：明文 ${JSON.stringify(plainStrings[i])} ≠ 产物 ${JSON.stringify(coreStrings[i])}`);
    }
  }

  // 门槛 3：CORE_VERSION 值一致（常量名是随机的）
  const outputAst = parse(code, { sourceType: 'module' });
  let versionOk = false;
  for (const stmt of outputAst.program.body) {
    if (stmt.type !== 'VariableDeclaration') continue;
    for (const d of stmt.declarations) {
      if (
        d.id.type === 'Identifier' &&
        d.id.name === result.versionBinding &&
        d.init &&
        d.init.type === 'StringLiteral' &&
        d.init.value === result.version
      ) {
        versionOk = true;
      }
    }
  }
  if (!versionOk) throw new Error(`产物里找不到 \`${result.versionBinding} = "${result.version}"\` 版本常量`);

  // 门槛 4：默认导出
  if (!hasDefaultExport(outputAst)) throw new Error('产物没有 default 导出，Workers/Pages 无法加载');

  // 门槛 5：噪音惰性
  assertInertNoise(result.noise);

  // 门槛 6：关键词（auto 硬性禁止，manual 期望隐藏）
  const hardLeaks = findKeywordLeaks(result.core, KEYWORDS.auto, { includeModuleSpecifiers: true, includeImportIdentifiers: true });
  if (hardLeaks.length) {
    throw new Error(
      `产物里仍有硬性禁止词以明文出现：${hardLeaks.map((l) => l.word).join(', ')}。` +
        '请检查 tools/keywords.mjs 的覆盖范围（正则/标识符不参与隐藏）或调整 sensitive_words_auto.txt。'
    );
  }
  const expectedLeaks = findKeywordLeaks(result.core, KEYWORDS.manual, { includeModuleSpecifiers: true, includeImportIdentifiers: true });
  if (expectedLeaks.length) {
    console.warn(`⚠️ 期望隐藏词仍可见：${expectedLeaks.map((l) => l.word).join(', ')}`);
  }
  const moduleHits = findKeywordLeaksInModuleSpecifiers(result.core, KEYWORDS.auto);
  const visibility = scanKeywordVisibility(result.core, KEYWORDS.auto);
  const structural = [...visibility.structural]
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  const exactVisible = [...visibility.exact]
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12);
  const exactTotal = [...visibility.exact].reduce((sum, [, count]) => sum + count, 0);

  // 运行时契约探针（两种引擎共用；面板 55 项测试在 check.sh 里跑）
  const probe = await probeRuntime({ code, version: result.version });

  const zip = createZip([{ name: WORKER_ENTRY, data: Buffer.from(code, 'utf8') }]);

  return {
    code,
    zip,
    version: result.version,
    versionBinding: result.versionBinding,
    engine,
    joPreset: null,
    dependency: null,
    seed: result.stats.seed,
    probe,
    keywords: {
      hidden: result.stats.keywordsHidden || 0,
      words: result.stats.keywordHits || [],
      hardLeaks,
      expectedLeaks,
      moduleHits,
      structural,
      exactVisible,
      exactTotal,
      syntaxWords: KEYWORDS.auto.filter((word) => JS_SYNTAX_WORDS.has(word)),
    },
    stats: result.stats,
    hashes: { worker: sha256(code), zip: sha256(zip) },
  };
}

function readExistingWorker(p) {
  if (!fs.existsSync(p)) return null;
  return normalizeEol(fs.readFileSync(p, 'utf8'));
}

function inspectExistingZip(p) {
  if (!fs.existsSync(p)) return { exists: false, entries: [], content: null };
  const entries = readZipEntries(fs.readFileSync(p));
  const entry = entries.find((e) => e.name === WORKER_ENTRY);
  return { exists: true, entries, content: entry ? entry.data.toString('utf8') : null };
}

function describeEntries(entries) {
  return entries.map((e) => `${e.name}（${humanBytes(e.size)}）`).join('、') || '（空）';
}

function writeAtomic(target, data, label) {
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, target);
  return `${path.relative(ROOT, target).replace(/\\/g, '/')}（${label}）`;
}

function printStats(artifacts, seedSource) {
  const s = artifacts.stats;
  const engineLabel =
    artifacts.engine === 'javascript-obfuscator'
      ? `javascript-obfuscator ${artifacts.dependency}（${artifacts.joPreset} 预设）`
      : `builtin（mangle=${s.mangle} escape=${s.escape}）`;
  console.log(`   引擎：${engineLabel}，种子 ${artifacts.seed}（${seedSource}）`);
  console.log(`   内核版本：${artifacts.version}${artifacts.versionBinding ? `（产物常量名 ${artifacts.versionBinding}）` : '（版本名由引擎随机化，运行时探针已核对）'}`);
  if (artifacts.engine === 'builtin') {
    console.log(`   反向映射：${s.mapped} 条；重命名 ${s.renamed} 个绑定；转义 ${s.escapedStrings} 个字符串（跳过 ${s.skippedStrings}）`);
    console.log(`   混淆核 ${humanBytes(s.coreBytes)} + 噪音 ${humanBytes(s.noiseBytes)} = ${humanBytes(s.totalBytes)}`);
  } else {
    const jo = s.joStats || {};
    const tuning = jo.preset === 'auto'
      ? `auto 预设：stringArrayThreshold=${jo.threshold ?? '关闭'}，探测 ${jo.runs} 次（骨架 ${jo.skeletonBytes} 字节）`
      : `${jo.preset} 预设（不做体积控制）`;
    console.log(`   产物 ${humanBytes(s.totalBytes)}；${tuning}`);
    console.log(`   运行时探针：coreVersion ${artifacts.probe.coreVersion}，配置字段 ${artifacts.probe.configKeys} 个，region=${artifacts.probe.region}`);
  }
  console.log(`   _worker.js：sha256 ${artifacts.hashes.worker.slice(0, 16)}…；pages.zip：${humanBytes(artifacts.zip.length)}，sha256 ${artifacts.hashes.zip.slice(0, 16)}…`);
  if (artifacts.keywords) {
    const k = artifacts.keywords;
    const structuralTotal = (k.structural || []).reduce((sum, [, count]) => sum + count, 0);
    console.log(
      `   关键词：隐藏 ${k.hidden} 段（${(k.words || []).length} 个词）；可隐藏位置泄露 ${k.hardLeaks.length}；期望泄露 ${k.expectedLeaks.length}`
    );
    if (k.exactVisible && k.exactVisible.length) {
      const detail = k.exactVisible.map(([word, count]) => `${word}×${count}`).join('、');
      console.log(`   结构内整词可见：约 ${k.exactTotal} 处（${detail} …；标识符/属性名，无法转义，未计入泄露）`);
    }
    if (k.structural && k.structural.length) {
      const detail = k.structural.map(([word, count]) => `${word}×${count}`).join('、');
      console.log(
        `   子串命中：约 ${structuralTotal} 处（${detail} …；可能是更长单词的一部分，如 import 含 port，未计入泄露）`
      );
    }
    console.log('   语法关键字固定保留：import / from / as（JS 语法，不是可隐藏字符串）');
    if (k.moduleHits && k.moduleHits.length) {
      const detail = [...new Set(k.moduleHits.map((h) => `${h.snippet}（含 ${h.word}）`))].join('、');
      console.log(`   结构性例外：${detail} —— 模块说明符必须保持原文（cfnew-panel 测试靠它打桩）`);
    }

  }
  for (const msg of s.missingBindings) console.log(`   ! ${msg}`);
  if (s.unmappedSemantics.length) {
    console.log(`   ! ${s.unmappedSemantics.length} 个语义名在明文里没有对应声明：${s.unmappedSemantics.join(', ')}`);
  }
  if (s.untouched.length) {
    console.log(`   ! names.json 有 ${s.untouched.length} 行没对上 _worker.pretty.js（映射过期？跑 tools/align.mjs）`);
  }
}

/** 解析引擎 + 预设：命令行/环境变量优先，其次种子记录，最后默认 builtin。 */
function resolveEngine({ opts, env, record }) {
  const engine = String(opts.get('engine') ?? env.CFNEW_ENGINE ?? (record && record.engine) ?? 'builtin');
  if (!ENGINES.has(engine)) throw new Error(`--engine 只能是 ${[...ENGINES].join(' / ')}，收到 ${engine}`);
  const joPreset = String(opts.get('jo-preset') ?? env.CFNEW_JO_PRESET ?? (record && record.joPreset) ?? 'auto');
  if (!JO_PRESETS[joPreset]) throw new Error(`--jo-preset 只能是 ${Object.keys(JO_PRESETS).join(' / ')}，收到 ${joPreset}`);
  const explicit = opts.has('engine') || opts.has('jo-preset') || Boolean(env.CFNEW_ENGINE) || Boolean(env.CFNEW_JO_PRESET);
  return { engine, joPreset, explicit };
}

function resolveSeed({ opts, env, record, plainSource, prettySource, names }) {
  const explicit = opts.get('seed') ?? env.CFNEW_SEED;
  if (explicit !== undefined) return { seed: normalizeSeed(explicit, '--seed / CFNEW_SEED'), source: '命令行/环境变量' };
  if (record) {
    return { seed: record.seed, source: path.relative(ROOT, SEED_FILE).replace(/\\/g, '/') };
  }
  return { seed: deriveSeed({ plainSource, prettySource, names }), source: '源码哈希（无 seed 文件）' };
}

function resolveSizeRange({ opts, env, record = null }) {
  const read = (key, fallback) =>
    Number(opts.get(key) ?? env[`CFNEW_${key.toUpperCase().replace(/-/g, '_')}`] ?? fallback);
  const min = read('size-min', record?.sizeMin ?? 32000);
  const max = read('size-max', record?.sizeMax ?? 42000);
  if (!Number.isInteger(min) || !Number.isInteger(max) || min <= 0 || min >= max) {
    throw new Error(`--size-min/--size-max 不合法：${min}..${max}`);
  }
  return { min, max };
}

async function main() {
  const { flags, opts } = parseCliArgs(process.argv.slice(2));
  const check = flags.has('check');
  const dryRun = flags.has('dry-run');
  const envRandomize = ['1', 'true', 'yes'].includes(String(process.env.CFNEW_RANDOMIZE || '').toLowerCase());
  const randomize = flags.has('randomize') || (!check && envRandomize);
  if (check && dryRun) throw new Error('--check 与 --dry-run 不能同时使用');
  if (check && randomize) throw new Error('--check 不能和 --randomize 一起用（校验必须固定种子）');

  const plainPath = process.env.CFNEW_PLAIN || PATHS.plain;
  const prettyPath = process.env.CFNEW_PRETTY || PATHS.pretty;
  const namesPath = process.env.CFNEW_NAMES || PATHS.names;
  const outPath = process.env.CFNEW_OUT || PATHS.out;
  const zipPath = process.env.CFNEW_ZIP || PATHS.zip;

  const plainSource = readText(plainPath);
  const prettySource = readText(prettyPath);
  const names = JSON.parse(readText(namesPath));

  const record = loadSeedRecord(SEED_FILE);
  const { mangle, escape, noiseBytes, targetBytes } = resolveObfuscationOptions({ opts, env: process.env, record });
  const sizeRange = resolveSizeRange({ opts, env: process.env, record });
  const { engine, joPreset } = resolveEngine({ opts, env: process.env, record });

  const writeMode = !check && !dryRun;
  const reuseSeedFlag =
    flags.has('reuse-seed') || ['1', 'true', 'yes'].includes(String(process.env.CFNEW_REUSE_SEED || '').toLowerCase());
  const explicitSeed = opts.get('seed') ?? process.env.CFNEW_SEED;

  if (check && explicitSeed === undefined && !record) {
    throw new Error('缺少 tools/obfuscate.seed.json：先运行 node tools/build-kernel.mjs 构建一次（会写入种子），或用 --seed 指定');
  }

  let seedInfo;
  // 默认行为：写模式每次构建都换新随机种子（两个引擎一致）；
  // --reuse-seed / --seed / --check / --dry-run 才使用固定种子，保证可复现。
  const freshSeed = randomize || (writeMode && !reuseSeedFlag && explicitSeed === undefined);
  if (freshSeed) {
    seedInfo = { seed: randomSeed(), source: randomize ? '--randomize 新种子' : '默认：本次构建新随机种子' };
  } else {
    seedInfo = resolveSeed({ opts, env: process.env, record, plainSource, prettySource, names });
  }

  console.log(
    `混淆工作流：${path.relative(ROOT, plainPath).replace(/\\/g, '/')} → ` +
      `${path.relative(ROOT, outPath).replace(/\\/g, '/')} + ${path.relative(ROOT, zipPath).replace(/\\/g, '/')}`,
  );
  const artifacts = await buildArtifacts({
    plainSource,
    prettySource,
    names,
    seed: seedInfo.seed,
    engine,
    joPreset,
    mangle,
    escape,
    noiseBytes,
    targetBytes,
    sizeRange,
  });
  printStats(artifacts, seedInfo.source);
  if (engine === 'builtin' && artifacts.stats.escape === 'budget') {
    console.log(
      `   格式/体积：单行，${Buffer.byteLength(artifacts.code)} 字节（目标 ${targetBytes}，允许 ${sizeRange.min}..${sizeRange.max}）`,
    );
  }

  const existingWorker = readExistingWorker(outPath);
  const workerOk = existingWorker === artifacts.code;
  let zipOk = false;
  let zipProblem = '';
  try {
    const existingZip = inspectExistingZip(zipPath);
    if (!existingZip.exists) {
      zipProblem = 'pages.zip 不存在';
    } else if (existingZip.entries.length !== 1 || existingZip.entries[0].name !== WORKER_ENTRY) {
      zipProblem = `pages.zip 必须只含一个根目录条目 ${WORKER_ENTRY}，实际是：${describeEntries(existingZip.entries)}`;
    } else if (existingZip.content !== artifacts.code) {
      zipProblem = 'pages.zip 里的 _worker.js 与明文生成的产物不一致';
    } else {
      zipOk = true;
    }
  } catch (error) {
    zipProblem = `pages.zip 无法解析：${error.message}`;
  }

  if (check) {
    let failed = false;
    if (existingWorker === null) {
      console.error(`❌ 缺少 _worker.js：${path.relative(ROOT, outPath)}`);
      failed = true;
    } else if (!workerOk) {
      console.error('❌ _worker.js 与明文 + 种子 + 引擎的产物不一致（手改过、换过配置或忘记重新构建）：');
      console.error(`   ${firstDiff(existingWorker, artifacts.code)}`);
      failed = true;
    }
    if (!zipOk) {
      console.error(`❌ ${zipProblem}`);
      failed = true;
    }
    if (failed) {
      console.error('\n修复：node tools/build-kernel.mjs （然后提交 _worker.js 与 pages.zip）');
      process.exit(1);
    }
    console.log(`✅ 产物可重现：_worker.js 与 pages.zip 和明文 + ${engine} 引擎 + 种子一致（运行时契约探针通过）`);
    return;
  }

  if (dryRun) {
    console.log(`   _worker.js：${workerOk ? '已是最新' : '需要更新'}`);
    console.log(`   pages.zip： ${zipOk ? '已是最新' : `需要更新（${zipProblem || '内容不一致'}）`}`);
    console.log('（--dry-run：未写入任何文件）');
    return;
  }

  const written = [];
  if (!workerOk) {
    written.push(writeAtomic(outPath, artifacts.code, `${humanBytes(Buffer.byteLength(artifacts.code))}，单行`));
  }
  if (!zipOk) {
    written.push(writeAtomic(zipPath, artifacts.zip, `${humanBytes(artifacts.zip.length)}，根目录只有 ${WORKER_ENTRY}`));
  }

  // 写模式把「引擎 + 预设 + 种子」落盘，供 CI 的 --check 复现。
  const nextRecord = {
    seed: seedInfo.seed,
    engine,
    joPreset,
    mangle,
    escape,
    noiseBytes,
    targetBytes,
    sizeMin: sizeRange.min,
    sizeMax: sizeRange.max,
  };
  const sameRecord = record && Object.entries(nextRecord).every(([key, value]) => record[key] === value);
  if (!sameRecord) {
    saveSeedRecord(nextRecord, SEED_FILE);
    console.log(`📝 已更新 ${path.relative(ROOT, SEED_FILE).replace(/\\/g, '/')}：engine=${engine}${engine === 'javascript-obfuscator' ? ` preset=${joPreset}` : ''} seed=${seedInfo.seed}`);
  }

  if (written.length === 0) {
    console.log('✅ 已是最新：_worker.js 与 pages.zip 无需改动');
    if (reuseSeedFlag || explicitSeed !== undefined) {
      console.log('   当前用的是固定种子（--reuse-seed / --seed）。去掉固定种子直接构建，就会每次生成不同产物。');
    }
  } else {
    console.log('✅ 已替换：');
    for (const line of written) console.log(`   ${line}`);
    console.log('   种子已写入记录，--check 可复现本次结果；下次直接构建仍会换新种子。');
    console.log('   下一步：bash check.sh（会额外把面板 55 项测试跑在 _worker.js 上）');
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`❌ ${error.message}`);
    process.exit(1);
  });
}
