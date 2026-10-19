/**
 * 关键词隐藏与检查（对齐 BPB 的 sensitive_words_auto/manual 机制）。
 *
 * 两类词表：
 *   sensitive_words_auto.txt    硬性禁止词：字符串里必须隐藏，构建时检查到明文即失败；
 *   sensitive_words_manual.txt  期望隐藏词：同样尽量隐藏，残留只在构建日志里 WARN。
 *
 * 隐藏方式：只把**命中的关键字符**改写成 `\xHH` / `\uHHHH`，字符串值不变，
 * 比整串转义省很多体积（BPB 的 auto 词表在本内核上约 +0.8 KB）。
 *
 * 作用范围（现实约束）：
 *   - 字符串字面量与模板静态片段：可隐藏、可检查；
 *   - import/export 的模块说明符：发布产物同样按词表转义（如 `cloudflare:sockets`）；
 *     面板测试靠正则打桩，所以 check.sh / 运行时探针会先用 normalizeModuleSpecifiers 还原成原文；
 *   - import 的绑定名（如 `connect`）：可用 Unicode 标识符转义隐藏（`\u0063onnect`）；
 *   - 其它标识符/属性名/正则：不改写（属性名是面板接口契约），检查也不覆盖；
 *   - `import` / `from` / `as` 是 JS 语法关键字，无法转义，构建时作为「语法保留」提示。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';

const traverse = _traverse.default || _traverse;
const ROOT = path.resolve(import.meta.dirname, '..');

export const DEFAULT_KEYWORD_PATHS = {
  auto: path.join(ROOT, 'sensitive_words_auto.txt'),
  manual: path.join(ROOT, 'sensitive_words_manual.txt'),
};

function readList(file, { required = false } = {}) {
  if (!fs.existsSync(file)) {
    if (required) throw new Error(`找不到词表：${file}`);
    return [];
  }
  const words = fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.toLowerCase());
  return [...new Set(words)];
}

/** 读取 auto/manual 两个词表；默认取仓库根目录，可用环境变量覆盖。 */
export function loadKeywordLists({ autoPath, manualPath } = {}) {
  const autoFile = autoPath || process.env.CFNEW_KEYWORDS_AUTO || DEFAULT_KEYWORD_PATHS.auto;
  const manualFile = manualPath || process.env.CFNEW_KEYWORDS_MANUAL || DEFAULT_KEYWORD_PATHS.manual;
  return {
    auto: readList(autoFile),
    manual: readList(manualFile),
    files: { auto: autoFile, manual: manualFile },
  };
}

const parseModule = (code) => parse(code, { sourceType: 'module' });

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

const hex2 = (n) => n.toString(16).padStart(2, '0');
const hex4 = (n) => n.toString(16).padStart(4, '0');

function escapeCodeUnit(code) {
  if (code <= 0xff) return `\\x${hex2(code)}`;
  return `\\u${hex4(code)}`;
}

function randomHex(code, width, rng) {
  const digits = code.toString(16).padStart(width, '0');
  let out = '';
  for (const ch of digits) out += rng() < 0.5 ? ch.toUpperCase() : ch;
  return out;
}

/** 随机转义一个字符：字符串可用 \x / \u，标识符只能用 \u；十六进制大小写也随机。 */
function randomEscapeUnit(code, rng, { identifier = false } = {}) {
  const style = rng();
  if (!identifier && code <= 0xff && style < 0.35) {
    return `\\x${randomHex(code, 2, rng)}`;
  }
  if (style < 0.72) {
    return `\\u${randomHex(code, 4, rng)}`;
  }
  // ES2015 的码点转义：\u{63} 与 \u0063 等价，但形态不同，增加每次构建的差异
  return `\\u{${randomHex(code, 2, rng)}}`;
}

/** 标识符里的关键词：用 Unicode 转义（`connect` → `\u0063onnect`），仍是同一个标识符。 */
function hideIdentifierName(name, words, { randomize = false, rng = () => 0.5 } = {}) {
  const { covered, hits } = markMatches(name, words);
  if (randomize) {
    let randomized = '';
    for (let i = 0; i < name.length; i++) {
      randomized += randomEscapeUnit(name.charCodeAt(i), rng, { identifier: true });
    }
    return { text: randomized, hits };
  }
  if (hits.length === 0) return null;
  let out = '';
  for (let i = 0; i < name.length; i++) {
    out += covered[i] ? `\\u${hex4(name.charCodeAt(i))}` : name[i];
  }
  return { text: out, hits };
}

function markMatches(text, words) {
  const lower = text.toLowerCase();
  const covered = new Array(text.length).fill(false);
  const hits = [];
  for (const word of words) {
    if (!word) continue;
    let index = lower.indexOf(word);
    while (index !== -1) {
      for (let i = 0; i < word.length; i++) covered[index + i] = true;
      hits.push(word);
      index = lower.indexOf(word, index + 1);
    }
  }
  return { covered, hits };
}

/** 把一个字符串字面量按命中位置改写（其余字符保持可读，尽量不增大体积）。 */
function hideStringLiteral(value, words, { randomize = false, rng = () => 0.5 } = {}) {
  const { covered, hits } = markMatches(value, words);
  if (randomize) {
    // 说明符整体随机转义：每个字符都换一种写法，值不变。
    let randomized = '"';
    for (let i = 0; i < value.length; i++) randomized += randomEscapeUnit(value.charCodeAt(i), rng);
    return { text: `${randomized}"`, hits };
  }
  if (hits.length === 0) return null;
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (covered[i]) {
      out += escapeCodeUnit(code);
    } else if (code === 0x22) {
      out += '\\"';
    } else if (code === 0x5c) {
      out += '\\\\';
    } else if (code < 0x20) {
      out += escapeCodeUnit(code);
    } else {
      out += value[i];
    }
  }
  return { text: `${out}"`, hits };
}

/** 模板静态片段：只改写命中的字符，保留已有的 `${...}` 表达式结构。 */
function hideTemplateRaw(raw, words) {
  const { covered, hits } = markMatches(raw, words);
  if (hits.length === 0) return null;
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    out += covered[i] ? escapeCodeUnit(raw.charCodeAt(i)) : raw[i];
  }
  return { text: out, hits };
}

/**
 * 隐藏一段代码里所有命中的关键词（字符串 + 模板静态片段）。
 * @returns {{ code: string, hidden: number, words: string[] }}
 */
export function hideKeywordsInCode(
  code,
  words,
  {
    includeModuleSpecifiers = false,
    includeImportIdentifiers = false,
    randomize = false,
    rng = () => 0.5,
  } = {}
) {
  if (!words || words.length === 0) return { code, hidden: 0, words: [] };
  const ast = parseModule(code);
  const edits = [];
  const hitWords = new Set();
  let hitCount = 0;

  traverse(ast, {
    StringLiteral(p) {
      if (isDirective(p)) return;
      const moduleSpecifier = isModuleSpecifier(p);
      if (moduleSpecifier && !includeModuleSpecifiers) return;
      const node = p.node;
      const hidden = hideStringLiteral(node.value, words, {
        randomize: randomize && moduleSpecifier,
        rng,
      });
      if (!hidden) return;
      hidden.hits.forEach((word) => {
        hitWords.add(word);
        hitCount += 1;
      });
      edits.push({ start: node.start, end: node.end, text: hidden.text });
    },
    TemplateElement(p) {
      const node = p.node;
      const raw = node.value.raw;
      const hidden = hideTemplateRaw(raw, words);
      if (!hidden) return;
      hidden.hits.forEach((word) => {
        hitWords.add(word);
        hitCount += 1;
      });
      edits.push({ start: node.start, end: node.end, text: hidden.text });
    },
    ImportSpecifier(p) {
      if (!includeImportIdentifiers) return;
      const node = p.node;
      for (const identifier of [node.imported, node.local]) {
        if (!identifier || identifier.type !== 'Identifier') continue;
        const hidden = hideIdentifierName(identifier.name, words, {
          randomize: randomize && identifier === node.imported,
          rng,
        });
        if (!hidden) continue;
        hidden.hits.forEach((word) => {
          hitWords.add(word);
          hitCount += 1;
        });
        edits.push({ start: identifier.start, end: identifier.end, text: hidden.text });
      }
    },
    ImportDefaultSpecifier(p) {
      if (!includeImportIdentifiers) return;
      const identifier = p.node.local;
      const hidden = hideIdentifierName(identifier.name, words, { randomize: false, rng });
      if (!hidden) return;
      hidden.hits.forEach((word) => {
        hitWords.add(word);
        hitCount += 1;
      });
      edits.push({ start: identifier.start, end: identifier.end, text: hidden.text });
    },
    ImportNamespaceSpecifier(p) {
      if (!includeImportIdentifiers) return;
      const identifier = p.node.local;
      const hidden = hideIdentifierName(identifier.name, words, { randomize: false, rng });
      if (!hidden) return;
      hidden.hits.forEach((word) => {
        hitWords.add(word);
        hitCount += 1;
      });
      edits.push({ start: identifier.start, end: identifier.end, text: hidden.text });
    },
  });

  if (edits.length === 0) return { code, hidden: 0, words: [] };
  // 同一个标识符可能同时被 imported/local 命中，按区间去重，避免重复改写
  const seen = new Set();
  const uniqueEdits = edits.filter((edit) => {
    const key = `${edit.start}:${edit.end}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  uniqueEdits.sort((a, b) => b.start - a.start);
  let out = code;
  for (const edit of uniqueEdits) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  parseModule(out); // 语法兜底：改坏了就在这里失败，而不是产出坏文件
  return { code: out, hidden: uniqueEdits.length, chars: hitCount, words: [...hitWords] };
}

/**
 * 把 import/export 的模块说明符统一还原成原文（JSON 字符串）。
 * 发布产物可以转义说明符；测试副本先用它还原，再交给面板测试的正则打桩。
 */
export function normalizeModuleSpecifiers(code) {
  const ast = parseModule(code);
  const edits = [];
  const inspect = (source) => {
    if (!source) return;
    edits.push({ start: source.start, end: source.end, text: JSON.stringify(source.value) });
  };
  const add = (node, text) => {
    if (!node || node.type !== 'Identifier') return;
    edits.push({ start: node.start, end: node.end, text });
  };
  traverse(ast, {
    ImportDeclaration(p) { inspect(p.node.source); },
    ExportAllDeclaration(p) { inspect(p.node.source); },
    ExportNamedDeclaration(p) { inspect(p.node.source); },
    ImportSpecifier(p) {
      add(p.node.imported, p.node.imported.name);
      add(p.node.local, p.node.local.name);
    },
    ImportDefaultSpecifier(p) { add(p.node.local, p.node.local.name); },
    ImportNamespaceSpecifier(p) { add(p.node.local, p.node.local.name); },
  });
  // imported/local 可能指向同一段（无 as 别名），按区间去重
  const seen = new Set();
  const uniqueEdits = [];
  for (const edit of edits) {
    const key = `${edit.start}:${edit.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueEdits.push(edit);
  }
  edits.length = 0;
  edits.push(...uniqueEdits);
  if (edits.length === 0) return { code, normalized: 0 };
  edits.sort((a, b) => b.start - a.start);
  let out = code;
  for (const edit of edits) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  parseModule(out);
  return { code: out, normalized: edits.length };
}

/**
 * 模块说明符里的关键词（import/export 的 source）。
 * 发布产物会转义模块说明符；这个函数用于统计残留（正常情况下应为空），
 * 以及给测试副本/探针提示需要还原的位置。
 */
export function findKeywordLeaksInModuleSpecifiers(code, words) {
  if (!words || words.length === 0) return [];
  const ast = parseModule(code);
  const leaks = [];
  const inspect = (source) => {
    if (!source) return;
    const raw = code.slice(source.start, source.end);
    const lower = raw.toLowerCase();
    for (const word of words) {
      if (lower.includes(word)) leaks.push({ word, kind: 'module', snippet: raw });
    }
  };
  traverse(ast, {
    ImportDeclaration(p) { inspect(p.node.source); },
    ExportAllDeclaration(p) { inspect(p.node.source); },
    ExportNamedDeclaration(p) { inspect(p.node.source); },
  });
  return leaks;
}

/**
 * 统计每个关键词在产物里的可见情况：
 *   hideable   —— 落在字符串/模板/模块说明符/import 绑定名里的命中（本应被隐藏，0 才算干净）
 *   structural —— 落在标识符、属性名、JS 语法关键字里的命中（无法转义，只能如实报告）
 *
 * 这样构建日志不会再把"结构里还能看到 type/config/from"误报成"泄露 0"。
 */
export function scanKeywordVisibility(code, words) {
  if (!words || words.length === 0) return { hideable: new Map(), structural: new Map(), total: new Map() };
  const ast = parseModule(code);
  const ranges = [];
  const addRange = (node) => {
    if (node && Number.isInteger(node.start) && Number.isInteger(node.end)) {
      ranges.push({ start: node.start, end: node.end });
    }
  };
  traverse(ast, {
    StringLiteral(p) { addRange(p.node); },
    TemplateElement(p) { addRange(p.node); },
    RegExpLiteral(p) { addRange(p.node); },
    ImportSpecifier(p) { addRange(p.node.imported); addRange(p.node.local); },
  });
  ranges.sort((a, b) => a.start - b.start);
  const insideHideable = (index) => {
    // 命中起点必须落在某个可隐藏 token 内；二分找前一个 range
    let lo = 0;
    let hi = ranges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ranges[mid].start <= index) lo = mid + 1;
      else hi = mid - 1;
    }
    const candidate = ranges[hi];
    return Boolean(candidate && index >= candidate.start && index < candidate.end);
  };

  const lower = code.toLowerCase();
  const hideable = new Map();
  const structural = new Map();
  const total = new Map();
  const exact = new Map();
  const identifiers = [];
  traverse(ast, {
    Identifier(p) { identifiers.push(code.slice(p.node.start, p.node.end)); },
  });
  for (const word of words) {
    if (!word) continue;
    let index = lower.indexOf(word);
    let all = 0;
    let hidden = 0;
    while (index !== -1) {
      all += 1;
      if (insideHideable(index)) hidden += 1;
      index = lower.indexOf(word, index + 1);
    }
    total.set(word, all);
    hideable.set(word, hidden);
    structural.set(word, all - hidden);
    exact.set(word, identifiers.filter((name) => name.toLowerCase() === word).length);
  }
  return { hideable, structural, total, exact };
}

/**
 * 检查产物里是否还有关键词以明文出现（只看字符串/模板/正则的原始文本）。
 * @returns {{ word: string, kind: 'string'|'template'|'regexp', snippet: string }[]}
 */
export function findKeywordLeaks(
  code,
  words,
  {
    includeModuleSpecifiers = false,
    includeImportIdentifiers = false,
    randomize = false,
    rng = () => 0.5,
  } = {}
) {
  if (!words || words.length === 0) return [];
  const ast = parseModule(code);
  const leaks = [];
  const add = (word, kind, raw) => {
    leaks.push({ word, kind, snippet: raw.length > 60 ? `${raw.slice(0, 57)}...` : raw });
  };

  traverse(ast, {
    StringLiteral(p) {
      if (isDirective(p)) return;
      const moduleSpecifier = isModuleSpecifier(p);
      if (moduleSpecifier && !includeModuleSpecifiers) return;
      const node = p.node;
      const raw = code.slice(node.start, node.end);
      const lower = raw.toLowerCase();
      for (const word of words) if (lower.includes(word)) add(word, 'string', raw);
    },
    TemplateElement(p) {
      const node = p.node;
      const raw = code.slice(node.start, node.end);
      const lower = raw.toLowerCase();
      for (const word of words) if (lower.includes(word)) add(word, 'template', raw);
    },
    RegExpLiteral(p) {
      const lower = p.node.pattern.toLowerCase();
      for (const word of words) if (lower.includes(word)) add(word, 'regexp', `/${p.node.pattern}/`);
    },
    ImportSpecifier(p) {
      if (!includeImportIdentifiers) return;
      for (const identifier of [p.node.imported, p.node.local]) {
        if (!identifier || identifier.type !== 'Identifier') continue;
        const raw = code.slice(identifier.start, identifier.end);
        const lower = raw.toLowerCase();
        for (const word of words) if (lower.includes(word)) add(word, 'identifier', raw);
      }
    },
  });
  return leaks;
}
