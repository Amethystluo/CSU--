/**
 * 用户上报 + 审核 + 交警绕行 的测试。
 *   node tools/test-reports.js
 */
const path = require('path');
const { ROOT: BASE } = require('./paths.js');
const router = require(path.join(BASE, 'utils', 'router.js'));
const scenarioEngine = require(path.join(BASE, 'utils', 'scenario.js'));
const reports = require(path.join(BASE, 'utils', 'reports.js'));
const graph = router.graph;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`); }
}
const place = n => graph.places.find(p => p.n === n);
const from = place('南校区6舍'), to = place('数学与统计学院');

/** 把上报聚合成 scenario 需要的入参。 */
function scenarioOpts(list, extra) {
  const agg = reports.aggregate(list);
  return Object.assign({
    closedEdges: Array.from(agg.closed),
    congestion: agg.congestion,
    policeEdges: Array.from(agg.police),
  }, extra || {});
}

/** 某条路段被切掉后，这条出行要花多久（Infinity = 断了）。 */
function timeWithout(ei) {
  const m = new Uint8Array(router.EDGE_COUNT);
  m[ei] = 1;
  const r = router.planOn(router.buildNetwork({ closed: m }), from.i, to.i, 'fastest');
  return r.ok ? r.timeMinutes : Infinity;
}

/** 在路线里挑一条"绕开代价最小"且足够长的路段（这样绕行的对比才有意义）。 */
function pickAvoidable(minLen) {
  const base = router.planOn(router.baselineNetwork(), from.i, to.i, 'fastest');
  let best = null;
  for (const e of base.usedEdges) {
    if (minLen && e.len < minLen) continue;
    const t = timeWithout(e.ei);
    if (!isFinite(t)) continue;
    const detour = t - base.timeMinutes;
    if (!best || detour < best.detour) best = { ei: e.ei, detour, edge: e, base };
  }
  return best;
}

/** 跨校区唯一的桥边（封了就彻底断了）。 */
function findBridge() {
  const base = router.planOn(router.baselineNetwork(), from.i, to.i, 'fastest');
  for (const e of base.usedEdges) if (!isFinite(timeWithout(e.ei))) return { ei: e.ei, edge: e, base };
  return null;
}

console.log('=== 1. 上报模型 ===');
{
  const r = reports.createReport({
    category: 'police', edges: [10], x: 100, y: 200, roadType: 'residential', edgeId: 'E004', note: '路口查车',
  });
  check('新建上报默认待核实', r.status === 'pending', r.status);
  check('带了类别/路段/备注', r.category === 'police' && r.edges[0] === 10 && r.note === '路口查车');
  check('id 唯一', reports.createReport({ category: 'police', edges: [1] }).id
    !== reports.createReport({ category: 'police', edges: [1] }).id);
  check('拒绝未知类别', (() => {
    try { reports.createReport({ category: 'ufo', edges: [1] }); return false; } catch (e) { return true; }
  })());
  check('拒绝不关联路段的上报', (() => {
    try { reports.createReport({ category: 'police', edges: [] }); return false; } catch (e) { return true; }
  })());
  check('备注长度被截断', reports.createReport({ category: 'police', edges: [1], note: 'x'.repeat(200) }).note.length === 60);
  check('四个类别都有颜色和说明',
    reports.CATEGORIES.every(c => c.color && c.name && c.hint && c.affects), reports.CATEGORIES.map(c => c.key).join(','));
}

console.log('\n=== 2. 审核是硬约束：未核实不影响规划 ===');
{
  const list = [
    reports.createReport({ category: 'closure', edges: [3] }),                    // 待核实
    reports.createReport({ category: 'police', edges: [5] }),                     // 待核实
  ];
  const aggDefault = reports.aggregate(list);
  check('待核实默认不计入', aggDefault.closed.size === 0 && aggDefault.police.size === 0,
    `closed=${aggDefault.closed.size} police=${aggDefault.police.size}`);
  check('但会被统计出来提示用户', aggDefault.counts.pending === 2);

  const aggLenient = reports.aggregate(list, { includePending: true });
  check('显式允许时才计入待核实', aggLenient.closed.size === 1 && aggLenient.police.size === 1);

  // 审核通过 -> 生效
  const verified = list.map(r => Object.assign({}, r, { status: 'verified' }));
  const aggV = reports.aggregate(verified);
  check('核实后生效', aggV.closed.has(3) && aggV.police.has(5), reports.summarize(aggV));

  // 判为不属实 -> 丢弃
  const rejected = list.map(r => Object.assign({}, r, { status: 'rejected' }));
  const aggR = reports.aggregate(rejected);
  check('判为不属实则完全丢弃', aggR.closed.size === 0 && aggR.police.size === 0);
  check('统计里区分了三种状态',
    aggR.counts.rejected === 2 && aggR.counts.verified === 0 && aggR.counts.pending === 0);

  check('状态流转校验', reports.canTransition('pending', 'verified')
    && !reports.canTransition('verified', 'verified') && !reports.canTransition('pending', 'bogus'));
}

console.log('\n=== 3. 过期上报自动失效 ===');
{
  const now = Date.now();
  const old = reports.createReport({ category: 'closure', edges: [7] }, now - reports.REPORT_TTL_MS - 1000);
  const fresh = reports.createReport({ category: 'closure', edges: [8] }, now - 1000);
  const both = [Object.assign(old, { status: 'verified' }), Object.assign(fresh, { status: 'verified' })];
  const agg = reports.aggregate(both, { now });
  check('过期的不再生效', agg.closed.has(7) === false && agg.closed.has(8) === true);
  check('过期的被单独统计', agg.expired === 1, `expired=${agg.expired}`);
}

console.log('\n=== 4. 上报真的改变了规划 ===');
{
  const baseAll = router.planAllOn(router.baselineNetwork(), from.i, to.i);
  const baseRoute = baseAll.fastest;
  const victim = baseRoute.usedEdges[Math.floor(baseRoute.usedEdges.length / 2)];

  // 上报：这条路施工（待核实）-> 不应有任何影响
  const pending = [reports.createReport({ category: 'closure', edges: [victim.ei] })];
  const sPending = scenarioEngine.applyScenario(Object.assign(
    { closedEdges: [] }, { closedEdges: Array.from(reports.aggregate(pending).closed) },
  ));
  const afterPending = router.planOn(sPending.network, from.i, to.i, 'fastest');
  check('待核实的封路上报不改变路线',
    afterPending.path.join(',') === baseRoute.path.join(','),
    `${afterPending.distanceMeters}m / ${afterPending.timeMinutes}分`);

  // 审核通过 -> 必须绕行
  const ok = pending.map(r => Object.assign({}, r, { status: 'verified' }));
  const s = scenarioEngine.applyScenario(scenarioOpts(ok));
  const after = router.planOn(s.network, from.i, to.i, 'fastest');
  check('核实后立即改道', !after.usedEdges.some(e => e.ei === victim.ei));
  check('核实后确实绕路了', after.timeMinutes > baseRoute.timeMinutes - 1e-9,
    `基线 ${baseRoute.timeMinutes} 分 -> 上报后 ${after.timeMinutes} 分`);
  check('封路流量被重分配', s.unassignedFlow === 0 && s.increased > 0, `${s.increased} 条路段流量上升`);
}

console.log('\n=== 5. 异常拥堵上报 ===');
{
  // 报"异常拥堵"的现实场景就是最忙的那条路
  const base = router.planOn(router.baselineNetwork(), from.i, to.i, 'fastest');
  const busy = base.usedEdges.slice().sort((a, b) => b.flow - a.flow)[0];
  const rep = Object.assign(
    reports.createReport({ category: 'congestion', edges: [busy.ei] }),
    { status: 'verified' },
  );
  const agg = reports.aggregate([rep]);
  check('拥堵上报产生流量倍数', agg.congestion.get(busy.ei) === reports.CONGESTION_BOOST,
    `×${agg.congestion.get(busy.ei)}`);

  const s = scenarioEngine.applyScenario(scenarioOpts([rep]));
  check('该路段流量被放大', s.peak[busy.ei] > s.basePeak[busy.ei] * 2,
    `${Math.round(s.basePeak[busy.ei])} -> ${Math.round(s.peak[busy.ei])} 人次`);
  check('放大后占用率上升',
    s.network.occ[busy.ei] > router.baselineNetwork().occ[busy.ei],
    `占用 ${router.baselineNetwork().occ[busy.ei].toFixed(2)} -> ${s.network.occ[busy.ei].toFixed(2)}`);
  check('拥堵上报会被算进"明显变堵"统计', s.aggravated > 0, `${s.aggravated} 条`);

  // 拥堵的实际效果：要么绕开它，要么经过它的用时变长——两者必有其一
  const after = router.planOn(s.network, from.i, to.i, 'fastest');
  const avoided = !after.usedEdges.some(e => e.ei === busy.ei);
  const slower = after.timeMinutes > base.timeMinutes + 0.05;
  check('拥堵上报产生了可见影响（绕开 或 变慢）', avoided || slower,
    `${avoided ? '已绕开' : '仍经过'}，${base.timeMinutes} 分 -> ${after.timeMinutes} 分`);
  console.log(`  最忙路段 #${busy.ei}(${busy.roadType}) 峰值 ${Math.round(busy.flow)} 人次 -> 上报后 ${Math.round(s.peak[busy.ei])} 人次，占用 ${s.network.occ[busy.ei].toFixed(2)}`);
}

console.log('\n=== 6. 绕开交警 ===');
{
  // 6a) 可绕开的路段：必须真的绕开
  const pick = pickAvoidable(100);
  check('找到了可绕开且有长度的路段', !!pick,
    pick && `#${pick.ei} ${pick.edge.roadType} ${Math.round(pick.edge.len)}m，绕行代价 +${pick.detour.toFixed(2)} 分`);
  const policeRep = Object.assign(
    reports.createReport({ category: 'police', edges: [pick.ei], roadType: pick.edge.roadType }),
    { status: 'verified' },
  );
  const agg = reports.aggregate([policeRep]);
  check('交警上报只进入 police 集合，不改流量',
    agg.police.has(pick.ei) && agg.closed.size === 0 && agg.congestion.size === 0);

  const sOff = scenarioEngine.applyScenario(scenarioOpts([policeRep], { avoidPolice: false }));
  const off = router.planOn(sOff.network, from.i, to.i, 'fastest');
  check('不启用规避时仍会经过交警路段', off.usedEdges.some(e => e.ei === pick.ei));
  check('不启用规避时结果里能数出交警', off.policeSegments >= 1, `${off.policeSegments} 段`);

  const sOn = scenarioEngine.applyScenario(scenarioOpts([policeRep], { avoidPolice: true }));
  const on = router.planOn(sOn.network, from.i, to.i, 'fastest');
  check('启用规避后不再经过交警路段', !on.usedEdges.some(e => e.ei === pick.ei));
  check('启用规避后结果里交警为 0 段', on.policeSegments === 0);
  console.log(`  不绕：${off.distanceMeters}m / ${off.timeMinutes}分`
    + `  →  绕开：${on.distanceMeters}m / ${on.timeMinutes}分`
    + `（多 ${(on.timeMinutes - off.timeMinutes).toFixed(2)} 分钟，省下约 ${router.POLICE_DELAY_MINUTES} 分钟的检查风险）`);

  // 6b) 固定延误模型：代价不应随边长无限放大
  check('交警代价用固定延误而不是倍数', typeof router.POLICE_DELAY_MINUTES === 'number'
    && router.POLICE_DELAY_MINUTES > 0, `${router.POLICE_DELAY_MINUTES} 分钟`);
  check('withPolice 只切换开关、不重算流量',
    router.withPolice(sOff.network, true).peak === sOff.network.peak
    && router.withPolice(sOff.network, true).policeActive === true
    && sOff.network.policeActive === false);

  // 6c) 绕不开的桥边：不能崩，要如实计数
  const bridge = findBridge();
  if (bridge) {
    const sB = scenarioEngine.applyScenario({
      policeEdges: [bridge.ei], avoidPolice: true,
    });
    const rb = router.planOn(sB.network, from.i, to.i, 'fastest');
    check('交警在必经之路上时仍能规划（不崩）', rb.ok,
      `${rb.distanceMeters}m / ${rb.timeMinutes}分`);
    check('绕不开就如实标出"仍会经过交警"', rb.policeSegments >= 1,
      `${rb.policeSegments} 段 · ${graph.edgeIds[bridge.ei]}`);
    console.log(`  必经路段 #${bridge.ei}(${graph.edgeIds[bridge.ei]}) 被标记交警：无法绕开，如实提示`);
  } else {
    check('该出行对存在必经桥边（用于测试绕不开的分支）', false, '没找到桥边');
  }

  // 6d) 多处交警：能绕的都绕开
  const baseRoute = router.planOn(router.baselineNetwork(), from.i, to.i, 'fastest');
  const several = [];
  for (const e of baseRoute.usedEdges) {
    if (several.length >= 3) break;
    if (!isFinite(timeWithout(e.ei)) || e.len < 60) continue;   // 跳过桥边和太短的
    several.push(e);
  }
  const reps = several.map(e => Object.assign(
    reports.createReport({ category: 'police', edges: [e.ei] }), { status: 'verified' },
  ));
  const sMany = scenarioEngine.applyScenario(scenarioOpts(reps, { avoidPolice: true }));
  const many = router.planOn(sMany.network, from.i, to.i, 'fastest');
  const stillHit = many.usedEdges.filter(e => several.some(x => x.ei === e.ei));
  check('多处交警时，能绕开的都绕开了', stillHit.length === 0,
    `新路线 ${many.distanceMeters}m/${many.timeMinutes}分，仍经过 ${stillHit.length} 处`);
}

console.log('\n=== 7. 按半径关联路段（点一下圈定一段路）===');
{
  const base = router.planAllOn(router.baselineNetwork(), from.i, to.i).fastest;
  const e = base.usedEdges[5];
  const mid = router.edgeMidpoint(e.ei);
  const one = router.nearestEdges(mid[0], mid[1], 0);
  check('半径=0 时只返回最近一条', one.length === 1 && one[0].ei === e.ei, `#${one[0].ei} vs #${e.ei}`);
  const near = router.nearestEdges(mid[0], mid[1], 80);
  check('给半径时返回一段路', near.length >= 1, `${near.length} 条路段在 80m 内`);
  check('返回结果按距离升序', near.every((x, i) => i === 0 || x.distanceMeters >= near[i - 1].distanceMeters));
  check('最近的确实是点中的那条', near[0].ei === e.ei && near[0].distanceMeters < 5, `${near[0].distanceMeters.toFixed(1)}m`);
  check('limit 生效', router.nearestEdges(mid[0], mid[1], 200, 2).length <= 2);
}

console.log('\n=== 8. 上报 + 天气 + 封路 叠加 ===');
{
  const base = router.planAllOn(router.baselineNetwork(), from.i, to.i).fastest;
  const picks = [base.usedEdges[4], base.usedEdges[9]].filter(Boolean);
  const list = [
    Object.assign(reports.createReport({ category: 'closure', edges: [picks[0].ei] }), { status: 'verified' }),
    Object.assign(reports.createReport({ category: 'congestion', edges: [picks[1] ? picks[1].ei : picks[0].ei] }), { status: 'verified' }),
    Object.assign(reports.createReport({ category: 'police', edges: [base.usedEdges[2].ei] }), { status: 'verified' }),
    reports.createReport({ category: 'closure', edges: [base.usedEdges[1].ei] }),   // 待核实，应被忽略
    Object.assign(reports.createReport({ category: 'police', edges: [base.usedEdges[3].ei] }), { status: 'rejected' }),
  ];
  const s = scenarioEngine.applyScenario(scenarioOpts(list, { level: 'heavy', avoidPolice: true }));
  const agg = reports.aggregate(list);
  check('只有已核实的生效', s.closedEdges.length === agg.closed.size,
    `生效封路 ${s.closedEdges.length} 条，待核实/不属实的被排除`);
  check('天气 + 上报叠加后拥堵指数上升', s.congestionIndex > 1, `${s.congestionIndex}`);
  const r = router.planOn(s.network, from.i, to.i, 'fastest');
  check('叠加情景后仍能规划', r.ok, `${r.distanceMeters}m / ${r.timeMinutes}分`);
  check('路线避开核实过的封路与交警',
    !r.usedEdges.some(e => s.closedEdges.indexOf(e.ei) >= 0)
    && r.policeSegments === 0);
  console.log(`  基线 ${base.distanceMeters}m/${base.timeMinutes}分 -> 叠加情景 ${r.distanceMeters}m/${r.timeMinutes}分`);
  console.log(`  摘要：${reports.summarize(agg)}`);
}

console.log('\n=== 9. 掩码与摘要 ===');
{
  const agg = reports.aggregate([
    Object.assign(reports.createReport({ category: 'closure', edges: [1, 2] }), { status: 'verified' }),
    Object.assign(reports.createReport({ category: 'police', edges: [5] }), { status: 'verified' }),
  ]);
  const mask = reports.toMask(agg.closed, router.EDGE_COUNT);
  check('掩码长度正确且命中', mask.length === router.EDGE_COUNT && mask[1] === 1 && mask[2] === 1 && mask[3] === 0);
  check('越界下标不会写坏掩码', reports.toMask(new Set([-1, 1e9]), 10).every(v => v === 0));
  check('摘要文案', /1 处施工/.test(reports.summarize(agg)) && /1 处交警/.test(reports.summarize(agg)),
    reports.summarize(agg));
  check('无上报时的摘要', reports.summarize(reports.aggregate([])) === '暂无用户上报');
}

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exit(fail ? 1 : 0);
