/**
 * 生成「时段对比」预览图：把同一张路网在几个真实换课时刻的热度层并排画出来。
 *
 * 为什么需要：用户问过"真的是按时间段预测的吗？怎么现在还是有道路拥堵"。
 * 这张图就是答案的可视化——07:50 早高峰是满的，18:50 晚上几乎是空的，
 * 而两者的差别**完全来自真实课表**（班级课表 (3).xls），不是任何假设曲线。
 *
 *   node tools/make-time-preview.js
 *   -> tools/preview-time.svg
 *
 * 不传参时画 4 个代表时段；也可以自己给时刻：
 *   node tools/make-time-preview.js 07:50 11:40 18:50
 */
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./paths.js');
const router = require(path.join(ROOT, 'utils', 'router.js'));
const timeModel = require(path.join(ROOT, 'utils', 'timeModel.js'));
const graph = router.graph;

if (!timeModel.available()) {
  console.error('data/time-profile.js 还是占位文件；先跑：');
  console.error('  .\\tools\\import-timetable.ps1');
  console.error('  node tools\\build-time-profile.js tools\\_in\\timetable-cells.csv');
  process.exit(1);
}

const P = require('./preview-common.js');
const heatColor = P.heatColor;

const VIEW_W = graph.meta.viewBox[0];
const VIEW_H = graph.meta.viewBox[1];
const GAP = 36;
const TOP = 132;
const COLS = 2;

const basemapRaw = fs.readFileSync(path.join(ROOT, 'assets', 'campus-map.svg'), 'utf8');
const inner = basemapRaw.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');

const CN = timeModel.WEEKDAY_CN;
/** "周一07:50" / "d1w0470" / "07:50"（默认周一）都能认。 */
function findSlot(spec) {
  const s = String(spec).trim();
  const keyed = timeModel.windows().find(w => w.key === s);
  if (keyed) return keyed;
  const m = /^(?:周|星期)?([一二三四五六日])\s*(\d{1,2}):(\d{2})$/.exec(s);
  if (m) {
    const wd = CN.indexOf(m[1]);
    const min = Number(m[2]) * 60 + Number(m[3]);
    return timeModel.windows().find(w => w.weekday === wd && w.minutes === min) || null;
  }
  if (/^\d{1,2}:\d{2}$/.test(s)) return timeModel.windowsFor(1).find(w => w.time === s) || null;
  return null;
}

const wanted = process.argv.slice(2);
// 默认四个面板：把"同一天不同时刻"和"同一时刻不同天"两个维度都画出来。
// 周四 18:50 几乎是空的、周一 18:50 还很忙——这是真实课表里的差别（周三下午 / 周四晚上全校没课）。
const defaultSpecs = ['周一07:50', '周一18:50', '周四07:50', '周四18:50'];
const specs = wanted.length ? wanted : defaultSpecs;
const picks = specs.map(t => {
  const w = findSlot(t);
  if (!w) {
    console.error(`找不到时段「${t}」。可用写法：周一07:50 / d1w0470。现有：`);
    console.error('  ' + timeModel.windows().map(x => `周${CN[x.weekday]}${x.time}`).join(', '));
    process.exit(1);
  }
  return w;
});

/** 一个面板：底图 + 该时段的热度层 + 统计。 */
function panel(slot, idx) {
  const f = timeModel.flowAt(slot.key);
  const cell = idx % COLS;
  const row = Math.floor(idx / COLS);
  const x0 = cell * (VIEW_W + GAP);
  const y0 = row * (VIEW_H + TOP);
  let hot = 0, warm = 0, nz = 0;
  graph.edges.forEach((e, ei) => {
    const vff = router.ROAD_SPEED[e[4]] || router.DEFAULT_SPEED;
    const occ = router.solveEdgeState(vff, 1, f[ei]).occ;
    if (occ >= 0.7) hot++; else if (occ >= 0.4) warm++;
    if (f[ei] > 0) nz++;
  });

  let s = `<g transform="translate(${x0},${y0 + TOP})">`;
  s += `<clipPath id="tc${idx}"><rect x="0" y="0" width="${VIEW_W}" height="${VIEW_H}"/></clipPath>`;
  s += `<g clip-path="url(#tc${idx})">`;
  s += `<rect x="0" y="0" width="${VIEW_W}" height="${VIEW_H}" fill="#f8faf7"/>`;
  s += inner;
  for (let ei = 0; ei < router.EDGE_COUNT; ei++) {
    if (f[ei] <= 0) continue;
    const vff = router.ROAD_SPEED[graph.edges[ei][4]] || router.DEFAULT_SPEED;
    const occ = router.solveEdgeState(vff, 1, f[ei]).occ;
    if (occ < 0.02) continue;
    s += P.heatSegSvg(router.edgePoints(ei), occ);
  }
  s += '</g>';

  const hhmm = `${String(Math.floor(slot.minutes / 60)).padStart(2, '0')}:${String(slot.minutes % 60).padStart(2, '0')}`;
  s += `<text x="0" y="-84" font-size="30" font-weight="bold" fill="#146b55">周${CN[slot.weekday]} ${hhmm} 换课</text>`;
  s += `<text x="0" y="-48" font-size="22" fill="#2c4a3f">全网 ${Number(slot.total).toLocaleString()} 人次`
    + ` · 有流量路段 ${nz} 条 · 较堵(占用≥0.5) ${hot} 条</text>`;
  s += `<text x="0" y="-18" font-size="22" fill="#6b7d74">口径：真实课表推算（${timeModel.source()}）</text>`;
  s += '</g>';
  return { svg: s, hot, nz, time: `周${CN[slot.weekday]} ${hhmm}`, total: slot.total };
}

const rendered = picks.map(panel);
const rows = Math.ceil(picks.length / COLS);
const W = VIEW_W * COLS + GAP * (COLS - 1);
const H = rows * (VIEW_H + TOP) + 70;

const out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`
  + `<rect width="100%" height="100%" fill="#eef3ef"/>`
  + rendered.map(r => r.svg).join('')
  + `<text x="0" y="${H - 24}" font-size="20" fill="#6b7d74">`
  + `热度层按该时段的“占用率”绘制（占用率 ∝ 流量 ÷ 车速）：越红越粗越堵。`
  + `形状来自真实班级课表（按星期几分开算，所以周三下午 / 周四晚上本来就空）；`
  + `量级按原始数据的 peak_slot_person_trips 逐边标定。`
  + `非换课时刻（周末/深夜/两节课中间）没有通勤，热度层为空。生成脚本：tools/make-time-preview.js`
  + `</text></svg>`;

const dest = path.join(__dirname, 'preview-time.svg');
fs.writeFileSync(dest, out, 'utf8');
rendered.forEach(r => console.log(`${r.time}  全网 ${String(r.total).padStart(8)} 人次  有流量 ${String(r.nz).padStart(3)} 条  较堵 ${r.hot} 条`));
console.log(`\n已生成 ${path.relative(process.cwd(), dest)}  ${(Buffer.byteLength(out) / 1024).toFixed(0)} KB`);
