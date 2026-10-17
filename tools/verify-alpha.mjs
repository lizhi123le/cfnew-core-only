/**
 * Alpha 等价性校验：把两份源码里所有作用域绑定的名字按声明顺序统一替换成
 * c0、c1、……，去掉注释、位置与字面量原始写法后逐字符比较。
 *
 * 若两份代码仅变量名/注释/换行不同，则归一化结果必须完全一致 —— 这证明
 * 明文化版本与原始压缩内核语义等价（重命名没有引入任何逻辑变化）。
 *
 * 用法：node tools/verify-alpha.mjs _worker.js plain/_worker.js
 */
import fs from 'node:fs';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import _generate from '@babel/generator';

const traverse = _traverse.default || _traverse;
const generate = _generate.default || _generate;

function canonicalize(source) {
  const ast = parse(source, { sourceType: 'module' });
  const scopes = [];
  traverse(ast, {
    Scope(p) {
      scopes.push(p.scope);
    },
  });
  let n = 0;
  for (const scope of scopes) {
    const bindings = Object.values(scope.bindings).sort((a, b) => a.identifier.start - b.identifier.start);
    for (const binding of bindings) {
      const old = binding.identifier.name;
      if (scope.getBinding(old) !== binding) continue;
      scope.rename(old, 'c' + n++);
    }
  }
  traverse(ast, {
    enter(p) {
      delete p.node.extra;
      p.node.leadingComments = null;
      p.node.trailingComments = null;
      p.node.innerComments = null;
    },
  });
  return generate(ast, { comments: false, compact: true, jsescOption: { minimal: true } }).code;
}

const [a, b] = process.argv.slice(2);
if (!a || !b) {
  console.error('用法: node tools/verify-alpha.mjs <原始> <明文化>');
  process.exit(2);
}
const ca = canonicalize(fs.readFileSync(a, 'utf8'));
const cb = canonicalize(fs.readFileSync(b, 'utf8'));
if (ca === cb) {
  console.log(`✅ alpha 等价：${a} ≡ ${b}（仅标识符/注释/格式不同，逻辑一致）`);
  console.log(`   归一化长度 ${ca.length} 字符`);
  process.exit(0);
}
let i = 0;
while (i < Math.min(ca.length, cb.length) && ca[i] === cb[i]) i++;
console.error(`❌ 不一致，首个差异在第 ${i} 个字符`);
console.error(' 原始: ' + ca.slice(Math.max(0, i - 80), i + 160));
console.error(' 明文化: ' + cb.slice(Math.max(0, i - 80), i + 160));
process.exit(1);
