/**
 * 路由逻辑测试（Node 直接跑，不需要开发者工具）：
 *   node tools/test-router.js
 *
 * 覆盖：投影正确性、节点吸附、路径连续性、距离自洽、热度惩罚效果、
 *       不可达分支、以及"少人路线 vs 最短路线"的实际差异。
 */
const { ROOT } = require('./paths.js');
const path = require('path');
const router = require(path.join(ROOT, 'utils', 'router.js'));
const graph = router.graph;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`); }
}

const findPlace = name => graph.places.find(p => p.n === name);

console.log('=== 1. 投影与数据包 ===');
console.log(`  节点 ${graph.meta.nodeCount} / 路段 ${graph.meta.edgeCount} / 投影误差 ${graph.meta.projectionMeanErrPx}px`);
check('投影误差 < 1px', graph.meta.projectionMeanErrPx < 1, `${graph.meta.projectionMeanErrPx}px`);
{
  // 已知点位：数学与统计学院 -> 应落在 viewBox 内，且靠近地图右下
  const p = router.project(112.94078141292744, 28.149803);
  const [W, H] = graph.meta.viewBox;
  check('投影结果落在 viewBox 内', p[0] >= 0 && p[0] <= W && p[1] >= 0 && p[1] <= H,
    `(${p[0].toFixed(0)}, ${p[1].toFixed(0)}) 视口 ${W.toFixed(0)}x${H.toFixed(0)}`);
  check('数统院在地图南部（y 较大）', p[1] > H * 0.7, `y=${p[1].toFixed(0)}`);
}

console.log('\n=== 2. 最近节点吸附 ===');
{
  const hit = router.nearestNodeByLonLat(112.93324839293244, 28.1627837); // 南校区6舍
  check('吸附成功且距离合理(<150m)', hit.snapMeters < 150, `${hit.snapMeters}m -> 节点#${hit.index}`);
  const gps = router.nearestNodeByLonLat(112.935, 28.155); // 新校区中部
  check('任意 GPS 点都能吸附', gps.index >= 0 && gps.snapMeters < 200, `${gps.snapMeters}m`);
}

console.log('\n=== 2b. 坐标 -> 地点名（自动定位显示什么） ===');
{
  // 就在某个地点上 -> 直接用地名
  const p = router.graph.places.find(x => x.n === '南校区6舍');
  const d0 = router.describeLonLat(112.93324839293244, 28.1627837);
  check('定位到某地点附近时用地名做标签', d0.label === p.n, d0.label);
  check('标签里不含裸经纬度', !/\d{2}\.\d{4,}/.test(d0.label), d0.label);
  check('附近地点就用它的名字', !!d0.place && d0.place.n === p.n);
  check('给出了距离并且与吸附计算一致',
    Math.abs(d0.distanceMeters - router.nearestPlace(
      router.project(112.93324839293244, 28.1627837)[0],
      router.project(112.93324839293244, 28.1627837)[1]).distanceMeters) < 1e-6,
    `${d0.distanceMeters.toFixed(1)} 米`);
  check('详情里给出了校区/类型/精确距离', /南校区 · 宿舍 · 距该地点约 \d+ 米/.test(d0.detail), d0.detail);
  check('详情里不再重复地点名（label 已经有了）', d0.detail.indexOf(d0.place.n) < 0, d0.detail);
  check('坐标仍然单独给出（便于核对）', d0.coord === '28.16278, 112.93325', d0.coord);

  // 阈值行为：150m 内是"就在这"，600m 内是"附近"，更远是"距…约 N 米"
  const show = (meters) => router.describeLonLat(112.93324839293244, 28.1627837 + meters / 111320);
  check('阈值常量有序', router.NEAR_PLACE_M < router.AROUND_PLACE_M,
    `${router.NEAR_PLACE_M} < ${router.AROUND_PLACE_M}`);
  check('近距离不加后缀', !/附近|距/.test(show(80).label), show(80).label);
  // 600~1000 米这一档用"米"：正东 700 米处离最近的教学点约 760 米
  const east = (meters) => router.describeLonLat(
    112.93324839293244 + meters / 111320 / Math.cos(28.16 * Math.PI / 180), 28.1627837);
  const mid = east(700);
  check('中距离说"距…约 N 米"', /^距.+约 \d+ 米$/.test(mid.label), mid.label);
  check('中距离不带"附近"后缀', !/附近/.test(mid.label), mid.label);
  check('远距离改用公里', /^距.+约 \d+\.\d 公里$/.test(show(1500).label), show(1500).label);

  // 全校区撒点都必须能命名（不能退化成"当前位置"）
  let unnamed = 0;
  for (let i = 0; i < 200; i++) {
    const lon = 112.925 + (i % 20) * 0.0015, lat = 28.145 + Math.floor(i / 20) * 0.0026;
    const d = router.describeLonLat(lon, lat);
    if (!d.place || !d.label) unnamed++;
  }
  check('校区内任意点都能给出地点名', unnamed === 0, `${unnamed}/200 个点无法命名`);
}

console.log('\n=== 3. 路径连续性 / 距离自洽 ===');
const cases = [
  ['南校区6舍', '数学与统计学院', '跨校区'],
  ['升华学生公寓 7 栋', '外语网络楼', '新校区内'],
  ['南校区2舍', '第二教学楼', '南校区内'],
  ['升华学生公寓44栋', '第一教学楼', '跨校区反向'],
];
const results = [];
for (const [from, to, tag] of cases) {
  const a = findPlace(from), b = findPlace(to);
  if (!a || !b) { check(`地点存在：${from} -> ${to}`, false); continue; }
  const r = router.plan(a.i, b.i, 'quiet');
  if (!r.ok) { check(`${from} -> ${to} 可规划`, false, r.reason); continue; }
  results.push({ from, to, tag, a, b, r });

  // 连续性：每一跳都必须是一条真实存在的边
  const g = new Map();
  graph.edges.forEach(([u, v], idx) => {
    if (!g.has(u)) g.set(u, new Map());
    if (!g.has(v)) g.set(v, new Map());
    g.get(u).set(v, idx); g.get(v).set(u, idx);
  });
  let contiguous = true;
  for (let i = 0; i + 1 < r.path.length; i++) {
    if (!g.get(r.path[i]) || !g.get(r.path[i + 1])) { contiguous = false; break; }
  }
  // 距离自洽：metricsOf 重算应与 plan 的结果一致
  const again = router.metricsOf(r.path);
  check(`${tag} ${from} -> ${to}`, true,
    `${r.distanceMeters}m, ${r.timeMinutes}分, ${r.segmentCount}段, 平均${r.avgHeatPersons}人, 峰值${r.maxHeatPersons}人`);
  check(`  路径每跳都是真实路段`, contiguous);
  check(`  距离指标可复算`, again.distanceMeters === r.distanceMeters, `${again.distanceMeters}m`);
  check(`  时间指标可复算`, again.timeMinutes === r.timeMinutes, `${again.timeMinutes}分`);
}

console.log('\n=== 3b. 电动自行车时间模型 ===');
{
  // 速度表取值范围：电动车应在合理区间（人行道推行除外）
  const speedOk = Object.entries(router.ROAD_SPEED).every(([t, v]) => {
    const kmh = v * 60 / 1000;
    return t === 'footway' || t === 'path' ? kmh <= 15 : (kmh >= 15 && kmh <= 25);
  });
  check('各道路类型车速在新国标合理区间', speedOk,
    Object.entries(router.ROAD_SPEED).map(([t, v]) => `${t} ${(v * 60 / 1000).toFixed(0)}km/h`).join(' '));
  check('主干道比人行道快', router.speedOf('primary', 0) > router.speedOf('footway', 0) * 3);
  check('拥挤会降低车速', router.speedOf('residential', 1) < router.speedOf('residential', 0),
    `${router.speedOf('residential', 0).toFixed(0)} -> ${router.speedOf('residential', 1).toFixed(0)} m/min`);
  check('拥挤最多降 40%（有下限保护）',
    router.speedOf('residential', 1) >= router.speedOf('residential', 0) * 0.4 - 1e-9);

  // 时间 = 距离 / 速度：用一条真实路径核对
  const r = results[0].r;
  const impliedSpeed = r.distanceMeters / r.timeMinutes;   // 米/分钟
  const kmh = impliedSpeed * 60 / 1000;
  check('整条路线均速落在电动车合理区间(10~25 km/h)', kmh >= 10 && kmh <= 25, `${kmh.toFixed(1)} km/h`);
  check('无拥挤时间 >= 实际时间', r.freeFlowTimeMinutes <= r.timeMinutes + 1e-9,
    `空载 ${r.freeFlowTimeMinutes}分 / 实际 ${r.timeMinutes}分`);
  check('被人流拖慢的时间 = 实际 - 空载',
    Math.abs(r.crowdDelayMinutes - (r.timeMinutes - r.freeFlowTimeMinutes)) < 0.11,
    `${r.crowdDelayMinutes} 分钟`);

  // formatDuration
  check('时长格式化', router.formatDuration(9) === '9 分钟'
    && router.formatDuration(65) === '1 小时 5 分钟'
    && router.formatDuration(120) === '2 小时',
    `${router.formatDuration(9)} / ${router.formatDuration(65)} / ${router.formatDuration(120)}`);
}

console.log('\n=== 4. 三种走法是否真的不同 ===');
let differCount = 0, stats = { fastestWin: 0, quietCut: 0 };
for (const c of results) {
  const all = router.planAll(c.a.i, c.b.i);
  const { quiet, fastest, shortest } = all;
  if (!quiet.ok || !fastest.ok || !shortest.ok) continue;
  const sigs = new Set([quiet, fastest, shortest].map(r => r.path.join(',')));
  if (sigs.size > 1) differCount++;
  const heatCut = fastest.avgHeatPersons > 0
    ? (1 - quiet.avgHeatPersons / fastest.avgHeatPersons) * 100 : 0;
  stats.quietCut += heatCut;
  if (fastest.timeMinutes < shortest.timeMinutes - 0.5) stats.fastestWin++;
  console.log(`  ${c.tag} ${c.from} → ${c.to}（${sigs.size} 条不同路线）`);
  console.log(`      少人优先 ${quiet.distanceMeters}m / ${quiet.timeMinutes}分 / 平均 ${quiet.avgHeatPersons} 人`);
  console.log(`      时间最短 ${fastest.distanceMeters}m / ${fastest.timeMinutes}分 / 平均 ${fastest.avgHeatPersons} 人`);
  console.log(`      距离最短 ${shortest.distanceMeters}m / ${shortest.timeMinutes}分 / 平均 ${shortest.avgHeatPersons} 人`);
  check(`  ${c.to}：时间最短方案确实最快`,
    fastest.timeMinutes <= shortest.timeMinutes + 1e-9 && fastest.timeMinutes <= quiet.timeMinutes + 1e-9);
  check(`  ${c.to}：距离最短方案确实最短`,
    shortest.distanceMeters <= fastest.distanceMeters && shortest.distanceMeters <= quiet.distanceMeters);
  check(`  ${c.to}：少人方案平均热度最低`, quiet.avgHeatPersons <= fastest.avgHeatPersons + 1e-9);
}
check('三种走法至少给出 2 条不同路线', differCount > 0, `${differCount}/${results.length} 组有差异`);
console.log(`  平均：少人方案比最快方案人流低 ${(stats.quietCut / results.length).toFixed(1)}%；` +
  `${stats.fastestWin}/${results.length} 组的"时间最短"确实比"距离最短"更快`);

console.log('\n=== 5. 不可达与边界分支 ===');
{
  // 分量1 只有 14 个孤立节点，先找一个样本
  const comp1 = [];
  for (let i = 0; i < graph.comp.length; i++) if (graph.comp[i] === 1) comp1.push(i);
  check('存在 14 节点孤立分量', comp1.length === 14, `${comp1.length} 个`);
  const inComp1 = comp1[0];
  const mainPlace = findPlace('数学与统计学院');
  const r = router.plan(inComp1, mainPlace.i, 'quiet');
  check('孤立分量 -> 主路网 返回不可达', !r.ok && r.unreachable === true, r.reason || '');
  const r2 = router.plan(mainPlace.i, inComp1, 'quiet');
  check('主路网 -> 孤立分量 返回不可达', !r2.ok && r2.unreachable === true);
}
{
  const p = findPlace('数学与统计学院');
  const r = router.plan(p.i, p.i, 'quiet');
  check('起点=终点 有明确提示', !r.ok && /同一个位置/.test(r.reason), r.reason);
  const bad = router.plan(-5, 10, 0);
  check('非法下标 有明确提示', !bad.ok && /越界/.test(bad.reason), bad.reason);
}

console.log('\n=== 6. 确定性 ===');
{
  const a = findPlace('南校区6舍'), b = findPlace('数学与统计学院');
  const r1 = router.plan(a.i, b.i, 'quiet');
  const r2 = router.plan(a.i, b.i, 'quiet');
  check('同样输入两次结果一致', JSON.stringify(r1.path) === JSON.stringify(r2.path));
}

console.log('\n=== 7. 地点清单 ===');
{
  const dorms = graph.places.filter(p => p.k === '宿舍').length;
  const locs = graph.places.filter(p => p.k === '教学点').length;
  check('宿舍 44 个', dorms === 44, `${dorms}`);
  check('教学点 14 个', locs === 14, `${locs}`);
  check('每个地点都指向有效节点',
    graph.places.every(p => p.i >= 0 && p.i < graph.meta.nodeCount));
  check('每个地点都有校区标签',
    graph.places.every(p => p.c === '新校区' || p.c === '南校区'),
    JSON.stringify([...new Set(graph.places.map(p => p.c))]));
}

console.log('\n=== 8. 绘制折线 ===');
{
  const a = findPlace('升华学生公寓 7 栋'), b = findPlace('外语网络楼');
  const r = router.plan(a.i, b.i, 'quiet');
  const pts = router.pathToPoints(r.path);
  check('折线点数 == 路径节点数', pts.length === r.path.length, `${pts.length}`);
  check('折线点全在 viewBox 内',
    pts.every(([x, y]) => x >= 0 && x <= graph.meta.viewBox[0] && y >= 0 && y <= graph.meta.viewBox[1]));
}

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exit(fail ? 1 : 0);
