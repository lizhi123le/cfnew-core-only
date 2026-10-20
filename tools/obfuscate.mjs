/**
 * 把可读明文重新压缩成发布产物：`deobfuscate.mjs` 的逆过程，并在此之上加入可重现的混淆随机性。
 *
 * 输入：plain/_worker.js（明文）
 * 参数：tools/names.json（`_worker.pretty.js` 行号 → 语义名）
 *       + _worker.pretty.js（同一行 → 上游短名）
 *       —— 两者按行号配对，得到「语义名 → 上游短名」的反向表。
 * 输出：_worker.js（无注释、单行、随机短名、随机转义字符串、可选的噪音声明）
 *
 * 三种混淆手段（都保持运行时语义不变）：
 *   1. 标识符替换：用种子 PRNG 生成全新的短名（默认替换全部绑定，或只替换解码参数覆盖的声明）。
 *      新名字不与源码里任何既有标识符/保留字重名，所以不可能发生遮蔽或捕获。
 *   2. 字符串转义：把字符串字面量改写成随机混合的 `\xHH` / `\uHHHH` 形式 ——
 *      **运行时值完全不变**，但 `"/api/config"`、字段名等不再以明文出现在文件里。
 *      跳过 import/export 的模块说明符（`cloudflare:sockets` 必须保持原样，面板测试靠它打桩）
 *      和指令序言（`"use strict"` 一类，转义会改变其语义）。
 *   3. 噪音声明：在文件末尾追加若干从未被引用的随机函数声明与随机注释（默认约 4 KiB）。
 *      只有顶层函数声明，加载时不会执行；V8 也只会惰性编译真正被调用的函数。
 *
 * 随机性可重现：随机数来自种子（默认读 tools/obfuscate.seed.json，其次由源码哈希派生）。
 * 同一份明文 + 同一个种子 → 逐字节相同的产物，所以 CI 的 `--check` 依然成立；
 * `node tools/build-kernel.mjs --randomize` 换一个种子即可让产物整体变样。
 *
 * 安全性（与 deobfuscate 对称的保险）：
 *   1. 用 babel 作用域分析改名，不做文本替换，不会碰属性名/JSON 字段名/字符串值；
 *   2. 改名前记录每个引用的绑定，改名后逐个重新解析并比对
 *      —— 任何「引用被新名字捕获 / 被内层同名遮蔽」都会直接报错拒绝输出；
 *   3. `build-kernel.mjs` 对「混淆核」做 AST alpha 等价校验，并对最终产物跑面板测试。
 *
 * 用法：
 *   node tools/obfuscate.mjs                    # plain/_worker.js → _worker.js
 *   node tools/obfuscate.mjs --seed 12345       # 指定随机种子
 *   node tools/obfuscate.mjs --mangle=all|mapped|upstream
 *   node tools/obfuscate.mjs --escape=all|partial|none
 *   node tools/obfuscate.mjs --noise=4096       # 噪音字节数，0 表示不加
 *   node tools/obfuscate.mjs --core             # 只输出混淆核（不含噪音，便于 verify-alpha）
 *   node tools/obfuscate.mjs --stdout           # 打印到 stdout（调试）
 *   node tools/obfuscate.mjs --keep-comments    # 保留注释（调试）
 *   node tools/obfuscate.mjs --one-line=false   # 多行输出（默认单行）
 *
 * 单行格式与体积预算可写在仓库根目录 harden.config.json（CLI > 环境变量 > 配置文件 > 默认值）。
 * 环境变量：CFNEW_PLAIN / CFNEW_PRETTY / CFNEW_NAMES / CFNEW_OUT /
 *           CFNEW_SEED / CFNEW_MANGLE / CFNEW_ESCAPE / CFNEW_NOISE / CFNEW_ONE_LINE
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parse } from '@babel/parser';
import { hideKeywordsInCode, loadKeywordLists } from './keywords.mjs';
import { loadHardenParams } from './harden-config.mjs';
import _traverse from '@babel/traverse';
import _generate from '@babel/generator';

const traverse = _traverse.default || _traverse;
const generate = _generate.default || _generate;

const TOOLS = import.meta.dirname;
const ROOT = path.resolve(TOOLS, '..');

export const DEFAULT_PATHS = {
  plain: path.join(ROOT, 'plain/_worker.js'),
  pretty: path.join(ROOT, '_worker.pretty.js'),
  names: path.join(TOOLS, 'names.json'),
  out: path.join(ROOT, '_worker.js'),
};

export const SEED_PATH = path.join(TOOLS, 'obfuscate.seed.json');

// 关键词词表（auto=硬性禁止，manual=期望隐藏），缺失时为空表。
const KEYWORDS = loadKeywordLists();

export const DEFAULTS = {
  mangle: 'all', // all：全部绑定随机短名；mapped：只换解码参数覆盖的声明；upstream：还原上游短名（不随机）
  escape: 'budget', // budget：按 --target-size 预算转义；all：全部转义；partial：一半左右；none：不转义
  noiseBytes: 4096, // 噪音上限（budget 模式下受体积预算限制）
  targetBytes: 39500, // budget 模式的目标产物体积（内容字节数，不含末尾换行）
  oneLine: true, // 产物是否压成一行（harden.config.json / CFNEW_ONE_LINE / --one-line=false）
};

const MANGLE_MODES = new Set(['all', 'mapped', 'upstream']);
const ESCAPE_MODES = new Set(['budget', 'all', 'partial', 'none']);

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ$_';

// 模块（严格模式）里不能做绑定名的词。`eval` / `arguments` 在严格模式下同样禁止。
const RESERVED = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else',
  'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof',
  'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void',
  'while', 'with', 'yield', 'let', 'static', 'await', 'implements', 'interface', 'package', 'private',
  'protected', 'public', 'eval', 'arguments', 'undefined', 'NaN', 'Infinity',
]);

const parseModule = (code) => parse(code, { sourceType: 'module' });

// ── 随机源 ────────────────────────────────────────────────────────────────

/** mulberry32：32 位种子、速度快、跨平台结果一致（只用整数运算）。 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function normalizeSeed(value, label = '种子') {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
    throw new Error(`${label}必须是 0..4294967295 的整数，收到 ${JSON.stringify(value)}`);
  }
  return n >>> 0;
}

/** 由「明文 + 行号基准 + 命名映射」派生确定性种子（找不到 seed 文件时使用）。 */
export function deriveSeed({ plainSource = '', prettySource = '', names = {} }) {
  const hash = crypto.createHash('sha256');
  hash.update(plainSource);
  hash.update('\0');
  hash.update(prettySource);
  hash.update('\0');
  hash.update(JSON.stringify(names));
  return hash.digest().readUInt32LE(0);
}

export function loadSeedFile(seedPath = SEED_PATH) {
  const record = loadSeedRecord(seedPath);
  return record ? record.seed : null;
}

/**
 * 种子文件（tools/obfuscate.seed.json）除了 seed 还记录「用哪个引擎/预设」，
 * 这样 CI 的 --check 不必依赖命令行就能逐字节复现产物。
 * 旧格式只有 { "seed": N }，等同于 engine=builtin。
 */
export function loadSeedRecord(seedPath = SEED_PATH) {
  if (!fs.existsSync(seedPath)) return null;
  const raw = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  const record = {
    seed: normalizeSeed(raw.seed, `${seedPath} 里的 seed`),
    engine: typeof raw.engine === 'string' && raw.engine ? raw.engine : 'builtin',
    joPreset: typeof raw.joPreset === 'string' && raw.joPreset ? raw.joPreset : 'auto',
  };
  // 把混淆参数也带上，--check 才能复现自定义配置（旧文件只有 seed，等价于全部默认）
  for (const key of ['mangle', 'escape']) {
    if (typeof raw[key] === 'string' && raw[key]) record[key] = raw[key];
  }
  for (const key of ['noiseBytes', 'targetBytes', 'sizeMin', 'sizeMax']) {
    if (Number.isInteger(raw[key])) record[key] = raw[key];
  }
  if (typeof raw.oneLine === 'boolean') record.oneLine = raw.oneLine;
  return record;
}

export function saveSeedRecord({ seed, engine = 'builtin', joPreset = 'auto', ...rest }, seedPath = SEED_PATH) {
  const clean = { seed: normalizeSeed(seed), engine };
  if (engine === 'javascript-obfuscator') clean.joPreset = joPreset;
  for (const key of ['mangle', 'escape']) {
    if (typeof rest[key] === 'string' && rest[key]) clean[key] = rest[key];
  }
  for (const key of ['noiseBytes', 'targetBytes', 'sizeMin', 'sizeMax']) {
    if (Number.isInteger(rest[key])) clean[key] = rest[key];
  }
  if (typeof rest.oneLine === 'boolean') clean.oneLine = rest.oneLine;
  fs.writeFileSync(seedPath, JSON.stringify(clean, null, 2) + '\n');
  return clean;
}

export function saveSeedFile(seed, seedPath = SEED_PATH) {
  return saveSeedRecord({ seed }, seedPath).seed;
}

/** 生成一个 32 位随机种子（用于 `--randomize`）。 */
export function randomSeed() {
  return crypto.randomInt(0, 0x100000000) >>> 0;
}

export function parseCliArgs(argv) {
  const flags = new Set();
  const opts = new Map();
  const takesValue = new Set([
  'seed',
  'mangle',
  'escape',
  'noise',
  'target-size',
  'size-min',
  'size-max',
  'target-bytes',
  'target-zip',
  'max-runs',
  'config',
]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq > 0) {
      opts.set(body.slice(0, eq), body.slice(eq + 1));
    } else if (takesValue.has(body)) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`--${body} 需要参数`);
      opts.set(body, value);
    } else {
      flags.add(body);
    }
  }
  return { flags, opts };
}

function readOption(opts, env, key, fallback) {
  const envName = `CFNEW_${key.toUpperCase().replace(/-/g, '_')}`;
  return opts.get(key) ?? env[envName] ?? fallback;
}

/** 解析 mangle / escape / noise / 体积预算（CLI 参数优先，其次环境变量，最后 seed 记录）。 */
export function resolveObfuscationOptions({ opts = new Map(), env = process.env, record = null } = {}) {
  const fallback = (key, hard) => record?.[key] ?? hard;
  const mangle = String(readOption(opts, env, 'mangle', fallback('mangle', DEFAULTS.mangle)));
  const escape = String(readOption(opts, env, 'escape', fallback('escape', DEFAULTS.escape)));
  const noiseRaw = readOption(opts, env, 'noise', fallback('noiseBytes', DEFAULTS.noiseBytes));
  const targetRaw = readOption(opts, env, 'target-size', fallback('targetBytes', DEFAULTS.targetBytes));
  const noiseBytes = Number(noiseRaw);
  const targetBytes = Number(targetRaw);
  if (!MANGLE_MODES.has(mangle)) throw new Error(`--mangle 只能是 ${[...MANGLE_MODES].join(' / ')}，收到 ${mangle}`);
  if (!ESCAPE_MODES.has(escape)) throw new Error(`--escape 只能是 ${[...ESCAPE_MODES].join(' / ')}，收到 ${escape}`);
  if (!Number.isInteger(noiseBytes) || noiseBytes < 0) throw new Error(`--noise 必须是非负整数，收到 ${JSON.stringify(noiseRaw)}`);
  if (!Number.isInteger(targetBytes) || targetBytes < 20000 || targetBytes > 200000) {
    throw new Error(`--target-size 必须是 20000..200000 的整数，收到 ${JSON.stringify(targetRaw)}`);
  }
  return { mangle, escape, noiseBytes, targetBytes };
}

// ── 反向映射（与 deobfuscate 对称）─────────────────────────────────────────

function declarationName(p) {
  const node = p.node;
  if (p.isFunctionDeclaration()) return node.id ? node.id.name : null;
  if (p.isImportSpecifier()) return node.local ? node.local.name : null;
  if (node.id && node.id.type === 'Identifier') return node.id.name;
  return null;
}

function declarationScope(p) {
  return p.isFunctionDeclaration() ? p.scope.parent : p.scope;
}

/**
 * 用「行号」把 names.json（行号 → 语义名）和 _worker.pretty.js（行号 → 上游短名）
 * 配对成「语义名 → 上游短名」的反向表。
 */
export function buildReverseMap({ prettySource, names }) {
  if (!names || typeof names !== 'object' || Array.isArray(names)) throw new Error('names.json 必须是对象');
  const ast = parseModule(prettySource);
  const reverse = new Map();
  const hitLines = new Set();
  const conflicts = [];

  traverse(ast, {
    'FunctionDeclaration|VariableDeclarator|ImportSpecifier'(p) {
      const line = p.node.loc.start.line;
      if (!(line in names)) return;
      hitLines.add(line);
      const semantic = names[line];
      if (typeof semantic !== 'string' || !semantic) {
        conflicts.push(`L${line} 的语义名不是非空字符串：${JSON.stringify(semantic)}`);
        return;
      }
      const orig = declarationName(p);
      if (!orig) {
        conflicts.push(`L${line} 找不到声明名（${p.node.type}），无法建立 ${semantic} 的反向映射`);
        return;
      }
      const prev = reverse.get(semantic);
      if (prev && prev.orig !== orig) {
        conflicts.push(`语义名 ${semantic} 同时指向两个短名：L${prev.line}=${prev.orig} / L${line}=${orig}`);
        return;
      }
      reverse.set(semantic, { orig, line, kind: p.node.type });
    },
  });

  const untouched = Object.keys(names)
    .map(Number)
    .filter((line) => !hitLines.has(line))
    .sort((a, b) => a - b)
    .map((line) => ({ line, semantic: names[line] }));

  return { reverse, untouched, conflicts };
}

function readVersion(ast, versionName) {
  for (const stmt of ast.program.body) {
    if (stmt.type !== 'VariableDeclaration') continue;
    for (const d of stmt.declarations) {
      if (d.id.type === 'Identifier' && d.id.name === versionName && d.init && d.init.type === 'StringLiteral') {
        return d.init.value;
      }
    }
  }
  return null;
}

// ── 改名 ──────────────────────────────────────────────────────────────────

/** 源码里出现过的所有标识符（绑定、引用、属性名、标签），新名字一律避开。 */
function collectIdentifierNames(ast) {
  const taken = new Set();
  traverse(ast, {
    Identifier(p) {
      taken.add(p.node.name);
    },
  });
  return taken;
}

function makeName(rng, taken) {
  for (let attempt = 0; attempt < 10000; attempt++) {
    const roll = rng();
    const length = roll < 0.7 ? 1 : roll < 0.93 ? 2 : 3;
    let name = '';
    for (let i = 0; i < length; i++) name += ALPHABET[Math.floor(rng() * ALPHABET.length)];
    if (RESERVED.has(name) || taken.has(name)) continue;
    taken.add(name);
    return name;
  }
  throw new Error('生成随机短名失败：候选空间耗尽');
}

export function scopeBindings(ast) {
  const seen = new Set();
  const bindings = [];
  traverse(ast, {
    Scope(p) {
      for (const binding of Object.values(p.scope.bindings)) {
        if (seen.has(binding)) continue;
        seen.add(binding);
        bindings.push(binding);
      }
    },
  });
  return bindings;
}

function scopeDepth(scope) {
  let depth = 0;
  let s = scope;
  while (s.parent) {
    depth += 1;
    s = s.parent;
  }
  return depth;
}

/** 没有被任何绑定声明捕获的标识符（全局/内建），新名字不能与它们重名，否则会捕获全局引用。 */
function collectFreeNames(ast) {
  const free = new Set();
  traverse(ast, {
    Identifier(p) {
      if (!p.isReferencedIdentifier()) return;
      if (!p.scope.getBinding(p.node.name)) free.add(p.node.name);
    },
  });
  return free;
}

/** 作用域链内唯一的随机短名：优先 1 字符（引用越多越早分配，长度越短），字符随机。 */
function makeScopedName(rng, used) {
  for (const length of [1, 2, 3]) {
    for (let attempt = 0; attempt < 512; attempt++) {
      let name = '';
      for (let i = 0; i < length; i++) name += ALPHABET[Math.floor(rng() * ALPHABET.length)];
      if (RESERVED.has(name) || used.has(name)) continue;
      return name;
    }
  }
  throw new Error('生成随机短名失败：候选空间耗尽');
}

/**
 * 两阶段改名，兼顾「随机短名」与「体积」：
 *   ① 先全部改成全局唯一的临时名，彻底消除旧名/遮蔽干扰；
 *   ② 再按作用域链分配最终名字 —— 只要求同一作用域链唯一，兄弟作用域可以复用，
 *      所以 1 字符名不会被同类作用域耗尽（平均名长回到上游水平，产物体积接近原始压缩版）。
 */
export function renameScoped({ ast, bindings, rng, blockedNames = new Set() }) {
  if (!bindings.length) return 0;
  const known = collectIdentifierNames(ast);
  const freeNames = collectFreeNames(ast);
  let counter = 0;
  const temps = [];

  for (const binding of bindings) {
    let tmp;
    do {
      tmp = `_$cfn${counter++}`;
    } while (known.has(tmp) || RESERVED.has(tmp));
    known.add(tmp);
    binding.scope.rename(binding.identifier.name, tmp);
    temps.push({ binding, tmp });
  }

  const assigned = new Map();
  const childScopes = new Map();
  const scopeSet = new Set();
  for (const { binding } of temps) {
    let s = binding.scope;
    while (s) {
      scopeSet.add(s);
      s = s.parent;
    }
  }
  for (const s of scopeSet) {
    if (!s.parent) continue;
    if (!childScopes.has(s.parent)) childScopes.set(s.parent, []);
    childScopes.get(s.parent).push(s);
  }

  // 按「全局引用次数」从多到少分配：让最热的绑定优先拿 1 字符名。
  // 可见性约束只覆盖祖先链与子树，兄弟作用域可以复用同一个名字（与上游压缩器一致）。
  temps.sort(
    (a, b) => (b.binding.references || 0) + b.binding.constantViolations.length -
      ((a.binding.references || 0) + a.binding.constantViolations.length),
  );
  for (const { binding, tmp } of temps) {
    const used = new Set(freeNames);
    for (const name of blockedNames) used.add(name);
    for (let s = binding.scope; s; s = s.parent) {
      const set = assigned.get(s);
      if (set) for (const name of set) used.add(name);
    }
    const stack = [binding.scope];
    while (stack.length) {
      const scope = stack.pop();
      for (const child of childScopes.get(scope) || []) {
        const set = assigned.get(child);
        if (set) for (const name of set) used.add(name);
        stack.push(child);
      }
    }
    const target = makeScopedName(rng, used);
    binding.scope.rename(tmp, target);
    if (!assigned.has(binding.scope)) assigned.set(binding.scope, new Set());
    assigned.get(binding.scope).add(target);
  }
  return temps.length;
}

/** 记录每个「被引用标识符」当前解析到的绑定，用于改名后复核。 */
function snapshotReferences(ast) {
  const snapshot = new Map();
  traverse(ast, {
    Identifier(p) {
      if (!p.isReferencedIdentifier()) return;
      snapshot.set(p.node, p.scope.getBinding(p.node.name) || null);
    },
  });
  return snapshot;
}

function findCapturedReferences(ast, snapshot) {
  const captured = [];
  traverse(ast, {
    Identifier(p) {
      if (!p.isReferencedIdentifier()) return;
      if (!snapshot.has(p.node)) return;
      const before = snapshot.get(p.node);
      const now = p.scope.getBinding(p.node.name) || null;
      if (now !== before) {
        captured.push(
          `L${p.node.loc ? p.node.loc.start.line : '?'} ${p.node.name}：改名后引用被 ${
            now ? `另一个绑定（${now.identifier.name}）` : '解析为全局变量'
          }捕获`,
        );
      }
    },
  });
  return captured;
}

// ── 字符串转义（值不变）────────────────────────────────────────────────────

function isDirective(p) {
  return p.parentPath && p.parentPath.isExpressionStatement() && p.parentPath.node.directive !== undefined;
}

function isModuleSpecifier(p) {
  const parent = p.parentPath;
  if (!parent) return false;
  if (parent.isImportDeclaration() || parent.isExportAllDeclaration()) return true;
  if (parent.isExportNamedDeclaration() && p.key === 'source') return true;
  if (parent.isImportExpression && parent.isImportExpression()) return true;
  if (parent.isCallExpression() && parent.node.callee && parent.node.callee.type === 'Import') return true;
  return false;
}

/** 把一个字符串值编码成随机混合 `\xHH` / `\uHHHH` 的字面量（解码后与 value 完全相同）。 */
function encodeStringLiteral(value, rng) {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x22) {
      out += '\\"';
    } else if (code === 0x5c) {
      out += '\\\\';
    } else if (code < 0x20 || code > 0x7e) {
      const useHex = code <= 0xff && rng() < 0.5;
      out += useHex
        ? '\\x' + code.toString(16).padStart(2, '0')
        : '\\u' + code.toString(16).padStart(4, '0');
    } else {
      out += rng() < 0.55 ? '\\x' + code.toString(16).padStart(2, '0') : '\\u' + code.toString(16).padStart(4, '0');
    }
  }
  return out + '"';
}

/** 面板接口里最值得隐藏的字符串：路由 + 配置字段/KV 键。 */
const CONTRACT_STRINGS = new Set(
  (
    'freeCpu wk ev et ex ech tp customDNS customECHDomain alpn d p yx yxURL s homepage scu ena epd epi ' +
    'egi ae rm qj dkby yxby ipv4 ipv6 ispMobile ispUnicom ispTelecom jk c c_ver hello coreVersion kvEnabled uuid ' +
    'api/config api/preferred-ips region test-api'
  ).split(' '),
);

const isSensitiveString = (value) => value.startsWith('/') || CONTRACT_STRINGS.has(value);

function shuffleInPlace(items, rng) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
}

/**
 * @param {object} [budget] budget 模式：{ targetBytes, noiseCap }
 * @returns {{code: string, escaped: number, skipped: number, noiseBudget: number}}
 */
function escapeStringLiterals(core, rng, escapeMode, budget = {}) {
  if (escapeMode === 'none') return { code: core, escaped: 0, skipped: 0, noiseBudget: budget.noiseCap ?? 0 };
  const ast = parseModule(core);
  const candidates = [];
  let skipped = 0;

  traverse(ast, {
    StringLiteral(p) {
      const node = p.node;
      if (!node.value || isDirective(p) || isModuleSpecifier(p)) {
        skipped += 1;
        return;
      }
      if (escapeMode === 'partial' && rng() > 0.5) {
        skipped += 1;
        return;
      }
      const text = encodeStringLiteral(node.value, rng);
      candidates.push({
        start: node.start,
        end: node.end,
        text,
        delta: Buffer.byteLength(text) - (node.end - node.start),
        sensitive: isSensitiveString(node.value),
        route: node.value.startsWith('/'),
      });
    },
  });

  let edits = [];
  let noiseBudget = budget.noiseCap ?? 0;

  if (escapeMode === 'budget') {
    const headroom = Math.max(0, (budget.targetBytes ?? 0) - Buffer.byteLength(core));
    const routes = candidates.filter((c) => c.route);
    const fields = candidates.filter((c) => c.sensitive && !c.route);
    const others = candidates.filter((c) => !c.sensitive);
    shuffleInPlace(routes, rng);
    shuffleInPlace(fields, rng);
    shuffleInPlace(others, rng);

    let used = 0;
    // ① 路由优先，其次配置字段：这两个直接对应面板接口
    for (const item of [...routes, ...fields]) {
      if (used + item.delta > headroom) continue;
      edits.push(item);
      used += item.delta;
    }
    // ② 剩余预算一半给随机字符串、一半给噪音（噪音上限可调）
    const remaining = headroom - used;
    noiseBudget = Math.min(budget.noiseCap ?? 0, Math.floor(remaining / 2));
    const othersBudget = remaining - noiseBudget - (noiseBudget > 0 ? 1 : 0);
    for (const item of others) {
      if (used + item.delta > headroom - noiseBudget - (noiseBudget > 0 ? 1 : 0)) continue;
      if (item.delta > othersBudget) continue;
      edits.push(item);
      used += item.delta;
    }
    noiseBudget = Math.min(budget.noiseCap ?? 0, Math.max(0, headroom - used - 1));
  } else {
    edits = candidates;
  }

  edits.sort((a, b) => b.start - a.start);
  let out = core;
  for (const edit of edits) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return { code: out, escaped: edits.length, skipped, noiseBudget };
}

// ── 噪音声明 ──────────────────────────────────────────────────────────────

const randomInt = (rng, min, max) => min + Math.floor(rng() * (max - min + 1));

function randomWord(rng, minLength, maxLength) {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  let word = '';
  const length = randomInt(rng, minLength, maxLength);
  for (let i = 0; i < length; i++) word += letters[Math.floor(rng() * letters.length)];
  return word;
}

/**
 * 生成惰性噪音：只包含顶层函数声明与随机注释。单行模式下拼成一行，多行模式按声明换行。
 * 这些函数从未被引用，加载时不会执行；函数体里的代码也就永远不会被求值。
 */
function buildNoise({ rng, maxBytes, taken, oneLine = true }) {
  if (maxBytes <= 0) return '';
  const parts = [];
  let total = 0;

  const hexComment = Array.from({ length: 32 }, () => '0123456789abcdef'[Math.floor(rng() * 16)]).join('');
  const comment = `/*${hexComment}*/`;
  if (comment.length <= maxBytes) {
    parts.push(comment);
    total += comment.length;
  }

  let written = 0;
  while (written < 400) {
    const fn = makeName(rng, taken);
    const inner = makeName(rng, taken);
    const arg1 = makeName(rng, taken);
    const arg2 = makeName(rng, taken);
    const v1 = makeName(rng, taken);
    const v2 = makeName(rng, taken);
    const i = makeName(rng, taken);
    const p = makeName(rng, taken);
    const word = randomWord(rng, 5, 14);
    const body =
      `var ${v1}=${randomInt(rng, 2, 0xffff)},${v2}=${randomInt(rng, 1, 0xff)},${i}=0;` +
      `function ${inner}(${p}){return ${p}+${randomInt(rng, 1, 0xff)}}` +
      `for(;${i}<${randomInt(rng, 1, 9)};${i}++){${v1}=(${v1}*${randomInt(rng, 2, 9)}+${inner}(${i}))|0;${v2}^=${v1}&${randomInt(rng, 1, 0xff)}}` +
      `return ${v1}+${v2}+'${word}'.length`;
    const decl = `function ${fn}(${arg1},${arg2}){${body}}`;
    if (total + decl.length > maxBytes) break;
    parts.push(decl);
    total += decl.length;
    written += 1;
  }
  return parts.join(oneLine ? '' : '\n');
}

/** 校验噪音块：独立解析后，顶层语句必须全是函数声明（因此不可能有副作用）。 */
export function assertInertNoise(noise) {
  if (!noise) return;
  const ast = parseModule(`\n${noise}`);
  for (const stmt of ast.program.body) {
    if (stmt.type !== 'FunctionDeclaration') throw new Error(`噪音里出现了非函数声明的顶层语句：${stmt.type}`);
  }
}

// ── 主流程 ────────────────────────────────────────────────────────────────

/**
 * 明文 → 混淆源码。
 *
 * @returns {{
 *   code: string,       // 最终产物（混淆核 + 噪音）
 *   core: string,       // 只有混淆核（alpha 等价校验针对它）
 *   noise: string,      // 追加的惰性噪音
 *   version: string|null,
 *   versionBinding: string|null,
 *   stats: object,
 * }}
 */
export function obfuscate({
  plainSource,
  prettySource,
  names,
  seed = 0,
  mangle = DEFAULTS.mangle,
  escape = DEFAULTS.escape,
  noiseBytes = DEFAULTS.noiseBytes,
  targetBytes = DEFAULTS.targetBytes,
  oneLine = DEFAULTS.oneLine,
  keepComments = false,
}) {
  const normalizedSeed = normalizeSeed(seed);
  const rng = mulberry32(normalizedSeed);

  const { reverse, untouched, conflicts } = buildReverseMap({ prettySource, names });
  if (conflicts.length) throw new Error('解码参数自相矛盾，无法反向改名：\n  ' + conflicts.join('\n  '));
  if (reverse.size === 0) throw new Error('反向映射为空：names.json 与 _worker.pretty.js 没有对上任何行号');

  const ast = parseModule(plainSource);
  const version = readVersion(ast, 'CORE_VERSION');

  let versionBindingRef = null;
  traverse(ast, {
    VariableDeclarator(p) {
      if (versionBindingRef) return;
      if (p.node.id.type === 'Identifier' && p.node.id.name === 'CORE_VERSION') {
        versionBindingRef = p.scope.getBinding('CORE_VERSION') || null;
      }
    },
  });

  const taken = collectIdentifierNames(ast);
  for (const word of RESERVED) taken.add(word);

  const expectedBindings = snapshotReferences(ast);
  const unmappedSemantics = new Set(reverse.keys());
  const missingBindings = [];
  let declarations = 0;
  let renamed = 0;
  const alreadyShort = [];

  // 先扫描一遍声明：统计覆盖率、核对反向映射是否仍然命中明文（这一遍不改名）。
  const mappedBindings = [];
  traverse(ast, {
    'FunctionDeclaration|VariableDeclarator|ImportSpecifier'(p) {
      const current = declarationName(p);
      if (!current) return;
      declarations += 1;
      if (!reverse.has(current)) return;
      unmappedSemantics.delete(current);
      const binding = declarationScope(p).getBinding(current);
      const info = reverse.get(current);
      if (!binding) {
        missingBindings.push(`L${info.line} ${current}：明文里找不到作用域绑定`);
        return;
      }
      mappedBindings.push({ binding, from: current, orig: info.orig, line: info.line });
    },
  });

  const ownConflicts = [];
  if (mangle === 'all') {
    const bindings = scopeBindings(ast).filter((binding) => binding.identifier);
    renamed += renameScoped({ ast, bindings, rng });
  } else if (mangle === 'mapped') {
    mappedBindings.sort((a, b) => a.line - b.line);
    const renameSet = new Set(mappedBindings.map((item) => item.binding));
    const blocked = new Set();
    for (const binding of scopeBindings(ast)) {
      if (!renameSet.has(binding)) blocked.add(binding.identifier.name);
    }
    renamed += renameScoped({ ast, bindings: [...renameSet], rng, blockedNames: blocked });
  } else {
    // upstream：还原上游短名（忠实重编码，不做随机替换）
    mappedBindings.sort((a, b) => a.line - b.line);
    for (const item of mappedBindings) {
      const scope = item.binding.scope;
      const current = item.binding.identifier.name;
      if (current === item.orig) {
        alreadyShort.push(current);
        continue;
      }
      if (scope.getOwnBinding(item.orig)) {
        ownConflicts.push(`L${item.line} ${current} → ${item.orig}：目标名已被同作用域绑定占用`);
        continue;
      }
      scope.rename(current, item.orig);
      renamed += 1;
    }
  }
  if (ownConflicts.length) {
    throw new Error('反向改名会覆盖同作用域的既有绑定，已拒绝输出：\n  ' + ownConflicts.join('\n  '));
  }

  const captured = findCapturedReferences(ast, expectedBindings);
  if (captured.length) {
    throw new Error('改名破坏了引用解析（内部错误，已拒绝输出）：\n  ' + captured.join('\n  '));
  }

  // 去注释 + 压缩成单行
  traverse(ast, {
    enter(p) {
      p.node.leadingComments = null;
      p.node.trailingComments = null;
      p.node.innerComments = null;
    },
  });
  ast.comments = [];

  let core = generate(ast, {
    comments: keepComments,
    compact: oneLine,
    minified: oneLine && !keepComments,
    jsescOption: { minimal: true },
  }).code;

  // 关键词隐藏先做：字符串/模板只转义命中的字符，值不变；标识符（含属性名）只转义命中的
  // 单个字符（`port` → `p\u006frt`），解码后仍是同一个名字。随后体积预算在剩余空间里分配。
  const ALL_WORDS = [...KEYWORDS.auto, ...KEYWORDS.manual];
  const keywordResult = hideKeywordsInCode(core, ALL_WORDS, {
    includeModuleSpecifiers: true,
    includeImportIdentifiers: true,
    includeIdentifiers: true,
    // 额外 700 字节预算：随机挑一部分标识符多转义 1 个字符（1–2 个随机），形态也随机。
    // 有上界，保证不会把产物体积撑破 harden.config.json 的上限。
    identifierExtraBudget: 700,
    randomize: true,
    rng,
  });
  if (keywordResult.hidden > 0) core = keywordResult.code;

  const escapedInfo = escapeStringLiterals(core, rng, escape, { targetBytes, noiseCap: noiseBytes });
  core = escapedInfo.code;

  // 噪音的候选名要避开「混淆核」里出现的所有标识符（含转义后仍不变的标识符）
  const coreTaken = collectIdentifierNames(parseModule(core));
  for (const name of taken) coreTaken.add(name);
  for (const word of RESERVED) coreTaken.add(word);
  const noiseRaw = buildNoise({ rng, maxBytes: escapedInfo.noiseBudget, taken: coreTaken, oneLine });
  // 噪音里的随机短名/随机单词也可能凑巧拼出词表词；同样做一次转义，保证最终产物整体干净。
  let noise = noiseRaw;
  if (noiseRaw) {
    const noiseKeywords = hideKeywordsInCode(noiseRaw, ALL_WORDS, {
      includeIdentifiers: true,
      includeModuleSpecifiers: true,
      rng,
    });
    if (noiseKeywords.hidden > 0) noise = noiseKeywords.code;
  }
  assertInertNoise(noise);

  const versionBinding = versionBindingRef
    ? versionBindingRef.identifier.name
    : reverse.has('CORE_VERSION')
      ? reverse.get('CORE_VERSION').orig
      : null;

  // 单行格式：混淆核本身单行，噪音也拼在同一个行里（用 ; 隔开更稳妥）。
  // 多行格式（oneLine=false）只影响可读性，不改变 AST / 字符串值。
  const code = noise ? (oneLine ? `${core};${noise}` : `${core}\n${noise}`) : core;

  const stats = {
    seed: normalizedSeed,
    mangle,
    escape,
    targetBytes,
    oneLine,
    declarations,
    mapped: reverse.size,
    renamed,
    alreadyShort: alreadyShort.length,
    unmappedSemantics: [...unmappedSemantics],
    untouched,
    missingBindings,
    escapedStrings: escapedInfo.escaped,
    skippedStrings: escapedInfo.skipped,
    keywordsHidden: keywordResult.hidden,
    keywordHits: keywordResult.words,
    coreBytes: Buffer.byteLength(core),
    noiseBytes: Buffer.byteLength(noise),
    totalBytes: Buffer.byteLength(code),
  };

  return { code, core, noise, version, versionBinding, stats };
}

// ── CLI ───────────────────────────────────────────────────────────────────

function readMap(env, name) {
  const p = process.env[env] || path.join(TOOLS, name);
  if (!fs.existsSync(p)) throw new Error(`找不到映射文件：${p}`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function main() {
  const { flags, opts } = parseCliArgs(process.argv.slice(2));
  const plainPath = process.env.CFNEW_PLAIN || DEFAULT_PATHS.plain;
  const prettyPath = process.env.CFNEW_PRETTY || DEFAULT_PATHS.pretty;
  const outPath = process.env.CFNEW_OUT || DEFAULT_PATHS.out;
  const plainSource = fs.readFileSync(plainPath, 'utf8');
  const prettySource = fs.readFileSync(prettyPath, 'utf8');
  const names = readMap('CFNEW_NAMES', 'names.json');

  let seed;
  let seedSource;
  if (opts.has('seed')) {
    seed = normalizeSeed(opts.get('seed'), '--seed');
    seedSource = '命令行 --seed';
  } else if (process.env.CFNEW_SEED) {
    seed = normalizeSeed(process.env.CFNEW_SEED, 'CFNEW_SEED');
    seedSource = '环境变量 CFNEW_SEED';
  } else {
    const stored = loadSeedFile();
    if (stored !== null) {
      seed = stored;
      seedSource = 'tools/obfuscate.seed.json';
    } else {
      seed = deriveSeed({ plainSource, prettySource, names });
      seedSource = '源码哈希（没有 seed 文件；运行 build-kernel --randomize 可固定一个随机种子）';
    }
  }

  const { mangle, escape, noiseBytes, targetBytes } = resolveObfuscationOptions({ opts, env: process.env });
  const harden = loadHardenParams({ opts, flags, env: process.env });
  const coreOnly = flags.has('core');
  const result = obfuscate({
    plainSource,
    prettySource,
    names,
    seed,
    mangle,
    escape,
    noiseBytes: coreOnly ? 0 : noiseBytes,
    targetBytes,
    oneLine: harden.oneLine,
    keepComments: flags.has('keep-comments'),
  });
  const code = `${coreOnly ? result.core : result.code}\n`;

  if (flags.has('stdout')) {
    process.stdout.write(code);
  } else {
    fs.writeFileSync(outPath, code);
  }

  const s = result.stats;
  console.error(`混淆模式 ${s.mangle} / escape=${s.escape}${coreOnly ? '（仅混淆核）' : ''}，种子 ${s.seed}（${seedSource}）`);
  console.error(`  反向映射 ${s.mapped} 条；重命名 ${s.renamed} 个绑定；转义 ${s.escapedStrings} 个字符串`);
  console.error(`  混淆核 ${s.coreBytes} 字节 + 噪音 ${s.noiseBytes} 字节 = ${s.totalBytes} 字节（目标 ${s.targetBytes}，${s.oneLine ? '单行' : '多行'}）`);
  if (s.unmappedSemantics.length) {
    console.error(`  ! ${s.unmappedSemantics.length} 个语义名在明文里没找到声明：${s.unmappedSemantics.join(', ')}`);
  }
  for (const msg of s.missingBindings) console.error(`  ! ${msg}`);
  if (s.untouched.length) {
    console.error(`  ! names.json 有 ${s.untouched.length} 行没对上 _worker.pretty.js（映射过期？跑 tools/align.mjs）`);
  }
  if (!flags.has('stdout')) {
    console.error(`已写出 ${outPath}，内核版本 ${result.version || '未找到'}`);
    if (result.version && result.versionBinding) {
      console.error(`产物版本常量：${result.versionBinding} = "${result.version}"`);
    }
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(`❌ ${error.message}`);
    process.exit(1);
  }
}
