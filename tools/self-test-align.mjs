/**
 * align.mjs 的回归自测：拿当前内核造一个"上游升级版"（整体下移若干行 + 版本号变更），
 * 跑一遍对齐，断言命名 100% 继承、无新增待命名。
 *
 *   node self-test-align.mjs            # 通过退出码 0，失败非 0
 *
 * 覆盖的是 align 最关键的两条性质：
 *   1. 行号整体平移（上游插入/删除代码）不影响命名继承；
 *   2. 模块常量值变化（版本号每次都变）仍能匹配到同一个实体。
 * CI 的 verify job 会跑它，防止 align 改动悄悄退化。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const TOOLS = import.meta.dirname;
const ROOT = path.resolve(TOOLS, '..');
const PRETTY = path.join(ROOT, '_worker.pretty.js');
const names = JSON.parse(fs.readFileSync(path.join(TOOLS, 'names.json'), 'utf8'));
const entityCount = Object.keys(names).length;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfnew-align-selftest-'));
const lines = fs.readFileSync(PRETTY, 'utf8').split(/\r?\n/);

let shifted = false;
let versionBumped = false;
const simulated = [];
for (const line of lines) {
  // 1) 在 import 之后插 5 行注释，模拟上游在文件顶部新增代码
  if (!shifted && line.includes('cloudflare:sockets')) {
    simulated.push(line, '// simulate: upstream inserted lines', '// simulate: 1', '// simulate: 2', '// simulate: 3', '// simulate: 4');
    shifted = true;
    continue;
  }
  // 2) 改版本号：模块常量值变化不应破坏实体匹配
  if (!versionBumped && /^const ht = "[^"]+",?$/.test(line)) {
    simulated.push(line.replace(/"[^"]+"/, '"2099.01.01.1"'));
    versionBumped = true;
    continue;
  }
  simulated.push(line);
}

if (!shifted || !versionBumped) {
  console.error('❌ 自测前置条件不满足：没找到 import 行或版本常量，内核格式可能已变，请更新 self-test-align.mjs');
  process.exit(1);
}

const simPath = path.join(tmp, '_worker.pretty.simulated.js');
fs.writeFileSync(simPath, simulated.join('\n'));
const tmpNames = path.join(tmp, 'names.json');
const tmpComments = path.join(tmp, 'comments.json');
fs.copyFileSync(path.join(TOOLS, 'names.json'), tmpNames);
fs.copyFileSync(path.join(TOOLS, 'comments.json'), tmpComments);

let out = '';
try {
  out = execFileSync(
    process.execPath,
    [path.join(TOOLS, 'align.mjs'), '--old', PRETTY, '--new', simPath, '--names', tmpNames, '--comments', tmpComments],
    { encoding: 'utf8' },
  );
} catch (error) {
  console.error('❌ align.mjs 执行失败\n' + (error.stdout || '') + (error.stderr || ''));
  process.exit(1);
}

const carried = Number((out.match(/自动继承命名：\*\*(\d+)\*\*/) || [])[1] ?? -1);
const pending = Number((out.match(/PENDING_NAMES=(\d+)/) || [])[1] ?? -1);

const checks = [
  ['继承了全部命名', carried === entityCount, `carried=${carried} 期望 ${entityCount}`],
  ['没有新增待命名', pending === 0, `pending=${pending}`],
];

let ok = true;
for (const [label, pass, detail] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${label}${pass ? '' : ' — ' + detail}`);
  ok = ok && pass;
}
console.log(ok ? `\n✅ align 回归自测通过（${entityCount} 个实体，行号平移 + 版本变更后全部继承）` : '\n❌ align 回归自测失败');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
