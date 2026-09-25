/**
 * wt-args.mjs —— 四个 wt-*.mjs 共用的参数解析
 *
 * 设计要点：
 *   - **数值参数一律显式校验**：非法值（NaN / Infinity / 越界 / 非整数）**立刻报错退出**，
 *     不再静默变成 NaN 往下传（那会让「请求风暴」「上限永不触发」「静默给错结果」这类
 *     问题以最难查的形式出现）。
 *   - 报错信息里带上**参数名、收到的值、允许范围**，用户一眼知道错在哪。
 *   - 纯 ESM、零依赖，和 wt-*.mjs 同目录即可用。
 *
 * 用法：
 *   import { posArg, strOpt, numOpt } from './wt-args.mjs';
 *   const dir = posArg(argv, '用法: node wt-track.mjs <数据目录> [--tol-deg 20]');
 *   const TOL = numOpt(argv, 'tol-deg', 20, { min: 0, max: 180, label: '容差角度(度)' });
 */

/** 取第一个非 `--` 开头的参数（数据目录）。缺失则打印用法并退出。 */
export function posArg(argv, usage) {
  const v = argv.find((a) => !a.startsWith('--'));
  if (!v) { console.error(usage); process.exit(2); }
  return v;
}

/**
 * 取字符串选项。
 * ⚠️ 注意 `def` **不能给默认值 `''`** —— 否则调用方传 `undefined` 时默认值会生效，
 * 让"用户没给这个参数"和"用户给了空值"变得无法区分（numOpt 就会误报"收到 ''"）。
 * 用法约定：传 `undefined` 表示"我要区分有没有给"。
 */
export function strOpt(argv, name, def) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;                       // 没给这个选项
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) return def;  // 给了但没带值（后面紧跟另一个选项）
  return String(v);
}

/** 取布尔开关（出现即 true）。 */
export function flag(argv, name) {
  return argv.includes('--' + name);
}

/**
 * 取数值选项，并做强校验。
 * @param {string[]} argv
 * @param {string} name        选项名（不带 --）
 * @param {number} def         默认值
 * @param {{min?:number,max?:number,int?:boolean,label?:string}} [o]
 * @returns {number}
 */
export function numOpt(argv, name, def, o = {}) {
  const raw = strOpt(argv, name, undefined);
  if (raw === undefined) return def;
  const label = o.label || name;
  const n = Number(raw);
  if (raw === '' || !Number.isFinite(n)) {
    console.error(`✗ --${name} 需要一个数字（${label}），收到：${JSON.stringify(raw)}`);
    process.exit(2);
  }
  if (o.int && !Number.isInteger(n)) {
    console.error(`✗ --${name} 需要整数（${label}），收到：${raw}`);
    process.exit(2);
  }
  if (o.min !== undefined && n < o.min) {
    console.error(`✗ --${name} 不能小于 ${o.min}（${label}），收到：${raw}`);
    process.exit(2);
  }
  if (o.max !== undefined && n > o.max) {
    console.error(`✗ --${name} 不能大于 ${o.max}（${label}），收到：${raw}`);
    process.exit(2);
  }
  return n;
}
