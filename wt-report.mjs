#!/usr/bin/env node
/**
 * War Thunder 遥测报告生成器（可复用）
 *
 *   node wt-report.mjs <数据目录> [--me 昵称] [--units metric|imperial|both]
 *
 * 输入：wt-collect.mjs 产出的 flight.jsonl / events.jsonl / objects.jsonl / meta.json
 * 产出：<数据目录>/report.md、<数据目录>/sitrep.svg
 */
import fs from 'node:fs';
import path from 'node:path';
import { strOpt, posArg } from './wt-args.mjs';

const argv = process.argv.slice(2);
const dir = posArg(argv, '用法: node wt-report.mjs <数据目录> [--me 昵称]');
const ME = strOpt(argv, 'me', '');

const readJsonl = (f) => {
  const p = path.join(dir, f);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
};
const readJson = (f) => {
  const p = path.join(dir, f);
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { console.error(`⚠️ ${f} 解析失败（文件可能被截断）：${e.message}`); return {}; }
};
const meta = readJson('meta.json');
const flight = readJsonl('flight.jsonl');
const events = readJsonl('events.jsonl');
const objects = readJsonl('objects.jsonl');
const marks = readJsonl('marks.jsonl');
// 局数优先用 marks.jsonl 的 round_start 计数（多局连打时 meta.rounds 可能没及时落盘/为 null）
const roundsFromMarks = marks.filter((m) => m && m.type === 'round_start').length;
const rounds = roundsFromMarks || meta.rounds || 1;

if (!flight.length) { console.error('flight.jsonl 为空，无法生成报告'); process.exit(1); }

// ---------- 工具 ----------
const ZW = /[\u200b-\u200d\u2060\ufeff]/g;
const clean = (s) => String(s == null ? '' : s).replace(ZW, '').replace(/\s+/g, ' ').trim();
const stripTag = (s) => s.replace(/^[⋇*\s]+/, '').replace(/^[◊◄▄▀■●○◘♦→\s]+/, '');
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : NaN);
const fmt = (v, d = 1) => (isFinite(v) ? v.toFixed(d) : '—');
const mmss = (sec) => { const s = Math.round(sec); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

// 单位换算：8111 固定给公制（km/h、m、m/s），游戏内改单位设置不影响它 ⇒ 英美制只能在这里换
const UNITS = String(strOpt(argv, 'units', 'both') || 'both').toLowerCase(); // metric | imperial | both
const SPD = (kmh) => !isFinite(kmh) ? '—' : UNITS === 'imperial' ? `${fmt(kmh * 0.539957, 0)} kn` : UNITS === 'metric' ? `${fmt(kmh, 0)} km/h` : `${fmt(kmh, 0)} km/h（${fmt(kmh * 0.539957, 0)} kn）`;
const ALT = (m) => !isFinite(m) ? '—' : UNITS === 'imperial' ? `${fmt(m * 3.28084, 0)} ft` : UNITS === 'metric' ? `${fmt(m, 0)} m` : `${fmt(m, 0)} m（${fmt(m * 3.28084, 0)} ft）`;
const VSP = (ms) => !isFinite(ms) ? '—' : UNITS === 'imperial' ? `${fmt(ms * 196.85, 0)} ft/min` : UNITS === 'metric' ? `${fmt(ms, 1)} m/s` : `${fmt(ms, 1)} m/s（${fmt(ms * 196.85, 0)} ft/min）`;
const F = (o, k) => num(o[k]);

// ---------- 飞行数据统计 ----------
const first = flight[0], last = flight[flight.length - 1];
// 时间基准：用 ISO 时间戳重算相对秒 —— 同一个目录里拼了多次采集时，t 会各自从 0 开始，只有 ts 连续
const t0ms = Date.parse(first.ts);
for (const s of flight) s.rt = (Date.parse(s.ts) - t0ms) / 1000;
const duration = last.rt;
const expect = Math.max(1, Math.round(duration / Math.max(0.2, (meta.stateMs || 1000) / 1000)));
const coverageRaw = (flight.length / expect) * 100;
// ⚠️ 覆盖率不能 >100%：expect 是按 meta.stateMs 推算的"应有采样数"，而实际采样间隔可能更小
//（或被拼接了多段），此时算出来会超过 100 ⇒ 封顶并在超限时如实标注，而不是印个假数字
const coverage = Math.min(100, coverageRaw);

const peak = (key, mode = 'max') => {
  let best = null;
  for (const s of flight) {
    const v = F(s, key);
    if (!isFinite(v)) continue;
    if (!best || (mode === 'max' ? v > best.v : v < best.v)) best = { v, t: s.rt };
  }
  return best;
};
const avg = (key, filter) => {
  const xs = flight.filter((s) => (filter ? filter(s) : true)).map((s) => F(s, key)).filter(isFinite);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
};
const airborne = flight.filter((s) => F(s, 'H, m') > 20);
const abTime = flight.filter((s) => F(s, 'throttle 1, %') > 100.5).length * ((meta.stateMs || 1000) / 1000);
// 燃油：中途重生/补油会让油量跳增 ⇒ 按"跳增 >100kg"切段，只统计最长连续段
const fuelSegs = [];
{
  let cur = [flight[0]];
  for (let i = 1; i < flight.length; i++) {
    const a = F(flight[i - 1], 'Mfuel, kg'), b = F(flight[i], 'Mfuel, kg');
    if (isFinite(a) && isFinite(b) && b - a > 100) { fuelSegs.push(cur); cur = []; }
    cur.push(flight[i]);
  }
  fuelSegs.push(cur);
}
const fseg = fuelSegs.reduce((a, b) => (b.length > a.length ? b : a), fuelSegs[0]);
const fuelStart = F(fseg[0], 'Mfuel, kg'), fuelEnd = F(fseg[fseg.length - 1], 'Mfuel, kg');
const fuelCap = F(fseg[0], 'Mfuel0, kg') || 7460;
const fuelDur = (Date.parse(fseg[fseg.length - 1].ts) - Date.parse(fseg[0].ts)) / 1000;
const fuelBurn = (fuelStart - fuelEnd) / Math.max(0.01, fuelDur / 60);

const maxTAS = peak('TAS, km/h'), maxIAS = peak('IAS, km/h'), maxM = peak('M'), maxH = peak('H, m'), minH = peak('H, m', 'min');
const maxNy = peak('Ny'), minNy = peak('Ny', 'min'), maxRPM = peak('RPM 1'), maxOil = peak('oil temp 1, C');
const maxVy = peak('Vy, m/s'), minVy = peak('Vy, m/s', 'min');
const nyOver = flight.filter((s) => F(s, 'Ny') > 10).length;
const stallish = flight.filter((s) => F(s, 'AoA, deg') > 18).length;

// ---------- 事件解析 ----------
const RULES = [
  ['kill', /^(.*?) \(([^()]*)\) 击落了 (.*?) \(([^()]*)\)$/],
  ['fatal', /^(.*?) \(([^()]*)\) 致命攻击 (.*?) \(([^()]*)\)$/],
  ['severe', /^(.*?) \(([^()]*)\) 重创 (.*?) \(([^()]*)\)$/],
  ['ignite', /^(.*?) \(([^()]*)\) 的攻击引燃了 (.*?) \(([^()]*)\)$/],
  ['first', /^(.*?) \(([^()]*)\) 先拔头筹！$/],
  ['award', /^(.*?) \(([^()]*)\) 获得嘉奖“(.*?)”$/],
  ['crash', /^(.*?) \(([^()]*)\) 已坠毁。$/],
  ['soft', /^(.*?) \(([^()]*)\) 完成了软着陆$/],
  ['gkill', /^(.*?) \(([^()]*)\) 击毁了 (.*)$/],
  ['disconnect', /^(.*?) 已掉线。$/],
  ['disconnect', /^(.*?)td! kd\?NET_PLAYER_DISCONNECT_FROM_GAME$/],
  ['fuelout', /^燃油耗尽$/],
  ['takeoff', /^(.*?) \((.*?)\) 已起飞$/],
  // 英文客户端文案（不保证完整；未覆盖部分由未匹配率告警兜底）
  ['kill', /^(.*?) \((.*?)\) shot down (.*?) \((.*?)\)$/i],
  ['kill', /^(.*?) \((.*?)\) destroyed (.*?) \((.*?)\)$/i],
  ['fatal', /^(.*?) \((.*?)\) severely damaged (.*?) \((.*?)\)$/i],
  ['severe', /^(.*?) \((.*?)\) damaged (.*?) \((.*?)\)$/i],
  ['crash', /^(.*?) \((.*?)\) has crashed\.?$/i],
  ['disconnect', /^(.*?) has been disconnected\.?$/i],
  ['takeoff', /^(.*?) \((.*?)\) has taken off$/i],
  ['soft', /^(.*?) \((.*?)\) has landed successfully$/i],
];
const parsed = [];
const seenKey = new Set();
for (const ev of events) {
  const msg = clean(ev.msg);
  if (!msg) continue;
  const key = (ev.id == null ? '' : ev.id) + '|' + msg; // 多次采集拼接时去重
  if (seenKey.has(key)) continue;
  seenKey.add(key);
  let hit = null;
  for (const [kind, re] of RULES) { const m = msg.match(re); if (m) { hit = { kind, m }; break; } }
  parsed.push({
    t: ev.t, ts: ev.ts, id: ev.id, pre: !!ev.pre, raw: msg,
    kind: hit ? hit.kind : 'other',
    who: hit && hit.m[1] != null ? stripTag(clean(hit.m[1])) : null,
    whoType: hit && hit.m[2] ? stripTag(clean(hit.m[2])) : null,
    victim: hit && hit.m[3] != null ? stripTag(clean(hit.m[3])) : null,
    victimType: hit && hit.m[4] ? stripTag(clean(hit.m[4])) : null,
    extra: hit && hit.kind === 'award' && hit.m[3] != null ? clean(hit.m[3]) : null,
  });
}
for (const p of parsed) p.rt = (Date.parse(p.ts) - t0ms) / 1000;
parsed.sort((a, b) => (a.rt - b.rt) || ((a.id || 0) - (b.id || 0)));
const preEvents = parsed.filter((p) => p.pre);   // 采集开始前就已在 hudmsg 里（可能属于上一局）
const unmatchedCount = parsed.filter((p) => p.kind === 'other').length;
const unmatchedRate = parsed.length ? unmatchedCount / parsed.length : 0;
const mainEvents = parsed.filter((p) => !p.pre); // 主统计只算本次采集覆盖到的事件
const byKind = (k) => mainEvents.filter((p) => p.kind === k);

// 击杀榜
const killBoard = new Map();
for (const p of byKind('kill')) {
  const k = `${p.who} (${p.whoType})`;
  if (!killBoard.has(k)) killBoard.set(k, { n: 0, victims: [] });
  const e = killBoard.get(k); e.n++; e.victims.push(`${p.victim} (${p.victimType})`);
}
const board = [...killBoard.entries()].sort((a, b) => b[1].n - a[1].n);
const deaths = byKind('kill').length;
const disconn = byKind('disconnect').length;
const crashes = byKind('crash').length;
const awards = byKind('award');
const mine = ME ? mainEvents.filter((p) => (p.who && p.who.includes(ME)) || (p.victim && p.victim.includes(ME))) : [];

// 机型兜底：meta 没拿到（开局瞬间是 dummy_plane）时，从日志里自己昵称那条反推
if (!meta.aircraft && ME) {
  const own = mainEvents.find((p) => p.who && p.who.includes(ME) && p.whoType);
  if (own) meta.aircraft = own.whoType + '（据日志推断）';
}

// ---------- 战场态势 ----------
// 过滤空快照（战斗加载瞬间 /map_obj.json 会返回空数组）
// H1：objects.jsonl 可能很大（长局几万帧 / 几百 MB），而报告只用"首末两帧的 counts"。
// 原实现把整份文件全量 JSON.parse 再 filter，实测常驻堆 ≈ 文件体积的 2.8 倍。
// 这里改成两段扫描：正向找第一个非空帧、反向找最后一个非空帧 —— 只 parse 两次。
const readObjEnds = (file) => {
  const p = path.join(dir, file);
  if (!fs.existsSync(p)) return { first: null, last: null, frames: 0 };
  const txt = fs.readFileSync(p, 'utf8');
  const lines = txt.split('\n');
  let frames = 0;
  const parseNonEmpty = (ln) => { try { const o = JSON.parse(ln); return (o && o.objs && o.objs.length) ? o : null; } catch { return null; } };
  let first = null;
  for (const ln of lines) {
    if (!ln) continue;
    frames++;
    if (!first) { const o = parseNonEmpty(ln); if (o) first = o; }
  }
  let last = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i];
    if (!ln) continue;
    const o = parseNonEmpty(ln);
    if (o) { last = o; break; }
  }
  return { first, last, frames };
};
const objEnds = readObjEnds('objects.jsonl');
const firstObj = objEnds.first, lastObj = objEnds.last;
const cntLine = (o) => o ? Object.entries(o.counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ') : '—';

const safePeak = (o) => (o && typeof o === 'object') ? o : { v: NaN, t: NaN };

// ---------- 报告 ----------
const L = [];
L.push(`# 战斗数据报告`, '');
L.push(`- 数据目录：\`${path.basename(dir)}\`（报告只写目录名）`);
L.push(`- 采集时间：${first.ts} → ${last.ts}（时长 **${mmss(duration)}**，${(duration / 60).toFixed(1)} 分钟）`);
L.push(`- 结束原因：${meta.endReason || '—'}`);
L.push(`- 机型：**${meta.aircraft || '未知'}**${ME ? `　玩家：**${ME}**` : ''}`);
L.push(`- 采样：${flight.length} 条（期望 ${expect}，完整率 ${coverage.toFixed(1)}%${coverageRaw > 100 ? `（实际采样比推算多 ${(coverageRaw - 100).toFixed(0)}%，已封顶）` : ``}）· 事件 ${mainEvents.length} 条（另 ${preEvents.length} 条采集前）· 局数 ${rounds}`, '');

if (parsed.length >= 10 && unmatchedRate > 0.3) {
  L.push('');
  L.push(`> ⚠️ **战斗日志有 ${unmatchedCount} / ${parsed.length} 条未能识别（${(unmatchedRate * 100).toFixed(0)}%）** —— 英文客户端或新版本文案可能未被规则表覆盖；`);
  L.push(`> 可把 events.jsonl 里 kind 为 other 的原文贴到仓库提 issue，便于补规则。`);
  L.push('');
}
L.push(`## 一、飞行概况`, '');
L.push(`| 项目 | 数值 | 时刻 |`, `|---|---|---|`);
L.push(`| 最大真空速 TAS | ${SPD(safePeak(maxTAS).v)} | ${safePeak(maxTAS) ? mmss(safePeak(maxTAS).t) : '—'} |`);
L.push(`| 最大表速 IAS | ${SPD(safePeak(maxIAS).v)} | ${safePeak(maxIAS) ? mmss(safePeak(maxIAS).t) : '—'} |`);
L.push(`| 最大马赫 M | ${fmt(safePeak(maxM).v, 2)} | ${safePeak(maxM) ? mmss(safePeak(maxM).t) : '—'} |`);
L.push(`| 最大高度 H | ${ALT(safePeak(maxH).v)} | ${safePeak(maxH) ? mmss(safePeak(maxH).t) : '—'} |`);
L.push(`| 最低高度（离地后） | ${ALT(safePeak(minH).v)} | ${safePeak(minH) ? mmss(safePeak(minH).t) : '—'} |`);
L.push(`| 最大正过载 Ny | ${fmt(safePeak(maxNy).v, 2)} G | ${safePeak(maxNy) ? mmss(safePeak(maxNy).t) : '—'} |`);
L.push(`| 最大负过载 Ny | ${fmt(safePeak(minNy).v, 2)} G | ${safePeak(minNy) ? mmss(safePeak(minNy).t) : '—'} |`);
L.push(`| 最大爬升率 Vy | ${VSP(safePeak(maxVy).v)} | — |`);
L.push(`| 最大下降率 Vy | ${VSP(safePeak(minVy).v)} | — |`);
L.push(`| 最大 RPM | ${fmt(safePeak(maxRPM).v, 0)} | — |`);
L.push(`| 最高油温 | ${fmt(safePeak(maxOil).v, 0)} ℃ | — |`);
L.push('');
L.push(`- 空中平均 TAS：**${SPD(avg('TAS, km/h', (s) => F(s, 'H, m') > 20))}**；空中样本 ${airborne.length} 条`);
L.push(`- 加力时间：**${abTime.toFixed(0)} 秒**（占 ${((abTime / Math.max(1, duration)) * 100).toFixed(1)}%）`);
L.push(`- 燃油：${fmt(fuelStart, 0)} → ${fmt(fuelEnd, 0)} kg（满油 ${fmt(fuelCap, 0)} kg，消耗 ${fmt(fuelStart - fuelEnd, 0)} kg，平均 **${fmt(fuelBurn, 1)} kg/分**，剩余 ${((fuelEnd / Math.max(1, fuelCap)) * 100).toFixed(0)}%）${fuelSegs.length > 1 ? `　⚠️ 期间重生/补油 ${fuelSegs.length - 1} 次，以上只取最长连续段（${mmss(fuelDur)}）` : ''}`);
L.push(`- 超 10G 采样：${nyOver} 条${nyOver ? `（${(nyOver * (meta.stateMs || 1000) / 1000).toFixed(1)} 秒）` : ''}；AoA>18° 采样：${stallish} 条`);
L.push('');

L.push(`## 二、战斗事件（本次采集覆盖 ${mainEvents.length} 条）`, '');
if (preEvents.length) L.push(`> 另有 ${preEvents.length} 条在采集开始前就已存在于 hudmsg（属采集前的战斗），列在文末时间轴、**不计入以下统计**。`, '');
L.push(`- 击落 ${deaths} 人次 · 掉线 ${disconn} 人 · 坠毁 ${crashes} 架 · 嘉奖 ${awards.length} 项`);
if (firstObj && lastObj) {
  L.push(`- 战场规模（首采 → 末采）：${cntLine(firstObj)}　→　${cntLine(lastObj)}`);
}
L.push('');
if (board.length) {
  L.push(`### 击杀榜`, '', `| # | 玩家 | 击杀数 | 受害者 |`, `|---|---|---|---|`);
  board.forEach(([k, v], i) => L.push(`| ${i + 1} | ${k} | **${v.n}** | ${v.victims.join('；')} |`));
  L.push('');
}
if (ME) {
  L.push(`### 你的记录（昵称含「${ME}」）`, '');
  if (!mine.length) L.push('- 本局没有与你相关的战斗日志条目');
  else for (const p of mine) L.push(`- \`${mmss(p.rt)}\` [${p.kind}] ${p.raw}`);
  L.push('');
}
L.push(`### 时间轴`, '', '```');
for (const p of mainEvents) L.push(`${mmss(p.rt).padStart(6)}  ${p.raw}`);
if (preEvents.length) {
  L.push('', `---- 以下 ${preEvents.length} 条：采集开始前已记录（不计入统计）----`);
  for (const p of preEvents) L.push(`${mmss(p.rt).padStart(6)}  ${p.raw}`);
}
L.push('```', '');

L.push(`## 三、附录`, '');
L.push(`- \`flight.jsonl\` 逐秒遥测原始数据（字段名与 8111 \`/state\` 一致）`);
L.push(`- \`events.jsonl\` 战斗日志（含 \`pre:true\` 的为采集开始前已发生的事件）`);
L.push(`- \`objects.jsonl\` 每 ${(meta.objMs || 5000) / 1000} 秒战场态势快照`);
L.push(`- \`sitrep.svg\` 末次战场态势图（浏览器直接打开）`);
L.push('');

fs.writeFileSync(path.join(dir, 'report.md'), L.join('\n'), 'utf8');

// ---------- 态势图 SVG ----------
if (lastObj) {
  const S = 1024, R = (v) => (v * S).toFixed(1);
  const COL = { aircraft: 5, ground_model: 3.5, airfield: 0, bombing_point: 6, defending_point: 6, respawn_base_bomber: 4, respawn_base_fighter: 4 };
  const svg = [];
  svg.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">`);
  svg.push(`<rect width="${S}" height="${S}" fill="#0b0f0b"/>`);
  if (fs.existsSync(path.join(dir, 'map.img'))) svg.push(`<image x="0" y="0" width="${S}" height="${S}" xlink:href="map.img" preserveAspectRatio="none" opacity="0.9"/>`);
  const PX = (o) => (typeof o.x === 'number' ? o.x : o.sx);
  const PY = (o) => (typeof o.y === 'number' ? o.y : o.sy);
  for (const o of lastObj.objs) {
    const x0 = PX(o), y0 = PY(o);
    if (typeof x0 !== 'number' || typeof y0 !== 'number') continue;
    const c = o.color || '#ffffff';
    const hl = o.blink ? ` stroke="#ffffff" stroke-width="1.2"` : ` stroke="#000000" stroke-width="0.6"`;
    if (o.type === 'airfield') {
      const x = R(Math.min(o.sx, o.ex)), y = R(Math.min(o.sy, o.ey)), w = R(Math.abs(o.ex - o.sx)), h = R(Math.abs(o.ey - o.sy));
      svg.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${c}" stroke-width="2" opacity="0.85"/>`);
    } else if (o.type === 'bombing_point' || o.type === 'defending_point') {
      const x = R(x0), y = R(y0);
      svg.push(`<rect x="${x - 7}" y="${y - 7}" width="14" height="14" fill="none" stroke="${c}" stroke-width="2"/>`);
      svg.push(`<text x="${(+x + 11).toFixed(1)}" y="${(+y + 5).toFixed(1)}" font-family="monospace" font-size="13" font-weight="bold" fill="${c}" stroke="#000" stroke-width="0.4">${o.type === 'bombing_point' ? 'B' : 'D'}</text>`);
    } else if (o.type === 'aircraft') {
      const x = R(x0), y = R(y0);
      const rot = (typeof o.dx === 'number' && (o.dx || o.dy)) ? ` transform="rotate(${((Math.atan2(o.dy, o.dx) * 180 / Math.PI) + 90).toFixed(1)} ${x} ${y})"` : '';
      svg.push(`<polygon points="${x},${+y - 8} ${+x + 5.5},${+y + 6} ${x},${+y + 3} ${+x - 5.5},${+y + 6}" fill="${c}"${hl}${rot}><title>aircraft ${o.icon || ''}</title></polygon>`);
    } else if (o.type === 'ground_model') {
      const x = R(x0), y = R(y0);
      svg.push(`<rect x="${(+x - 2.5).toFixed(1)}" y="${(+y - 2.5).toFixed(1)}" width="5" height="5" fill="${c}"${hl}><title>${o.icon || 'ground'}</title></rect>`);
    } else {
      svg.push(`<circle cx="${R(x0)}" cy="${R(y0)}" r="4" fill="${c}"${hl}><title>${o.type}</title></circle>`);
    }
  }
  const counts = lastObj.counts || {};
  svg.push(`<g font-family="monospace" font-size="16" fill="#eaeaea"><rect x="8" y="8" width="330" height="${26 + Object.keys(counts).length * 20}" fill="#000" opacity="0.55"/>`);
  svg.push(`<text x="16" y="30">态势快照 t=+${lastObj.t}s（共 ${(lastObj.objs || []).length} 个对象）</text>`);
  Object.entries(counts).sort((a, b) => b[1] - a[1]).forEach(([k, v], i) => svg.push(`<text x="16" y="${54 + i * 20}">${k}: ${v}</text>`));
  svg.push(`</g></svg>`);
  fs.writeFileSync(path.join(dir, 'sitrep.svg'), svg.join('\n'), 'utf8');
}

console.log('报告已生成:');
console.log('  ' + path.join(dir, 'report.md'));
if (lastObj) console.log('  ' + path.join(dir, 'sitrep.svg'));
