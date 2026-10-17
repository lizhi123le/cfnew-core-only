// 打印内核顶层结构骨架，用于人工命名映射。
import fs from 'node:fs';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import _generate from '@babel/generator';

const traverse = _traverse.default || _traverse;
const generate = _generate.default || _generate;
const file = process.argv[2];
const code = fs.readFileSync(file, 'utf8');
const ast = parse(code, { sourceType: 'module', plugins: [] });

const rows = [];
function describe(node, kind, exported) {
  const params = (node.params || []).map((p) => generate(p).code).join(', ');
  const body = node.body ? generate(node.body).code.replace(/\s+/g, ' ') : '';
  return {
    kind,
    name: node.id ? node.id.name : '',
    params,
    exported,
    lines: node.loc ? `${node.loc.start.line}-${node.loc.end.line}` : '',
    head: body.slice(0, 180),
    size: body.length,
  };
}

for (const stmt of ast.program.body) {
  if (stmt.type === 'FunctionDeclaration') rows.push(describe(stmt, 'function', false));
  else if (stmt.type === 'VariableDeclaration') {
    for (const d of stmt.declarations) {
      const n = d.id.name;
      const init = d.init;
      if (init && (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression')) {
        rows.push(describe({ id: d.id, params: init.params, body: init.body, loc: stmt.loc }, 'arrow', false));
      } else {
        rows.push({ kind: 'const', name: n, params: '', exported: false, lines: stmt.loc ? `${stmt.loc.start.line}-${stmt.loc.end.line}` : '', head: init ? generate(init).code.replace(/\s+/g, ' ').slice(0, 180) : '', size: init ? generate(init).code.length : 0 });
      }
    }
  } else if (stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportDefaultDeclaration') {
    const d = stmt.declaration;
    if (!d) continue;
    if (d.type === 'FunctionDeclaration') rows.push(describe(d, 'function', true));
    else if (d.type === 'VariableDeclaration') {
      for (const dec of d.declarations) {
        if (dec.init && (dec.init.type === 'ArrowFunctionExpression' || dec.init.type === 'FunctionExpression')) {
          rows.push(describe({ id: dec.id, params: dec.init.params, body: dec.init.body, loc: stmt.loc }, 'arrow', true));
        } else {
          rows.push({ kind: 'const', name: dec.id.name, params: '', exported: true, lines: stmt.loc ? `${stmt.loc.start.line}-${stmt.loc.end.line}` : '', head: dec.init ? generate(dec.init).code.replace(/\s+/g, ' ').slice(0, 180) : '', size: 0 });
        }
      }
    } else if (d.type === 'Identifier') {
      rows.push({ kind: 'export-ref', name: d.name, params: '', exported: true, lines: '', head: '', size: 0 });
    }
  } else if (stmt.type === 'ClassDeclaration') {
    rows.push({ kind: 'class', name: stmt.id.name, params: '', exported: false, lines: `${stmt.loc.start.line}-${stmt.loc.end.line}`, head: '', size: 0 });
  }
}

for (const r of rows) {
  console.log(`${r.kind}${r.exported ? '*' : ''}\t${r.name}(${r.params})\t${r.lines}\t${r.size}\t${r.head}`);
}
console.log(`\ntotal top-level: ${rows.length}`);
