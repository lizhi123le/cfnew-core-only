/**
 * 查看内核结构，辅助命名。
 *
 *   node structure.mjs                 # 顶层结构：kind/名字/参数/行号/体积/首行摘要
 *   node structure.mjs --functions     # 全部函数（含嵌套层级），定位内部函数用
 *   node structure.mjs --file ../_worker.pretty.js
 *
 * 行号就是 names.json / comments.json 的键，所以输出直接可以照着填。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';
import _generate from '@babel/generator';

const generate = _generate.default || _generate;

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const FILE = path.resolve(arg('file', path.join(import.meta.dirname, '..', '_worker.pretty.js')));
const SHOW_FUNCTIONS = argv.includes('--functions');
const code = fs.readFileSync(FILE, 'utf8');
const ast = parse(code, { sourceType: 'module' });

const brief = (node, limit = 130) => generate(node).code.replace(/\s+/g, ' ').slice(0, limit);

if (!SHOW_FUNCTIONS) {
  console.log(`# 顶层结构：${path.basename(FILE)}\n`);
  const rows = [];
  for (const stmt of ast.program.body) {
    if (stmt.type === 'ImportDeclaration') {
      const imported = stmt.specifiers.map((s) => `${s.imported ? s.imported.name + ' as ' : ''}${s.local.name}`).join(', ');
      rows.push(['import', imported, '', stmt.loc.start.line, '', stmt.source.value]);
    } else if (stmt.type === 'FunctionDeclaration') {
      rows.push(['function', stmt.id.name, stmt.params.length, stmt.loc.start.line, stmt.loc.end.line - stmt.loc.start.line + 1, brief(stmt.body)]);
    } else if (stmt.type === 'VariableDeclaration') {
      for (const d of stmt.declarations) {
        const isFn = d.init && ['ArrowFunctionExpression', 'FunctionExpression'].includes(d.init.type);
        rows.push([
          isFn ? 'function' : 'const',
          d.id.name,
          isFn ? d.init.params.length : '',
          stmt.loc.start.line,
          isFn ? stmt.loc.end.line - stmt.loc.start.line + 1 : '',
          isFn ? brief(d.init.body) : brief(d.init || { type: 'NullLiteral' }),
        ]);
      }
    }
  }
  for (const [kind, name, params, line, lines, head] of rows) {
    console.log(`${kind.padEnd(8)} ${name}(${params})`.padEnd(42) + `L${line}\t${lines ? lines + ' 行' : ''}\t${head}`);
  }
  console.log(`\n顶层声明 ${rows.length} 个。加 --functions 看全部函数（含嵌套）。`);
} else {
  const found = [];
  const walk = (node, depth) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'FunctionDeclaration') {
      found.push({ depth, name: node.id.name, params: node.params.length, line: node.loc.start.line, size: generate(node.body).code.length, head: brief(node.body) });
    }
    for (const key of Object.keys(node)) {
      if (['loc', 'leadingComments', 'trailingComments', 'extra'].includes(key)) continue;
      const v = node[key];
      if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && walk(c, depth + 1));
      else if (v && typeof v.type === 'string') walk(v, depth + 1);
    }
    if (node.type === 'VariableDeclarator' && node.init && ['ArrowFunctionExpression', 'FunctionExpression'].includes(node.init.type)) {
      found.push({ depth, name: node.id.name, params: node.init.params.length, line: node.loc.start.line, size: generate(node.init.body).code.length, head: brief(node.init.body) });
    }
  };
  walk(ast, 0);
  found.sort((a, b) => a.line - b.line);
  console.log(`# 全部函数（含嵌套）：${path.basename(FILE)}\n`);
  for (const f of found) console.log(`${'  '.repeat(Math.min(f.depth, 8))}${f.name}(${f.params}) L${f.line} [${f.size}]\t${f.head}`);
  console.log(`\n共 ${found.length} 个函数。行号 = names.json 的键。`);
}
