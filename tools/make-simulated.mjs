// 合成一个"上游升级版" pretty 文件，用来验证 align.mjs 的行号平移与新增/删除识别。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const src = fs.readFileSync(path.join(ROOT, '_worker.pretty.js'), 'utf8');
const lines = src.split(/\r?\n/);

const out = [];
let versionChanged = false;
let sleepRemoved = false;
let fnAdded = false;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];

  // 1) 版本号升级（模块常量值变化，仍应匹配到 CORE_VERSION）
  if (!versionChanged && line.includes('const ht = "2026.10.17.2"')) {
    out.push(line.replace('2026.10.17.2', '2099.01.01.1'));
    versionChanged = true;
    continue;
  }

  // 2) 顶部插入 3 行注释，让后面所有行号整体下移（模拟上游新增逻辑）
  if (line.includes('from "cloudflare:sockets"')) {
    out.push(line, '// 新增注释 A', '// 新增注释 B', '// 新增注释 C');
    continue;
  }

  // 3) 删掉一个函数（模拟上游移除 sleep）
  if (!sleepRemoved && /^\s*function he\(e\) \{/.test(line)) {
    sleepRemoved = true;
    i += 2; // 跳过函数体剩余两行
    continue;
  }

  // 4) 新增一个函数（模拟上游新增能力，期望被报告为"需要人工命名"）
  if (!fnAdded && /^\s*return On;$/.test(line)) {
    out.push('  function zeng(e) {', '    return e * 2;', '  }');
    fnAdded = true;
  }

  out.push(line);
}

const target = path.join(ROOT, '_worker.pretty.simulated.js');
fs.writeFileSync(target, out.join('\n'));
console.log(`已生成 ${target}（${out.length} 行）`);
console.log('替换检查:', { versionChanged, sleepRemoved, fnAdded });
