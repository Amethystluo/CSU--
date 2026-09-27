/**
 * 生成路线预览图：把算出来的路线直接画进热度地图 SVG 里，
 * 用浏览器打开 tools/preview-routes.svg 就能核对路线是否严丝合缝压在道路上。
 *
 * 线宽与箭头沿用 tools/preview-common.js（与小程序同一套比例），所以预览≈真机观感。
 *
 *   node tools/make-preview.js
 */
const { ROOT } = require('./paths.js');
const fs = require('fs');
const path = require('path');
const P = require('./preview-common.js');
const router = P.router;
const graph = router.graph;

const basemap = fs.readFileSync(
  path.join(ROOT, 'assets', 'traffic-heatmap.svg'), 'utf8',
);

const COLORS = ['#146b55', '#1f5fd0', '#8a2bbf'];
const DEMOS = [
  ['南校区6舍', '数学与统计学院'],
  ['升华学生公寓 7 栋', '外语网络楼'],
  ['升华学生公寓44栋', '第一教学楼'],
];

const place = name => graph.places.find(p => p.n === name);
const legend = [];
let overlay = '';

DEMOS.forEach(([from, to], k) => {
  const a = place(from), b = place(to);
  if (!a || !b) { console.log(`跳过（找不到地点）: ${from} -> ${to}`); return; }
  const quiet = router.plan(a.i, b.i, 'quiet');
  const fast = router.plan(a.i, b.i, 'fastest');
  if (!quiet.ok) { console.log(`跳过（不可达）: ${from} -> ${to}`); return; }

  const color = COLORS[k % COLORS.length];
  const pts = router.pathToPoints(quiet.path);

  // 时间最短的走法用红色虚线画在下面做对比
  if (fast.ok && JSON.stringify(fast.path) !== JSON.stringify(quiet.path)) {
    const fp = P.d(router.pathToPoints(fast.path));
    overlay += `<path d="${fp}" fill="none" stroke="#c0392b" stroke-width="3" stroke-dasharray="9 7"`
      + ` opacity="0.55" stroke-linecap="round"/>`;
  }
  overlay += P.routeSvg(pts, color, quiet.path, quiet.usedEdges);
  overlay += P.endpointSvg(graph.px[a.i], graph.py[a.i], color);
  overlay += P.endpointSvg(graph.px[b.i], graph.py[b.i], '#d22626');

  const heatCut = fast.ok && fast.avgHeatPersons > 0
    ? Math.round((1 - quiet.avgHeatPersons / fast.avgHeatPersons) * 100) : 0;
  legend.push({
    color,
    text: `${from} → ${to}`,
    sub: `少人 ${quiet.distanceMeters}m/${quiet.timeMinutes}分 平均${quiet.avgHeatPersons}人`
      + ` · 最快 ${fast.ok ? fast.distanceMeters + 'm/' + fast.timeMinutes + '分 平均' + fast.avgHeatPersons + '人' : '-'}`
      + ` · 人流 -${heatCut}%`,
  });
  console.log(`${from} -> ${to}: 少人 ${quiet.distanceMeters}m/${quiet.timeMinutes}分 平均${quiet.avgHeatPersons}人`
    + ` | 最快 ${fast.distanceMeters}m/${fast.timeMinutes}分 平均${fast.avgHeatPersons}人 | 人流降 ${heatCut}%`);
});

let legendSvg = '<g font-family="Microsoft YaHei,sans-serif">'
  + '<rect x="24" y="24" width="1000" height="' + (78 + legend.length * 54) + '" rx="14"'
  + ' fill="#ffffff" opacity="0.94" stroke="#cfe0d5"/>'
  + '<text x="48" y="62" font-size="26" font-weight="bold" fill="#146b55">'
  + '路线规划预览（实线=少人优先，绿色箭头=行进方向，红色虚线=时间最短）</text>';
legend.forEach((l, i) => {
  const y = 106 + i * 54;
  legendSvg += `<rect x="48" y="${y - 16}" width="30" height="8" rx="4" fill="${l.color}"/>`
    + `<text x="92" y="${y - 8}" font-size="23" fill="#1c3b31">${l.text}</text>`
    + `<text x="92" y="${y + 20}" font-size="19" fill="#6b7d74">${l.sub}</text>`;
});
legendSvg += '</g>';

const out = basemap.replace('</svg>', `${overlay}${legendSvg}</svg>`);
const dest = path.join(__dirname, 'preview-routes.svg');
fs.writeFileSync(dest, out, 'utf8');
console.log(`\n已生成 ${path.relative(process.cwd(), dest)}  ${(Buffer.byteLength(out) / 1024).toFixed(0)} KB`);
console.log('线宽/箭头按 375px 屏宽折算，观感与真机一致；用浏览器打开即可查看。');
