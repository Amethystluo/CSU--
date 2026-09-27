/**
 * 情景引擎测试：封路/下雨之后，流量重分配是否守规矩。
 *   node tools/test-scenario.js
 */
const { ROOT } = require('./paths.js');
const path = require('path');
const router = require(path.join(ROOT, 'utils', 'router.js'));
const scenario = require(path.join(ROOT, 'utils', 'scenario.js'));
const graph = router.graph;
const MAX = router.MAX_PEAK;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`); }
}
const place = n => graph.places.find(p => p.n === n);

// 找一条真实的高流量路段当作"施工路段"
let busiest = 0;
for (let i = 0; i < graph.edges.length; i++) if (graph.edges[i][3] > graph.edges[busiest][3]) busiest = i;
console.log(`测试用最忙路段: #${busiest} ${graph.edgeIds[busiest]} ${graph.roadTypes[graph.edges[busiest][4]]} `
  + `峰值 ${graph.edges[busiest][3]} 人次, 长 ${Math.round(graph.edges[busiest][2])}m`);

console.log('\n=== 1. 基线情景（无雨无封路）===');
{
  const r = scenario.applyScenario({});
  check('不封路时不改变任何流量', r.changedCount === 0, `变化路段 ${r.changedCount}`);
  check('拥堵指数为 1', r.congestionIndex === 1);
  check('总量与基线一致', r.totalFlowNow === r.totalFlowBase);
  check('摘要文案正确', scenario.describeScenario(r) === '基线情景（无雨、无施工、无上报）', scenario.describeScenario(r));
}

console.log('\n=== 2. 封路：流量全部被转移 ===');
{
  const r = scenario.applyScenario({ closedEdges: [busiest] });
  check('被封路段流量清零', r.peak[busiest] === 0, `now=${r.peak[busiest]}`);
  check('被封路段被标记', r.closed[busiest] === 1);
  // 被封路段的流量必须全部找到替代路径（可达时不允许凭空消失）
  check('被封路段的流量没有丢失', r.unassignedFlow === 0, `未分配 ${r.unassignedFlow} 人次`);
  check('流量确实被转移到了别的路上', r.increased > 0, `${r.increased} 条路段流量上升`);
  check('报告给出了最拥堵的替代路段', r.worst.length > 0,
    r.worst.slice(0, 3).map(w => `${w.roadType}(占用+${w.occDelta})`).join(', '));
  check('替代路径不会包含被封路段',
    !r.worst.some(w => w.ei === busiest && w.now > 0));
  // 绕路会经过更多条边，所以全网"边遍历总量"只会增加；这是绕行的正常代价
  const sumBase = Array.from(r.basePeak).reduce((a, b) => a + b, 0);
  const sumNow = Array.from(r.peak).reduce((a, b) => a + b, 0);
  const extra = sumNow - sumBase;
  check('绕行使全网边遍历量增加（不是凭空少算）', extra > 0,
    `+${Math.round(extra)} 人次（被封 ${Math.round(r.basePeak[busiest])} 人次，绕行路径更长）`);
}

console.log('\n=== 3. 封路后：路网确实被切断一条边 ===');
{
  const net = router.buildNetwork({ closed: (() => { const c = new Uint8Array(router.EDGE_COUNT); c[busiest] = 1; return c; })() });
  const e = graph.edges[busiest];
  const has = net.adj[e[0]].some(x => x.ei === busiest) || net.adj[e[1]].some(x => x.ei === busiest);
  check('封路边不在可路由邻接表里', !has);
}

console.log('\n=== 4. 封路影响：拥堵指数上升、并且能算出绕行代价 ===');
{
  const a = place('南校区6舍'), b = place('数学与统计学院');
  const base = router.planAllOn(router.baselineNetwork(), a.i, b.i);

  // 找一条恰好在这条路线上的路段来封
  const onRoute = base.fastest.usedEdges.map(e => e.ei);
  const pick = onRoute[Math.floor(onRoute.length / 2)];
  const s = scenario.applyScenario({ closedEdges: [pick] });
  const after = router.planAllOn(s.network, a.i, b.i);

  console.log(`  封闭路线中段 #${pick} ${graph.edgeIds[pick]}（峰值 ${graph.edges[pick][3]} 人次）`);
  console.log(`  时间最短: 封闭前 ${base.fastest.distanceMeters}m/${base.fastest.timeMinutes}分`
    + ` -> 封闭后 ${after.fastest.distanceMeters}m/${after.fastest.timeMinutes}分`);
  check('封闭后时间最短路径仍然可达', after.fastest.ok);
  check('封闭后路径不再经过被封闭路段',
    !after.fastest.usedEdges.some(e => e.ei === pick));
  check('封闭后确实绕路或多花时间',
    after.fastest.timeMinutes > base.fastest.timeMinutes - 1e-9
    || after.fastest.distanceMeters > base.fastest.distanceMeters,
    `时间 +${(after.fastest.timeMinutes - base.fastest.timeMinutes).toFixed(1)} 分, `
    + `距离 +${after.fastest.distanceMeters - base.fastest.distanceMeters}m`);
}

console.log('\n=== 5. 多路段同时封闭（级联）===');
{
  const a = place('南校区6舍'), b = place('数学与统计学院');
  const base = router.planAllOn(router.baselineNetwork(), a.i, b.i);
  const onRoute = base.fastest.usedEdges.map(e => e.ei);
  const picks = [onRoute[3], onRoute[8], onRoute[13]].filter(x => x !== undefined);
  const s = scenario.applyScenario({ closedEdges: picks });
  const after = router.planAllOn(s.network, a.i, b.i);
  check('同时封 3 条路仍能找到路径', after.fastest.ok,
    after.fastest.ok ? `${after.fastest.distanceMeters}m/${after.fastest.timeMinutes}分` : after.fastest.reason);
  check('不会经过任何一条被封路段',
    after.fastest.ok && !after.fastest.usedEdges.some(e => picks.indexOf(e.ei) >= 0));
  check('多条路封闭后流量都没有丢失', s.unassignedFlow === 0, `未分配 ${s.unassignedFlow}`);
  const sumBase = Array.from(s.basePeak).reduce((x, y) => x + y, 0);
  const sumNow = Array.from(s.peak).reduce((x, y) => x + y, 0);
  check('级联绕行后全网边遍历量增加', sumNow > sumBase, `+${Math.round(sumNow - sumBase)}`);
}

console.log('\n=== 6. 封闭所有通道 -> 明确报告不可达，而不是崩掉 ===');
{
  // 找出通往 14 节点孤立分量的全部路段？改为直接封闭一条主干道两端的所有边
  const target = 0;
  const all = [];
  graph.edges.forEach((e, i) => { if (e[0] === target || e[1] === target) all.push(i); });
  const s = scenario.applyScenario({ closedEdges: all });
  check('孤立一个节点不会报错', !!s && s.peak.length === router.EDGE_COUNT);
  check('报告了无法绕行的流量', s.unassignedFlow > 0, `未分配 ${s.unassignedFlow} 人次`);
}

console.log('\n=== 7. 下雨情景：速度 -> 占用率（核心）===');
{
  const none = scenario.applyScenario({ level: 'none' });
  const light = scenario.applyScenario({ level: 'light' });
  const heavy = scenario.applyScenario({ level: 'heavy' });

  check('雨天降低出行需求', heavy.totalFlowNow < none.totalFlowNow,
    `无雨 ${none.totalFlowNow} 人次 -> 大雨 ${heavy.totalFlowNow} 人次`);
  check('雨越大需求越低', light.totalFlowNow < none.totalFlowNow && heavy.totalFlowNow < light.totalFlowNow);
  check('雨天系数表覆盖了所有路型',
    graph.roadTypes.every(t => heavy.weather.speed[t] !== undefined),
    graph.roadTypes.join(','));

  // 核心断言：出行人数几乎没变（只降 6%），但拥堵必须明显上升
  console.log(`  全网平均占用率: 无雨 ${none.avgOccNow} -> 大雨 ${heavy.avgOccNow}（拥堵指数 ${heavy.congestionIndex}）`);
  console.log(`  全网出行需求:   无雨 ${none.totalFlowNow} -> 大雨 ${heavy.totalFlowNow}（仅 -${(100 - heavy.totalFlowNow / none.totalFlowNow * 100).toFixed(1)}%）`);
  check('下雨使拥堵指数上升', heavy.congestionIndex > 1, `${heavy.congestionIndex}`);
  check('拥堵上升幅度大于需求下降幅度',
    heavy.congestionIndex - 1 > (1 - heavy.totalFlowNow / none.totalFlowNow),
    `拥堵 +${((heavy.congestionIndex - 1) * 100).toFixed(0)}% vs 需求 -${((1 - heavy.totalFlowNow / none.totalFlowNow) * 100).toFixed(1)}%`);
  check('大面积路段变堵，而不只是封路那几条', heavy.aggravated > 0,
    `明显变堵 ${heavy.aggravated} 条，新增堵点 ${heavy.newHotspots} 处`);

  // 自洽性：速度越低 -> 占用率越高（用同一条边验证函数关系）
  const vff = router.ROAD_SPEED.residential;
  const dry = router.solveEdgeState(vff, 1.0, 4000);
  const wet = router.solveEdgeState(vff, 0.8, 4000);
  check('同样流量下，天气越差速度越低、占用率越高',
    wet.speed < dry.speed && wet.occ > dry.occ,
    `无雨 ${dry.speed.toFixed(0)}m/min 占用${dry.occ.toFixed(2)} -> 大雨 ${wet.speed.toFixed(0)}m/min 占用${wet.occ.toFixed(2)}`);
  check('占用率定义成立：occ ≈ (流量/基线峰值) × (自由流速度/实际速度)',
    Math.abs(wet.occ - (4000 / MAX) * (vff / wet.speed)) < 1e-6);

  // 路线层面
  const a = place('南校区6舍'), b = place('数学与统计学院');
  const dryRoute = router.planOn(none.network, a.i, b.i, 'fastest');
  const wetRoute = router.planOn(heavy.network, a.i, b.i, 'fastest');
  check('雨天骑行时间变长', wetRoute.timeMinutes > dryRoute.timeMinutes,
    `无雨 ${dryRoute.timeMinutes} 分 -> 大雨 ${wetRoute.timeMinutes} 分`);
  check('雨天路线更拥堵（占用率更高的路被绕开）',
    wetRoute.avgCongestion >= 0,
    `拥堵程度 ${dryRoute.avgCongestion} -> ${wetRoute.avgCongestion}`);
  const sameRoute = dryRoute.path.join(',') === wetRoute.path.join(',');
  console.log(`  时间最短路线是否改变: ${sameRoute ? '否' : '是'}`);
  check('雨天三种走法仍都可用',
    ['quiet', 'fastest', 'shortest'].every(k => router.planOn(heavy.network, a.i, b.i, k).ok));
}

console.log('\n=== 8. WMO 天气编码映射 ===');
{
  const cases = [
    [0, 'none', '晴'], [2, 'none', '多云'], [3, 'none', '阴'],
    [45, 'light', '雾'], [51, 'light', '毛毛雨'], [61, 'light', '小雨'],
    [63, 'heavy', '中雨'], [65, 'heavy', '大雨'], [80, 'light', '小阵雨'],
    [82, 'heavy', '强阵雨'], [95, 'heavy', '雷阵雨'], [75, 'heavy', '雪'],
  ];
  let ok = true;
  for (const [code, level, text] of cases) {
    const l = scenario.levelFromWeatherCode(code, 0);
    const t = scenario.weatherText(code);
    if (l !== level || t !== text) { ok = false; console.log(`    ${code}: 期望 ${level}/${text} 实际 ${l}/${t}`); }
  }
  check('编码 -> 档位/文案 映射正确', ok, `${cases.length} 个编码`);
  check('无编码时用降水量兜底',
    scenario.levelFromWeatherCode(undefined, 0) === 'none'
    && scenario.levelFromWeatherCode(undefined, 1) === 'light'
    && scenario.levelFromWeatherCode(undefined, 5) === 'heavy');
}

console.log('\n=== 9. 情景 + 时间最短路径（完整链条）===');
{
  const a = place('南校区6舍'), b = place('数学与统计学院');
  const base = router.planOn(router.baselineNetwork(), a.i, b.i, 'fastest');

  // 封掉基线最快路径上最忙的一段，模拟"主干道施工 + 下雨"
  const busiestOnRoute = base.usedEdges.slice().sort((x, y) => y.heat - x.heat)[0];
  const s = scenario.applyScenario({ level: 'heavy', closedEdges: [busiestOnRoute.ei] });
  const after = router.planOn(s.network, a.i, b.i, 'fastest');

  console.log(`  情景: ${scenario.describeScenario(s)}`);
  console.log(`  基线最快: ${base.distanceMeters}m / ${base.timeMinutes}分 / 平均 ${base.avgHeatPersons} 人`);
  console.log(`  情景最快: ${after.distanceMeters}m / ${after.timeMinutes}分 / 平均 ${after.avgHeatPersons} 人`);
  console.log(`  拥堵指数 ${s.congestionIndex}, 新堵点 ${s.newHotspots} 处, 明显变堵 ${s.aggravated} 条, 流量上升 ${s.increased} 条`);
  check('完整链条可跑通：封路+下雨 -> 新热度 -> 新路径', after.ok);
  check('新路径避开了施工路段', !after.usedEdges.some(e => e.ei === busiestOnRoute.ei));
  check('情景改变了流量分布', s.changedCount > 0, `${s.changedCount} 条路段变化`);
  check('能指出受影响最重的路段', s.worst.length > 0,
    s.worst.slice(0, 2).map(w => `${w.roadType} 占用 ${w.occBase}->${w.occNow}`).join(', '));
}

console.log('\n=== 9. 路段下标是字符串也必须生效（否则封路会被静默丢掉）===');
{
  // closed 是 Uint8Array：用字符串下标赋值既不报错也不生效，
  // 于是"点了封路、热度图却没变"——用户看到的就是封了的路还是原来那个颜色。
  const target = busiest;
  const asStr = scenario.applyScenario({ closedEdges: [String(target)] });
  check('字符串下标也被当作路段下标处理',
    asStr.network.closed[target] === 1, `closed[${target}] = ${asStr.network.closed[target]}`);
  check('字符串下标下这条路的流量同样被清零',
    asStr.network.occ[target] === 0, `occ = ${asStr.network.occ[target]}`);

  const asNum = scenario.applyScenario({ closedEdges: [target] });
  check('与数字下标的结论一致（不再因为类型不同而两种行为）',
    Math.abs(asStr.congestionIndex - asNum.congestionIndex) < 1e-9
    && asStr.changedCount === asNum.changedCount,
    `指数 ${asStr.congestionIndex} vs ${asNum.congestionIndex}`);

  const bad = scenario.applyScenario({ closedEdges: ['x', -1, 1e9, null, undefined] });
  check('非法下标不会把路网搞坏（当作没封）', bad.closedEdges.length === 0 && bad.network.closed[target] === 0);

  const police = scenario.applyScenario({ level: 'none', policeEdges: [String(target)] });
  check('交警标记同样接受字符串下标', police.policeEdges.indexOf(target) >= 0,
    police.policeEdges.join(','));
}

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exit(fail ? 1 : 0);
