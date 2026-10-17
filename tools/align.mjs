/**
 * 对齐（re-align）：上游内核升级后，把 names.json / comments.json 里的行号
 * 平移到新版本的对应函数上，让 deobfuscate.mjs 继续沿用原来的语义命名。
 *
 * 做法：给新旧两版的每个"实体"（导入项、模块级常量、函数）算一个**结构指纹**——
 * 把标识符全部抹成 `_`、保留运算符/字面量/属性名后生成的代码。指纹与变量改名无关，
 * 也不受行号移动影响。然后对新旧实体序列做 LCS：指纹相同的就认为是同一个实体，
 * 名字随之前移。上游新增/删除的函数自然落空，逐条报告出来待人工命名。
 *
 * 用法：
 *   node align.mjs --old ../_worker.pretty.js --new ../_worker.pretty.new.js [--report align-report.md]
 *
 * 退出码恒为 0（允许部分命名）：调用方（CI）根据报告里的"新增未命名"数量决定是否开 issue。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import _generate from '@babel/generator';
import * as t from '@babel/types';

const traverse = _traverse.default || _traverse;
const generate = _generate.default || _generate;
const TOOLS = import.meta.dirname;
const ROOT = path.resolve(TOOLS, '..');

// ── 参数 ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const OLD = path.resolve(arg('old', path.join(ROOT, '_worker.pretty.js')));
const NEW = path.resolve(arg('new', path.join(ROOT, '_worker.pretty.new.js')));
const REPORT = arg('report', null);
const NAMES_JSON = path.resolve(arg('names', path.join(TOOLS, 'names.json')));
const COMMENTS_JSON = path.resolve(arg('comments', path.join(TOOLS, 'comments.json')));

const readJson = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {});
const NAMES = readJson(NAMES_JSON);
const COMMENTS = readJson(COMMENTS_JSON);

// ── 结构指纹 ────────────────────────────────────────────────────────────
function blankIdentifiers(node, parent = null, key = null) {
  if (Array.isArray(node)) {
    for (const child of node) blankIdentifiers(child, parent, key);
    return;
  }
  if (!node || typeof node.type !== 'string') return;
  if (node.type === 'Identifier') {
    const isProperty =
      ((parent?.type === 'MemberExpression' || parent?.type === 'OptionalMemberExpression') && key === 'property' && !parent.computed) ||
      ((parent?.type === 'ObjectProperty' || parent?.type === 'ObjectMethod') && key === 'key' && !parent.computed);
    if (!isProperty) node.name = '_';
    return;
  }
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'start' || k === 'end' || k === 'extra' || k.endsWith('Comments')) continue;
    blankIdentifiers(node[k], node, k);
  }
}

// 函数体指纹要排除内层函数：上游增删/重写某个内部小函数时，不应该让外层闭包
// （以及整条祖先链）的命名一起失效。所以把嵌套函数声明整条丢掉、嵌套函数表达式
// 换成 null 占位，只保留"本函数自己的逻辑骨架"。
const FN_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ObjectMethod',
  'ClassMethod',
]);

function pruneNestedFunctions(node) {
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'start' || k === 'end' || k === 'extra' || k.endsWith('Comments')) continue;
    const v = node[k];
    if (Array.isArray(v)) {
      const kept = [];
      for (const child of v) {
        if (child && FN_TYPES.has(child.type)) continue;
        kept.push(child && typeof child.type === 'string' ? pruneNestedFunctions(child) : child);
      }
      node[k] = kept;
    } else if (v && typeof v.type === 'string') {
      node[k] = FN_TYPES.has(v.type) ? { type: 'NullLiteral' } : pruneNestedFunctions(v);
    }
  }
  return node;
}

function structuralCode(node, { stripInner = false } = {}) {
  const clone = t.cloneNode(node, true, false);
  if (stripInner) pruneNestedFunctions(clone);
  blankIdentifiers(clone);
  return generate(clone, { compact: true, comments: false, jsescOption: { minimal: true } }).code;
}

const fpString = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
const fp = (kind, node, extra = '', opts = {}) =>
  fpString(`${kind}|${extra}|${structuralCode(node, opts)}`);
// 模块级常量：只看初始化表达式的"种类"，值变了（比如版本号）也仍算同一个实体
const declFp = (init) =>
  fpString(`decl|${init.type}|${init.callee?.name || ''}|${init.properties?.length ?? ''}`);

function readCoreVersion(file) {
  const m = fs.readFileSync(file, 'utf8').match(/const ht ?= ?"([^"]+)"/);
  return m ? m[1] : '未知';
}

// ── 采集实体（按文档顺序） ──────────────────────────────────────────────
function collect(source) {
  const ast = parse(source, { sourceType: 'module' });
  const entities = [];
  const programScope = [];
  traverse(ast, {
    Program(p) {
      programScope.push(p.scope.uid);
    },
    ImportSpecifier(p) {
      entities.push({ line: p.node.loc.start.line, short: p.node.local.name, kind: 'import', fp: fp('import', p.node, p.node.imported.name) });
    },
    FunctionDeclaration(p) {
      entities.push({ line: p.node.loc.start.line, short: p.node.id.name, kind: 'fn', fp: fp('fn', p.node.body, p.node.params.length, { stripInner: true }) });
    },
    VariableDeclarator(p) {
      const node = p.node;
      if (!node.id || node.id.type !== 'Identifier') return;
      const init = node.init;
      if (!init) return;
      if (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') {
        entities.push({ line: node.loc.start.line, short: node.id.name, kind: 'fn', fp: fp('fn', init.body, init.params.length, { stripInner: true }) });
        return;
      }
      // 只关心模块级常量（WeakMap / Map / 版本字符串 / 对象等）
      const isTopLevel = p.scope.path.isProgram();
      if (!isTopLevel) return;
      entities.push({ line: node.loc.start.line, short: node.id.name, kind: 'decl', fp: declFp(init) });
    },
  });
  entities.sort((a, b) => a.line - b.line);
  return entities;
}

// ── LCS ────────────────────────────────────────────────────────────────
function lcsPairs(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

// ── 主流程 ──────────────────────────────────────────────────────────────
const oldSrc = fs.readFileSync(OLD, 'utf8');
const newSrc = fs.readFileSync(NEW, 'utf8');
const oldEntities = collect(oldSrc);
const newEntities = collect(newSrc);
const pairs = lcsPairs(oldEntities.map((e) => e.fp), newEntities.map((e) => e.fp));

const newNames = {};
const newComments = {};
const matchedOld = new Set();
let carried = 0;

for (const [oi, ni] of pairs) {
  const o = oldEntities[oi];
  const n = newEntities[ni];
  matchedOld.add(oi);
  const name = NAMES[o.line];
  if (name) {
    newNames[n.line] = name;
    carried++;
  }
  if (COMMENTS[o.line]) newComments[n.line] = COMMENTS[o.line];
}

const matchedNew = new Set(pairs.map(([, ni]) => ni));
const unmatchedNew = newEntities.filter((_, i) => !matchedNew.has(i));
const lostNames = oldEntities.filter((e, i) => matchedOld.has(i) === false && NAMES[e.line]);
const pendingNames = unmatchedNew.filter((e) => e.kind === 'fn' || e.kind === 'decl' || e.kind === 'import');

const sortNum = (obj) => Object.fromEntries(Object.entries(obj).sort((a, b) => Number(a[0]) - Number(b[0])));
fs.writeFileSync(NAMES_JSON, JSON.stringify(sortNum(newNames), null, 2) + '\n');
fs.writeFileSync(COMMENTS_JSON, JSON.stringify(sortNum(newComments), null, 2) + '\n');

const oldVersion = readCoreVersion(OLD);
const newVersion = readCoreVersion(NEW);
const preview = (line) => {
  const src = newSrc.split('\n');
  return (src[line - 1] || '').trim().slice(0, 90);
};

const lines = [];
lines.push(`# 内核对齐报告`);
lines.push('');
lines.push(`- 旧版本：\`${oldVersion}\`（实体 ${oldEntities.length} 个）`);
lines.push(`- 新版本：\`${newVersion}\`（实体 ${newEntities.length} 个）`);
lines.push(`- 自动继承命名：**${carried}** 个`);
lines.push(`- 新增/无法匹配、需要人工命名：**${pendingNames.length}** 个`);
lines.push(`- 旧名失效（上游删除或改动过大）：**${lostNames.length}** 个`);
lines.push('');
if (pendingNames.length) {
  lines.push('## 需要人工命名');
  lines.push('');
  lines.push('| 行号 | 类型 | 代码预览 |');
  lines.push('| --- | --- | --- |');
  for (const e of pendingNames) lines.push(`| L${e.line} | ${e.kind} | \`${preview(e.line).replace(/\|/g, '\\|')}\` |`);
  lines.push('');
}
if (lostNames.length) {
  lines.push('## 旧名失效');
  lines.push('');
  lines.push('| 旧行号 | 名称 | 原始短名 |');
  lines.push('| --- | --- | --- |');
  for (const e of lostNames) lines.push(`| L${e.line} | ${NAMES[e.line]} | ${e.short} |`);
  lines.push('');
}
lines.push('> 补名字：把上表行号写进 `tools/names.json`（键=行号，值=语义名），再跑 `node tools/deobfuscate.mjs`。');
const report = lines.join('\n') + '\n';
if (REPORT) {
  fs.mkdirSync(path.dirname(path.resolve(REPORT)), { recursive: true });
  fs.writeFileSync(path.resolve(REPORT), report);
}
console.log(report);
console.log(`已更新 ${path.basename(NAMES_JSON)}（${Object.keys(newNames).length} 条）、${path.basename(COMMENTS_JSON)}（${Object.keys(newComments).length} 条）`);
console.log(`PENDING_NAMES=${pendingNames.length}`);
