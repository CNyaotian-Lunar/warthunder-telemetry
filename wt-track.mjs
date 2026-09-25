#!/usr/bin/env node
/**
 * 航迹还原 —— 把「自己」从 /map_obj.json 的全场飞机里认出来，并画出这一局的航迹
 *
 *   node wt-track.mjs <数据目录> [--tol-deg 20]
 *
 * 定位方式：
 *   ① **首选**：8111 会把自己的飞机标成 `icon: "Player"` —— 直接取坐标即可（实测 81/84 快照都有）
 *   ② 兜底：`/indicators` 的 `compass` 是自己的真航向，每架 aircraft 带 `dx/dy` 航向向量
 *      （地图坐标 x 向右=东、y 向下=南）⇒ 航向角 `atan2(dx, -dy)` 与 compass 最接近的那架
 *
 * 产出：<数据目录>/track.svg、<数据目录>/track.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { numOpt, posArg } from './wt-args.mjs';

const argv = process.argv.slice(2);
const dir = posArg(argv, '用法: node wt-track.mjs <数据目录> [--tol-deg 20]');
const TOL = numOpt(argv, 'tol-deg', 20, { min: 0, max: 180, label: '容差角度(度)' });
const KM_PER_UNIT = 131.072;

const readJsonl = (f) => {
  const p = path.join(dir, f);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
};
const snaps = readJsonl('objects.jsonl').filter((o) => o.objs && o.objs.length);
if (!snaps.length) { console.error('objects.jsonl 为空'); process.exit(1); }
const flight = readJsonl('flight.jsonl').filter((s) => typeof s.compass === 'number');
const anyPlayer = snaps.some((s) => s.objs.some((o) => o.icon === 'Player'));
if (!anyPlayer && !flight.length) { console.error('数据里既没有 icon=Player 也没有 compass —— 只有 2026-09-21 之后的采集器能定位'); process.exit(1); }

const norm = (d) => { let x = d % 360; if (x < 0) x += 360; return x; };
const angDiff = (a, b) => { const d = Math.abs(norm(a) - norm(b)); return d > 180 ? 360 - d : d; };
const T0 = Date.parse(snaps[0].ts);
const rt = (iso) => (Date.parse(iso) - T0) / 1000;
const mmss = (s) => { const x = Math.round(s); return `${Math.floor(x / 60)}:${String(x % 60).padStart(2, '0')}`; };
// 遥测时间戳预解析一次（采集是顺序写入，所以单调递增）—— 供二分查找
const flightTs = flight.map((f) => Date.parse(f.ts));
/** 取最接近 iso 的遥测罗盘值（二分，O(log n)；原实现每个快照都线性扫一遍全部遥测 = O(n×m)） */
const compassAt = (iso) => {
  if (!flight.length) return null;
  const t = Date.parse(iso);
  let lo = 0, hi = flightTs.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (flightTs[mid] < t) lo = mid + 1; else hi = mid; }
  let best = null;
  for (const i of [lo, lo - 1]) {
    if (i < 0 || i >= flightTs.length) continue;
    const d = Math.abs(flightTs[i] - t);
    if (!best || d < best.d) best = { d, c: flight[i].compass };
  }
  return best && best.d < 2500 ? best : null;
};

const track = [];
let viaIcon = 0, viaHeading = 0, rejected = 0;
for (const snap of snaps) {
  const ac = snap.objs.filter((o) => o.type === 'aircraft' && typeof o.x === 'number' && typeof o.y === 'number');
  if (!ac.length) continue;
  let pick = null;
  const me = ac.find((a) => a.icon === 'Player');
  if (me) { pick = { a: me, d: 0, via: 'icon' }; viaIcon++; }
  else {
    const cm = compassAt(snap.ts);
    if (cm) {
      let best = null;
      for (const a of ac) {
        if (typeof a.dx !== 'number') continue;
        const hdg = norm(Math.atan2(a.dx, -a.dy) * 180 / Math.PI);
        const d = angDiff(hdg, cm.c);
        if (!best || d < best.d) best = { a, d, via: 'heading' };
      }
      if (best && best.d <= TOL) { pick = best; viaHeading++; }
    }
  }
  if (!pick) { rejected++; continue; }
  const a = pick.a;
  const hdg = typeof a.dx === 'number' ? norm(Math.atan2(a.dx, -a.dy) * 180 / Math.PI) : null;
  track.push({ t: rt(snap.ts), ts: snap.ts, x: a.x, y: a.y, hdg, via: pick.via, diff: pick.d });
}
const total = snaps.length;

// ---------- 后处理：按"瞬移"把航迹切成连续段（重生 / 认错都会造成不合理位移） ----------
const MAX_STEP_KM = numOpt(argv, 'max-step-km', 4, { min: 0.1, max: 100, label: '航迹断点阈值(km)' }); // 5 秒一采样，>4 km 即 >800 m/s，必是断点
const segs = [];
{
  let cur = [];
  for (const p of track) {
    if (cur.length) {
      const q = cur[cur.length - 1];
      if (Math.hypot((p.x - q.x) * KM_PER_UNIT, (p.y - q.y) * KM_PER_UNIT) > MAX_STEP_KM) { segs.push(cur); cur = []; }
    }
    cur.push(p);
  }
  if (cur.length) segs.push(cur);
}
const segsOk = segs.filter((s) => s.length >= 2);
const segKm = (s) => { let d = 0; for (let i = 1; i < s.length; i++) d += Math.hypot((s[i].x - s[i - 1].x) * KM_PER_UNIT, (s[i].y - s[i - 1].y) * KM_PER_UNIT); return d; };
const totalKm = segsOk.reduce((a, s) => a + segKm(s), 0);

// ---------- 分段方位 ----------
const dirName = (dx, dy) => {
  const a = norm(Math.atan2(dx, -dy) * 180 / Math.PI);
  return ['北', '东北', '东', '东南', '南', '西南', '西', '西北'][Math.round(a / 45) % 8];
};
const legs = [];
for (const s of segsOk) {
  for (let i = 1; i < s.length; i++) {
    const dx = s[i].x - s[i - 1].x, dy = s[i].y - s[i - 1].y;
    const km = Math.hypot(dx * KM_PER_UNIT, dy * KM_PER_UNIT);
    if (km < 0.03) continue;
    legs.push({ t: s[i].t, dir: dirName(dx, dy), km });
  }
}
const merged = [];
for (const l of legs) {
  const last = merged[merged.length - 1];
  if (last && last.dir === l.dir && l.t - last.tEnd < 60) { last.km += l.km; last.tEnd = l.t; }
  else merged.push({ dir: l.dir, km: l.km, tStart: l.t, tEnd: l.t });
}

// ---------- SVG ----------
{
  const S = 1024, R = (v) => (v * S).toFixed(1);
  const svg = [];
  svg.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">`);
  svg.push(`<rect width="${S}" height="${S}" fill="#0b0f0b"/>`);
  if (fs.existsSync(path.join(dir, 'map.img'))) svg.push(`<image x="0" y="0" width="${S}" height="${S}" xlink:href="map.img" preserveAspectRatio="none" opacity="0.8"/>`);
  for (const s of segsOk) {
    svg.push(`<polyline points="${s.map((p) => `${R(p.x)},${R(p.y)}`).join(' ')}" fill="none" stroke="#00e5ff" stroke-width="3" opacity="0.95" stroke-linejoin="round"/>`);
    for (let i = 1; i < s.length; i += 8) {  // 每隔一段画一个方向箭头
      const p = s[i - 1], q = s[i];
      svg.push(`<line x1="${R(p.x)}" y1="${R(p.y)}" x2="${R(q.x)}" y2="${R(q.y)}" stroke="#00e5ff" stroke-width="2" marker-end="url(#ar)" opacity="0.95"/>`);
    }
  }
  svg.push(`<defs><marker id="ar" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#00e5ff"/></marker></defs>`);
  if (segsOk.length) {
    const a = segsOk[0][0], b = segsOk[segsOk.length - 1].slice(-1)[0];
    svg.push(`<circle cx="${R(a.x)}" cy="${R(a.y)}" r="10" fill="#00ff66" stroke="#000" stroke-width="2"><title>起点 ${mmss(a.t)}</title></circle>`);
    svg.push(`<circle cx="${R(b.x)}" cy="${R(b.y)}" r="10" fill="#ff3355" stroke="#000" stroke-width="2"><title>终点 ${mmss(b.t)}</title></circle>`);
  }
  const lines = [
    '航迹还原（绿=起点 红=终点）',
    `定位 ${track.length} / ${total} 个快照`,
  ];
  svg.push(`<g font-family="monospace" font-size="16" fill="#f2f2f2"><rect x="8" y="8" width="330" height="${22 * lines.length + 16}" fill="#000" opacity="0.6"/>`);
  lines.forEach((s, i) => svg.push(`<text x="18" y="${32 + i * 22}">${s}</text>`));
  svg.push(`</g></svg>`);
  fs.writeFileSync(path.join(dir, 'track.svg'), svg.join('\n'), 'utf8');
}

// ---------- MD ----------
const L = [];
L.push('# 航迹还原', '');
if (viaIcon) L.push(`- 定位方式：**\`icon: "Player"\` 标记 ${viaIcon} 个**${viaHeading ? ` + compass×dx/dy 航向匹配兜底 ${viaHeading} 个` : ''}${rejected ? `（放弃 ${rejected} 个）` : ''}`);
else L.push(`- 定位方式：compass × 航向匹配（容差 ${TOL}°）${viaHeading} 个，放弃 ${rejected} 个`);
if (track.length) {
  const xs = track.map((p) => p.x), ys = track.map((p) => p.y);
  const span = Math.hypot((Math.max(...xs) - Math.min(...xs)) * KM_PER_UNIT, (Math.max(...ys) - Math.min(...ys)) * KM_PER_UNIT);
  const dist = totalKm;
  L.push(`- 定位 **${track.length} / ${total}** 个快照（${((track.length / total) * 100).toFixed(0)}%）`);
  L.push(`- 连续航迹 **${segsOk.length} 段**${segs.length > segsOk.length ? `（另有 ${segs.length - segsOk.length} 个孤立点被丢弃）` : ''}${segsOk.length > 1 ? ` —— 中间出现 >${MAX_STEP_KM} km 的瞬移（重生或识别错误），已在图上断开` : ''}`);
  L.push(`- 活动范围对角 **${span.toFixed(1)} km**，航迹里程 **${dist.toFixed(1)} km**，时长 ${mmss(track[track.length - 1].t - track[0].t)}`);
  const firstPt = segsOk[0][0], lastPt = segsOk[segsOk.length - 1].slice(-1)[0];
  L.push(`- 起点 \`${firstPt.x.toFixed(3)}, ${firstPt.y.toFixed(3)}\` @ ${mmss(firstPt.t)}　终点 \`${lastPt.x.toFixed(3)}, ${lastPt.y.toFixed(3)}\` @ ${mmss(lastPt.t)}`, '');
  L.push('## 航向分段（连续同向合并）', '', '| 时段 | 主要航向 | 里程 |', '|---|---|---|');
  for (const m of merged) L.push(`| ${mmss(m.tStart)} – ${mmss(m.tEnd || m.tStart)} | **${m.dir}** | ${m.km.toFixed(1)} km |`);
  L.push('');
  L.push('> 说明：坐标是 8111 的归一化地图坐标（1.0 = 131.072 km），x 向右=东、y 向下=南。');
}
fs.writeFileSync(path.join(dir, 'track.md'), L.join('\n'), 'utf8');

console.log(`定位 ${track.length}/${total}（icon ${viaIcon} / 航向 ${viaHeading} / 放弃 ${rejected}）`);
console.log('  ' + path.join(dir, 'track.svg'));
console.log('  ' + path.join(dir, 'track.md'));
