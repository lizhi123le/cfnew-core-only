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
 * 作用范围：
 *   - 字符串字面量与模板静态片段：可隐藏、可检查；
 *   - import/export 的模块说明符：发布产物同样按词表转义（如 `cloudflare:sockets`）；
 *     面板测试靠正则打桩，所以 check.sh / 运行时探针会先用 normalizeModuleSpecifiers 还原成原文；
 *   - import 的绑定名（如 `connect`）：可用 Unicode 标识符转义隐藏（`\u0063onnect`）；
 *   - 任意标识符 / 属性名（含 `port`、`region`、`ech` 这类契约字段）：用 Unicode 转义改写
 *     命中关键字的那一个字符即可（如 `p\u006frt`）。转义后的标识符在运行时仍是同一个名字，
 *     不会改动属性键、JSON 字段名或作用域绑定；字符串值也完全不变；
 *   - 正则字面量：不改写（改 pattern 原文可能影响 `RegExp#source` 等语义），命中即构建失败；
 *   - `import` / `export` / `typeof` 这类 JS 语法关键字无法转义（ECMAScript 明确禁止用转义
 *     拼出保留字），所以 `port`、`type` 仍会作为子串出现在关键字里 —— 这是唯一允许的残留，
 *     构建门禁 `findForbiddenKeywords` 只放行被词法器判定为关键字的 token。
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

/** 长形态转义：`\u{000070}` 这类带随机前导零的码点写法，长度 8–11，增加每次构建的形态差异。 */
function randomEscapeUnitLong(code, rng) {
  const digits = code.toString(16);
  const width = Math.max(digits.length, 3 + Math.floor(rng() * 4)); // 3–6 位，允许前导零
  let out = '\\u{';
  for (const ch of digits.padStart(width, '0')) out += rng() < 0.5 ? ch.toUpperCase() : ch;
  return `${out}}`;
}

/** 找出 name 里所有命中词的区间（可能重叠）。 */
function keywordIntervals(name, words) {
  const lower = name.toLowerCase();
  const intervals = [];
  for (const word of words) {
    if (!word) continue;
    let index = lower.indexOf(word);
    while (index !== -1) {
      intervals.push([index, index + word.length]);
      index = lower.indexOf(word, index + 1);
    }
  }
  return intervals.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}

/**
 * 在每个命中区间里挑位置：先保证每个区间至少 minCount 个字符被转义（每个词 2 个），
 * 再按 extraChance 随机给一部分区间多转义 1 个（每个词 2–3 个）。
 */
function chooseIntervalPositions(intervals, minCount, rng, extraChance = 0) {
  const positions = [];
  const taken = new Set();
  const countIn = (start, end) => positions.filter((pos) => pos >= start && pos < end).length;
  const pickOne = (start, end) => {
    const pool = [];
    for (let i = start; i < end; i++) if (!taken.has(i)) pool.push(i);
    if (pool.length === 0) return null;
    const pos = pool[Math.floor(rng() * pool.length)];
    positions.push(pos);
    taken.add(pos);
    return pos;
  };
  for (const [start, end] of intervals) {
    while (countIn(start, end) < minCount) {
      if (pickOne(start, end) === null) break;
    }
  }
  if (extraChance > 0) {
    for (const [start, end] of intervals) {
      if (rng() >= extraChance) continue;
      pickOne(start, end);
    }
  }
  return positions;
}

/**
 * 标识符的转义点：每个命中的词先挑 2 个字符，明文就消失了，而标识符解码后仍是原名字。
 * 命中区间可能重叠（如 customECHDomain 同时命中 ech 与 omain），用「区间取点」保证全覆盖。
 */
function planIdentifierBase(name, words, rng) {
  const intervals = keywordIntervals(name, words);
  if (intervals.length === 0) return null;
  const positions = chooseIntervalPositions(intervals, 2, rng, 0);
  return { positions, intervals };
}

/** 在命中区间里再随机挑 count 个尚未转义的字符（用于把每个词从 2 个加到 3 个）。 */
function pickExtraPositions(name, intervals, taken, count, rng) {
  const pool = [];
  for (const [start, end] of intervals) {
    for (let i = start; i < end; i++) if (!taken.has(i) && !pool.includes(i)) pool.push(i);
  }
  const picked = [];
  for (let i = 0; i < count && pool.length; i++) {
    const index = Math.floor(rng() * pool.length);
    picked.push(pool[index]);
    pool.splice(index, 1);
  }
  return picked;
}

/** 按位置渲染标识符：转义位随机选 `\uXXXX` / `\u{HH}`，强调位再随机用长形态。 */
function renderIdentifier(name, basePositions, extraPositions, rng) {
  const base = new Set(basePositions);
  const extra = new Set(extraPositions);
  let text = '';
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (extra.has(i)) text += rng() < 0.5 ? randomEscapeUnitLong(code, rng) : randomEscapeUnit(code, rng, { identifier: true });
    else if (base.has(i)) text += randomEscapeUnit(code, rng, { identifier: true });
    else text += name[i];
  }
  return text;
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

/** 把一个字符串字面量按命中位置改写（每个命中词随机转义 2–3 个字符，其余保持可读）。 */
function hideStringLiteral(value, words, { randomize = false, rng = () => 0.5 } = {}) {
  const { hits } = markMatches(value, words);
  if (randomize) {
    // 说明符整体随机转义：每个字符都换一种写法，值不变。
    let randomized = '"';
    for (let i = 0; i < value.length; i++) randomized += randomEscapeUnit(value.charCodeAt(i), rng);
    return { text: `${randomized}"`, hits };
  }
  if (hits.length === 0) return null;
  const intervals = keywordIntervals(value, words);
  const escaped = new Set(chooseIntervalPositions(intervals, 2, rng, 0.5));
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (escaped.has(i)) {
      // 命中的字符随机用 \xHH / \uHHHH / \u{HH}，同一 seed 可复现，不同 seed 形态不同。
      out += randomEscapeUnit(code, rng);
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

/** 模板静态片段：每个命中词随机转义 2–3 个字符，保留已有的 `${...}` 表达式结构。 */
function hideTemplateRaw(raw, words, rng) {
  const { hits } = markMatches(raw, words);
  if (hits.length === 0) return null;
  const intervals = keywordIntervals(raw, words);
  const escaped = new Set(chooseIntervalPositions(intervals, 2, rng, 0.5));
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    out += escaped.has(i) ? randomEscapeUnit(raw.charCodeAt(i), rng) : raw[i];
  }
  return { text: out, hits };
}

/**
 * 隐藏一段代码里所有命中的关键词（字符串 + 模板静态片段 + 可选标识符）。
 *
 * 每个命中词默认转义 2 个字符（字符串/模板再随机加到 3 个）；`identifierExtraBudget` 是额外的
 * 字节预算，用来随机给一部分标识符也补到 3 个（2–3 个随机、长短形态随机），预算用完即止，
 * 因此产物体积有确定上界，不会因为随机而失控。
 *
 * @returns {{ code: string, hidden: number, words: string[] }}
 */
export function hideKeywordsInCode(
  code,
  words,
  {
    includeModuleSpecifiers = false,
    includeImportIdentifiers = false,
    includeIdentifiers = false,
    identifierExtraBudget = 0,
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
      const hidden = hideTemplateRaw(raw, words, rng);
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
    Identifier(p) {
      if (!includeIdentifiers) return;
      const node = p.node;
      // 属性名、成员访问、绑定、引用、标签……都走这里；转义不改变解码后的名字。
      const plan = planIdentifierBase(node.name, words, rng);
      if (!plan) return;
      const text = renderIdentifier(node.name, plan.positions, [], rng);
      for (const word of new Set(markMatches(node.name, words).hits)) {
        hitWords.add(word);
      }
      hitCount += plan.positions.length;
      edits.push({
        start: node.start,
        end: node.end,
        text,
        ident: { name: node.name, base: plan.positions, intervals: plan.intervals },
      });
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

  // 随机加码：预算内随机挑一半左右的标识符多转义 1 个字符（总共 2–3 个），
  // 形态随机（\uXXXX / \u{HH} / 带随机前导零的 \u{0000HH}），预算见底就停。
  if (includeIdentifiers && identifierExtraBudget > 0) {
    let remaining = identifierExtraBudget;
    for (const edit of uniqueEdits) {
      if (!edit.ident || rng() < 0.5) continue;
      const { name, base, intervals } = edit.ident;
      const extra = pickExtraPositions(name, intervals, new Set(base), 1, rng);
      if (extra.length === 0) continue;
      const text = renderIdentifier(name, base, extra, rng);
      const delta = text.length - edit.text.length;
      if (delta > remaining) continue;
      remaining -= delta;
      edit.text = text;
      hitCount += extra.length;
    }
  }

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

/** 二分找到包含 index 的 token（tokens 按 start 升序）。 */
function tokenAt(tokens, index) {
  let lo = 0;
  let hi = tokens.length - 1;
  let candidate = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tokens[mid].start <= index) {
      candidate = tokens[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return candidate && index < candidate.end ? candidate : null;
}

/**
 * 逐字扫描产物里每个关键词的所有出现位置，并用词法器给出现位置分类：
 *   keyword    —— JS 语法关键字（`import`/`export`/`typeof`…），ECMAScript 禁止用转义拼出保留字；
 *   string / template / regexp —— 可转义隐藏的字面量；
 *   identifier —— 标识符 / 属性名（可用 Unicode 转义隐藏）；
 *   comment / other —— 注释或其它文本（产物里不应出现）。
 */
export function scanKeywordOccurrences(code, words) {
  if (!words || words.length === 0) return [];
  const ast = parse(code, { sourceType: 'module', tokens: true });
  const tokens = ast.tokens || [];
  const lower = code.toLowerCase();
  const occurrences = [];
  for (const word of words) {
    if (!word) continue;
    let index = lower.indexOf(word);
    while (index !== -1) {
      const token = tokenAt(tokens, index);
      let kind;
      if (!token) kind = 'comment';
      else if (token.type.keyword) kind = 'keyword';
      else if (token.type.label === 'string') kind = 'string';
      else if (token.type.label === 'template') kind = 'template';
      else if (token.type.label === 'regexp') kind = 'regexp';
      else if (token.type.label === 'name') kind = 'identifier';
      else kind = 'other';
      occurrences.push({
        word,
        index,
        kind,
        tokenLabel: token ? token.type.keyword || token.type.label : 'raw',
        tokenStart: token ? token.start : index,
        tokenEnd: token ? token.end : index + word.length,
        snippet: code.slice(Math.max(0, index - 24), index + word.length + 24),
      });
      index = lower.indexOf(word, index + 1);
    }
  }
  return occurrences;
}

/**
 * 硬性门禁：返回所有「不是 JS 语法关键字」的关键词出现位置。
 * 空数组 = 词表在产物里彻底不可见；只要有一处（字符串/标识符/属性名/注释）就构建失败。
 */
export function findForbiddenKeywords(code, words) {
  return scanKeywordOccurrences(code, words).filter((occurrence) => occurrence.kind !== 'keyword');
}

/**
 * 统计每个关键词在产物里的可见情况：
 *   hideable   —— 字符串/模板/正则里的命中（本应被隐藏，0 才算干净）
 *   structural —— 标识符/属性名/其它文本里的命中（现在会被 Unicode 转义消掉，应为 0）
 *   keyword    —— JS 语法关键字内部的子串（无法转义，只能如实报告）
 *   exact      —— 整个标识符恰好等于某个词（如 `port`、`region`）的出现次数
 */
export function scanKeywordVisibility(code, words) {
  const empty = () => new Map();
  const result = { hideable: empty(), structural: empty(), keyword: empty(), exact: empty(), total: empty() };
  if (!words || words.length === 0) return result;
  const bump = (map, word) => map.set(word, (map.get(word) || 0) + 1);
  for (const occurrence of scanKeywordOccurrences(code, words)) {
    const { word, kind } = occurrence;
    bump(result.total, word);
    if (kind === 'string' || kind === 'template' || kind === 'regexp') bump(result.hideable, word);
    else if (kind === 'keyword') bump(result.keyword, word);
    else bump(result.structural, word);
    if (kind === 'identifier' && occurrence.tokenEnd - occurrence.tokenStart === word.length) bump(result.exact, word);
  }
  return result;
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
