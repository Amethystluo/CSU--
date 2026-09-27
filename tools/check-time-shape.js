/**
 * 验证：用真实课表生成的时段画像到底"分不分时段、分不分天"。
 *   node tools/check-time-shape.js
 * 只读，不改任何数据。
 */
const path = require('path');
const { ROOT } = require('./paths.js');
const graph = require(path.join(ROOT, 'data', 'route-graph.js'));
const router = require(path.join(ROOT, 'utils', 'router.js'));
const timeModel = require(path.join(ROOT, 'utils', 'timeModel.js'));
const profile = require(path.join(ROOT, 'data', 'time-profile.js'));

if (!profile.available) {
  console.log('time-profile.js 还是占位文件（available=false），先跑：');
  console.log('  .\\tools\\import-timetable.ps1');
  console.log('  node tools\\build-time-profile.js tools\\_in\\timetable-cells.csv');
  process.exit(0);
}
const CN = timeModel.WEEKDAY_CN;
const W = profile.windows.length;
const days = timeModel.days();
const st = profile.stats || {};
console.log(`画像：${profile.edgeIndex.length} 条有流量路段 × ${W} 个时段（${days.length} 天）`);
console.log(`来源 ${profile.source} · 生成于 ${profile.generatedAt}`);
console.log(`口径：${st.classesInTimetable} 个班级 / ${st.sessions} 门去重后的课（其中 ${st.sharedSessions} 门多班共上）`
  + ` / 人数 ${st.peopleTotalAfterDedup}（可定位 ${st.peopleMatched}，不纳入 ${st.peopleExcluded}，未知 ${st.peopleUnknown}）`);

const occOf = f => {
  let hot = 0, maxOcc = 0, sum = 0, nz = 0;
  graph.edges.forEach((e, ei) => {
    const vff = router.ROAD_SPEED[e[4]] || router.DEFAULT_SPEED;
    const occ = router.solveEdgeState(vff, 1, f[ei]).occ;
    if (f[ei] > 0) nz++;
    sum += occ;
    if (occ > maxOcc) maxOcc = occ;
    if (occ >= 0.5) hot++;
  });
  return { hot, maxOcc, sum, nz };
};

console.log('\n=== 1. 每天的量级与拥堵 ===');
const perDay = days.map(d => {
  const rows = timeModel.windowsFor(d).map(w => {
    const o = occOf(timeModel.flowAt(w.key));
    return { time: w.time, key: w.key, total: w.total, hot: o.hot, maxOcc: o.maxOcc, sum: o.sum, nz: o.nz };
  });
  const totals = rows.map(r => r.total);
  return {
    weekday: d,
    rows,
    min: Math.min.apply(null, totals),
    max: Math.max.apply(null, totals),
    peak: rows.reduce((a, b) => (b.total > a.total ? b : a), rows[0]),
  };
});
console.log('  周几   最忙时刻   最忙人次     最闲人次    峰/谷   较堵路段  最高占用率');
for (const d of perDay) {
  console.log(`  周${CN[d.weekday]}    ${d.peak.time}   ${String(d.peak.total).padStart(9)}`
    + `  ${String(d.min).padStart(9)}  ${(d.max / Math.max(d.min, 1)).toFixed(1).padStart(6)}×`
    + `  ${String(d.peak.hot).padStart(6)}    ${d.peak.maxOcc.toFixed(2)}`);
}

console.log('\n=== 2. 每天的时段明细（人次 / 占用率合计）===');
for (const d of perDay) {
  console.log(`  周${CN[d.weekday]}: ` + d.rows.map(r => `${r.time} ${r.total}(${r.sum.toFixed(1)})`).join('  '));
}

console.log('\n=== 3. 三个维度上的差异（"选日期"到底有没有意义）===');
const allRows = perDay.reduce((a, d) => a.concat(d.rows), []);
const allTotals = allRows.map(r => r.total);
const dayPeaks = perDay.map(d => d.peak.total);
console.log(`  全部 ${W} 个时段：最小 ${Math.min.apply(null, allTotals).toLocaleString()}`
  + ` ~ 最大 ${Math.max.apply(null, allTotals).toLocaleString()}`
  + `（峰/谷 ${(Math.max.apply(null, allTotals) / Math.max(Math.min.apply(null, allTotals), 1)).toFixed(1)}×）`);
console.log(`  各天最忙之间：${Math.min.apply(null, dayPeaks).toLocaleString()}`
  + ` ~ ${Math.max.apply(null, dayPeaks).toLocaleString()}`);
for (const t of ['07:50', '18:50']) {
  const v = perDay.map(d => (d.rows.find(r => r.time === t) || { total: 0 }).total);
  console.log(`  同一时刻 ${t} 跨天：` + v.map((x, i) => `周${CN[days[i]]} ${x.toLocaleString()}`).join(' · ')
    + `  (最大/最小 ${(Math.max.apply(null, v) / Math.max(Math.min.apply(null, v), 1)).toFixed(1)}×)`);
}
const thu = perDay.find(d => d.weekday === 4);
const mon = perDay.find(d => d.weekday === 1);
if (thu && mon) {
  const f = d => (d.rows.find(r => r.time === '18:50') || { total: 0 }).total;
  console.log(`  -> 同一时刻 18:50：周一 ${f(mon).toLocaleString()} vs 周四 ${f(thu).toLocaleString()}`);
  console.log('     周四晚上全校基本没课，这是课表里的事实，不是模型编的。');
}
const wed = perDay.find(d => d.weekday === 3);
if (wed) {
  const f = t => (wed.rows.find(r => r.time === t) || { total: 0 }).total;
  console.log(`  -> 周三下午：13:50 ${f('13:50').toLocaleString()} / 15:40 ${f('15:40').toLocaleString()}`
    + ` / 15:50 ${f('15:50').toLocaleString()} / 18:50 ${f('18:50').toLocaleString()}`);
  console.log('     周三下午全校几乎没课、晚上才满 —— 合成"整周平均"就会把这个特征抹平。');
}

console.log('\n=== 4. 包络 vs 真实时刻（最容易被误读的一点）===');
const env = occOf(router.baselinePeak());
console.log(`  整周最高峰（包络）  较堵路段 ${env.hot} 条，最高占用率 ${env.maxOcc.toFixed(2)}，占用率合计 ${env.sum.toFixed(1)}`);
const best = allRows.reduce((a, b) => (b.sum > a.sum ? b : a), allRows[0]);
console.log(`  最忙的真实时刻      较堵路段 ${best.hot} 条，最高占用率 ${best.maxOcc.toFixed(2)}`
  + `，占用率合计 ${best.sum.toFixed(1)}（${best.time}）`);
console.log('  包络把不同时刻的峰值叠在了一起，比任何真实时刻都更堵，所以单独做成"最坏情况"选项。');

console.log('\n=== 5. 标定质量 ===');
const withPeak = profile.edgeIndex.filter(ei => graph.edges[ei][3] > 0).length;
const reach = profile.flow.filter((v, i) => graph.edges[profile.edgeIndex[i]][3] > 0
  && Math.abs(Math.max.apply(null, v) - graph.edges[profile.edgeIndex[i]][3]) < 0.5).length;
console.log(`  原始数据有峰值的路段 ${withPeak} 条，画像峰值对上的 ${reach} 条（${(100 * reach / withPeak).toFixed(0)}%）`);
console.log(`  标定系数：中位 ${st.scaleMedian}，>10 的 ${st.scaleOver10} 条，范围 ${st.scaleMin} ~ ${st.scaleMax}`);
console.log(`  完全没有流量的路段 ${st.edgesWithoutFlow} 条（原始数据里也没峰值的那些）`);
