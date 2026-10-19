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
 *   - import/export 的模块说明符：必须保持原文（面板测试靠它打桩），跳过；
 *   - 标识符、属性名、正则字面量：不在此处改写（属性名是面板接口契约），检查也不覆盖，
 *     所以词表里尽量放"出现在字符串里"的指纹词。
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
function hideStringLiteral(value, words) {
  const { covered, hits } = markMatches(value, words);
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
export function hideKeywordsInCode(code, words) {
  if (!words || words.length === 0) return { code, hidden: 0, words: [] };
  const ast = parseModule(code);
  const edits = [];
  const hitWords = new Set();
  let hitCount = 0;

  traverse(ast, {
    StringLiteral(p) {
      if (isDirective(p) || isModuleSpecifier(p)) return;
      const node = p.node;
      const hidden = hideStringLiteral(node.value, words);
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
  });

  if (edits.length === 0) return { code, hidden: 0, words: [] };
  edits.sort((a, b) => b.start - a.start);
  let out = code;
  for (const edit of edits) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  parseModule(out); // 语法兜底：改坏了就在这里失败，而不是产出坏文件
  return { code: out, hidden: hitCount, words: [...hitWords] };
}

/**
 * 模块说明符里的关键词（import/export 的 source）。
 * 这些位置不能转义：cfnew-panel 的测试用正则匹配 `cloudflare:sockets` 来给 connect 打桩，
 * 改了说明符的书写形式会让行为闸门无法加载内核。这里只用于报告“结构性例外”。
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
 * 检查产物里是否还有关键词以明文出现（只看字符串/模板/正则的原始文本）。
 * @returns {{ word: string, kind: 'string'|'template'|'regexp', snippet: string }[]}
 */
export function findKeywordLeaks(code, words) {
  if (!words || words.length === 0) return [];
  const ast = parseModule(code);
  const leaks = [];
  const add = (word, kind, raw) => {
    leaks.push({ word, kind, snippet: raw.length > 60 ? `${raw.slice(0, 57)}...` : raw });
  };

  traverse(ast, {
    StringLiteral(p) {
      if (isDirective(p) || isModuleSpecifier(p)) return;
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
  });
  return leaks;
}
