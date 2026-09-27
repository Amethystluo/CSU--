/**
 * 事件 / 校历 / 人群索引 的测试。
 *   node tools/test-events.js
 *
 * 覆盖：班级名解析出的人群索引、按年级/专业选人、场馆解析、
 * 事件流量（叠加到路网上真的改变占用率与路线）、放假/调休的口径、校验与规范化。
 */
const path = require('path');
const fs = require('fs');
const { ROOT } = require('./paths.js');
const events = require(path.join(ROOT, 'utils', 'events.js'));
const calendar = require(path.join(ROOT, 'utils', 'calendar.js'));
const router = require(path.join(ROOT, 'utils', 'router.js'));
const graph = router.graph;

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`); }
}

const people = require(path.join(ROOT, 'data', 'people-index.js'));
const landmarks = require(path.join(ROOT, 'data', 'landmarks.js'));

console.log('\n=== 1. 人群索引（班级名 -> 专业 / 年级 / 宿舍）===');
{
  check('索引文件存在且非空', people.classes > 0 && people.rows.length > 0,
    `${people.classes} 个班 / ${people.rows.length} 行`);
  check('年级是 23~26 级', people.grades.length === 4 && people.grades.every(g => /^\d{2}$/.test(g.code)),
    people.grades.map(g => g.label).join(' '));
  check('每个年级都有人', people.grades.every(g => g.students > 0),
    people.grades.map(g => `${g.label}:${g.students}`).join(' '));
  check('专业前缀数量合理（>50）', people.prefixes.length > 50, `${people.prefixes.length} 个`);
  check('人数总和与班级数自洽',
    people.grades.reduce((a, g) => a + g.students, 0) === people.students
    && people.grades.reduce((a, g) => a + g.classes, 0) === people.classes,
    `共 ${people.students} 人 / ${people.classes} 班`);
  check('聚合行结构与人数一致',
    people.rows.every(r => r.length === 5 && r[3] > 0 && r[4] > 0)
    && people.rows.reduce((a, r) => a + r[3], 0) === people.students);
  check('宿舍节点数与名字一一对应',
    people.dormNodes.length === people.dormNames.length && people.dormNodes.length > 0,
    `${people.dormNodes.length} 个节点`);
  check('"学院"粗分覆盖全部专业',
    people.groups.reduce((a, g) => a + g.prefixes.length, 0) === people.prefixes.length,
    `${people.groups.length} 个学院 -> ${people.prefixes.length} 个专业`);
  check('宿舍节点在路网里都能找到',
    people.dormNodes.every(id => (graph.nodeIds || []).indexOf(id) >= 0));
}

console.log('\n=== 2. 按年级 / 专业选人 ===');
{
  const all = events.audienceOf({ grades: [], departments: [] });
  check('不选=全校', all.students === people.students && all.classes === people.classes,
    `${all.students} 人`);
  check('不选时标明"全部年级/全部专业"',
    all.unlimitedGrades && all.unlimitedDepartments);

  const g26 = events.audienceOf({ grades: ['26'], departments: [] });
  const g = people.grades.find(x => x.code === '26');
  check('只按年级选，人数与索引一致', g26.students === g.students, `2026级 ${g26.students} 人`);
  check('选出来的比全校少', g26.students < all.students);

  const mech = people.groups.find(x => x.key === '机械');
  const dept = events.audienceOf({ grades: [], departments: mech.prefixes });
  check('按"学院"（多个专业）选，人数等于这些专业之和',
    dept.students === mech.students, `机械 ${dept.students} 人`);
  check('不选年级时年级不受限', dept.unlimitedGrades === true);

  const both = events.audienceOf({ grades: ['26'], departments: mech.prefixes });
  check('年级 × 专业 是**交集**（两个都要）',
    both.students > 0 && both.students < dept.students && both.students < g26.students,
    `机械+2026级 = ${both.students} 人（机械 ${dept.students}，26级 ${g26.students}）`);

  const unknown = events.audienceOf({ grades: ['99'], departments: ['不存在的专业'] });
  check('无法识别的年级/专业会被报出来', unknown.unknownGrades.length === 1
    && unknown.unknownDepartments.length === 1,
    unknown.unknownGrades.concat(unknown.unknownDepartments).join('、'));

  check('可读描述写清了专业与年级',
    /个专业/.test(events.describeAudience({ grades: ['26'], departments: mech.prefixes }))
    && /2026级/.test(events.describeAudience({ grades: ['26'], departments: [] })),
    events.describeAudience({ grades: ['26'], departments: mech.prefixes }));
}

console.log('\n=== 3. 场馆解析（地标 -> 路网节点）===');
{
  check('地标索引有 100 个以上', landmarks.count > 100, `${landmarks.count} 个`);
  check('地标都带节点下标', landmarks.items.every(x => x.i >= 0 && x.i < graph.px.length));
  const venue = events.landmarkByName('新校体育场“鸟巢”西门');
  check('能找到校运会用的体育场', !!venue && venue.node >= 0,
    venue ? `节点 #${venue.node}，离标注 ${venue.snapMeters} 米` : '(没找到)');
  check('南校礼堂也能找到（双选会场地）', !!events.landmarkByName('南校礼堂'));
  check('场馆候选列表把体育场馆/礼堂排在前面', (() => {
    const opts = events.venueOptions();
    return opts.length > 100 && opts.slice(0, 3).every(o => o.kind === '体育场馆' || o.kind === '礼堂会场');
  })(), events.venueOptions().slice(0, 3).map(o => `${o.name}(${o.kind})`).join(' '));
  check('场馆尽量贴着路网（吸附距离 < 200 米）',
    events.venueOptions().filter(o => o.kind === '体育场馆' || o.kind === '礼堂会场')
      .every(o => o.snapMeters < 200));
  check('自定义点也能当场馆', (() => {
    const p = graph.places[0];
    const v = events.venueOf({ venue: '', venuePoint: { x: graph.px[p.i], y: graph.py[p.i] } });
    return !!v && v.custom === true && v.node === p.i;
  })());
  check('场馆没选时返回 null', events.venueOf({ venue: '', venuePoint: null }) === null);
}

console.log('\n=== 4. 活动类型与出行窗口 ===');
{
  check('内置了校运会/双选会/考试等类型', events.EVENT_TYPES.length >= 6,
    events.EVENT_TYPES.map(t => t.name).join('、'));
  check('每种类型都有到场提前量', events.EVENT_TYPES.every(t => t.leadMin > 0));
  const sports = events.normalize({ title: '校运会', type: 'sports', start: '08:00', end: '17:00' });
  const ws = events.windowsOf(sports);
  check('窗口 = 开场前 + 结束', ws.length === 2 && ws[0].kind === 'arrival' && ws[1].kind === 'departure');
  check('入场时刻 = 开始 - 提前量', ws[0].minutes === 8 * 60 - 40, events.fmt(ws[0].minutes));
  check('离场时刻 = 结束', ws[1].minutes === 17 * 60, events.fmt(ws[1].minutes));
  check('换类型会带上不同的默认提前量', (() => {
    const jf = events.normalize({ title: '双选会', type: 'jobfair', start: '09:00', end: '16:00' });
    return events.windowsOf(jf)[0].minutes !== ws[0].minutes;
  })());
  check('时间工具自洽', events.toMinutes('07:20') === 440 && events.fmt(440) === '07:20'
    && events.toMinutes('乱写') === null);
}

console.log('\n=== 5. 事件流量真的改变了路网 ===');
{
  const ev = events.normalize({
    title: '测试校运会', type: 'sports', date: '2026-10-15',
    start: '08:00', end: '17:00', venue: '新校体育场“鸟巢”西门',
    grades: [], departments: [], headcount: 3000,
  });
  check('校验通过', events.validate(ev).length === 0, JSON.stringify(events.validate(ev)));
  const r = events.flowFor(ev);
  check('按宿舍聚合成出发点（应少于 60 个）', r.stats.dorms > 0 && r.stats.dorms < 60,
    `${r.stats.dorms} 栋宿舍`);
  check('每个窗口都算出了人', r.perWindow.every(w => w.people > 0),
    r.perWindow.map(w => `${w.time}:${Math.round(w.people)}`).join(' '));
  check('人数守恒（入场人数 = 事件规模）', Math.abs(r.perWindow[0].people - 3000) < 1,
    `${Math.round(r.perWindow[0].people)} 人`);
  check('产生了实际路网流量', (() => {
    let nz = 0;
    for (const v of r.flow) if (v > 0) nz++;
    return nz > 10;
  })(), (() => { let nz = 0, s = 0; for (const v of r.flow) { if (v > 0) nz++; s += v; } return `${nz} 条路段 / ${Math.round(s)} 人次`; })());
  check('没有走不通的宿舍', r.stats.unassigned === 0, `未连通 ${Math.round(r.stats.unassigned)} 人`);

  // 拥堵变严重
  const base = router.baselinePeak();
  const withEv = new Float64Array(router.EDGE_COUNT);
  for (let i = 0; i < router.EDGE_COUNT; i++) withEv[i] = base[i] + r.flow[i];
  const hot = f => graph.edges.filter((e, i) => {
    const vff = router.ROAD_SPEED[e[4]] || router.DEFAULT_SPEED;
    return router.solveEdgeState(vff, 1, f[i]).occ >= 0.5;
  }).length;
  check('叠加活动后较堵路段变多', hot(withEv) > hot(base), `${hot(base)} 条 -> ${hot(withEv)} 条`);

  // 路线确实会变
  const a = graph.places.find(p => p.n === '南校区6舍');
  const b = graph.places.find(p => p.n === '数学与统计学院');
  const r0 = router.planOn(router.buildNetwork({}), a.i, b.i, 'fastest');
  const r1 = router.planOn(router.buildNetwork({ peak: withEv }), a.i, b.i, 'fastest');
  check('活动会改变时间最短路线或耗时',
    r0.distanceMeters !== r1.distanceMeters || r0.timeMinutes !== r1.timeMinutes,
    `基线 ${r0.distanceMeters}m/${r0.timeMinutes}分 -> 含活动 ${r1.distanceMeters}m/${r1.timeMinutes}分`);

  // 按时刻取分量
  const atArrival = events.flowAt([ev], events.windowsOf(ev)[0].minutes);
  const atDeparture = events.flowAt([ev], events.windowsOf(ev)[1].minutes);
  const atMidnight = events.flowAt([ev], 0);
  const sum = f => { let s = 0; for (const v of f.flow) s += v; return Math.round(s); };
  check('只取入场时刻时只含入场流量', atArrival.used.length === 1 && sum(atArrival) > 0,
    `${sum(atArrival)} 人次`);
  check('入场与离场是两个独立窗口', r.perWindow.length === 2
    && r.perWindow[0].kind === 'arrival' && r.perWindow[1].kind === 'departure');
  check('离场也有流量（同一批人回宿舍）', sum(atDeparture) === sum(atArrival) && sum(atDeparture) > 0,
    `入场 ${sum(atArrival)} / 离场 ${sum(atDeparture)} 人次`);
  // 路网是无向的，所以"去"和"回"走同一条路、各边流量相同 —— 这是预期行为，记下来
  check('无向图上"去"和"回"经过同一批路段',
    atArrival.flow.every((v, i) => v === atDeparture.flow[i]));
  check('窗口时刻不同（这是两股流的意义）',
    r.perWindow[0].minutes !== r.perWindow[1].minutes,
    `${r.perWindow[0].time} vs ${r.perWindow[1].time}`);
  check('跟活动无关的时刻不加流量', sum(atMidnight) === 0);
  check('传 null 表示所有窗口都算上', sum(events.flowAt([ev], null)) >= sum(atArrival));
}

console.log('\n=== 6. 预计人数 vs 实际人群 ===');
{
  const audience = events.audienceOf({ grades: ['26'], departments: [] });
  const est = events.normalize({ title: 'x', type: 'exam', date: '2026-10-15', venue: '南校礼堂',
    grades: ['26'], departments: [], headcount: 500 });
  const h1 = events.headcountOf(est, audience);
  check('填了预计人数就按预计人数', h1.people === 500 && h1.source === 'estimated');
  const noEst = events.normalize({ title: 'x', type: 'exam', date: '2026-10-15', venue: '南校礼堂',
    grades: ['26'], departments: [], headcount: 0 });
  const h2 = events.headcountOf(noEst, audience);
  check('没填就按选中人群实际人数', h2.people === audience.students && h2.source === 'audience',
    `${h2.people} 人`);

  const over = events.headcountOf(events.normalize({ title: 'x', type: 'exam', date: '2026-10-15',
    venue: '南校礼堂', grades: ['26'], departments: [], headcount: audience.students + 1000 }), audience);
  check('预计人数超过人群时会标出来', over.overCapacity === true);
  check('超过时也照样按预计人数算（可能含校外人员）', over.people === audience.students + 1000);

  // 按比例缩放：流量总量应等于预计人数
  const big = events.normalize({ title: 'y', type: 'sports', date: '2026-10-15',
    venue: '新校体育场“鸟巢”西门', grades: [], departments: [], headcount: 1000 });
  const rb = events.flowFor(big);
  check('缩放后入场总量 = 预计人数', Math.abs(rb.perWindow[0].people - 1000) < 1,
    `${Math.round(rb.perWindow[0].people)} 人`);
}

console.log('\n=== 7. 校验与规范化 ===');
{
  // 裸对象（没经过 normalize）应该被挑出一堆问题
  const rawProblems = events.validate({});
  check('空事件会被挑出问题', rawProblems.length >= 3,
    `${rawProblems.length} 条：${rawProblems.join('；')}`);
  const bad = events.normalize({ title: 'x', type: 'exam', date: '2026-10-15', venue: '南校礼堂' });
  check('缺名称', events.validate(Object.assign({}, bad, { title: '' }))
    .some(p => /名称/.test(p)));
  check('缺场馆', events.validate(Object.assign({}, bad, { title: 'x', venue: '' }))
    .some(p => /场馆/.test(p)));
  check('结束早于开始', events.validate(Object.assign({}, bad, {
    title: 'x', venue: '南校礼堂', start: '17:00', end: '09:00',
  })).some(p => /晚于/.test(p)));
  check('日期格式不对', events.validate(Object.assign({}, bad, {
    title: 'x', venue: '南校礼堂', date: '10-15',
  })).some(p => /YYYY-MM-DD/.test(p)));
  check('类型不认识', events.validate(Object.assign({}, bad, {
    title: 'x', venue: '南校礼堂', type: 'nosuchtype',
  })).some(p => /类型/.test(p)));
  check('规范化会补默认值', (() => {
    const n = events.normalize({ title: '  ', type: 'sports' });
    return n.title === '校运会 / 体育比赛' && n.start === '08:00' && n.leadMin === 40 && !!n.id;
  })(), events.normalize({ title: '  ', type: 'sports' }).title);
  check('规范化会替换不认识的类型', events.normalize({ title: 'x', type: '乱写' }).type === 'other');
  check('规范化保留已有字段', (() => {
    const n = events.normalize({ id: 'keep-me', title: 'x', type: 'exam', start: '10:30', end: '12:00', leadMin: 5 });
    return n.id === 'keep-me' && n.start === '10:30' && n.leadMin === 5;
  })());
  check('规范化后可直接参与计算（不会抛错）', (() => {
    const n = events.normalize({ title: 'z', type: 'exam', date: '2026-10-15', venue: '南校礼堂' });
    const r = events.flowFor(n);
    return r && r.flow.length === router.EDGE_COUNT;
  })());
  check('onDate 只挑当天', events.onDate([
    { date: '2026-10-15', id: 'a' }, { date: '2026-10-16', id: 'b' },
  ], '2026-10-15').length === 1);
  check('可读描述含名称/场馆/人数', (() => {
    const d = events.describe(events.normalize({ title: '双选会', type: 'jobfair',
      date: '2026-10-15', venue: '南校礼堂', grades: ['26'], departments: [] }));
    return /双选会/.test(d) && /南校礼堂/.test(d) && /人/.test(d);
  })());
}

console.log('\n=== 8. 校历：放假 / 调休 ===');
{
  // 2026-09-28 是周一，2026-10-03 是周六
  const normal = calendar.resolveDay('2026-09-28', []);
  check('普通工作日按当天星期算', normal.kind === 'normal' && normal.hasClass
    && normal.effectiveWeekday === 1, `${normal.label} ${normal.kindLabel}`);

  const weekend = calendar.resolveDay('2026-10-03', []);
  check('周末没有课', weekend.kind === 'weekend' && !weekend.hasClass && weekend.effectiveWeekday === null,
    weekend.kindLabel);

  const holiday = calendar.resolveDay('2026-10-01', [{ date: '2026-10-01', kind: 'holiday' }]);
  check('放假：工作日也不上课', holiday.kind === 'holiday' && !holiday.hasClass
    && holiday.effectiveWeekday === null, `${holiday.label} ${holiday.kindLabel}`);

  const makeup = calendar.resolveDay('2026-10-03', [{ date: '2026-10-03', kind: 'makeup', asWeekday: 4 }]);
  check('调休：周六按周四上课', makeup.kind === 'makeup' && makeup.hasClass
    && makeup.effectiveWeekday === 4 && makeup.effectiveCN === '四',
    `${makeup.label} ${makeup.kindLabel}`);
  check('调休那天不再是"周末无课"', makeup.isWeekend === true && makeup.hasClass === true);

  const makeupBad = calendar.resolveDay('2026-10-03', [{ date: '2026-10-03', kind: 'makeup', asWeekday: 9 }]);
  check('调休没写清周几时退回按当天算（周末仍无课）', makeupBad.hasClass === false);

  check('同一天多条覆盖时以最后一条为准', (() => {
    const d = calendar.resolveDay('2026-10-01', [
      { date: '2026-10-01', kind: 'makeup', asWeekday: 2 },
      { date: '2026-10-01', kind: 'holiday' },
    ]);
    return d.kind === 'holiday';
  })());

  check('日期格式错误返回 null', calendar.resolveDay('2026/10/01', []) === null);
  check('isoOf / labelOf 自洽', calendar.isoOf(new Date(2026, 9, 1)) === '2026-10-01'
    && calendar.labelOf(new Date(2026, 9, 1)) === '10月1日 周四');

  check('覆盖条目校验：放假没问题', calendar.validateOverride({ date: '2026-10-01', kind: 'holiday' }).length === 0);
  check('覆盖条目校验：调休要写周几',
    calendar.validateOverride({ date: '2026-10-03', kind: 'makeup' }).some(p => /周几/.test(p)));
  check('覆盖条目校验：日期要合法',
    calendar.validateOverride({ date: 'x', kind: 'holiday' }).some(p => /YYYY/.test(p)));
  check('可读描述', /调休上课（按周四）/.test(calendar.describeOverride({ date: '2026-10-03', kind: 'makeup', asWeekday: 4 })),
    calendar.describeOverride({ date: '2026-10-03', kind: 'makeup', asWeekday: 4 }));
}

console.log('\n=== 9. 调休/放假会换掉那天的时段口径 ===');
{
  const timeModel = require(path.join(ROOT, 'utils', 'timeModel.js'));
  if (!timeModel.available()) {
    console.log('  （画像不可用，跳过）');
  } else {
    // 周六补周四：应该能取到周四的换课时段
    const makeup = calendar.resolveDay('2026-10-03', [{ date: '2026-10-03', kind: 'makeup', asWeekday: 4 }]);
    const thu = timeModel.windowsFor(makeup.effectiveWeekday);
    check('调休那天能取到"被补那天"的换课时段', thu.length > 0 && thu.every(w => w.weekday === 4),
      `${thu.length} 个周四时段`);
    const thuPeak = thu.reduce((a, b) => (b.total > a.total ? b : a), thu[0]);
    check('周四最忙时刻与画像一致', !!timeModel.peakKey(4) && thuPeak.key === timeModel.peakKey(4),
      `${thuPeak.time} ${thuPeak.total} 人次`);
    // 放假：这天不该有课表流量（页面据此给零基线）
    const hol = calendar.resolveDay('2026-10-01', [{ date: '2026-10-01', kind: 'holiday' }]);
    check('放假那天标记为没有课（页面据此给零基线）', hol.hasClass === false);
  }
}

console.log('\n=== 10. 事件存储（本机）===');
{
  // 用假的 wx.storage 跑 eventStore
  const mem = new Map();
  global.wx = {
    getStorageSync: k => (mem.has(k) ? mem.get(k) : ''),
    setStorageSync: (k, v) => mem.set(k, v),
    removeStorageSync: k => mem.delete(k),
  };
  delete require.cache[require.resolve(path.join(ROOT, 'utils', 'eventStore.js'))];
  const store = require(path.join(ROOT, 'utils', 'eventStore.js'));

  check('初始为空', store.events().length === 0 && store.dayOverrides().length === 0);
  const e1 = events.normalize({ title: '双选会', type: 'jobfair', date: '2026-10-15', venue: '南校礼堂' });
  store.putEvent(e1);
  check('新增后能读出来', store.events().length === 1 && store.events()[0].title === '双选会');
  store.putEvent(Object.assign({}, e1, { title: '改过的双选会' }));
  check('按 id 更新而不是重复添加',
    store.events().length === 1 && store.events()[0].title === '改过的双选会');
  check('按日期查得到', store.eventsOn('2026-10-15').length === 1
    && store.eventsOn('2026-10-16').length === 0);
  store.putOverride({ date: '2026-10-01', kind: 'holiday' });
  check('校历条目能存', store.dayOverrides().length === 1);
  store.putOverride({ date: '2026-10-01', kind: 'makeup', asWeekday: 2 });
  check('同一天只留一条校历条目（可改主意）',
    store.dayOverrides().length === 1 && store.dayOverrides()[0].kind === 'makeup');
  store.removeOverride('2026-10-01');
  check('校历条目能删', store.dayOverrides().length === 0);
  store.removeEvent(e1.id);
  check('事件能删', store.events().length === 0);

  store.loadSamples('2026-09-28');
  check('载入示例会填进事件与校历',
    store.events().length === 3 && store.dayOverrides().length === 2,
    `${store.events().length} 个事件 / ${store.dayOverrides().length} 条校历`);
  check('示例日期顺延到今天起（否则演示看不到效果）',
    store.events()[0].date === '2026-09-28' && store.events()[1].date === '2026-09-29'
    && store.events()[2].date === '2026-09-30',
    store.events().map(x => x.date).join(' '));
  check('示例事件本身是合法的', store.events().every(e => {
    const p = events.validate(e);
    return p.filter(x => !/超过所选人群/.test(x)).length === 0;
  }), store.events().map(e => events.validate(e).length).join(','));
  check('校历示例是 放假 + 调休', store.dayOverrides().some(o => o.kind === 'holiday')
    && store.dayOverrides().some(o => o.kind === 'makeup'));
  store.clearLocal();
  check('清空本机', store.events().length === 0 && store.dayOverrides().length === 0);

  // 坏数据不能把页面搞崩
  mem.set(store.STORAGE_KEY, '{{{ 不是 JSON');
  check('存储里是坏数据时安全退回空', store.events().length === 0 && store.dayOverrides().length === 0);
  delete global.wx;
}

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exit(fail ? 1 : 0);
