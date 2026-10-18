/**
 * Alpha 等价性校验：把两份源码里所有作用域绑定的名字按声明顺序统一替换成
 * c0、c1、……，去掉注释、位置与字面量原始写法后逐字符比较。
 *
 * 若两份代码仅变量名/注释/换行不同，则归一化结果必须完全一致 —— 这证明
 * 明文化版本与原始压缩内核语义等价（重命名没有引入任何逻辑变化）。
 *
 * 注意：混淆产物默认带「惰性噪音」，噪音是额外 AST 节点，不该参与 alpha 比对。
 * 请对混淆核使用：
 *   node tools/build-kernel.mjs --check        # 内部已对 core 做 alpha + 字符串值校验
 *   node tools/obfuscate.mjs --core --stdout > core.js && node tools/verify-alpha.mjs core.js plain/_worker.js
 *
 * 用法：node tools/verify-alpha.mjs 原始.js 明文化.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import _generate from '@babel/generator';

const traverse = _traverse.default || _traverse;
const generate = _generate.default || _generate;

/** 归一化：绑定按声明顺序改成 c0、c1…，抹掉注释/位置/字面量写法。可被其他脚本 import。 */
export function canonicalize(source) {
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

function main() {
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
}

// 只在本文件被 `node` 直接执行时跑 CLI；被 import（build-kernel.mjs）时只提供 canonicalize。
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main();
}
