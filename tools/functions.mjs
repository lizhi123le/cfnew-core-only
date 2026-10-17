// 列出所有函数（含嵌套），用于命名映射。
import fs from 'node:fs';
import { parse } from '@babel/parser';
import _generate from '@babel/generator';
const generate = _generate.default || _generate;
const file = process.argv[2];
const code = fs.readFileSync(file, 'utf8');
const ast = parse(code, { sourceType: 'module' });

const found = [];
function walk(node, depth, parentName) {
  if (!node || typeof node.type !== 'string') return;
  if (node.type === 'FunctionDeclaration') {
    found.push({ depth, name: node.id.name, params: node.params.map((p) => generate(p).code).join(','), line: node.loc.start.line, size: generate(node.body).code.length, head: generate(node.body).code.replace(/\s+/g, ' ').slice(0, 130), parent: parentName });
    parentName = node.id.name;
  }
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
    const v = node[key];
    if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && walk(c, depth + 1, parentName));
    else if (v && typeof v.type === 'string') walk(v, depth + 1, parentName);
  }
  if (node.type === 'VariableDeclarator' && node.init && (node.init.type === 'ArrowFunctionExpression' || node.init.type === 'FunctionExpression')) {
    const f = node.init;
    found.push({ depth, name: node.id.name, params: f.params.map((p) => generate(p).code).join(','), line: node.loc.start.line, size: generate(f.body).code.length, head: generate(f.body).code.replace(/\s+/g, ' ').slice(0, 130), parent: parentName });
  }
}
walk(ast, 0, '');
found.sort((a, b) => a.line - b.line);
for (const r of found) {
  console.log(`${'  '.repeat(Math.min(r.depth, 8))}${r.name}(${r.params}) L${r.line} [${r.size}]\t${r.head}`);
}
console.log(`\ntotal functions: ${found.length}`);
