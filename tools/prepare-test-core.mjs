/**
 * 为 cfnew-panel 测试准备一份「等价但可打桩」的副本。
 *
 * 发布产物会把模块说明符和 import 绑定名转义（`cloudflare:\x73...`、`\u0063onnect`），
 * 而面板测试用正则 `import{connect as X}from"cloudflare:sockets"` 把 connect 换成桩函数。
 * 这里只把这些「语法书写形式」规范化回原文（值不变），再交给测试；发布产物本身不受影响。
 *
 * 用法：node tools/prepare-test-core.mjs <输入> <输出>
 */
import fs from 'node:fs';
import { normalizeModuleSpecifiers } from './keywords.mjs';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('用法: node tools/prepare-test-core.mjs <输入> <输出>');
  process.exit(2);
}
const source = fs.readFileSync(input, 'utf8');
const { code, normalized } = normalizeModuleSpecifiers(source);
fs.writeFileSync(output, code);
console.log(`测试副本：${input} -> ${output}（还原 ${normalized} 个模块说明符；字符串值未变）`);
