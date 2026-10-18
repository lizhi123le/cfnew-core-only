/**
 * 可选引擎：javascript-obfuscator（BSD-2-Clause）。
 *
 * 为什么是「可选」而不是默认：
 *   - 它会把字符串搬进数组/解码函数或重写控制流，无法再用 AST alpha 等价做静态证明，
 *     只能靠运行时探针 + cfnew-panel 55 项测试来证明行为一致；
 *   - 默认预设 `auto` 会做体积预算：JO 输出先还原属性语法（obj['x'] → obj.x），
 *     再按 --target-size 搜索 stringArrayThreshold，保证落在 32–42 KB 且单行。
 *
 * 参数优先级（后者覆盖前者）：
 *   JO_BASE_OPTIONS → 预设 → tools/obfuscator.config.json → 调用方 overrides
 *
 * 安全边界：
 *   - renameProperties 必须是 false：面板的配置字段名是 JSON 属性名，改名会直接破坏接口；
 *   - 不建议开启 selfDefending / debugProtection / controlFlowFlattening。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import _generate from '@babel/generator';
import { mulberry32, renameScoped, scopeBindings } from './obfuscate.mjs';

const traverse = _traverse.default || _traverse;
const generate = _generate.default || _generate;

const TOOLS = import.meta.dirname;

export const JO_PACKAGE = 'javascript-obfuscator';
export const JO_CONFIG_PATH = path.join(TOOLS, 'obfuscator.config.json');

/** 与官方混淆器参数一一对应；这里只是本仓库的基线值。 */
export const JO_BASE_OPTIONS = {
  compact: true,
  simplify: true,
  target: 'node',
  seed: 0,
  identifierNamesGenerator: 'mangled',
  renameGlobals: true,
  renameProperties: false,
  selfDefending: false,
  debugProtection: false,
  disableConsoleOutput: false,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  stringArray: false,
  stringArrayThreshold: 1,
  stringArrayEncoding: ['base64'],
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 0,
  stringArrayWrappersType: 'variable',
  splitStrings: false,
  unicodeEscapeSequence: false,
};

/**
 * auto：体积预算模式（默认）——JO 改名 + 属性语法还原 + 按 target-size 搜索字符串数组强度；
 * light：纯 JO 的 unicode 转义（体积约 80 KB，不做体积控制）；
 * balanced：纯 JO 的字符串数组 + base64（体积约 50 KB，不做体积控制）。
 */
export const JO_PRESETS = {
  auto: {},
  light: {
    stringArray: false,
    unicodeEscapeSequence: true,
    deadCodeInjection: false,
  },
  balanced: {
    stringArray: true,
    stringArrayThreshold: 1,
    stringArrayEncoding: ['base64'],
    stringArrayWrappersCount: 0,
    splitStrings: false,
    unicodeEscapeSequence: false,
    deadCodeInjection: false,
  },
};

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function validateJoOptions(options) {
  if (options.renameProperties) {
    throw new Error('javascript-obfuscator: renameProperties 必须是 false —— 面板配置字段名是 JSON 属性名，改名会破坏接口');
  }
  if (options.selfDefending || options.debugProtection) {
    throw new Error('javascript-obfuscator: 不建议开启 selfDefending/debugProtection —— 依赖 Function 构造与调试器检测，Workers 运行时不可靠');
  }
  if (options.controlFlowFlattening) {
    throw new Error('javascript-obfuscator: controlFlowFlattening 会显著增加每请求 CPU，与 Cloudflare 免费额度冲突，已禁用');
  }
  if (!Array.isArray(options.stringArrayEncoding)) {
    throw new Error('javascript-obfuscator: stringArrayEncoding 必须是数组，例如 ["base64"]');
  }
  return options;
}

export function loadJavaScriptObfuscator() {
  const require = createRequire(import.meta.url);
  try {
    const mod = require(JO_PACKAGE);
    return mod.default || mod;
  } catch (error) {
    throw new Error(
      `缺少可选依赖 ${JO_PACKAGE}：在 tools/ 里运行 npm install（CI 用 npm ci）。原始错误：${error.message}`,
    );
  }
}

export function loadJoConfig(configPath = process.env.CFNEW_JO_CONFIG || JO_CONFIG_PATH) {
  if (!fs.existsSync(configPath)) return {};
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${configPath} 必须是 JSON 对象`);
  return raw;
}

export function joDependencyVersion() {
  const require = createRequire(import.meta.url);
  try {
    return require(`${JO_PACKAGE}/package.json`).version;
  } catch {
    return 'unknown';
  }
}

/**
 * light 预设会开启 unicodeEscapeSequence，连 `import ... from "cloudflare:sockets"`
 * 的模块说明符也会被转义。cfnew-panel 测试靠这条 import 打桩，所以这里复原成原文。
 * 只改书写形式，字符串值不变。
 */
export function restoreModuleSpecifiers(code) {
  const ast = parse(code, { sourceType: 'module' });
  const edits = [];
  for (const stmt of ast.program.body) {
    if ((stmt.type === 'ImportDeclaration' || stmt.type === 'ExportAllDeclaration' || stmt.type === 'ExportNamedDeclaration') && stmt.source) {
      edits.push({ start: stmt.source.start, end: stmt.source.end, text: JSON.stringify(stmt.source.value) });
    }
  }
  edits.sort((a, b) => b.start - a.start);
  let out = code;
  for (const edit of edits) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return out;
}

/**
 * JO 在 `renameProperties:false` 时会把 `obj.prop` 写成 `obj['prop']`、
 * 对象键写成 `{'prop': v}`。这里在 AST 层还原成点号/标识符键（语义完全相同），
 * 再用压缩生成器重排 —— 体积能小 5 KB 左右，且顺带把被转义的模块说明符恢复成原文。
 */
export function normalizeJoOutput(code) {
  const ast = parse(code, { sourceType: 'module' });
  traverse(ast, {
    ObjectProperty(p) {
      const node = p.node;
      if (node.computed || node.key.type !== 'StringLiteral') return;
      if (!IDENT.test(node.key.value)) return;
      node.key = { type: 'Identifier', name: node.key.value };
      node.computed = false;
    },
    'MemberExpression|OptionalMemberExpression'(p) {
      const node = p.node;
      if (!node.computed || !node.property || node.property.type !== 'StringLiteral') return;
      if (!IDENT.test(node.property.value)) return;
      if (node.object.type === 'NumericLiteral' || node.object.type === 'BigIntLiteral') return;
      node.computed = false;
      node.property = { type: 'Identifier', name: node.property.value };
    },
  });
  return generate(ast, { comments: false, compact: true, minified: true, jsescOption: { minimal: true } }).code;
}

/**
 * JO 的 `mangled` 命名不是按引用频率优化的，产物会比内置引擎大约 2.5 KB。
 * 这一步在 AST 上复用本仓库的「按作用域链 + 引用频率」重命名，把体积拉回 37.8 KB 量级；
 * JO 的结构性混淆（simplify / stringArray 等）保持不变。
 */
export function optimizeNames(code, seed) {
  const ast = parse(code, { sourceType: 'module' });
  const rng = mulberry32((Number(seed) >>> 0) ^ 0x9e3779b9);
  const bindings = scopeBindings(ast).filter((binding) => binding.identifier);
  renameScoped({ ast, bindings, rng });
  return generate(ast, { comments: false, compact: true, minified: true, jsescOption: { minimal: true } }).code;
}

function runJo({ source, options }) {
  const obfuscator = loadJavaScriptObfuscator();
  // javascript-obfuscator 5.x 会打印一条 Pro 广告，构建日志里不需要它
  const originalLog = console.log;
  const isAd = (args) => args.some((arg) => typeof arg === 'string' && (arg.includes('obfuscator.io') || arg.includes('Virtual Machine obfuscation')));
  console.log = (...args) => {
    if (isAd(args)) return;
    originalLog.apply(console, args);
  };
  try {
    return obfuscator.obfuscate(source, options).getObfuscatedCode();
  } finally {
    console.log = originalLog;
  }
}

/**
 * 用 javascript-obfuscator 混淆整份明文。
 *
 * @param {object} options
 * @param {string} options.source
 * @param {number} options.seed
 * @param {'auto'|'light'|'balanced'} [options.preset]
 * @param {number} [options.targetBytes]
 * @param {{min:number,max:number}} [options.sizeRange]
 * @param {object} [options.overrides]
 * @returns {{ code: string, options: object, version: string, stats: object }}
 */
export function obfuscateWithJavaScriptObfuscator({
  source,
  seed,
  preset = 'auto',
  targetBytes = 39500,
  sizeRange = { min: 32000, max: 42000 },
  overrides = {},
  configPath,
}) {
  const presetOptions = JO_PRESETS[preset];
  if (!presetOptions) throw new Error(`未知预设 ${preset}（可选 ${Object.keys(JO_PRESETS).join(' / ')}）`);
  const config = loadJoConfig(configPath);
  const baseOptions = validateJoOptions({
    ...JO_BASE_OPTIONS,
    ...presetOptions,
    ...config,
    ...overrides,
    seed: Number(seed) >>> 0,
  });

  const dependency = joDependencyVersion();

  if (preset !== 'auto') {
    const raw = runJo({ source, options: baseOptions });
    // balanced 的字符串数组经过 AST 重排仍保留编码值，体积更小；light 的 unicode 转义必须保留
    const code = preset === 'balanced' ? normalizeJoOutput(raw) : restoreModuleSpecifiers(raw);
    return {
      code,
      options: baseOptions,
      version: dependency,
      stats: { preset, bytes: Buffer.byteLength(code), threshold: null, runs: 1 },
    };
  }

  // auto：JO 混淆 → 属性语法还原 → 按引用频率重命名 → 逐步加 stringArray 强度填到目标
  const buildCandidate = (options) => optimizeNames(normalizeJoOutput(runJo({ source, options })), seed);
  const skeleton = buildCandidate(baseOptions);
  let best = { code: skeleton, threshold: null, bytes: Buffer.byteLength(skeleton), runs: 1 };
  if (best.bytes > sizeRange.max) {
    throw new Error(
      `javascript-obfuscator 最小产物 ${best.bytes} 字节已超过 ${sizeRange.max}（37±5 KB）。` +
        '可换回 builtin 引擎，或放宽 --size-max。',
    );
  }

  if (best.bytes < targetBytes) {
    for (const threshold of [0.01, 0.02, 0.03, 0.05, 0.08, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.7, 1]) {
      const candidateOptions = validateJoOptions({
        ...baseOptions,
        stringArray: true,
        stringArrayThreshold: threshold,
        stringArrayEncoding: ['base64'],
        stringArrayWrappersCount: 0,
      });
      const code = buildCandidate(candidateOptions);
      const bytes = Buffer.byteLength(code);
      best.runs += 1;
      if (bytes > targetBytes) break; // 阈值越大体积越大，超过目标就停
      best = { code, threshold, bytes, runs: best.runs };
    }
  }

  const finalBytes = Buffer.byteLength(best.code);
  if (finalBytes < sizeRange.min || finalBytes > sizeRange.max) {
    throw new Error(`javascript-obfuscator 产物 ${finalBytes} 字节不在 ${sizeRange.min}..${sizeRange.max} 内`);
  }

  return {
    code: best.code,
    options: baseOptions,
    version: dependency,
    stats: { preset: 'auto', bytes: finalBytes, threshold: best.threshold, runs: best.runs, skeletonBytes: Buffer.byteLength(skeleton) },
  };
}
