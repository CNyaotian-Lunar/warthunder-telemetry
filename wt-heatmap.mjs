#!/usr/bin/env node
/**
 * 缠斗热区图 —— 用 /map_obj.json 的全场飞机坐标算"聚集度"，标出几架挤在一起的空域
 *
 *   node wt-heatmap.mjs <数据目录> [选项]
 *
 * 选项：
 *   --radius-km N   判定同一场缠斗的距离阈值（默认 5 km）
 *   --min-planes N  至少几架互相在半径内才算热区（默认 3）
 *   --grid N        热度网格分辨率（默认 64）
 *   --bin-sec N     时刻表聚合粒度秒（默认 15）
 *
 * 产出：<数据目录>/heatmap.svg、<数据目录>/heatmap.md
 *
 * 原理：8111 的归一化坐标 1.0 = 131072 世界单位(=米) = 131.072 km
 *      对每个快照，若某架飞机半径内有 >= min-planes-1 架邻机，就给它所在网格加权重。
 */
import fs from 'node:fs';
import path from 'node:path';
import { numOpt, posArg } from './wt-args.mjs';

const argv = process.argv.slice(2);
const dir = posArg(argv, '用法: node wt-heatmap.mjs <数据目录> [--radius-km 5] [--min-planes 3] [--grid 64] [--bin-sec 15]');
const R_KM = numOpt(argv, 'radius-km', 5, { min: 0.1, max: 200, label: '缠斗半径(km)' });
const MIN_P = numOpt(argv, 'min-planes', 3, { min: 2, max: 64, int: true, label: '判定热区的最少飞机数' });
const GRID = numOpt(argv, 'grid', 64, { min: 4, max: 1024, int: true, label: '热度网格分辨率' });
const BIN = numOpt(argv, 'bin-sec', 15, { min: 1, max: 600, int: true, label: '时刻表聚合粒度(秒)' });
const KM_PER_UNIT = 131.072;

const rows = fs.readFileSync(path.join(dir, 'objects.jsonl'), 'utf8').split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((o) => o && o.objs && o.objs.length);
if (!rows.length) { console.error('objects.jsonl 里没有有效快照'); process.exit(1); }

const heat = new Float64Array(GRID * GRID);
const marks = [];
let hot = 0, total = 0, maxPlanes = 0;
for (const snap of rows) {
  const ac = snap.objs.filter((o) => o.type === 'aircraft' && typeof o.x === 'number' && typeof o.y === 'number');
  total++;
  if (ac.length < MIN_P) continue;
  let best = { n: 0, cx: 0, cy: 0 };
  for (let i = 0; i < ac.length; i++) {
    let n = 0, sx = ac[i].x, sy = ac[i].y;
    for (let j = 0; j < ac.length; j++) {
      if (i === j) continue;
      const dx = (ac[j].x - ac[i].x) * KM_PER_UNIT, dy = (ac[j].y - ac[i].y) * KM_PER_UNIT;
      if (Math.hypot(dx, dy) <= R_KM) { n++; sx += ac[j].x; sy += ac[j].y; }
    }
    if (n + 1 >= MIN_P) {
      const w = n + 1;
      const gx = Math.min(GRID - 1, Math.max(0, Math.floor(ac[i].x * GRID)));
      const gy = Math.min(GRID - 1, Math.max(0, Math.floor(ac[i].y * GRID)));
      heat[gy * GRID + gx] += w;
      if (w > best.n) best = { n: w, cx: sx / (n + 1), cy: sy / (n + 1) };
    }
  }
  if (best.n >= MIN_P) {
    hot++;
    maxPlanes = Math.max(maxPlanes, best.n);
    marks.push({ ts: snap.ts, t: snap.t, n: best.n, cx: best.cx, cy: best.cy });
  }
}
const maxHeat = heat.reduce((m, v) => Math.max(m, v), 0) || 1;

// ---------- 时刻表（按 BIN 秒聚合，取该桶最热的一刻） ----------
const t0 = Date.parse(rows[0].ts);
const rt = (iso) => (Date.parse(iso) - t0) / 1000;
const mmss = (s) => { const x = Math.round(s); return `${Math.floor(x / 60)}:${String(x % 60).padStart(2, '0')}`; };
const buckets = new Map();
for (const m of marks) {
  const k = Math.floor(rt(m.ts) / BIN);
  const cur = buckets.get(k);
  if (!cur || m.n > cur.n) buckets.set(k, m);
}
const timeline = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([, m]) => m);

// ---------- SVG ----------
{
  const S = 1024, CELL = S / GRID;
  const svg = [];
  svg.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">`);
  svg.push(`<rect width="${S}" height="${S}" fill="#0b0f0b"/>`);
  if (fs.existsSync(path.join(dir, 'map.img'))) svg.push(`<image x="0" y="0" width="${S}" height="${S}" xlink:href="map.img" preserveAspectRatio="none" opacity="0.75"/>`);
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      const v = heat[gy * GRID + gx];
      if (!v) continue;
      const k = v / maxHeat;
      const hue = 55 * (1 - Math.min(1, k * 1.4));
      svg.push(`<rect x="${(gx * CELL).toFixed(1)}" y="${(gy * CELL).toFixed(1)}" width="${CELL.toFixed(1)}" height="${CELL.toFixed(1)}" fill="hsl(${hue.toFixed(0)},100%,50%)" opacity="${(0.12 + 0.6 * k).toFixed(2)}"/>`);
    }
  }
  for (const m of marks) {
    if (m.n >= MIN_P + 2) svg.push(`<circle cx="${(m.cx * S).toFixed(1)}" cy="${(m.cy * S).toFixed(1)}" r="7" fill="none" stroke="#fff" stroke-width="1.5" opacity="0.75"><title>${mmss(rt(m.ts))} 附近 ${m.n} 架</title></circle>`);
  }
  const lines = [
    `缠斗热区 · 半径 ${R_KM} km / ≥${MIN_P} 架`,
    `快照 ${total} 个，含热区 ${hot} 个（${((hot / total) * 100).toFixed(0)}%）`,
    `最大聚集 ${maxPlanes} 架`,
    `暖黄 → 深红 = 聚集越频繁`,
  ];
  svg.push(`<g font-family="monospace" font-size="16" fill="#f2f2f2"><rect x="8" y="8" width="360" height="${22 * lines.length + 16}" fill="#000" opacity="0.6"/>`);
  lines.forEach((s, i) => svg.push(`<text x="18" y="${32 + i * 22}">${s}</text>`));
  svg.push(`</g></svg>`);
  fs.writeFileSync(path.join(dir, 'heatmap.svg'), svg.join('\n'), 'utf8');
}

// ---------- MD ----------
const L = [];
L.push('# 缠斗热区分析', '');
L.push(`- 判据：两机相距 ≤ **${R_KM} km** 视为同一场缠斗；同一时刻有 **≥${MIN_P} 架**互相在半径内即计为热区`);
L.push(`- 快照：${total} 个，其中含热区 **${hot}** 个（${((hot / total) * 100).toFixed(1)}%）；全程最大聚集 **${maxPlanes} 架**`);
L.push(`- 热区地图：\`heatmap.svg\`（浏览器直接打开）`, '');
L.push('## 热区时刻表', '', '| 时刻 | 聚集架数 | 位置(归一化 x,y) |', '|---|---|---|');
for (const m of timeline) L.push(`| ${mmss(rt(m.ts))} | ${m.n} | ${m.cx.toFixed(3)}, ${m.cy.toFixed(3)} |`);
L.push('');
fs.writeFileSync(path.join(dir, 'heatmap.md'), L.join('\n'), 'utf8');

console.log(`快照 ${total} / 热区 ${hot} / 最大聚集 ${maxPlanes} 架`);
console.log('  ' + path.join(dir, 'heatmap.svg'));
console.log('  ' + path.join(dir, 'heatmap.md'));
