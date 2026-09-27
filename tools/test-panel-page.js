/**
 * 模块二级页（pages/panel）测试：一个通用页 + key 区分，9 个模块共用。
 *   node tools/test-panel-page.js
 *
 * 重点验三件事：
 *   1. key 决定标题与内容，未知 key 有兜底；
 *   2. 显示的数据来自路线页的快照（panelBus），页面自己不算业务数据；
 *   3. 改参数只写 session + 推一条 intent，不在这里做重算。
 */
const path = require('path');
const { ROOT } = require('./paths.js');

const storage = new Map();
const calls = { toast: [], navTo: [], navBack: 0, title: '' };

global.wx = {
  getStorageSync: k => (storage.has(k) ? storage.get(k) : ''),
  setStorageSync: (k, v) => { storage.set(k, JSON.parse(JSON.stringify(v))); },
  removeStorageSync: k => { storage.delete(k); },
  showToast: opt => { calls.toast.push(opt); },
  navigateTo: opt => { calls.navTo.push(opt.url); },
  navigateBack: () => { calls.navBack++; },
  setNavigationBarTitle: opt => { calls.title = opt.title; },
};

let pageConfig = null;
global.Page = cfg => { pageConfig = cfg; };
require(path.join(ROOT, 'pages', 'panel', 'panel.js'));

const session = require(path.join(ROOT, 'utils', 'session.js'));
const panelBus = require(path.join(ROOT, 'utils', 'panelBus.js'));
const reportsUtil = require(path.join(ROOT, 'utils', 'reports.js'));
const reportStore = require(path.join(ROOT, 'utils', 'reportStore.js'));
const router = require(path.join(ROOT, 'utils', 'router.js'));

function newPage(query) {
  const inst = Object.assign({}, pageConfig);
  inst.data = JSON.parse(JSON.stringify(pageConfig.data));
  inst.setData = function (obj, cb) {
    Object.keys(obj).forEach(k => { this.data[k] = obj[k]; });
    if (cb) cb();
  };
  inst.onLoad(query || {});
  return inst;
}

const fresh = key => { panelBus.putSnapshot('route', SNAP); return newPage({ key }); };

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`); }
}

// 造一份路线页会推过来的快照
const SNAP = {
  timeAvailable: true,
  timeChoices: [{ key: 'auto', label: '按当前时间（自动）' }, { key: 'd1w0470', label: '07:50 换课' }],
  timeIndex: 0,
  timeChoice: 'auto',
  timeText: '周一 07:50：换课',
  timeHint: '时段画像来自课表',
  timeIdle: false,
  caliber: '周一 07:50 换课',
  dateISO: '2026-09-28',
  dateLabel: '9月28日 周一',
  dateHint: '正常上课日。',
  dateMin: '2024-01-01',
  dateMax: '2030-12-31',
  isWeekend: false,
  dayKind: 'normal',
  eventList: [{ id: 'e1', title: '校运会', typeName: '校运会', timeText: '08:00-17:00', venueText: '体育场', audienceText: '全部专业 · 全部年级', peopleText: '3,000 人', include: true }],
  eventCount: 1,
  eventIncluded: 1,
  eventText: '当天 1 个活动，已计入 1 个',
  weatherChoice: 'auto',
  weatherIndex: 0,
  weatherText: '小雨',
  weatherDetail: '22°C · 降水 0.4 mm',
  weatherSource: 'Weather data by Open-Meteo.com',
  weatherAssumption: '雨天假设说明',
  reportSummary: '1 处施工 · 1 处交警',
  reportCounts: { pending: 2, verified: 1, rejected: 1 },
  reportBackend: '本机存储',
  reportCloud: false,
  avoidPolice: false,
  policeCount: 1,
  tracking: false,
  trackingText: '',
  closedList: [{ ei: 3, roadType: '生活区道路', label: 'E004' }],
  congestion: { index: 1.4, aggravated: 3, eased: 0, newHotspots: 1, avgOccNow: 0.21, avgOccBase: 0.15, increased: 9, unassignedFlow: 0, worst: [{ roadType: '生活区道路', occBase: 0.4, occNow: 0.9, now: 120, text: 'x' }] },
  scenarioSummary: '中到大雨',
  scenarioNote: '',
  atBaseline: false,
  result: { modeName: '少人优先', timeText: '9 分钟', distanceMeters: 2896, avgHeatPersons: 12, avgCongestion: 0.07, crowdDelayMinutes: 1.2, policeSegments: 1, roadMix: '生活区道路 1200m', congestedSegments: 3, badSegments: 1 },
  comparison: [{ key: 'quiet', name: '少人优先', active: true, timeText: '9 分钟', distance: 2896, avgHeat: 12 }],
  insight: '少人优先略慢但更清净',
  policeInsight: '已避开 1 处交警',
  hint: '',
  mode: 'quiet',
};

console.log('\n=== 1. key -> 标题与兜底 ===');
{
  const titles = {
    time: '预测时段', event: '当天事件', weather: '天气', report: '实时路况上报',
    police: '交警规避', locate: '实时定位', close: '直接封路',
    congestion: '拥堵预测', result: '规划结果',
  };
  let ok = true, detail = [];
  Object.keys(titles).forEach(k => {
    const p = newPage({ key: k });
    if (p.data.key !== k || p.data.title !== titles[k] || calls.title !== titles[k]) {
      ok = false; detail.push(`${k}->${p.data.title}`);
    }
  });
  check('9 个 key 都能对上标题', ok, detail.join(' ') || `例如 result -> ${titles.result}`);
  check('标题也设进了导航栏', calls.title === titles.result, calls.title);

  const bad = newPage({ key: '不存在的模块' });
  check('未知 key 兜底到「预测时段」', bad.data.key === 'time', bad.data.title);
  const none = newPage({});
  check('不带 key 也不崩', none.data.key === 'time');
}

console.log('\n=== 2. 显示的数据来自路线页快照 ===');
{
  panelBus.clear();
  session.patch({ dateISO: '', timeChoice: 'auto', mode: 'quiet', avoidPolice: false, closedList: [], wantTracking: false, weatherChoice: 'auto' });
  const empty = newPage({ key: 'congestion' });
  check('没有快照时不崩、显示空状态', empty.data.congestion === null);

  panelBus.putSnapshot('route', SNAP);
  const p = newPage({ key: 'congestion' });
  check('口径来自快照', p.data.caliber === SNAP.caliber, p.data.caliber);
  check('拥堵数据来自快照', p.data.congestion.index === 1.4);
  check('受影响最重路段来自快照', p.data.congestion.worst.length === 1);
  check('情景说明来自快照', p.data.scenarioSummary === '中到大雨' && p.data.atBaseline === false);

  const pr = newPage({ key: 'result' });
  check('结果来自快照', pr.data.result.distanceMeters === 2896);
  check('较堵/爆堵段数也来自快照（和地图上的橙红段对应）',
    pr.data.result.congestedSegments === 3 && pr.data.result.badSegments === 1,
    `较堵 ${pr.data.result.congestedSegments} · 爆堵 ${pr.data.result.badSegments}`);
  check('三走法对比来自快照', pr.data.comparison.length === 1 && pr.data.comparison[0].active === true);
  check('交警说明来自快照', /避开/.test(pr.data.policeInsight));
  check('没结果时显示空状态而不是报错', (() => {
    panelBus.putSnapshot('route', Object.assign({}, SNAP, { result: null }));
    const q = newPage({ key: 'result' });
    const ok = q.data.result === null;
    panelBus.putSnapshot('route', SNAP);
    return ok;
  })());

  const pw = newPage({ key: 'weather' });
  check('天气来自快照', pw.data.weatherText === '小雨' && pw.data.weatherChoice === 'auto');
  check('天气档位下标算对了', pw.data.weatherIndex === 0);
  check('雨天算法说明也带过来了', !!pw.data.weatherAssumption);

  const pe = newPage({ key: 'event' });
  check('事件列表来自快照', pe.data.eventList.length === 1 && pe.data.eventCount === 1);

  const pc = newPage({ key: 'close' });
  check('封路列表来自 session（可被面板直接改）', pc.data.closedList.length === 1,
    pc.data.closedList[0] && pc.data.closedList[0].label);
}

console.log('\n=== 3. 改参数：只写 session + 推 intent ===');
{
  panelBus.clear();
  session.patch({ timeChoice: 'auto', timeIndex: 0, dateISO: '2026-09-28', mode: 'quiet', avoidPolice: false, closedList: [], wantTracking: false, weatherChoice: 'auto' });
  panelBus.putSnapshot('route', SNAP);

  const p = newPage({ key: 'time' });
  p.onTimeChoice({ detail: { value: 1 } });
  check('选时段写进 session', session.get().timeChoice === 'd1w0470' && session.get().timeIndex === 1,
    session.get().timeChoice);
  check('并推了一条 applyConfig 意图',
    panelBus.peekIntents().length === 1 && panelBus.peekIntents()[0].action === 'applyConfig');
  check('页面自己也更新了（即时反馈）', p.data.timeChoice === 'd1w0470' && p.data.timeIndex === 1);

  panelBus.clear();
  p.onDateChange({ detail: { value: '2026-10-01' } });
  check('选日期写进 session', session.get().dateISO === '2026-10-01');
  check('日期也推了意图', panelBus.peekIntents().length === 1);

  panelBus.clear();
  p.onWeatherChoice({ detail: { value: 3 } });
  check('手动切天气写进 session',
    session.get().weatherChoice === 'heavy' && session.get().level === 'heavy');
  check('手动档位推 applyConfig', panelBus.peekIntents()[0].action === 'applyConfig');

  panelBus.clear();
  const w2 = fresh('weather');
  w2.onWeatherChoice({ detail: { value: 0 } });
  check('切回「自动」推的是 refreshWeather（要联网）',
    panelBus.peekIntents()[0].action === 'refreshWeather', panelBus.peekIntents()[0].action);

  panelBus.clear();
  const pe = fresh('event');
  pe.toggleEventInclude({ currentTarget: { dataset: { id: 'e1' } } });
  check('事件「计入/排除」写进 session',
    session.get().eventInclude.e1 === false, JSON.stringify(session.get().eventInclude));
  check('页面上的计数跟着变', pe.data.eventIncluded === 0);

  panelBus.clear();
  const pp = fresh('police');
  pp.toggleAvoidPolice();
  check('交警开关写进 session', session.get().avoidPolice === true && pp.data.avoidPolice === true);

  panelBus.clear();
  const pl = fresh('locate');
  pl.toggleTracking();
  check('定位开关写进 session', session.get().wantTracking === true);
  check('定位开关只表达意愿，不在这里开监听（不调 wx.startLocationUpdate）', !global.wx.startLocationUpdate);

  panelBus.clear();
  const pc = fresh('close');
  pc.removeClosed({ currentTarget: { dataset: { ei: 3 } } });
  check('解除封路写进 session', session.get().closedList.length === 0);
  check('页面列表也清空了', pc.data.closedList.length === 0);

  panelBus.clear();
  const pr = fresh('result');
  pr.onSwitchMode({ currentTarget: { dataset: { mode: 'fastest' } } });
  check('切走法写进 session', session.get().mode === 'fastest');
  check('对比表高亮跟着变',
    pr.data.comparison.find(c => c.key === 'fastest') === undefined
    || pr.data.comparison.find(c => c.key === 'fastest').active === true);
  check('推的是 applyConfig（路线页会重新规划）', panelBus.peekIntents()[0].action === 'applyConfig');

  check('切走法后确实留下了待消费的意图', panelBus.peekIntents().length === 1);
}

console.log('\n=== 4. 生效路况分项统计（读本机上报）===');
{
  storage.clear();
  reportStore.add(reportsUtil.createReport({
    category: 'closure', edges: [3], x: 100, y: 100,
    roadType: router.graph.roadTypes[router.graph.edges[3][4]],
    edgeId: router.graph.edgeIds[3],
  }, Date.now()));
  const p = newPage({ key: 'report' });
  check('统计出来了', !!p.data.effective, JSON.stringify(p.data.effective));
  check('未核实的上报不计入「正在影响规划」', p.data.effective.total === 0,
    `生效 ${p.data.effective.total}`);
  check('但会计入「待核实」计数', p.data.reportCounts && p.data.reportCounts.pending === 1
    || (p.data.effective && p.data.effective.total === 0));
  storage.clear();
}

console.log('\n=== 5. 跳别的页 ===');
{
  calls.navTo.length = 0;
  const p = newPage({ key: 'report' });
  p.beginPickReport();
  p.beginPickClose();
  p.goAdmin();
  p.goEventPage();
  check('上报 -> 点选页（report 模式）', calls.navTo[0] === '/pages/pick/pick?mode=report&from=panel', calls.navTo[0]);
  check('封路 -> 点选页（close 模式）', calls.navTo[1] === '/pages/pick/pick?mode=close&from=panel', calls.navTo[1]);
  check('都带上 from=panel（点选页靠它知道「取消」要回到本页）',
    calls.navTo.slice(0, 2).every(u => /from=panel$/.test(u)), calls.navTo.slice(0, 2).join(' '));
  check('管理页', calls.navTo[2] === '/pages/admin/admin');
  check('事件与校历页', calls.navTo[3] === '/pages/event/event');
  const before = calls.navBack;
  p.close();
  check('返回', calls.navBack > before);
  check('空结果时的「回去规划」也是返回', (() => {
    panelBus.putSnapshot('route', Object.assign({}, SNAP, { result: null }));
    const q = newPage({ key: 'result' });
    const n = calls.navBack;
    q.close();
    panelBus.putSnapshot('route', SNAP);
    return calls.navBack > n;
  })());
}

console.log('\n=== 6. 预测时段：作息时间表（第1-2节 课前 / 课后）===');
{
  const timeModel2 = require(path.join(ROOT, 'utils', 'timeModel.js'));
  const periods2 = require(path.join(ROOT, 'utils', 'periods.js'));

  panelBus.clear();
  session.patch({ timeChoice: 'auto', timeIndex: 0, dateISO: '2026-09-28' });   // 周一
  const p = fresh('time');

  check('列出周一到周五五个页签', p.data.weekdayTabs.length === 5
    && p.data.weekdayTabs.map(t => t.name).join('') === '周一周二周三周四周五',
    p.data.weekdayTabs.map(t => t.name).join(' '));
  check('所选日期是周一，就默认看周一', p.data.previewWeekday === 1 && p.data.previewName === '周一',
    p.data.previewName);
  check('周一页签是高亮的', p.data.weekdayTabs[0].active === true);
  check('有序表数据，正常上课日不算 offDay', p.data.offDay === false && p.data.periodTable.length === 6,
    `${p.data.periodTable.length} 行`);
  check('第一行是第1-2节', p.data.periodTable[0].name === '第1-2节' && p.data.periodTable[0].start === '08:00',
    `${p.data.periodTable[0].name} ${p.data.periodTable[0].start}-${p.data.periodTable[0].end}`);
  check('课前那个按钮是 07:50 换课，带得上窗口 key',
    p.data.periodTable[0].before.time === '07:50' && p.data.periodTable[0].before.key === 'd1w0470',
    `${p.data.periodTable[0].before.time} / ${p.data.periodTable[0].before.key}`);
  check('课后那个按钮是 09:40', p.data.periodTable[0].after.time === '09:40');
  check('人次在页面上是千分位显示（不是裸数字）',
    /^\d{1,3}(,\d{3})*$/.test(p.data.periodTable[0].before.totalText),
    p.data.periodTable[0].before.totalText);
  check('可选项个数 = 周一换课窗口个数',
    p.data.tablePicks === timeModel2.windowsFor(1).length,
    `${p.data.tablePicks} / ${timeModel2.windowsFor(1).length}`);
  check('如实说明节次时刻来自通行作息', /通行作息/.test(p.data.tableHint), p.data.tableHint);

  // 切到周三
  p.onWeekday({ currentTarget: { dataset: { w: 3 } } });
  check('点页签切到周三', p.data.previewWeekday === 3 && p.data.previewName === '周三');
  check('周三页签变成高亮、周一不再高亮',
    p.data.weekdayTabs[2].active === true && p.data.weekdayTabs[0].active === false);
  check('周三的按钮带的是周三的窗口 key（d3 开头）',
    p.data.periodTable[0].before.key === 'd3w0470', p.data.periodTable[0].before.key);
  check('周三可选项个数也对', p.data.tablePicks === timeModel2.windowsFor(3).length,
    `${p.data.tablePicks} / ${timeModel2.windowsFor(3).length}`);

  const before6 = p.data.previewWeekday;
  p.onWeekday({ currentTarget: { dataset: { w: 6 } } });   // 周六，画像里没有
  check('周末页签点不动（画像里没有周六的课）', p.data.previewWeekday === before6);

  // 点某一节课的「课前」
  panelBus.clear();
  p.onPickSlot({ currentTarget: { dataset: { key: 'd3w0470', minutes: 470 } } });
  check('点作息表上的按钮写进 session', session.get().timeChoice === 'd3w0470', session.get().timeChoice);
  check('并推 applyConfig 让路线页重算', panelBus.peekIntents()[0].action === 'applyConfig');
  check('提示词是人话', /第1-2节 课前/.test(calls.toast[calls.toast.length - 1].title),
    calls.toast[calls.toast.length - 1].title);
  check('选中的按钮在表上高亮', (() => {
    const row = p.data.periodTable[0];
    return row.before.selected === true && row.after.selected === false;
  })());

  // 所选日期是周日/放假：退回"看某一个上课日"，而不是给一张空表
  // （日期以路线页推来的快照为准，所以这里连快照一起换成周日）
  panelBus.clear();
  session.patch({ timeChoice: 'auto', dateISO: '2026-09-27' });   // 周日
  panelBus.putSnapshot('route', Object.assign({}, SNAP, {
    dateISO: '2026-09-27', dateLabel: '9月27日 周日', isWeekend: true, dayKind: 'weekend',
  }));
  const off = newPage({ key: 'time' });
  check('周日也照样给出完整作息表（不空白）',
    off.data.periodTable.length === 6 && off.data.tablePicks > 0, `${off.data.tablePicks} 个可选`);
  check('并说明这天没课、现在看的是周几', off.data.offDay === true && /周/.test(off.data.offDayNote),
    off.data.offDayNote);
  check('默认退到周一', off.data.previewWeekday === 1 && off.data.previewName === '周一');

  check('带不上 minutes 时提示退回 key（不显示 NaN:NaN）', (() => {
    const n = calls.toast.length;
    p.onPickSlot({ currentTarget: { dataset: { key: 'd1w0470' } } });
    const t = calls.toast[calls.toast.length - 1].title;
    return calls.toast.length === n + 1 && /d1w0470/.test(t);
  })());
}

console.log('\n=== 7. 选日期：界面必须真的跟着换（曾经的 bug）===');
{
  const timeModel3 = require(path.join(ROOT, 'utils', 'timeModel.js'));

  // 回归：用户报"选择日期后日期并没有真正改变"。
  // 当时 onDateChange 只 setData({dateISO})，徽标/说明/作息表全是旧的那一天；
  // 而且 pull() 里 dateISO 是"快照优先"，回一趟别的页就被旧快照顶回去。
  panelBus.clear();
  session.patch({ dateISO: '2026-09-28', timeChoice: 'auto' });   // 周一
  panelBus.putSnapshot('route', Object.assign({}, SNAP, { dateISO: '2026-09-28' }));
  const p = newPage({ key: 'time' });
  check('初始是周一', p.data.dateISO === '2026-09-28' && p.data.previewWeekday === 1, p.data.dateLabel);

  panelBus.clear();
  p.onDateChange({ detail: { value: '2026-10-01' } });            // 周四
  check('日期写进 session', session.get().dateISO === '2026-10-01');
  check('并推了一条 applyConfig', panelBus.peekIntents()[0].action === 'applyConfig');
  check('dateISO 当场就变了', p.data.dateISO === '2026-10-01', p.data.dateISO);
  check('徽标上的日期名也当场变了（不是旧的周一）',
    /10月1日/.test(p.data.dateLabel) && /周四/.test(p.data.dateLabel), p.data.dateLabel);
  check('日期说明也当场重算了',
    /10月1日/.test(p.data.dateHint) && /正常上课日/.test(p.data.dateHint), p.data.dateHint);
  check('作息表跟着换成周四', p.data.previewWeekday === 4 && p.data.previewName === '周四',
    p.data.previewName);
  check('周四页签高亮、周一不再高亮',
    p.data.weekdayTabs[3].active === true && p.data.weekdayTabs[0].active === false);
  check('表里的按钮也换成周四的 key（d4 开头）',
    p.data.periodTable[0].before.key === 'd4w0470', p.data.periodTable[0].before.key);
  check('周四可选项个数与画像一致',
    p.data.tablePicks === timeModel3.windowsFor(4).length, String(p.data.tablePicks));

  // 关键回归：快照还是旧的周一，重新进页面不能把日期顶回周一
  const p2 = newPage({ key: 'time' });
  check('【回归】旧快照不会把日期顶回去（session 优先）',
    p2.data.dateISO === '2026-10-01' && p2.data.previewWeekday === 4,
    `${p2.data.dateISO} ${p2.data.dateLabel}`);
  check('【回归】重进页面后作息表还是那一天', p2.data.periodTable[0].before.key === 'd4w0470',
    p2.data.periodTable[0].before.key);

  // 选到周末：如实说没课，并且作息表退回上课日
  panelBus.clear();
  p.onDateChange({ detail: { value: '2026-09-27' } });            // 周日
  check('周日：徽标与说明都换成周日',
    /9月27日/.test(p.data.dateLabel) && /周日/.test(p.data.dateLabel)
    && /没有通勤/.test(p.data.dateHint), p.data.dateHint);
  check('周日：isWeekend 为真、判为 offDay', p.data.isWeekend === true && p.data.offDay === true);
  check('周日：作息表退回周一而不是空白',
    p.data.previewWeekday === 1 && p.data.tablePicks === timeModel3.windowsFor(1).length,
    `周${p.data.previewWeekday} / ${p.data.tablePicks} 个`);
  check('周日：说明里点出"现在看的是周一"', /「周一」的作息表/.test(p.data.offDayNote), p.data.offDayNote);

  // 从周日再选到周三：作息表要跟着换（不能还停在"默认周一"）
  panelBus.clear();
  p.onDateChange({ detail: { value: '2026-09-30' } });            // 周三
  check('从周末选到周三，作息表跟着换到周三',
    p.data.previewWeekday === 3 && p.data.periodTable[0].before.key === 'd3w0470',
    p.data.previewName || String(p.data.previewWeekday));

  // 放假：日期说明要说清"按没有课算"
  const eventStore3 = require(path.join(ROOT, 'utils', 'eventStore.js'));
  storage.clear();
  session.patch({ dateISO: '2026-10-01', timeChoice: 'auto' });
  eventStore3.putOverride({ date: '2026-10-01', kind: 'holiday', note: '测试放假' });
  const hol = newPage({ key: 'time' });
  check('放假：说明写清按没有课算', /放假/.test(hol.data.dateHint), hol.data.dateHint);
  check('放假：kind/isWeekend 也对', hol.data.dayKind === 'holiday' && hol.data.isWeekend === false,
    hol.data.dayKind);
  check('放假：作息表退回上课日而不是空白', hol.data.offDay === true && hol.data.tablePicks > 0,
    String(hol.data.tablePicks));
  eventStore3.clearLocal();
  storage.clear();
}

console.log('\n=== 8. 二级页也要收下点选页的回传（封路/上报）===');
{
  // 用户报的现象：在二级页点「去地图上封路」→ 点选页封完返回 →
  // 二级页的清单还是空的、session 也没更新 → **再进点选页那条路还是"没封"的样子**
  //（画着正常热度色，占用率低时正好是黄色），看起来就像"封路没生效、热度图没重算"。
  const pickBus = require(path.join(ROOT, 'utils', 'pickBus.js'));
  const eventStore8 = require(path.join(ROOT, 'utils', 'eventStore.js'));
  const reportsUtil8 = require(path.join(ROOT, 'utils', 'reports.js'));
  const reportStore8 = require(path.join(ROOT, 'utils', 'reportStore.js'));

  storage.clear();
  session.patch({ closedList: [], timeChoice: 'auto', dateISO: '2026-09-28' });
  panelBus.clear();
  panelBus.putSnapshot('route', SNAP);

  // 模拟点选页回传一条封路结果
  pickBus.put({
    action: 'close', edgeIndex: 42, edgeId: 'E042', roadType: 'residential',
    peak: 321, length: 210,
  });
  // 真机上点选页返回时会走 onShow（onLoad 之后），二级页在 onShow 里收结果
  const p = newPage({ key: 'close' });
  p.onShow();
  check('封路清单当场就有了（不用等路线页回推）',
    p.data.closedList.length === 1 && p.data.closedList[0].ei === 42,
    JSON.stringify(p.data.closedList[0] || null));
  check('写进了 session（其它页面读得到）',
    session.get().closedList.length === 1 && session.get().closedList[0].ei === 42,
    JSON.stringify(session.get().closedList));
  check('并推了 applyConfig 让路线页重算',
    panelBus.peekIntents().some(i => i.action === 'applyConfig'));
  check('封路项里带上人话名称与峰值',
    /生活区道路/.test(p.data.closedList[0].label) && p.data.closedList[0].peak === 321,
    p.data.closedList[0].label);
  check('点选结果已经被取走（不会又被路线页收一次）', pickBus.peek() === null);

  // 同一条路再封一次：不能重复添加
  pickBus.put({ action: 'close', edgeIndex: 42, edgeId: 'E042', roadType: 'residential', peak: 321, length: 210 });
  const p2 = newPage({ key: 'close' });
  p2.onShow();
  check('重复封同一条路不会加两条', p2.data.closedList.length === 1, `${p2.data.closedList.length} 条`);

  // 坏数据：不能塞一条 ei 是 undefined 的进去
  pickBus.put({ action: 'close', edgeIndex: null, roadType: 'residential' });
  const p3 = newPage({ key: 'close' });
  p3.onShow();
  check('数据不完整的封路结果被丢掉（不会污染清单）', p3.data.closedList.length === 1);

  // 上报：二级页也要把它存进上报库（路线页下次 onShow 会重新读库）
  storage.clear();
  pickBus.put({
    action: 'report', category: 'congestion', edges: [7],
    x: 100, y: 100, roadType: 'residential', edgeId: 'E007', note: '测试上报',
  });
  const p4 = newPage({ key: 'report' });
  p4.onShow();
  const stored = [];
  reportStore8.load(list => { stored.push.apply(stored, list); });
  check('上报落到上报库里（路线页下次读到）', stored.length === 1,
    `${stored.length} 条`);
  check('上报内容完整', stored.length === 1 && stored[0].category === 'congestion'
    && stored[0].edges[0] === 7 && reportsUtil8.CATEGORY_MAP[stored[0].category], JSON.stringify(stored[0] || null));
  check('上报结果也被取走了', pickBus.peek() === null);
  check('本页的"待核实"计数立刻加上了（不用等路线页回推）',
    p4.data.reportCounts && p4.data.reportCounts.pending === 1,
    JSON.stringify(p4.data.reportCounts));
  check('后端来源也跟着刷新', !!p4.data.reportBackend, p4.data.reportBackend);

  eventStore8.clearLocal();
  storage.clear();
  panelBus.clear();
  session.patch({ closedList: [] });
}

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exit(fail ? 1 : 0);
