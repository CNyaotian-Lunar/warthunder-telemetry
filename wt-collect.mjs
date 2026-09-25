#!/usr/bin/env node
/**
 * War Thunder 8111 遥测采集器（可复用）
 *
 *   node wt-collect.mjs [选项]
 *
 * 选项：
 *   --out DIR       输出目录（默认 runs/run-<时间戳>）
 *   --base URL      8111 基址（默认 http://127.0.0.1:8111）
 *   --me NAME       玩家昵称（写进 meta.json，供报告标注"你"）
 *   --state-ms N    遥测采样间隔毫秒（默认 1000）
 *   --obj-ms N      战场态势采样间隔毫秒（默认 5000）
 *   --max-min N     硬上限分钟（默认 180）
 *   --no-idle-stop  禁用"回机库自动停"
 *
 * 产出（全部 UTF-8）：
 *   meta.json      启动/结束信息、机型、参数
 *   flight.jsonl   每秒遥测（/state 全字段 + t 相对秒 + ts ISO 时间）
 *   events.jsonl   战斗日志增量（/hudmsg，damage 数组各项 + kind 标记）
 *   objects.jsonl  战场态势（/map_obj.json 精简：type/color/icon/sx/sy/ex/ey）
 *   marks.jsonl    分段标记（新开一局 / valid 变化 / 结束原因）
 *   map.img        地图底图 JPEG（2048×2048，供报告画态势图）
 *   indicators.json 仪表快照（含机型 type 字段）
 *   heartbeat.log  心跳日志
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { numOpt, flag } from './wt-args.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
const stamp = () => {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

const BASE = String(arg('base', 'http://127.0.0.1:8111')).replace(/\/+$/, '');
const OUT = path.resolve(String(arg('out', path.join(HERE, 'runs', 'run-' + stamp()))));
const ME = arg('me', '');
const STATE_MS = numOpt(argv, 'state-ms', 1000, { min: 200, max: 60000, int: true, label: '遥测采样间隔毫秒' });
const OBJ_MS = numOpt(argv, 'obj-ms', 5000, { min: 1000, max: 600000, int: true, label: '态势采样间隔毫秒' });
const MAX_MIN = numOpt(argv, 'max-min', 180, { min: 1, max: 1440, int: true, label: '硬上限分钟' });
const IDLE_STOP = !flag(argv, 'no-idle-stop');

fs.mkdirSync(OUT, { recursive: true });
const w = (name) => fs.createWriteStream(path.join(OUT, name), { flags: 'a' });
const fFlight = w('flight.jsonl'), fEvt = w('events.jsonl'), fObj = w('objects.jsonl'), fMark = w('marks.jsonl'), fLog = w('heartbeat.log');

const T0 = Date.now();
const t = () => +((Date.now() - T0) / 1000).toFixed(2);
const ts = () => new Date().toISOString();
const say = (m) => { const l = `[${ts()}] +${t()}s ${m}`; console.log(l); fLog.write(l + '\n'); };
const mark = (type, detail = '') => fMark.write(JSON.stringify({ t: t(), ts: ts(), type, detail }) + '\n');
const meta = { startedAt: ts(), me: ME || null, base: BASE, stateMs: STATE_MS, objMs: OBJ_MS, maxMin: MAX_MIN, aircraft: null, endedAt: null, endReason: null, samples: 0, events: 0 };
const saveMeta = () => fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
saveMeta();

async function get(p, timeout = 4000, as = 'text') {
  const c = new AbortController();
  const tm = setTimeout(() => c.abort(), timeout);
  try {
    const r = await fetch(BASE + p, { signal: c.signal, cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return as === 'json' ? await r.json() : await r.text();
  } finally { clearTimeout(tm); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 前置：确认 8111 在线，抓机型与底图 ----
// 开局加载瞬间 /indicators 会返回 dummy_plane ⇒ 必须重试到拿到真机型为止
let ind = null;
for (let i = 0; i < 12; i++) {
  try { ind = await get('/indicators', 4000, 'json'); } catch { ind = null; }
  if (ind && ind.type && ind.type !== 'dummy_plane') break;
  await sleep(1500);
}
if (!ind) {
  console.error(`8111 不可达（${BASE}/indicators）——请先启动 War Thunder 并进入战斗。`);
  mark('fatal', '8111 unreachable at startup');
  meta.endReason = '8111 unreachable at startup'; meta.endedAt = ts(); saveMeta();
  process.exit(2);
}
meta.aircraft = (ind.type && ind.type !== 'dummy_plane') ? ind.type : null;
fs.writeFileSync(path.join(OUT, 'indicators.json'), JSON.stringify(ind, null, 2), 'utf8');
try {
  const rMap = await fetch(BASE + '/map.img', { signal: AbortSignal.timeout(8000) });
  if (!rMap.ok) throw new Error('HTTP ' + rMap.status);
  const buf = Buffer.from(await rMap.arrayBuffer());
  // 游戏还在加载时会返回 ~1.5 KB 的占位图 ⇒ 必须校验 JPEG magic（FF D8）且体积够大
  if (buf.length > 50000 && buf[0] === 0xff && buf[1] === 0xd8) fs.writeFileSync(path.join(OUT, 'map.img'), buf);
  else say(`⚠️ 底图无效（${buf.length} 字节），跳过 —— 可在战斗开始后重新抓 /map.img 补上再跑报告脚本`);
} catch (e) { say('⚠️ 底图抓取失败（不影响采集，可在战斗开始后重抓）：' + e.message); }

say(`开始采集 → ${OUT}`);
say(`机型 = ${meta.aircraft || '未知'}${ME ? '，玩家 = ' + ME : ''}`);

// ---- 初始全量事件（本局已发生的部分） ----
let lastEvt = 0, lastDmg = 0;
async function pullEvents(pre = false) {
  const h = await get(`/hudmsg?lastEvt=${lastEvt}&lastDmg=${lastDmg}`, 4000, 'json');
  let n = 0;
  // ⚠️ 缺 id 的条目必须跳过：Math.max(x, undefined) === NaN ⇒ 游标永久变 NaN、事件从此报废（且 30s 校准因 NaN 比较恒 false 无法自愈）
  let skipped = 0;
  for (const e of h.events || []) {
    if (!Number.isFinite(e.id)) { skipped++; continue; }
    fEvt.write(JSON.stringify({ t: t(), ts: ts(), kind: 'evt', pre, ...e }) + '\n'); lastEvt = Math.max(lastEvt, e.id); meta.events++; n++;
  }
  for (const d of h.damage || []) {
    if (!Number.isFinite(d.id)) { skipped++; continue; }
    fEvt.write(JSON.stringify({ t: t(), ts: ts(), kind: 'dmg', pre, ...d }) + '\n'); lastDmg = Math.max(lastDmg, d.id); meta.events++; n++; logEvent(d);
  }
  if (skipped) say(`⚠️ 跳过 ${skipped} 条缺 id 的 hudmsg 条目（游标不受影响）`);
  return n;
}
let evtLog = 0;
function logEvent(d) { if (evtLog++ < 500) say('事件: ' + String(d.msg || JSON.stringify(d)).replace(/[\u200b-\u200d\ufeff]/g, '')); }

try {
  if (argv.includes('--no-pre')) {
    // 只取基线，不落盘：hudmsg 跨局不清空，把上一局的日志拒之门外
    const h = await get('/hudmsg?lastEvt=0&lastDmg=0', 4000, 'json');
    for (const e of h.events || []) lastEvt = Math.max(lastEvt, e.id);
    for (const d of h.damage || []) lastDmg = Math.max(lastDmg, d.id);
    say(`--no-pre：跳过 ${(h.events || []).length + (h.damage || []).length} 条历史事件，基线 lastEvt=${lastEvt} lastDmg=${lastDmg}`);
  } else {
    const n = await pullEvents(true);
    say(`初始全量: ${n} 条 (lastEvt=${lastEvt} lastDmg=${lastDmg})`);
  }
} catch (e) { say('初始 hudmsg 失败: ' + e.message); }

// ---- 主循环 ----
let stateFails = 0, invalidStreak = 0, nextObj = 0, nextCal = 0, lastValid = null, rounds = 1, stopReason = null;

// 收到中断信号时优雅收尾：置标记 -> 主循环下一次检查退出 -> 正常 end()/saveMeta()（否则 meta 与数据会互相矛盾）
let gotSignal = null;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { if (!gotSignal) { gotSignal = sig; say(`收到 ${sig}，正在收尾…`); } });
}
mark('round_start', 'round 1');
saveMeta();

while (true) {
  if (gotSignal) { stopReason = '收到信号 ' + gotSignal; break; }
  if ((Date.now() - T0) / 60000 > MAX_MIN) { stopReason = '达到硬上限 ' + MAX_MIN + ' 分钟'; break; }

  try {
    const s = await get('/state', 4000, 'json');
    stateFails = 0;
    if (s.valid !== lastValid) { mark('valid', String(s.valid)); lastValid = s.valid; }
    invalidStreak = s.valid ? 0 : invalidStreak + 1;
    // 顺带取罗盘：/state 不给航向，只有 /indicators 有 —— 它是把"自己"从全场飞机里认出来的钥匙
    let compass = null, bank = null, turn = null;
    try { const i3 = await get('/indicators', 3000, 'json'); compass = i3.compass ?? null; bank = i3.bank ?? null; turn = i3.turn ?? null; } catch { /* 取不到不影响主循环 */ }
    fFlight.write(JSON.stringify({ t: t(), ts: ts(), compass, bank, turn, ...s }) + '\n');
    meta.samples++;

    try {
      const before = lastDmg;
      await pullEvents(false);
      // id 回退 ⇒ 新的一局（hudmsg 计数重置）
      if (lastDmg < before) {
        rounds++;
        mark('round_start', `round ${rounds} (hudmsg id 回退 ${before}→${lastDmg})`);
        say(`检测到新的一局：round ${rounds}`);
      }
    } catch { /* 事件失败不影响主循环 */ }

    if (meta.samples % 5 === 0) {
      say(`心跳 #${meta.samples} H=${s['H, m']}m TAS=${s['TAS, km/h']}km/h M=${s['M']} Ny=${s['Ny']} 油=${s['Mfuel, kg']}/${s['Mfuel0, kg']} 事件=${meta.events}`);
      saveMeta();
    }
  } catch (e) {
    stateFails++;
    if (stateFails % 5 === 0) say(`/state 失败 ${stateFails} 次: ${e.message}`);
    if (stateFails >= 12) { stopReason = '8111 无响应（游戏退出/战斗结束）'; break; }
  }

  if (Date.now() >= nextObj) {
    nextObj = Date.now() + OBJ_MS;
    try {
      const raw = await get('/map_obj.json', 4000, 'json');
      if (!Array.isArray(raw) || raw.length === 0) throw new Error('empty snapshot'); // 加载瞬间会返回空数组，别记空快照
      const counts = {};
      for (const o of raw) counts[o.type] = (counts[o.type] || 0) + 1;
      fObj.write(JSON.stringify({ t: t(), ts: ts(), counts, objs: raw.map((o) => ({ type: o.type, color: o.color, icon: o.icon, x: o.x, y: o.y, dx: o.dx, dy: o.dy, sx: o.sx, sy: o.sy, ex: o.ex, ey: o.ey, blink: o.blink })) }) + '\n');
    } catch { /* ignore */ }
  }

  // ---- 全量校准（每 30 秒）：hudmsg 跨局不清空，且 id 可能跨局重置 ----
  if (Date.now() >= nextCal) {
    nextCal = Date.now() + 30000;
    try {
      const full = await get('/hudmsg?lastEvt=0&lastDmg=0', 6000, 'json');
      const dmg = full.damage || [], evs = full.events || [];
      const maxD = dmg.reduce((m, d) => Math.max(m, d.id || 0), 0);
      const maxE = evs.reduce((m, e) => Math.max(m, e.id || 0), 0);
      if (maxD > 0 && maxD < lastDmg) {
        rounds++;
        mark('round_start', `round ${rounds}（校准发现 id 回退 ${lastDmg}→${maxD}）`);
        say(`检测到新的一局：round ${rounds}（hudmsg id 重置为 ${maxD}）`);
        lastEvt = 0; lastDmg = 0;
        await pullEvents(false); // 补拉新局已产生的事件
      } else if (maxD > lastDmg || maxE > lastEvt) {
        await pullEvents(false); // 增量漏拉，补齐
      }
      // 顺便刷新机型（开局瞬间可能是 dummy_plane，或中途换机）
      try {
        const ind2 = await get('/indicators', 4000, 'json');
        if (ind2 && ind2.type && ind2.type !== 'dummy_plane' && ind2.type !== meta.aircraft) {
          mark('aircraft', `${meta.aircraft || ''} → ${ind2.type}`);
          say(`机型更新: ${meta.aircraft || '(空)'} → ${ind2.type}`);
          meta.aircraft = ind2.type;
          fs.writeFileSync(path.join(OUT, 'indicators.json'), JSON.stringify(ind2, null, 2), 'utf8');
        }
      } catch { /* ignore */ }
    } catch { /* 校准失败不致命 */ }
  }

  if (IDLE_STOP && invalidStreak >= 30) { stopReason = 'valid=false 连续 30 次（疑似回机库）'; break; }
  await sleep(STATE_MS);
}

fFlight.end(); fEvt.end(); fObj.end();
mark('end', stopReason || 'unknown');
meta.endReason = stopReason; meta.endedAt = ts(); meta.rounds = rounds; saveMeta();
say(`采集结束: ${((Date.now() - T0) / 1000).toFixed(0)}s / 遥测 ${meta.samples} 条 / 事件 ${meta.events} 条 / ${rounds} 局`);
fLog.end();
console.log('DONE ' + OUT);
