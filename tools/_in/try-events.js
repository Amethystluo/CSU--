// 验证事件模型：选人 -> 场馆 -> 流量 -> 对路线的影响
const events = require('../..' + '/miniprogram/miniprogram/utils/events.js');
const router = require('../../miniprogram/miniprogram/utils/router.js');
const graph = router.graph;

const demo = events.normalize({
  title: '2026 秋季校运会',
  type: 'sports',
  date: '2026-10-15',
  start: '08:00', end: '17:00',
  venue: '新校体育场“鸟巢”西门',
  grades: [],
  departments: [],
  headcount: 3000,
});
console.log('事件：', events.describe(demo));
console.log('校验：', JSON.stringify(events.validate(demo)));
console.log('人群：', events.describeAudience(demo));
const a = events.audienceOf(demo);
console.log(`  选中 ${a.students} 人 / ${a.classes} 班 / 涉及 ${a.dorms.length} 栋宿舍`);
console.log('  按年级：', a.byGrade.map(g => `${g.name} ${g.students}`).join('，'));
console.log('  前几栋宿舍：', a.dorms.slice(0, 5).map(d => `${d.name} ${Math.round(d.students)}`).join('，'));

const v = events.venueOf(demo);
console.log('\n场馆：', v.name, '-> 节点 #' + v.node, '离标注', v.snapMeters, '米');

const t0 = Date.now();
const r = events.flowFor(demo);
console.log(`\n流量：${r.stats.people} 人，从 ${r.stats.dorms} 栋宿舍出发，${r.stats.pairs} 次最短路，${r.stats.trips} 段成形，未连通 ${Math.round(r.stats.unassigned)} 人（${Date.now() - t0} ms）`);
console.log('窗口：', r.perWindow.map(w => `${w.time} ${w.kind === 'arrival' ? '入场' : '离场'} ${Math.round(w.people)}人`).join(' | '));
let sum = 0, nz = 0;
for (const x of r.flow) { sum += x; if (x > 0) nz++; }
console.log(`合计 ${Math.round(sum)} 人次 · 有流量路段 ${nz} 条`);

// 与基线对比：这条路变了多少
const base = router.baselinePeak();
const occ = f => {
  let hot = 0, mx = 0;
  graph.edges.forEach((e, i) => {
    const vff = router.ROAD_SPEED[e[4]] || router.DEFAULT_SPEED;
    const o = router.solveEdgeState(vff, 1, f[i]).occ;
    if (o > mx) mx = o; if (o >= 0.5) hot++;
  });
  return { hot, mx: mx.toFixed(2) };
};
const withEv = new Float64Array(router.EDGE_COUNT);
for (let i = 0; i < router.EDGE_COUNT; i++) withEv[i] = base[i] + r.flow[i];
console.log('\n占用率对比（包络基线 vs 基线+事件）：');
console.log('  基线      ', JSON.stringify(occ(base)));
console.log('  基线+校运会', JSON.stringify(occ(withEv)));

// 对路线的影响
const from = graph.places.find(p => p.n === '南校区6舍');
const to = graph.places.find(p => p.n === '数学与统计学院');
const n0 = router.buildNetwork({});
const n1 = router.buildNetwork({ peak: withEv });
const r0 = router.planOn(n0, from.i, to.i, 'fastest');
const r1 = router.planOn(n1, from.i, to.i, 'fastest');
console.log('\n路线（南校区6舍 -> 数学与统计学院）：');
console.log(`  基线       ${r0.distanceMeters}m / ${r0.timeMinutes}分 / 平均占用 ${r0.avgCongestion}`);
console.log(`  含校运会   ${r1.distanceMeters}m / ${r1.timeMinutes}分 / 平均占用 ${r1.avgCongestion}`);
console.log(`  ${r0.distanceMeters !== r1.distanceMeters ? '路线变了' : '路线未变（绕路不划算）'}`);

// 小规模事件：只影响一栋楼
const small = events.normalize({
  title: '机械学院双选会', type: 'jobfair', date: '2026-10-15',
  start: '09:00', end: '16:00', venue: '南校礼堂',
  grades: ['26'], departments: ['机械', '机械类', '机械D', '机械T'], headcount: 0,
});
console.log('\n' + events.describe(small));
const rs = events.flowFor(small);
console.log('  窗口：', rs.perWindow.map(w => `${w.time} ${Math.round(w.people)}人`).join(' | '));

// 只按年级
const g = events.normalize({ title: '全校年级大会', type: 'assembly', date: '2026-10-16', start: '07:00', end: '07:40', venue: '南校礼堂', grades: ['26'], departments: [] });
console.log('\n' + events.describe(g), '->', events.audienceOf(g).students, '人');
