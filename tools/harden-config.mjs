/**
 * harden.config.json：体积预算 / 单行参数的唯一入口。
 *
 * 优先级（从高到低）：CLI > 环境变量 > 仓库根目录 harden.config.json > 默认值。
 * 配置文件可选；`--config=path` / `CFNEW_HARDEN_CONFIG` 可以指定别的路径。
 *
 * 体积写法（targetBytes / targetZipBytes）：
 *   320000 / 320k / 1m   绝对字节（k/m 按 1024 进制）
 *   75%                  相对「首次混淆产物」的百分比（raw 目标相对 raw，zip 目标相对 zip）
 *   0                    关闭该限制（显式写 0 与不写不同：不写=保留默认行为，0=不再检查）
 *
 * 注意：这里的 targetBytes 是**上限预算**，不是混淆时分配转义/噪音的
 * `--target-size`（后者决定产物想落在多大）。两者用途不同，见 tools/README.md。
 *
 * 示例：
 *   { "targetBytes": "522k", "targetZipBytes": "232k", "maxRuns": 20, "oneLine": true }
 */
import fs from 'node:fs';
import path from 'node:path';

const TOOLS = import.meta.dirname;
const ROOT = path.resolve(TOOLS, '..');

export const DEFAULT_HARDEN_CONFIG_PATH = path.join(ROOT, 'harden.config.json');
export { ROOT as HARDEN_ROOT };

const SIZE_RE = /^(\d+(?:\.\d+)?)\s*(b|k|kb|kib|m|mb|mib)?$/i;

/** 解析体积参数；返回 { kind: 'bytes'|'percent', value } 或 null（0 / 空 = 关闭）。 */
export function parseSizeSpec(value, label = '体积参数') {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'boolean') throw new Error(`${label} 不能是布尔值：${value}`);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${label} 必须是非负数：${value}`);
    const bytes = Math.round(value);
    return bytes > 0 ? { kind: 'bytes', value: bytes } : null;
  }

  const text = String(value).trim().toLowerCase();
  if (text.endsWith('%')) {
    const percent = Number(text.slice(0, -1));
    if (!Number.isFinite(percent) || percent < 0) {
      throw new Error(`${label} 百分比不合法：${value}（应形如 75%，0% 表示关闭）`);
    }
    return percent > 0 ? { kind: 'percent', value: percent } : null;
  }

  const match = text.match(SIZE_RE);
  if (!match) throw new Error(`${label} 无法解析：${value}（支持 320000 / 320k / 1m / 75% / 0）`);
  const unit = (match[2] || 'b').toLowerCase();
  const factor = unit === 'b' ? 1 : unit.startsWith('k') ? 1024 : 1024 * 1024;
  const bytes = Math.round(Number(match[1]) * factor);
  return bytes > 0 ? { kind: 'bytes', value: bytes } : null;
}

/** 日志/记录里使用的规范字符串；null 表示不限制。 */
export function formatSizeSpec(spec) {
  if (!spec) return '';
  return spec.kind === 'percent' ? `${spec.value}%` : String(spec.value);
}

function toBool(value, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['false', '0', 'no', 'off'].includes(text)) return false;
  if (['true', '1', 'yes', 'on'].includes(text)) return true;
  throw new Error(`${label} 必须是布尔值：${value}`);
}

function toInt(value, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${label} 必须是非负整数：${value}`);
  return n;
}

function readConfig(configPath, required) {
  if (!fs.existsSync(configPath)) {
    if (required) throw new Error(`找不到配置文件：${configPath}`);
    return {};
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`配置文件不是合法 JSON：${configPath}（${error.message}）`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`配置文件必须是 JSON 对象：${configPath}`);
  }
  return raw;
}

const ENV_NAMES = {
  targetBytes: ['CFNEW_TARGET_BYTES', 'HARDEN_TARGET_BYTES'],
  targetZipBytes: ['CFNEW_TARGET_ZIP_BYTES', 'HARDEN_TARGET_ZIP_BYTES', 'HARDEN_TARGET_ZIP'],
  maxRuns: ['CFNEW_MAX_RUNS', 'HARDEN_SIZE_MAX_RUNS', 'HARDEN_MAX_RUNS'],
  oneLine: ['CFNEW_ONE_LINE', 'HARDEN_ONE_LINE'],
  config: ['CFNEW_HARDEN_CONFIG', 'HARDEN_CONFIG'],
};

function firstEnv(env, names) {
  for (const name of names) {
    if (env[name] !== undefined && env[name] !== '') return env[name];
  }
  return undefined;
}

/**
 * @param {object} [options]
 * @param {Map<string,string>} [options.opts]  parseCliArgs 的带值参数
 * @param {Set<string>} [options.flags]        parseCliArgs 的开关
 * @param {NodeJS.ProcessEnv} [options.env]
 * @returns {{
 *   configPath: string,
 *   configExists: boolean,
 *   targetBytes: {kind:'bytes'|'percent',value:number}|null,
 *   targetZipBytes: {kind:'bytes'|'percent',value:number}|null,
 *   maxRuns: number,
 *   oneLine: boolean,
 *   provided: {targetBytes:boolean,targetZipBytes:boolean,maxRuns:boolean,oneLine:boolean},
 * }}
 */
export function loadHardenParams({ opts = new Map(), flags = new Set(), env = process.env } = {}) {
  const explicitConfig = opts.get('config') ?? firstEnv(env, ENV_NAMES.config);
  const configPath = explicitConfig
    ? path.resolve(ROOT, explicitConfig)
    : DEFAULT_HARDEN_CONFIG_PATH;
  const config = readConfig(configPath, Boolean(explicitConfig));
  const configExists = fs.existsSync(configPath);

  const pick = (flag, envNames, configKey) => {
    if (opts.has(flag)) return opts.get(flag);
    const fromEnv = firstEnv(env, envNames);
    if (fromEnv !== undefined) return fromEnv;
    if (config[configKey] !== undefined) return config[configKey];
    return undefined;
  };

  const rawTargetValue = pick('target-bytes', ENV_NAMES.targetBytes, 'targetBytes');
  const zipTargetValue = pick('target-zip', ENV_NAMES.targetZipBytes, 'targetZipBytes');
  const maxRunsValue = pick('max-runs', ENV_NAMES.maxRuns, 'maxRuns');

  // --one-line=false / --no-one-line / --one-line 都支持
  let oneLineValue;
  if (opts.has('one-line')) oneLineValue = opts.get('one-line');
  else if (flags.has('no-one-line')) oneLineValue = false;
  else if (flags.has('one-line')) oneLineValue = true;
  else {
    oneLineValue = firstEnv(env, ENV_NAMES.oneLine);
    if (oneLineValue === undefined && config.oneLine !== undefined) oneLineValue = config.oneLine;
  }

  return {
    configPath,
    configExists,
    targetBytes: parseSizeSpec(rawTargetValue, 'targetBytes'),
    targetZipBytes: parseSizeSpec(zipTargetValue, 'targetZipBytes'),
    maxRuns: Math.max(1, toInt(maxRunsValue, 1, 'maxRuns')),
    oneLine: toBool(oneLineValue, true, 'oneLine'),
    provided: {
      targetBytes: rawTargetValue !== undefined,
      targetZipBytes: zipTargetValue !== undefined,
      maxRuns: maxRunsValue !== undefined,
      oneLine: oneLineValue !== undefined,
    },
  };
}
