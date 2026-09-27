/**
 * 三种模式（少人优先 / 时间最短 / 距离最短）的对比分析，用来判断它们是否真的
 * 给出了不同的路线、以及速度模型是否合理。
 *
 *   node tools/compare-modes.js
 */
const { ROOT } = require('./paths.js');
const path = require('path');
const router = require(path.join(ROOT, 'utils', 'router.js'));
const graph = router.graph;
const place = n => graph.places.find(p => p.n === n);

console.log('速度表 (米/分钟):', JSON.stringify(router.ROAD_SPEED));
console.log(`拥挤减速系数 ${router.CROWD_SLOWDOWN}（最挤路段车速降 ${(router.CROWD_SLOWDOWN * 100).toFixed(0)}%）\n`);

const PAIRS = [
  ['南校区6舍', '数学与统计学院'],
  ['升华学生公寓 7 栋', '外语网络楼'],
  ['南校区2舍', '第二教学楼'],
  ['升华学生公寓44栋', '第一教学楼'],
  ['南校区1舍', '化学化工学院'],
  ['升华学生公寓 24 栋', 'D座'],
];

const kmh = m => (m * 60 / 1000).toFixed(1) + ' km/h';
let distinctTotal = 0, n = 0;

for (const [from, to] of PAIRS) {
  const a = place(from), b = place(to);
  if (!a || !b) { console.log(`跳过 ${from} -> ${to}`); continue; }
  const all = router.planAll(a.i, b.i);
  const rows = ['quiet', 'fastest', 'shortest'].map(k => all[k]);
  if (rows.some(r => !r.ok)) { console.log(`跳过（不可达）${from} -> ${to}\n`); continue; }
  n++;

  const sigs = new Set(rows.map(r => r.path.join(',')));
  distinctTotal += sigs.size;
  console.log(`【${from} → ${to}】 三种模式给出 ${sigs.size} 条不同路线`);

  for (const r of rows) {
    const avgSpeed = r.distanceMeters / r.timeMinutes;   // 米/分钟
    console.log(
      `  ${r.modeName}  距离 ${String(r.distanceMeters).padStart(5)} m` +
      `  时间 ${String(r.timeMinutes).padStart(5)} 分` +
      `  (均速 ${kmh(avgSpeed).padStart(9)})` +
      `  平均热度 ${String(r.avgHeatPersons).padStart(5)} 人` +
      `  最挤 ${String(r.maxHeatPersons).padStart(5)} 人` +
      `  段数 ${String(r.segmentCount).padStart(3)}`,
    );
  }
  // 一致性：时间最短方案的时间必须不劣于其他方案
  const fastest = all.fastest, shortest = all.shortest, quiet = all.quiet;
  const okTime = fastest.timeMinutes <= shortest.timeMinutes + 1e-9 && fastest.timeMinutes <= quiet.timeMinutes + 1e-9;
  const okDist = shortest.distanceMeters <= fastest.distanceMeters && shortest.distanceMeters <= quiet.distanceMeters;
  const okHeat = quiet.avgHeatPersons <= fastest.avgHeatPersons + 1e-9;
  console.log(`  自洽性: 时间最短方案确实最快=${okTime}  距离最短方案确实最短=${okDist}  少人方案热度最低=${okHeat}`);
  // 路型构成差异
  const types = new Set();
  rows.forEach(r => Object.keys(r.byRoadType).forEach(t => types.add(t)));
  console.log('  路型构成:');
  for (const r of rows) {
    const s = Object.entries(r.byRoadType).sort((x, y) => y[1] - x[1])
      .map(([t, v]) => `${t} ${v}m`).join(', ');
    console.log(`    ${r.modeName}: ${s}`);
  }
  console.log('');
}

console.log(`平均每种出行对给出 ${(distinctTotal / n).toFixed(2)} 条不同路线`);

// 全局：路段速度分布
const speeds = {};
graph.edges.forEach(e => {
  const t = graph.roadTypes[e[4]];
  speeds[t] = speeds[t] || { n: 0, min: Infinity, max: 0 };
  const s = router.speedOf(t, e[3]);
  speeds[t].n++; speeds[t].min = Math.min(speeds[t].min, s); speeds[t].max = Math.max(speeds[t].max, s);
});
console.log('\n各类型路段实际速度区间（含拥挤）:');
Object.entries(speeds).forEach(([t, v]) => {
  console.log(`  ${t.padEnd(14)} ${v.n} 段  ${kmh(v.min)} ~ ${kmh(v.max)}`);
});
