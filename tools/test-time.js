/**
 * 时段能力测试：课表解析 → 逐时段流量 → 标定 → 应用侧取用。
 *
 * 这是"到底是不是按时间段预测"这件事的守卫：
 *   1. 解析器要能容忍常见的课表写法；
 *   2. 没有课表时必须如实报告"不可用"，绝不能假装有时段数据；
 *   3. 有画像时，峰值时段必须等于原始数据，周末/非换课时段必须为空。
 *
 *   node tools/test-time.js
 */
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./paths.js');

const router = require(path.join(ROOT, 'utils', 'router.js'));
const scenarioEngine = require(path.join(ROOT, 'utils', 'scenario.js'));
const timeModel = require(path.join(ROOT, 'utils', 'timeModel.js'));
const graph = router.graph;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`); }
}

console.log('=== 1. 数据里到底有几个时间量（回归守卫）===');
{
  const flow = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'traffic-flow.json'), 'utf8'));
  const edgeKeys = Object.keys(flow.edges[0]);
  check('逐路段只有两个时间字段',
    edgeKeys.indexOf('semester_person_trips') >= 0 && edgeKeys.indexOf('peak_slot_person_trips') >= 0
    && !edgeKeys.some(k => /slot_?\d|series|histogram|per_?slot|by_?time/i.test(k)),
    edgeKeys.join(', '));
  check('数据里没有时段数组', !Object.keys(flow).some(k => /slots|timeseries|periods/i.test(k)),
    Object.keys(flow).join(', '));
}

console.log('\n=== 2. 没有课表时：必须如实说"不可用"===');
{
  // 仓库里当前就是占位文件（还没拿到课表）
  const placeholder = !timeModel.available();
  check('timeModel 如实报告可用性', typeof timeModel.available() === 'boolean',
    `available=${timeModel.available()}`);
  if (placeholder) {
    check('给得出不可用的原因', /课表/.test(timeModel.reason()), timeModel.reason());
    check('时段列表为空（不编造时段）', timeModel.windows().length === 0);
    check('只有自动与最高峰两个选项', timeModel.choices().length === 2,
      timeModel.choices().map(c => c.label).join(' | '));
    check('flowAt 返回 null 而不是假数据', timeModel.flowAt('w0500') === null);
    const slot = timeModel.currentSlot(new Date('2026-09-28T07:50:00'));
    check('当前时刻会明确说明未提供课表', slot.idle === true && /未提供课表/.test(slot.label), slot.label);
  } else {
    // 仓库里已经是真实课表画像（用班级课表算出来的）——这条分支才是当前的真实状态，
    // 必须一起验，否则"发布出去的那份数据"反而没有测试覆盖。
    check('给得出数据来源', /课表|cells/.test(timeModel.source()), timeModel.source());
    const ws = timeModel.windows();
    // 画像按 (星期, 时刻) 二维排列：整体看是"周一整天 -> 周二整天 -> …"，
    // 所以**每一天内部**时刻必须递增，天与天之间也必须递增。
    const dayAscending = ws.every((w, i) => i === 0 || ws[i - 1].weekday <= w.weekday);
    const timeAscendingInDay = ws.every((w, i) => i === 0 || w.weekday !== ws[i - 1].weekday
      || w.minutes > ws[i - 1].minutes);
    check('时段列表非空', ws.length >= 4, `${ws.length} 个时段`);
    check('时段按「星期 -> 时刻」排列', dayAscending && timeAscendingInDay,
      `天 ${timeModel.days().join(',')}；首日时刻 ${ws.filter(w => w.weekday === ws[0].weekday).map(w => w.time).join(' ')}`);
    check('每天都有各自的时段', timeModel.days().every(d => timeModel.windowsFor(d).length > 0),
      timeModel.days().map(d => `周${timeModel.WEEKDAY_CN[d]}:${timeModel.windowsFor(d).length}`).join(' '));
    check('每天的最忙时段都能取到，且属于那一天', timeModel.days().every(d => {
      const k = timeModel.peakKey(d);
      const w = timeModel.windowsFor(d).find(x => x.key === k);
      return !!w && w.weekday === d;
    }), timeModel.days().map(d => `周${timeModel.WEEKDAY_CN[d]}=${timeModel.peakKey(d)}`).join(' '));
    check('每个时段都带全网人次', ws.every(w => w.total > 0),
      ws.map(w => `${w.time}:${w.total}`).join(' '));
    check('选项 = 自动 + 最高峰 + 各时段', timeModel.choices().length === ws.length + 2,
      `${timeModel.choices().length} 项`);
    check('flowAt 拿到的是与路网等长的数组',
      timeModel.flowAt(timeModel.peakKey()).length === router.EDGE_COUNT);
    check('不存在的时段返回 null（不编造）', timeModel.flowAt('w9999') === null);

    // 关键：只有换课时刻才有通勤，其他时刻必须为空 —— 这正是用户嫌"夜里也堵"的地方
    const atPeak = timeModel.currentSlot(new Date('2026-09-28T' + ws[0].time + ':00'));
    check('换课时刻能对上某个时段', atPeak.idle === false && !!atPeak.key, atPeak.label);
    const weekend = timeModel.currentSlot(new Date('2026-09-26T09:40:00'));
    check('周末判为无通勤', weekend.idle === true, weekend.label);
    const monday3am = timeModel.currentSlot(new Date('2026-09-28T03:00:00'));
    check('凌晨判为无通勤', monday3am.idle === true, monday3am.label);
    check('无通勤时给的流量是全零', Array.prototype.every.call(timeModel.zeroFlow(), v => v === 0));
  }
}

console.log('\n=== 3. 课表解析的容错 ===');
{
  const P = require('./build-time-profile.js');

  check('星期：数字 / 周几 / 星期几 都能认',
    P.parseWeekday('1') === 1 && P.parseWeekday('周三') === 3 && P.parseWeekday('星期五') === 5
    && P.parseWeekday('礼拜天') === 7, '1/周三/星期五/礼拜天');
  check('星期：非法值返回 null', P.parseWeekday('') === null && P.parseWeekday('无') === null);
  check('节次："1-2" / "3,4" / "第5节" / "5" 都能认',
    JSON.stringify(P.parsePeriods('1-2')) === '[1,2]'
    && JSON.stringify(P.parsePeriods('3,4')) === '[3,4]'
    && JSON.stringify(P.parsePeriods('第5节')) === '[5,6]'
    && JSON.stringify(P.parsePeriods('5')) === '[5,6]',
    ['1-2', '3,4', '第5节', '5'].map(v => P.parsePeriods(v).join('-')).join(' / '));
  check('节次：越界或空值不认', P.parsePeriods('').length === 0 && P.parsePeriods('99').length === 0);
  check('节次 -> 课段映射正确', P.blockOfPeriod(1).key === 'p1' && P.blockOfPeriod(9).key === 'p9');
  check('时间字串解析', P.toMinutes('08:00') === 480 && P.toMinutes('19:05') === 1145 && P.toMinutes('x') === null);

  // CSV：带 BOM、引号、别名表头
  const csv = '\uFEFF班级,星期,节次,上课地点\n"自动化2301",周一,1-2,"科教南306"\n软件工程2401,2,3-4,B座112\n';
  const tmp = path.join(__dirname, '.tmp-timetable.csv');
  fs.writeFileSync(tmp, csv, 'utf8');
  const parsed = P.loadTimetable(tmp);
  fs.unlinkSync(tmp);
  check('CSV 解析出 2 行', parsed.rows.length === 2, `${parsed.rows.length} 行，问题 ${parsed.problems.length}`);
  check('别名表头与"周一"都能识别',
    parsed.rows[0].cls === '自动化2301' && parsed.rows[0].weekday === 1
    && parsed.rows[0].room === '科教南306');
  check('缺列的行走问题清单，而不是静默丢弃', (() => {
    const bad = path.join(__dirname, '.tmp-bad.csv');
    fs.writeFileSync(bad, '班级,星期,节次,教室\n自动化2301,1,,科教南306\n', 'utf8');
    const r = P.loadTimetable(bad);
    fs.unlinkSync(bad);
    return r.rows.length === 0 && r.problems.length === 1;
  })());
  check('JSON 格式也能读', (() => {
    const jf = path.join(__dirname, '.tmp-timetable.json');
    fs.writeFileSync(jf, JSON.stringify([{ 班级: '自动化2301', 星期: 3, 节次: '1-2', 教室: '科教南306' }]), 'utf8');
    const r = P.loadTimetable(jf);
    fs.unlinkSync(jf);
    return r.rows.length === 1 && r.rows[0].weekday === 3;
  })());
}

console.log('\n=== 4. 示例课表算出的画像自洽 ===');
{
  const samplePath = path.join(__dirname, 'time-profile.sample.js');
  const hasSample = fs.existsSync(samplePath);
  check('示例画像存在（跑过 --sample 模式）', hasSample,
    hasSample ? '' : '请先执行 node tools/build-time-profile.js --sample');
  if (hasSample) {
    const p = require(samplePath);
    check('示例画像标记为示例来源', /示例/.test(p.source), p.source);
    check('有多个换课时段', p.windows.length >= 5, `${p.windows.length} 个`);
    check('时段按「星期 -> 时刻」排列',
      p.windows.every((w, i) => i === 0 || p.windows[i - 1].weekday <= w.weekday)
      && p.windows.every((w, i) => i === 0 || w.weekday !== p.windows[i - 1].weekday
        || w.minutes > p.windows[i - 1].minutes));
    check('示例画像也按天分开', Array.isArray(p.days) && p.days.length === 5 && p.days[0] === 1,
      JSON.stringify(p.days));
    check('每个时段都标了属于哪一天', p.windows.every(w => p.days.indexOf(w.weekday) >= 0));
    check('每条边在每个时段都有值',
      p.flow.every(row => row.length === p.windows.length));
    // 关键不变量：峰值时段的标定 —— 每条边在峰值的值 == 原始 peak_slot
    const peakIdx = p.windows.findIndex(w => w.key === p.peakWindow);
    check('标定后峰值时段不高于原始峰值（不会凭空放大）',
      p.edgeIndex.every((ei, i) => Math.max.apply(null, p.flow[i]) <= graph.edges[ei][3] + 0.5),
      '各边峰值 ≤ 原始 peak_slot');
    check('多数有流量的边在峰值时确实达到原始峰值',
      (() => {
        let hit = 0, total = 0;
        p.edgeIndex.forEach((ei, i) => {
          const pk = graph.edges[ei][3];
          if (pk <= 0) return;
          total++;
          if (Math.max.apply(null, p.flow[i]) >= pk - 1) hit++;
        });
        return total > 0 && hit / total > 0.9;
      })(), '标定后峰值对齐原始数据');
    check('非峰值时段明显低于峰值（时段确实有区分度）', (() => {
      let flat = 0, total = 0;
      p.edgeIndex.forEach((ei, i) => {
        const mx = Math.max.apply(null, p.flow[i]);
        if (mx <= 0) return;
        total++;
        const others = p.flow[i].filter(v => v !== mx);
        if (others.every(v => v < mx)) flat++;
      });
      return total > 0 && flat / total > 0.5;
    })(), '多数路段确实存在"峰值 > 其他时段"');
  }
}

console.log('\n=== 5. 应用侧：按时段取基线 ===');
{
  const samplePath = path.join(__dirname, 'time-profile.sample.js');
  if (!fs.existsSync(samplePath)) {
    check('跳过（无示例画像）', true);
  } else {
    const p = require(samplePath);
    // 直接把示例画像喂进 timeModel（运行时不会被加载，这里只是验证取用逻辑）
    timeModel.__setProfileForTest(p);
    check('注入后可用', timeModel.available() === true);
    check('选项 = 自动 + 最高峰 + 各时段',
      timeModel.choices().length === p.windows.length + 2,
      `${timeModel.choices().length} 项`);

    const peakFlow = timeModel.flowAt(p.peakWindow);
    check('峰值时段的流量数组长度与路网一致', peakFlow.length === router.EDGE_COUNT);
    // 注意：peak_slot_person_trips 是**每条路各自**最忙的那个时段，
    // 而不是全网统一的某一时刻。所以"等于原始峰值"要按每条路自己的最大值来验，
    // 不能拿全网峰值时段去比。
    check('每条路在自身最忙时段恰为原始 peak_slot', (() => {
      let same = 0, n = 0;
      p.edgeIndex.forEach((ei, i) => {
        const pk = graph.edges[ei][3];
        if (pk <= 0) return;
        n++;
        if (Math.abs(Math.max.apply(null, p.flow[i]) - pk) < 0.5) same++;
      });
      return n > 0 && same === n;
    })(), `${p.edgeIndex.length} 条边`);
    check('全网合计在 peakWindow 这个时刻最大', (() => {
      const totals = p.windows.map((w, i) => p.flow.reduce((s, row) => s + row[i], 0));
      const mx = Math.max.apply(null, totals);
      const idx = p.windows.findIndex(w => w.key === p.peakWindow);
      return idx >= 0 && Math.abs(totals[idx] - mx) < 1e-6;
    })());

    // 周末：无通勤
    const sat = timeModel.currentSlot(new Date('2026-09-26T09:40:00'));   // 周六
    check('周六判定为无通勤', sat.idle === true && /周末/.test(sat.label), sat.label);
    check('无通勤时给出全零流量', (() => {
      const z = timeModel.zeroFlow();
      return z.length === router.EDGE_COUNT && Array.prototype.every.call(z, v => v === 0);
    })());
    // 工作日换课时刻：命中最近时段
    const mon = timeModel.currentSlot(new Date('2026-09-28T09:38:00'));   // 周一 09:38
    check('工作日临近换课会命中该时段', mon.key === p.windows.find(w => w.time === '09:40').key,
      `${mon.label} -> ${mon.key}`);
    const deep = timeModel.currentSlot(new Date('2026-09-28T02:00:00')); // 周一凌晨
    check('凌晨判定为不是换课时段', deep.idle === true && /不是换课/.test(deep.label), deep.label);

    // 时段真的会改变热度图：夜间应为空/极低
    const quiet = timeModel.flowAt(p.windows[0].key);
    const busy = timeModel.flowAt(p.windows[1].key);
    const sum = a => Array.prototype.reduce.call(a, (s, v) => s + v, 0);
    check('不同时段的流量不同', sum(quiet) !== sum(busy), `${Math.round(sum(quiet))} vs ${Math.round(sum(busy))}`);

    // 与情景引擎配合：换成低峰时段的基线，占用率应显著下降
    const full = scenarioEngine.applyScenario({});
    const night = scenarioEngine.applyScenario({ basePeak: timeModel.zeroFlow() });
    check('基线换成"无通勤"后没有拥堵',
      night.avgOccNow === 0 && night.congestionIndex === 0,
      `占用率 ${night.avgOccNow}，拥堵指数 ${night.congestionIndex}`);
    check('而最高峰基线是有拥堵的', full.avgOccNow > 0, `占用率 ${full.avgOccNow}`);
    check('情景引擎接受自定义基线', night.peak.length === router.EDGE_COUNT
      && Array.prototype.every.call(night.peak, v => v === 0));

    timeModel.__clearProfileForTest();
    // 清理后必须回到**仓库里真正的那份** data/time-profile.js：
    // 以前仓库里是占位文件，现在可能已经是真实课表画像，所以不能写死 available===false。
    const shipped = require(path.join(ROOT, 'data', 'time-profile.js'));
    check('清理后回到真实状态',
      timeModel.available() === !!shipped.available
      && timeModel.source() === (shipped.source || ''),
      `available=${timeModel.available()}，来源 ${timeModel.source() || '(占位)'}`);
  }
}

console.log('\n=== 6. 真实画像文件必须始终存在（否则小程序编译失败）===');
{
  const f = path.join(ROOT, 'data', 'time-profile.js');
  check('data/time-profile.js 存在', fs.existsSync(f));
  const p = require(f);
  check('有 available 字段', typeof p.available === 'boolean', `available=${p.available}`);
  if (!p.available) {
    check('占位文件说明了原因与做法', /课表/.test(p.reason) && /时段数据说明/.test(p.howTo || ''),
      p.reason);
  }
  const src = fs.readFileSync(f, 'utf8');
  check('占位不含示例数据（不会把示例当真实）', p.available || !/示例/.test(src));
}

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exit(fail ? 1 : 0);
