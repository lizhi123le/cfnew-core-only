/**
 * 把压缩内核还原成可读明文：仅做标识符重命名 + 格式化 + 注释，不改变任何逻辑。
 *
 * 输入：_worker.pretty.js（prettier 格式化后的原始压缩代码，行号即映射键）
 * 映射：tools/names.json（行号 → 新名字）、tools/comments.json（行号 → 注释）
 *       —— 这两个文件由 align.mjs 在上游升级后自动重排行号，也可手工编辑。
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
const TOOLS = import.meta.dirname;
const SRC = process.env.CFNEW_PRETTY || path.join(ROOT, '_worker.pretty.js');
const OUT_DIR = path.join(ROOT, 'plain');
const OUT = process.env.CFNEW_OUT || path.join(OUT_DIR, '_worker.js');

const readMap = (env, name) => {
  const p = process.env[env] || path.join(TOOLS, name);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
};
const NAMES = readMap('CFNEW_NAMES', 'names.json');
const COMMENTS = readMap('CFNEW_COMMENTS', 'comments.json');

const code = fs.readFileSync(SRC, 'utf8');
const ast = parse(code, { sourceType: 'module' });

// 先记下全部函数声明（含嵌套）的原始名字与行号，用于报告"尚未命名的函数"，
// 这样上游发新版本时能一眼看出要往 names.json 里补哪些行。
const declaredFunctions = [];
traverse(ast, {
  'FunctionDeclaration|VariableDeclarator'(p) {
    const node = p.node;
    let name = null;
    if (p.isFunctionDeclaration() && node.id) name = node.id.name;
    else if (node.id && node.id.type === 'Identifier' && node.init && (node.init.type === 'ArrowFunctionExpression' || node.init.type === 'FunctionExpression')) name = node.id.name;
    if (!name) return;
    declaredFunctions.push({ line: node.loc.start.line, name });
  },
});

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

for (const k of Object.keys(NAMES)) {
  if (!applied.has(Number(k))) console.error(`! 行 ${k} 未命中任何声明（期望 ${NAMES[k]}）——映射可能已过期，跑 tools/align.mjs 重排`);
}

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

// 版本号从内核本身读，避免 banner 写死
function readCoreVersion() {
  for (const stmt of ast.program.body) {
    if (stmt.type !== 'VariableDeclaration') continue;
    for (const d of stmt.declarations) {
      if (d.id.type === 'Identifier' && d.id.name === 'CORE_VERSION' && d.init && d.init.type === 'StringLiteral') {
        return d.init.value;
      }
    }
  }
  return '未知';
}
const CORE_VERSION = readCoreVersion();

const banner = `/**
 * Cloudflare Worker 内核 —— 精简版（core-only）明文化版本
 *
 * 来源：byJoey/cfnew 分支 core-only 的发布产物 _worker.js（版本 ${CORE_VERSION}）
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
console.log(`已写出 ${OUT} (${out.length} 字符)，内核版本 ${CORE_VERSION}`);

// ── 命名覆盖率报告：上游发新版时据此补映射 ─────────────────────────────
const unmapped = declaredFunctions.filter((f) => !(f.line in NAMES));
console.log(
  `函数总数 ${declaredFunctions.length}，已命名 ${declaredFunctions.length - unmapped.length}，未命名 ${unmapped.length}`,
);
if (unmapped.length) {
  console.log('以下函数还没有名字（在上游新版本里通常是新增/挪动的函数，补到 names.json 即可）：');
  for (const f of unmapped) console.log(`  L${f.line}\t${f.name}`);
}
