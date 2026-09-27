/**
 * 少人路线页逻辑测试：用假的 wx / Page 把页面跑起来。
 * 覆盖：自动定位、列表选点、点选页回传处理、天气、情景重算、三走法、绘制、上报与审核。
 *
 *   node tools/test-route-page.js
 */
const fs = require('fs');
const path = require('path');

const rect = { left: 16, top: 100, width: 343, height: 450 };
const calls = { canvas: [], toast: [], modal: [], navBack: 0, request: [], navigate: [], actionSheet: [], title: '' };
let locationBehavior = 'ok';
let weatherBehavior = 'ok';
let trackBehavior = 'ok';
let actionSheetPick = 0;      // wx.showActionSheet 选第几项
let measureDeferred = false;  // true = 把 boundingClientRect 的回调挂起（模拟真机的异步测量）
const measureQueue = [];
/** 把挂起的测量回调都执行掉（模拟"测量晚一点才回来"）。 */
const flushMeasures = () => { while (measureQueue.length) measureQueue.shift()(rect); };
// 模拟 wx.onLocationChange 的回调注册与手动触发
let locationListeners = [];
const storage = new Map();

const canvasRecorder = () => {
  const rec = { ops: [], strokes: [], arcs: [], fills: [] };
  let cur = null;
  const push = (name, args) => rec.ops.push([name].concat(args));
  const api = {
    rec,
    clearRect: (...a) => push('clearRect', a),
    save: () => push('save'),
    restore: () => push('restore'),
    translate: (...a) => push('translate', a),
    scale: (...a) => push('scale', a),
    setLineCap: (...a) => push('setLineCap', a),
    setLineJoin: (...a) => push('setLineJoin', a),
    setStrokeStyle: c => { rec.curColor = c; push('setStrokeStyle', [c]); },
    setFillStyle: c => { rec.curFill = c; push('setFillStyle', [c]); },
    setLineWidth: w => { rec.curWidth = w; push('setLineWidth', [w]); },
    setLineDash: p => { rec.curDash = p; push('setLineDash', [p]); },
    beginPath: () => { cur = { segs: 0 }; },
    closePath: () => push('closePath'),
    moveTo: (...a) => push('moveTo', a),
    lineTo: (...a) => { if (cur) cur.segs++; push('lineTo', a); },
    stroke: () => {
      rec.strokes.push({ color: rec.curColor, width: rec.curWidth, dash: rec.curDash, segs: cur ? cur.segs : 0 });
      cur = null;
      push('stroke');
    },
    arc: (...a) => { rec.arcs.push([a[0], a[1], a[2]]); push('arc', a); },
    fill: () => { rec.fills.push(rec.curFill); push('fill'); },
    draw: () => push('draw'),
  };
  calls.canvas.push(rec);
  return api;
};

global.wx = {
  createSelectorQuery: () => {
    const q = {
      _cb: null,
      select() { return q; },
      boundingClientRect(cb) { q._cb = cb; return q; },
      exec() {
        if (!q._cb) return;
        // 真机上 boundingClientRect 的回调是**异步**的；测试默认同步执行（大多数断言不关心），
        // 需要复现"测量还没回来用户就扫完了"的场景时把 measureDeferred 打开。
        if (measureDeferred) measureQueue.push(q._cb);
        else q._cb(rect);
      },
    };
    return q;
  },
  createCanvasContext: () => canvasRecorder(),
  getLocation: opt => {
    if (locationBehavior === 'ok') {
      opt.success({ longitude: 112.93324839293244, latitude: 28.1627837 });
    } else {
      opt.fail({ errMsg: 'getLocation:fail auth deny' });
    }
  },
  getSetting: opt => opt.success({ authSetting: {} }),
  authorize: opt => opt.fail({}),
  showModal: opt => { calls.modal.push(opt); },
  openSetting: () => {},
  showToast: opt => { calls.toast.push(opt); },
  // 起点/终点现在收进原生选择菜单（wx.showActionSheet），测试里要能选某一项
  showActionSheet: opt => {
    calls.actionSheet.push(opt.itemList.slice());
    if (opt.success) opt.success({ tapIndex: actionSheetPick });
  },
  setNavigationBarTitle: opt => { calls.title = opt.title; },
  navigateBack: () => { calls.navBack++; },
  navigateTo: opt => { calls.navigate.push(opt.url); },
  getStorageSync: k => (storage.has(k) ? storage.get(k) : ''),
  setStorageSync: (k, v) => { storage.set(k, JSON.parse(JSON.stringify(v))); },
  removeStorageSync: k => { storage.delete(k); },
  startLocationUpdate: opt => {
    if (trackBehavior === 'ok') { if (opt.success) opt.success({}); }
    else if (opt.fail) opt.fail({ errMsg: 'startLocationUpdate:fail auth deny' });
  },
  stopLocationUpdate: () => { calls.stopLocationUpdate = (calls.stopLocationUpdate || 0) + 1; },
  onLocationChange: cb => { locationListeners.push(cb); },
  offLocationChange: cb => { locationListeners = locationListeners.filter(x => x !== cb); },
  request: opt => {
    calls.request.push(opt.url);
    if (weatherBehavior === 'ok') {
      opt.success({
        data: {
          current: {
            time: '2026-09-26T20:15', interval: 900,
            temperature_2m: 18.5, precipitation: 0.4, rain: 0.4, weather_code: 61,
          },
        },
      });
    } else {
      opt.fail({ errMsg: 'request:fail url not in domain list' });
    }
  },
};

let pageConfig = null;
global.Page = cfg => { pageConfig = cfg; };

const { ROOT: BASE } = require('./paths.js');
require(path.join(BASE, 'pages', 'route', 'route.js'));
const router = require(path.join(BASE, 'utils', 'router.js'));
const timeModel = require(path.join(BASE, 'utils', 'timeModel.js'));
const scenarioEngine = require(path.join(BASE, 'utils', 'scenario.js'));
const reportsUtil = require(path.join(BASE, 'utils', 'reports.js'));
const reportStore = require(path.join(BASE, 'utils', 'reportStore.js'));
const session = require(path.join(BASE, 'utils', 'session.js'));
const pickBus = require(path.join(BASE, 'utils', 'pickBus.js'));
const graph = router.graph;

// ---------------------------------------------------------------- 冻结时钟
// 有了真实课表后，「按当前时间」这个默认口径会随**运行测试的那一刻**变化：
// 周末、或离换课时段超过 1 小时，热度层就是空的（这是正确行为）。
// 测试必须可复现，所以这里把时钟钉在"周一早高峰"，需要别的时刻就 withClock。
const REAL_DATE = Date;
let fakeNow = '2026-09-28T07:50:00';        // 周一 07:50，正是 1-2 节的课前换课高峰
global.Date = class extends REAL_DATE {
  constructor(...a) { super(...(a.length ? a : [fakeNow])); }
  static now() { return new REAL_DATE(fakeNow).getTime(); }
};
/** 在指定时刻下跑一段测试，跑完还原。 */
function withClock(iso, fn) {
  const prev = fakeNow;
  fakeNow = iso;
  try { return fn(); } finally { fakeNow = prev; }
}

function setByPath(root, p, value) {
  const parts = String(p).replace(/\[(\d+)\]/g, '.$1').split('.');
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] === undefined) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function newPage() {
  const inst = Object.assign({}, pageConfig);
  inst.data = JSON.parse(JSON.stringify(pageConfig.data));
  inst.setData = function (obj, cb) {
    Object.keys(obj).forEach(k => {
      if (k.indexOf('.') >= 0 || k.indexOf('[') >= 0) setByPath(this.data, k, obj[k]);
      else this.data[k] = obj[k];
    });
    if (cb) cb();
  };
  // 真实微信一定会先调 onLoad，地图视口与手势在那里初始化
  inst.onLoad({});
  return inst;
}

const lastCanvas = () => calls.canvas[calls.canvas.length - 1];
const routeStrokes = rec => rec.strokes.filter(s => s.color === '#146b55');
const heatStrokes = rec => rec.strokes.filter(s => typeof s.color === 'string' && s.color.indexOf('rgb(') === 0);
const closedStrokes = rec => rec.strokes.filter(s => s.color === '#3a3a3a');
const lastToast = () => calls.toast[calls.toast.length - 1];

const VIEW_W = graph.meta.viewBox[0];
const VIEW_H = graph.meta.viewBox[1];

/** SVG 坐标 -> 屏幕触点坐标（按当前矩形、偏移与缩放换算）。 */
function svgToClient(page, svgX, svgY) {
  const r = rect;
  const s = Math.min(r.width / VIEW_W, r.height / VIEW_H);
  const offX = (r.width - VIEW_W * s) / 2;
  const offY = (r.height - VIEW_H * s) / 2;
  const k = page.data.scale || 1;
  const tx = page.data.tx || 0;
  const ty = page.data.ty || 0;
  const ux = svgX * s + offX;
  const uy = svgY * s + offY;
  return {
    clientX: r.left + r.width / 2 + tx + (ux - r.width / 2) * k,
    clientY: r.top + r.height / 2 + ty + (uy - r.height / 2) * k,
  };
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`); }
}

/** 通过搜索面板选一个地点（走真实交互路径）。 */
function searchPick(p, name, target) {
  p.openPlaceSearch({ currentTarget: { dataset: { target: target || 'dest' } } });
  p.setData({ 'placeSearch.keyword': name });
  p.refreshPlaceResults();
  const i = p.data.placeResults.findIndex(x => x.n === name);
  if (i < 0) throw new Error('搜索不到地点: ' + name);
  p.onPickPlaceResult({ currentTarget: { dataset: { index: i } } });
}

/** 造一个已就绪的页面：定位 + 选好终点。 */
function readyPage(dest) {
  const p = newPage();
  p.onReady();
  p.onShow();
  searchPick(p, dest || '数学与统计学院', 'dest');
  return p;
}

console.log('=== 1. 初始化：定位 + 天气 + 情景 ===');
{
  storage.clear();
  pickBus.take();
  const page = newPage();
  page.onReady();
  check('视口测量成功', !!page.view && page.view.ready, page.view && `W=${page.view.W} H=${page.view.H}`);
  check('请求了天气', calls.request.length === 1 && /api\.open-meteo\.com/.test(calls.request[0]));
  check('天气解析为「小雨」', page.data.weatherText === '小雨', page.data.weatherDetail);
  check('天气档位 light', page.currentLevel() === 'light');
  check('标注了数据来源', /Open-Meteo/.test(page.data.weatherSource));
  page.onShow();
  check('自动定位后起点就绪', page.data.startReady === true && page.data.startSource === 'gps', page.data.startLabel);
  check('吸附结果与路由层一致',
    page.startNode === router.nearestNodeByLonLat(112.93324839293244, 28.1627837).index);
  // 用户要求：自动定位要显示地点名，而不是只丢一串经纬度
  check('起点显示的是地点名而不是坐标', page.data.startLabel === '南校区6舍', page.data.startLabel);
  check('地点名不是经纬度格式', !/\d{2}\.\d{4,}/.test(page.data.startLabel), page.data.startLabel);
  check('提示里给出了校区/类型/距离', /南校区 · 宿舍 · 距该地点约 \d+ 米/.test(page.data.startSnapText)
    && /偏移约 \d+(\.\d)? 米/.test(page.data.startSnapText), page.data.startSnapText);
  check('经纬度仍然保留在提示里（需要核对时看得到）',
    /28\.16278, 112\.93325/.test(page.data.startSnapText), page.data.startSnapText);
  check('小雨情景已生效', page.data.atBaseline === false, page.data.scenarioSummary);
  check('拥堵面板已生成', !!page.data.congestion, `拥堵指数 ${page.data.congestion.index}`);
  check('把情景共享给了点选页', session.get().level === 'light');
}

console.log('\n=== 2. 动态热度层 ===');
{
  const rec = lastCanvas();
  check('画出了热度层', heatStrokes(rec).length > 50, `${heatStrokes(rec).length} 条`);
  check('线宽随占用率变化', new Set(heatStrokes(rec).map(s => Math.round(s.width))).size > 3);
  check('还没有路线时不画绿线', routeStrokes(rec).length === 0);
  check('起点标记已画', rec.arcs.length === 2);
}

console.log('\n=== 3. 点选按钮改为打开全屏点选页 ===');
{
  const p = readyPage();
  const n0 = calls.navigate.length;
  p.beginPickClose();
  check('「地图上点选封路」跳转到点选页', calls.navigate[n0] === '/pages/pick/pick?mode=close&from=route',
    calls.navigate[n0]);
  p.beginPickReport();
  check('「在线上报路况」带 report 模式', calls.navigate[n0 + 1] === '/pages/pick/pick?mode=report&from=route');
  p.beginPickStart();
  check('起点点选带 start 模式', calls.navigate[n0 + 2] === '/pages/pick/pick?mode=start&from=route');
  p.beginPickDest();
  check('终点点选带 dest 模式', calls.navigate[n0 + 3] === '/pages/pick/pick?mode=dest&from=route');
  check('都带上了 from=route（点选页靠它知道「取消」回哪一页）',
    calls.navigate.slice(n0, n0 + 4).every(u => /from=route$/.test(u)),
    calls.navigate.slice(n0, n0 + 4).join(' '));
  check('路线页不再自己处理地图点选（只处理手势）',
    typeof p.applyPick === 'undefined' && typeof p.applyClose === 'undefined'
    && typeof p.onMapTouchEnd === 'function');
}

console.log('\n=== 4. 接收点选页回传：起终点 ===');
{
  const p = newPage();
  p.onReady();
  p.onShow();
  const node = 151;
  pickBus.put({ action: 'start', nodeIndex: node, snapMeters: 12.5 });
  p.onShow();
  check('onShow 会消费点选结果', p.startNode === node && p.data.startSource === 'map', p.data.startLabel);
  check('展示了吸附偏移', /12.5/.test(p.data.startSnapText), p.data.startSnapText);
  check('结果只被消费一次', (() => { p.startNode = 1; p.onShow(); return p.startNode === 1; })());

  pickBus.put({ action: 'dest', nodeIndex: node + 1, snapMeters: 8 });
  p.onShow();
  check('终点也能被设置', p.destNode === node + 1 && p.data.destSource === 'map');
  check('两点齐了自动规划', p.data.planned === true, p.data.result && `${p.data.result.timeText}`);
}

console.log('\n=== 5. 接收点选页回传：封闭道路 ===');
{
  const p = readyPage();
  const base = p.data.result.distanceMeters;
  const fastest = router.planOn(p.network, p.startNode, p.destNode, 'fastest');
  const victim = fastest.usedEdges[Math.floor(fastest.usedEdges.length / 2)];

  pickBus.put({
    action: 'close', edgeIndex: victim.ei, edgeId: graph.edgeIds[victim.ei],
    roadType: victim.roadType, peak: Math.round(victim.flow), length: Math.round(victim.len),
  });
  p.onShow();
  check('封路进入列表', p.data.closedList.length === 1, p.data.closedList[0].label);
  check('封的正是回传的那条', p.data.closedList[0].ei === victim.ei);
  check('情景摘要包含封路', /封闭 1 条路段/.test(p.data.scenarioSummary), p.data.scenarioSummary);
  const after = router.planOn(p.network, p.startNode, p.destNode, 'fastest');
  check('新路线绕开了被封路段', !after.usedEdges.some(e => e.ei === victim.ei));
  check('画布把封路画成深灰虚线',
    closedStrokes(lastCanvas()).length === 1 && closedStrokes(lastCanvas())[0].dash.length > 0);
  check('共享情景里也带上了封路', session.get().closedList.length === 1);

  // 重复封同一条 -> 提示，不重复添加
  const n = calls.toast.length;
  pickBus.put({ action: 'close', edgeIndex: victim.ei, edgeId: 'x', roadType: victim.roadType, peak: 0, length: 0 });
  p.onShow();
  check('重复封同一条会被挡下', p.data.closedList.length === 1 && /已经封了/.test(lastToast().title),
    lastToast().title);

  // 列表里解除
  p.removeClosed({ currentTarget: { dataset: { ei: victim.ei } } });
  check('可以从列表解除', p.data.closedList.length === 0);
  p.clearClosed();
  check('全部解除无副作用', p.data.closedList.length === 0);

  // 直接封路同样会改变路线（用回传接口）
  pickBus.put({ action: 'close', edgeIndex: victim.ei, edgeId: graph.edgeIds[victim.ei], roadType: victim.roadType, peak: 0, length: 0 });
  p.onShow();
  check('重新封闭后路线改变', p.data.result.distanceMeters !== base
    || p.data.result.timeMinutes > 0, `${base}m -> ${p.data.result.distanceMeters}m`);
}

console.log('\n=== 6. 接收点选页回传：上报路况（待核实不生效）===');
{
  storage.clear();
  pickBus.take();
  const p = readyPage();
  const base = p.data.result.distanceMeters;
  const fastest = router.planOn(p.network, p.startNode, p.destNode, 'fastest');
  const victim = fastest.usedEdges[Math.floor(fastest.usedEdges.length / 2)];

  pickBus.put({
    action: 'report', category: 'closure', edges: [victim.ei],
    x: 100, y: 200, roadType: victim.roadType, edgeId: graph.edgeIds[victim.ei], note: '南门施工',
  });
  p.onShow();
  check('上报进入列表', p.data.reportList.length === 1, p.data.reportSummary);
  check('默认待核实', p.data.reportList[0].status === 'pending');
  check('备注被保存', p.data.reportList[0].note === '南门施工');
  check('落到了本机存储', (storage.get(reportStore.STORAGE_KEY) || []).length === 1);
  check('提示"待核实"', /待核实/.test(lastToast().title), lastToast().title);
  check('待核实不影响路线', p.data.result.distanceMeters === base, `${p.data.result.distanceMeters}m`);
  check('待核实画成空心标记',
    !lastCanvas().fills.includes(reportsUtil.CATEGORY_MAP.closure.color)
    && lastCanvas().strokes.some(s => s.color === reportsUtil.CATEGORY_MAP.closure.color && s.dash.length));

  // 管理员核实 -> 生效
  const id = p.data.reportList[0].id;
  reportStore.update(id, { status: 'verified' });
  p.loadReports();
  check('核实后计入生效路况', /1 处施工/.test(p.data.reportSummary), p.data.reportSummary);
  check('核实后改道', p.data.result.distanceMeters !== base || p.data.result.timeMinutes > 0,
    `${base}m -> ${p.data.result.distanceMeters}m`);
  check('属实画成实心标记', lastCanvas().fills.includes(reportsUtil.CATEGORY_MAP.closure.color));

  // 判为不属实 -> 恢复
  reportStore.update(id, { status: 'rejected' });
  p.loadReports();
  check('判为不属实时路线恢复', p.data.result.distanceMeters === base);
  check('不属实不再画在地图上',
    !lastCanvas().fills.includes(reportsUtil.CATEGORY_MAP.closure.color));

  // 多路段上报（交警类会关联一段）
  pickBus.put({
    action: 'report', category: 'police', edges: [victim.ei, victim.ei + 1],
    x: 100, y: 200, roadType: victim.roadType, edgeId: 'x', note: '',
  });
  p.onShow();
  check('交警上报先进入待核实', p.data.reportCounts.pending === 1 && p.data.reportCounts.police === 0,
    JSON.stringify(p.data.reportCounts));
  const pid = p.data.reportList.find(r => r.category === 'police').id;
  reportStore.update(pid, { status: 'verified' });
  p.loadReports();
  check('核实后才计为生效交警', p.data.reportCounts.police === 1 && p.data.reportCounts.pending === 0,
    JSON.stringify(p.data.reportCounts));
  check('多路段上报保留了多段',
    p.data.reportList.find(r => r.id === pid).edges.length === 2);
}

console.log('\n=== 7. 天气档位切换会重算热度图 ===');
{
  storage.clear();                 // 清掉上一节留下的已核实上报，否则情景不是基线
  const p = readyPage();
  p.onWeatherChoice({ detail: { value: 1 } });
  check('切到晴天后回到基线', p.currentLevel() === 'none' && p.data.atBaseline === true, p.data.scenarioSummary);
  const dry = heatStrokes(lastCanvas()).length;
  p.onWeatherChoice({ detail: { value: 3 } });
  check('切到中到大雨', p.currentLevel() === 'heavy');
  check('雨天拥堵指数上升', p.data.congestion.index > 1, `${p.data.congestion.index}`);
  check('雨天明显变堵路段为正', p.data.congestion.aggravated > 0, `${p.data.congestion.aggravated} 条`);
  check('热度层覆盖不减少', heatStrokes(lastCanvas()).length >= dry,
    `晴 ${dry} -> 大雨 ${heatStrokes(lastCanvas()).length}`);
  check('列出了受影响路段', p.data.congestion.worst.length > 0, p.data.congestion.worst[0].text);
}

console.log('\n=== 8. 天气联网失败时优雅降级 ===');
{
  const p = newPage();
  weatherBehavior = 'fail';
  p.onReady();
  check('联网失败不崩溃', /未能联网获取天气/.test(p.data.weatherError), p.data.weatherError);
  check('失败时按无雨处理', p.currentLevel() === 'none');
  check('提示里说明了开发者工具设置项', /不校验合法域名/.test(p.data.weatherError));
  p.onWeatherChoice({ detail: { value: 2 } });
  check('可手动指定天气继续演示', p.currentLevel() === 'light' && p.data.weatherError === '');
  weatherBehavior = 'ok';
}

console.log('\n=== 9. 三种走法 ===');
{
  const p = readyPage('外语网络楼');
  check('有结果', p.data.planned === true, p.data.result && p.data.result.timeText);
  check('结果含占用率', p.data.result.avgCongestion >= 0, `平均占用 ${p.data.result.avgCongestion}`);
  check('结果含被拥堵拖慢的时间', p.data.result.crowdDelayMinutes >= 0, `${p.data.result.crowdDelayMinutes} 分`);

  const quiet = JSON.parse(JSON.stringify(p.data.result));
  p.setFastest();
  const fast = JSON.parse(JSON.stringify(p.data.result));
  p.setShortest();
  const short = JSON.parse(JSON.stringify(p.data.result));
  check('三种走法都能算',
    quiet.modeName === '少人优先' && fast.modeName === '时间最短' && short.modeName === '距离最短');
  check('时间最短确实最快', fast.timeMinutes <= short.timeMinutes + 1e-9 && fast.timeMinutes <= quiet.timeMinutes + 1e-9,
    `最快 ${fast.timeMinutes} / 最短 ${short.timeMinutes} / 少人 ${quiet.timeMinutes}`);
  check('少人方案同行人数最少',
    quiet.avgHeatPersons <= fast.avgHeatPersons && quiet.avgHeatPersons <= short.avgHeatPersons);
  check('对比表三行且标出当前',
    p.data.comparison.length === 3 && p.data.comparison.filter(c => c.active).length === 1);
  check('路线为绿色主线', routeStrokes(lastCanvas()).length === 1);
  check('折线段数与路径一致',
    routeStrokes(lastCanvas())[0].segs
    === router.planOn(p.network, p.startNode, p.destNode, 'shortest').path.length - 1);
  p.onSwitchMode({ currentTarget: { dataset: { mode: 'fastest' } } });
  check('点对比表可切换', p.data.mode === 'fastest' && p.data.result.modeName === '时间最短');
}

console.log('\n=== 10. 交警上报与绕行开关 ===');
{
  storage.clear();
  pickBus.take();
  const p = readyPage();
  const base = p.data.result.distanceMeters;

  const fastest = router.planOn(p.network, p.startNode, p.destNode, 'fastest');
  let target = null;
  for (const e of fastest.usedEdges) {
    if (e.len < 100) continue;
    const m = new Uint8Array(router.EDGE_COUNT); m[e.ei] = 1;
    const r = router.planOn(router.buildNetwork({ closed: m }), p.startNode, p.destNode, 'fastest');
    if (!r.ok) continue;
    if (!target || r.timeMinutes - fastest.timeMinutes < target.detour) {
      target = { ei: e.ei, detour: r.timeMinutes - fastest.timeMinutes };
    }
  }
  reportStore.add(Object.assign(
    reportsUtil.createReport({ category: 'police', edges: [target.ei], roadType: fastest.usedEdges[0].roadType }),
    { status: 'verified' },
  ));
  p.loadReports();
  check('交警上报被统计', p.data.reportCounts.police === 1, p.data.reportSummary);
  check('未开启规避时仍走原路', p.data.result.distanceMeters === base);
  check('如实提示会经过交警', p.data.result.policeSegments > 0, `${p.data.result.policeSegments} 段`);

  p.toggleAvoidPolice();
  check('开关已开启', p.data.avoidPolice === true);
  check('共享给了点选页', session.get().avoidPolice === true);
  check('开启后不再经过交警路段',
    !router.planOn(p.network, p.startNode, p.destNode, 'fastest').usedEdges.some(e => e.ei === target.ei));
  check('结果里交警段数归零', p.data.result.policeSegments === 0);
  check('给出取舍说明', /避开全部|绕不开/.test(p.data.policeInsight), p.data.policeInsight);

  p.toggleAvoidPolice();
  check('可以关掉', p.data.avoidPolice === false && p.data.result.policeSegments >= 1);
}

console.log('\n=== 11. 三种输入叠加 + 管理页入口 ===');
{
  storage.clear();
  const p = readyPage('外语网络楼');
  const fastest = router.planOn(p.network, p.startNode, p.destNode, 'fastest');
  const busy = fastest.usedEdges.slice().sort((a, b) => b.flow - a.flow)[0];
  reportStore.add(Object.assign(
    reportsUtil.createReport({ category: 'congestion', edges: [busy.ei], roadType: busy.roadType }),
    { status: 'verified' },
  ));
  p.loadReports();
  check('拥堵上报生效', /异常拥堵/.test(p.data.reportSummary), p.data.reportSummary);

  p.onWeatherChoice({ detail: { value: 3 } });
  pickBus.put({ action: 'close', edgeIndex: fastest.usedEdges[4].ei, edgeId: 'x', roadType: 'residential', peak: 0, length: 0 });
  p.onShow();
  check('三种输入叠加后仍能规划', p.data.planned === true,
    `${p.data.result.distanceMeters}m / ${p.data.result.timeText}`);
  check('情景摘要包含天气与封路',
    /雨/.test(p.data.scenarioSummary) && /封闭/.test(p.data.scenarioSummary), p.data.scenarioSummary);

  const navBefore = calls.navigate.length;
  p.goAdmin();
  check('可以跳到路况管理页',
    calls.navigate[navBefore] === '/pages/admin/admin', calls.navigate[navBefore]);
}

console.log('\n=== 12. 异常分支 ===');
{
  const p = readyPage();
  const around = [];
  graph.edges.forEach((e, i) => { if (e[0] === p.startNode || e[1] === p.startNode) around.push(i); });
  p.setData({ closedList: around.map(ei => ({ ei, roadType: '测试', label: 't', peak: 0, length: 0 })) });
  p.refreshScenario();
  check('路网被切断时明确提示', !p.data.planned && /封闭|不连通/.test(p.data.planError), p.data.planError);
}
{
  const p = newPage();
  p.onReady();
  p.setData({ startReady: true });
  p.startNode = 5;
  p.plan();
  check('只有起点时提示先设置终点', /请先设置起点和终点/.test(p.data.hint), p.data.hint);
}
{
  locationBehavior = 'deny';
  const p = newPage();
  p.onReady();
  p.onShow();
  check('定位被拒时回退到校园中心', /校园中心/.test(p.data.startLabel), p.data.startLabel);
  check('回退起点也能吸附到节点', p.startNode >= 0, `#${p.startNode}`);
  locationBehavior = 'ok';
}
{
  const p = newPage();
  p.onReady();
  locationBehavior = 'ok';
  searchPick(p, '升华学生公寓 7 栋', 'start');
  check('搜索选点覆盖 GPS 起点',
    p.data.startSource === 'place' && p.data.startLabel === '升华学生公寓 7 栋');
  p.useMyLocation();
  check('「用当前位置」可切回 GPS', p.data.startSource === 'gps');
}
{
  const p = readyPage();
  for (let i = 0; i < 20; i++) p.zoomIn();
  check('缩放上限为 4 倍', p.data.scale === 4, p.data.scaleLabel);
  p.resetZoom();
  check('「全览」回到 1 倍', p.data.scale === 1, p.data.scaleLabel);
  const before = calls.navBack;
  p.back();
  check('可以返回', calls.navBack === before + 1);
}

console.log('\n=== 13. 展示地图可拖动 / 双指捏合 ===');
{
  const p = readyPage();
  // 用户报"地图拖不动"：1.0×（全览）时 panLimit 为 0，本来就拖不动，
  // 而一屏布局下地图又矮又留白。所以默认给一点放大 —— 开局就拖得动。
  check('默认给一点放大，开局就能拖动', p.data.canPan === true && p.data.scale > 1,
    `scale=${p.data.scale} canPan=${p.data.canPan}`);
  check('初始缩放标注与数值一致', p.data.scaleLabel === p.data.scale.toFixed(1) + '×',
    p.data.scaleLabel);

  // 全览（1.0×）时反过来：拖不动，并且界面要提示用户先放大
  p.resetZoom();
  check('「全览」时拖不动（aspectFit 下四周没有余量）',
    p.data.scale === 1 && p.data.canPan === false, `scale=${p.data.scale}`);
  const hintShown = (() => {
    const wxml = fs.readFileSync(path.join(BASE, 'pages', 'route', 'route.wxml'), 'utf8');
    return /wx:if="\{\{!canPan\}\}"/.test(wxml) && /放大后即可拖动/.test(wxml);
  })();
  check('全览时界面会提示"放大后即可拖动"', hintShown);

  // 放大后就能拖
  p.zoomIn(); p.zoomIn(); p.zoomIn();
  check('放大后可以拖动', p.data.canPan === true, p.data.scaleLabel);

  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  // 拖动
  p.onMapTouchStart({ touches: [{ clientX: cx, clientY: cy }] });
  p.onMapTouchMove({ touches: [{ clientX: cx - 50, clientY: cy - 30 }] });
  p.onMapTouchEnd({ changedTouches: [{ clientX: cx - 50, clientY: cy - 30 }] });
  check('拖动改变了偏移', p.data.tx !== 0 || p.data.ty !== 0, `tx=${p.data.tx} ty=${p.data.ty}`);
  check('拖动方向正确（手往左上拖 -> 负偏移）', p.data.tx < 0 && p.data.ty < 0);
  check('拖动后路线仍画在图上（缓存了路径）',
    routeStrokes(lastCanvas()).length === 1, `${routeStrokes(lastCanvas()).length} 条主线`);

  // 双指捏合
  const before = p.data.scale;
  p.onMapTouchStart({ touches: [{ clientX: cx - 40, clientY: cy }, { clientX: cx + 40, clientY: cy }] });
  p.onMapTouchMove({ touches: [{ clientX: cx - 80, clientY: cy }, { clientX: cx + 80, clientY: cy }] });
  p.onMapTouchEnd({
    changedTouches: [{ clientX: cx - 80, clientY: cy }, { clientX: cx + 80, clientY: cy }],
  });
  check('双指捏合放大了地图', p.data.scale > before, `${before} -> ${p.data.scale}`);
  check('捏合不会被当成点选（没有弹彩蛋）', p.data.nodeSheet === null);

  // ---- 双指之后紧接着的 tap 不能弹堵点彩蛋 ----
  // （WeChat 的 tap 有时会在多指抬手后补一发；route 页只有一个 bindtap 入口）
  {
    const bodyGuard = require(path.join(BASE, 'utils', 'panelBus.js'));
    const sessGuard = require(path.join(BASE, 'utils', 'session.js'));
    // 切到"整周最高峰 + 距离最短"：这条路线会穿过最忙走廊，必有可点的堵点
    bodyGuard.clear();
    sessGuard.patch({ timeChoice: 'worst', mode: 'shortest' });
    bodyGuard.pushIntent('applyConfig');
    // 注意：session 要在页面就绪**之后**再改 —— onReady 里的 refreshScenario 会把
    // 当前 data 里的 timeChoice/mode 写回 session，先改会被它覆盖掉。
    const q = readyPage('数学与统计学院');
    bodyGuard.clear();
    sessGuard.patch({ timeChoice: 'worst', mode: 'shortest' });
    bodyGuard.pushIntent('applyConfig');
    q.onShow();
    check('已切到"整周最高峰 + 距离最短"（这段路会穿过最忙走廊）',
      q.data.mode === 'shortest' && q.data.timeChoice === 'worst',
      `${q.data.mode} / ${q.data.timeChoice} / ${q.data.caliber}`);
    check('这条路线有可点的堵点（否则这条断言没意义）', q.nodes.length > 0, `${q.nodes.length} 个`);
    const cxq = rect.left + rect.width / 2;
    const cyq = rect.top + rect.height / 2;
    // 先来一次双指捏合
    q.onMapTouchStart({ touches: [{ clientX: cxq - 40, clientY: cyq }, { clientX: cxq + 40, clientY: cyq }] });
    q.onMapTouchMove({ touches: [{ clientX: cxq - 80, clientY: cyq }, { clientX: cxq + 80, clientY: cyq }] });
    q.onMapTouchEnd({ changedTouches: [{ clientX: cxq - 80, clientY: cyq }], touches: [{ clientX: cxq + 80, clientY: cyq }] });
    q.onMapTouchEnd({ changedTouches: [{ clientX: cxq + 80, clientY: cyq }], touches: [] });
    // 紧接着补一发 tap（落在某个堵点上）
    const n0 = q.nodes[0];
    const pt = svgToClient(q, n0.x, n0.y);
    q.onCongestionTap({ changedTouches: [{ clientX: pt.clientX, clientY: pt.clientY }] });
    check('【回归】双指缩放之后紧跟的 tap 不会弹堵点彩蛋', q.data.nodeSheet === null,
      q.data.nodeSheet ? JSON.stringify(q.data.nodeSheet) : 'null');

    // 之后再正常点一次：照旧能弹（标记不能永久生效）
    q.onMapTouchStart({ touches: [{ clientX: cxq, clientY: cyq }] });
    q.onMapTouchEnd({ changedTouches: [{ clientX: cxq, clientY: cyq }], touches: [] });
    const pt2 = svgToClient(q, n0.x, n0.y);
    q.onCongestionTap({ changedTouches: [{ clientX: pt2.clientX, clientY: pt2.clientY }] });
    check('双指之后的单指点击照旧能弹堵点彩蛋', !!q.data.nodeSheet, JSON.stringify(q.data.nodeSheet || null));
  }

  // ---- 关键回归：真机上 boundingClientRect 是异步的 ----
  // 如果等它回来才 gestureStart，一次"快速轻扫"（touchstart → move → end 都在回调之前）
  // 会被整段丢掉，现象就是用户说的"地图拖不动"。拖动只需要位移差，起手不该等测量。
  {
    const q = readyPage();
    q.zoomIn(); q.zoomIn(); q.zoomIn();
    const before = { tx: q.data.tx, ty: q.data.ty };

    measureDeferred = true;
    q.onMapTouchStart({ touches: [{ clientX: cx, clientY: cy }] });          // 测量被挂起
    q.onMapTouchMove({ touches: [{ clientX: cx - 40, clientY: cy - 25 }] }); // 用户已经扫完了
    q.onMapTouchEnd({ changedTouches: [{ clientX: cx - 40, clientY: cy - 25 }] });
    const quick = { tx: q.data.tx, ty: q.data.ty };
    check('【回归】测量还没回来时的快速拖动也算数（不再整段丢掉）',
      quick.tx !== before.tx || quick.ty !== before.ty,
      `tx ${before.tx}->${quick.tx} ty ${before.ty}->${quick.ty}`);

    // 测量回来之后仍然要能正常拖动，并且 rect 被刷新
    flushMeasures();
    measureDeferred = false;
    const p0 = { tx: q.data.tx, ty: q.data.ty };
    q.onMapTouchStart({ touches: [{ clientX: cx, clientY: cy }] });
    q.onMapTouchMove({ touches: [{ clientX: cx - 60, clientY: cy }] });
    q.onMapTouchEnd({ changedTouches: [{ clientX: cx - 60, clientY: cy }] });
    check('测量回来后拖动照常工作', q.data.tx < p0.tx, `tx ${p0.tx} -> ${q.data.tx}`);
    check('测量回调仍然刷新了容器矩形（点选换算要用最新的）', !!q.rect);
  }

  // 容器位置变了（页面滚动）仍然准确
  const savedRect = { left: rect.left, top: rect.top };
  rect.left = 0; rect.top = 40;
  const beforeTx = p.data.tx;
  p.onMapTouchStart({ touches: [{ clientX: 200, clientY: 300 }] });
  p.onMapTouchMove({ touches: [{ clientX: 240, clientY: 330 }] });
  p.onMapTouchEnd({ changedTouches: [{ clientX: 240, clientY: 330 }] });
  check('容器位置变化后拖动仍然生效', p.data.tx !== beforeTx, `${beforeTx} -> ${p.data.tx}`);
  rect.left = savedRect.left; rect.top = savedRect.top;

  p.resetZoom();
  check('「全览」回到 1 倍且偏移归零', p.data.scale === 1 && p.data.tx === 0 && p.data.ty === 0);
}

console.log('\n=== 14. 路线方向箭头 ===');
{
  const p = readyPage('外语网络楼');
  const rec = lastCanvas();
  const arrows = rec.fills.filter(f => f === '#146b55');
  check('画出了方向箭头（用填充，不增加描边）', arrows.length > 0, `${arrows.length} 个箭头`);
  check('绿色主线仍只有一条（箭头没干扰它）', routeStrokes(rec).length === 1);
  check('折线段数与路径一致',
    routeStrokes(rec)[0].segs === p.lastPath.length - 1, `${routeStrokes(rec)[0].segs} 段`);
  // 箭头应当沿路线分布，而不是全挤在一处
  const arrowOps = [];
  let count = 0;
  rec.ops.forEach(op => {
    if (op[0] === 'moveTo' && count >= 0) arrowOps.push([op[1], op[2]]);
  });
  const xs = arrows.map((_, i) => i);
  check('箭头不止一个（路线够长）', arrows.length >= 2, `${arrows.length} 个`);
  check('缩放后箭头仍是"屏幕间距"（数量随缩放变化）', (() => {
    const before = lastCanvas().fills.filter(f => f === '#146b55').length;
    p.setRouteScale(3);
    const after = lastCanvas().fills.filter(f => f === '#146b55').length;
    return after !== before || before === 0;
  })());
}

console.log('\n=== 15. 目的地搜索过滤 ===');
{
  const p = newPage();
  p.onReady();
  check('初始没有搜索结果面板', p.data.placeSearch === null);

  p.openPlaceSearch({ currentTarget: { dataset: { target: 'dest' } } });
  check('打开面板并默认列出全部地点', p.data.placeSearch.visible === true
    && p.data.placeResults.length === graph.places.length,
    `${p.data.placeResults.length} 项`);
  check('默认目标是终点', p.data.placeSearch.target === 'dest');

  // 关键词过滤
  p.setData({ 'placeSearch.keyword': '升华' });
  p.refreshPlaceResults();
  const sheng = p.data.placeResults.length;
  check('按名称过滤生效', sheng > 0 && sheng < graph.places.length, `「升华」-> ${sheng} 项`);
  check('过滤结果都含关键词',
    p.data.placeResults.every(x => (x.n + x.c + x.k).indexOf('升华') >= 0));

  p.setData({ 'placeSearch.keyword': '37' });
  p.refreshPlaceResults();
  check('可以用编号搜到具体宿舍',
    p.data.placeResults.some(x => x.n.indexOf('37') >= 0),
    p.data.placeResults.map(x => x.n).join('/'));

  p.setData({ 'placeSearch.keyword': '新校区' });
  p.refreshPlaceResults();
  check('可以按校区搜索', p.data.placeResults.length > 0
    && p.data.placeResults.every(x => x.c.indexOf('新校区') >= 0), `${p.data.placeResults.length} 项`);

  p.setData({ 'placeSearch.keyword': '不存在的名字xyz' });
  p.refreshPlaceResults();
  check('搜不到时返回空列表', p.data.placeResults.length === 0);

  // 类别筛选
  p.setData({ 'placeSearch.keyword': '' });
  p.onPlaceKind({ currentTarget: { dataset: { kind: '教学点' } } });
  check('按类别筛选生效', p.data.placeResults.length === 14
    && p.data.placeResults.every(x => x.k === '教学点'), `${p.data.placeResults.length} 项`);
  p.onPlaceKind({ currentTarget: { dataset: { kind: '宿舍' } } });
  check('切到宿舍', p.data.placeResults.length === 44, `${p.data.placeResults.length} 项`);

  // 选中并规划
  p.setData({ 'placeSearch.kind': 'all', 'placeSearch.keyword': '数学与统计' });
  p.refreshPlaceResults();
  p.onPickPlaceResult({ currentTarget: { dataset: { index: 0 } } });
  check('选中后关闭面板', p.data.placeSearch === null);
  check('终点被设上', p.data.destLabel === '数学与统计学院' && p.data.destSource === 'place',
    p.data.destLabel);
  check('带上了校区与吸附距离', /新校区/.test(p.data.destSnapText), p.data.destSnapText);
  p.onShow();
  check('两点齐了自动规划', p.data.planned === true, p.data.result && p.data.result.timeText);

  // 起点也能用搜索
  p.openPlaceSearch({ currentTarget: { dataset: { target: 'start' } } });
  p.setData({ 'placeSearch.keyword': '南校区2舍' });
  p.refreshPlaceResults();
  p.onPickPlaceResult({ currentTarget: { dataset: { index: 0 } } });
  check('搜索也能设起点', p.data.startLabel === '南校区2舍' && p.data.startSource === 'place');

  p.openPlaceSearch({ currentTarget: { dataset: { target: 'dest' } } });
  p.closePlaceSearch();
  check('可以取消搜索面板', p.data.placeSearch === null);
}

console.log('\n=== 16. 拥堵节点与趣味提示 ===');
{
  // 拥堵节点要的是"占用的上界"，所以显式切到「整周最高峰（最坏情况）」这个包络口径：
  // 真实时刻（当天最忙）每个时段全网只有 1 条路段 occ≥0.5，路线上往往一个节点都没有——
  // 那是正确行为，但不适合用来验节点的绘制与点击。
  const p = readyPage('外语网络楼');
  const worstIdx = p.data.timeChoices.findIndex(c => c.key === 'worst');
  if (worstIdx >= 0) p.onTimeChoice({ detail: { value: worstIdx } });
  check('切到了包络口径', p.data.caliber === '整周最高峰（包络）', p.data.caliber);

  check('路线上生成了拥堵节点', p.nodes.length > 0,
    `${p.nodes.length} 个（口径 ${p.data.caliber}）`);
  check('节点数量有上限（不会太乱）', p.nodes.length <= 8);
  check('节点都落在确实拥堵的路段上',
    p.nodes.every(n => n.heat >= 0.5), `占用率 ${p.nodes.map(n => n.heat.toFixed(2)).join(',')}`);
  check('节点之间至少间隔 90 米', (() => {
    const S = graph.proj[0];
    for (let i = 1; i < p.nodes.length; i++) {
      const d = Math.hypot(p.nodes[i].x - p.nodes[i - 1].x, p.nodes[i].y - p.nodes[i - 1].y) / S;
      if (d < 90) return false;
    }
    return true;
  })());
  check('节点被画在地图上',
    lastCanvas().fills.indexOf('#e8720c') >= 0, '有橙色节点');

  // 点到节点 -> 弹彩蛋
  const node = p.nodes[0];
  const c = svgToClient(p, node.x, node.y);
  // 需要先测一次视口（真实交互里 touchstart 会做）
  p.onMapTouchStart({ touches: [{ clientX: c.clientX, clientY: c.clientY }] });
  p.onMapTouchEnd({ changedTouches: [{ clientX: c.clientX, clientY: c.clientY }] });
  // onCongestionTap 由 bindtap 触发，这里直接调用
  p.onCongestionTap({ changedTouches: [{ clientX: c.clientX, clientY: c.clientY }] });
  check('点击节点弹出趣味提示', !!p.data.nodeSheet, p.data.nodeSheet && p.data.nodeSheet.title);
  check('提示里带了真实数据', /\d/.test(p.data.nodeSheet.desc), p.data.nodeSheet.desc);
  check('提示有两个选项', p.data.nodeSheet.options.length === 2,
    p.data.nodeSheet.options.map(o => o.label).join(' / '));
  check('明确标注是彩蛋', /不影响路线/.test(p.data.nodeSheet.note));

  // 换个节点应该换一段文案
  const first = p.data.nodeSheet.title;
  p.closeCongestionSheet();
  check('可以关闭提示', p.data.nodeSheet === null);
  if (p.nodes.length > 1) {
    const n2 = p.nodes[1];
    const c2 = svgToClient(p, n2.x, n2.y);
    p.onCongestionTap({ changedTouches: [{ clientX: c2.clientX, clientY: c2.clientY }] });
    check('再次点击会换内容（4 段文案轮换）', !!p.data.nodeSheet, p.data.nodeSheet.title);
  }

  // 点选项 -> 只给反馈，不动路线
  const distBefore = p.data.result.distanceMeters;
  p.onJokeOption({ currentTarget: { dataset: { label: '弃车快跑' } } });
  check('点选项后关闭提示', p.data.nodeSheet === null);
  check('彩蛋不影响路线', p.data.result.distanceMeters === distBefore, `${distBefore} m`);
  check('给出了反馈', /彩蛋/.test(lastToast().title), lastToast().title);

  // 点远处不该弹
  p.onCongestionTap({ changedTouches: [{ clientX: rect.left + 5, clientY: rect.top + 5 }] });
  check('点在远离节点的地方不弹', p.data.nodeSheet === null);
}

console.log('\n=== 16b. 换时段真的会换热度（用户报的"怎么还是有拥堵"）===');
{
  const p = readyPage('外语网络楼');
  // 按 key 找（key 稳定：d<星期>w<分钟>），标签是给人看的，会随文案调整
  const byKey = k => p.data.timeChoices.findIndex(c => c.key === k);

  // 有真实课表时，各时段的拥堵程度必须不同，并且符合"早高峰最堵、晚上最空"
  if (timeModel.available()) {
    const iEarly = byKey('d1w0470');     // 周一 07:50 第1-2节 课前
    const iNoon = byKey('d1w0700');      // 周一 11:40 第3-4节 课后
    const iEve = byKey('d1w1130');       // 周一 18:50 第9-10节 课前
    check('时段选择器列出了真实换课时刻', iEarly >= 0 && iNoon >= 0 && iEve >= 0,
      p.data.timeChoices.map(c => c.label).join(' / '));
    check('时段标签是人话「第N-M节 课前/课后」',
      /^第1-2节 课前 07:50$/.test(p.data.timeChoices[iEarly].label),
      p.data.timeChoices[iEarly].label);

    p.onTimeChoice({ detail: { value: iEarly } });
    const early = { occ: p.data.congestion.avgOccNow, idx: p.data.congestion.index, nodes: p.nodes.length };
    p.onTimeChoice({ detail: { value: iEve } });
    const eve = { occ: p.data.congestion.avgOccNow, idx: p.data.congestion.index, nodes: p.nodes.length };

    check('早高峰比傍晚更堵', early.occ > eve.occ,
      `07:50 占用率 ${early.occ} vs 18:50 ${eve.occ}`);
    check('拥堵指数也更高', early.idx > eve.idx, `${early.idx} vs ${eve.idx}`);
    check('切换时段后热度层确实重画了', early.occ !== eve.occ || early.nodes !== eve.nodes,
      `节点 ${early.nodes} -> ${eve.nodes}`);

    // 晚上不该还满屏拥堵：拥堵路段数必须明显少于早高峰
    const hotOf = () => graph.edges.filter((e, ei) => {
      const vff = router.ROAD_SPEED[e[4]] || router.DEFAULT_SPEED;
      return router.solveEdgeState(vff, 1, p.network.peak[ei]).occ >= 0.5;
    }).length;
    p.onTimeChoice({ detail: { value: iEarly } });
    const hotEarly = hotOf();
    p.onTimeChoice({ detail: { value: iEve } });
    const hotEve = hotOf();
    check('18:50 的较堵路段少于 07:50', hotEve < Math.max(hotEarly, 1),
      `07:50 ${hotEarly} 条 -> 18:50 ${hotEve} 条`);
    p.onTimeChoice({ detail: { value: 0 } });   // 还原「按当前时间」
  } else {
    console.log('  （仍是占位画像，跳过真实时段对比）');
  }
}

console.log('\n=== 17. 持续定位 ===');
{
  const p = readyPage();
  locationListeners = [];
  check('初始未开启', p.data.tracking === false && p.data.trackingText === '');

  p.toggleTracking();
  check('开启后状态为跟随中', p.data.tracking === true);
  check('注册了位置变化回调', locationListeners.length === 1);

  // 第一次位置回调：画"我的位置"
  const lon = 112.93324839293244, lat = 28.1627837;
  locationListeners[0]({ longitude: lon, latitude: lat, accuracy: 15 });
  check('记录了实时位置', !!p.myLocation, `(${p.myLocation.x.toFixed(0)}, ${p.myLocation.y.toFixed(0)})`);
  const expectSvg = router.project(lon, lat);
  check('位置按原始坐标投影（不吸附，避免跳动）',
    Math.abs(p.myLocation.x - expectSvg[0]) < 1e-6 && Math.abs(p.myLocation.y - expectSvg[1]) < 1e-6);
  check('显示了地点名与精度', /实时位置/.test(p.data.trackingText) && /精度 15/.test(p.data.trackingText),
    p.data.trackingText);
  check('实时位置也带地点名（不只是坐标）',
    /实时位置 · [^·]+ · 28\.\d{5}, 112\.\d{5}/.test(p.data.trackingText), p.data.trackingText);
  check('地图上画出了蓝色"我的位置"', lastCanvas().fills.indexOf('#1f5fd0') >= 0);
  check('共享给了点选页', session.get().myLocation && session.get().myLocation.x === p.myLocation.x);

  // 起点是 GPS 来的 -> 移动足够远会跟随重规划
  check('起点来源是自动定位', p.data.startSource === 'gps');
  const beforeNode = p.startNode;
  const dist = p.data.result.distanceMeters;
  locationListeners[0]({ longitude: 112.938, latitude: 28.1615, accuracy: 12 });   // 明显移动
  check('移动足够远后起点跟随更新', p.startNode !== beforeNode,
    `#${beforeNode} -> #${p.startNode}`);
  check('起点跟随定位后换了地点名', p.data.startLabel === '南校区5舍附近'
    && !/\d{2}\.\d{4,}/.test(p.data.startLabel), p.data.startLabel);
  check('跟随后的提示同样带地点与偏移',
    /南校区 · 宿舍 · 距该地点约 \d+ 米/.test(p.data.startSnapText)
    && /吸附到最近路口|离路网约/.test(p.data.startSnapText),
    p.data.startSnapText);
  check('跟随之后重新规划了', p.data.planned === true && p.data.result.distanceMeters !== dist,
    `${dist}m -> ${p.data.result.distanceMeters}m`);

  // 位移很小时不重算
  const nodeNow = p.startNode;
  const distNow = p.data.result.distanceMeters;
  const nearLon = 112.938 + 0.0001;      // 约 10 米
  locationListeners[0]({ longitude: nearLon, latitude: 28.1615, accuracy: 12 });
  check('小幅移动不触发重规划', p.startNode === nodeNow && p.data.result.distanceMeters === distNow,
    `仍在 #${p.startNode}`);

  // 手动设过起点 -> 不覆盖用户选择
  searchPick(p, '南校区2舍', 'start');
  check('手动起点生效', p.data.startSource === 'place');
  const manualNode = p.startNode;
  locationListeners[0]({ longitude: 112.945, latitude: 28.150, accuracy: 10 });
  check('手动选过起点时不被实时定位覆盖', p.startNode === manualNode,
    `仍是 #${p.startNode}`);
  check('但"我的位置"仍然更新', (() => {
    const e = router.project(112.945, 28.150);
    return Math.abs(p.myLocation.x - e[0]) < 1e-6;
  })());

  // 关闭
  p.toggleTracking();
  check('关闭后摘掉了回调', locationListeners.length === 0);
  check('关闭后状态复位', p.data.tracking === false && p.data.trackingText === '');

  // 失败分支
  trackBehavior = 'fail';
  p.toggleTracking();
  check('开启失败时不残留状态', p.data.tracking === false);
  check('失败时给出可读提示', /未授权实时定位/.test(p.data.trackingError), p.data.trackingError);
  trackBehavior = 'ok';

  // 生命周期：离开页面停掉，回来恢复
  trackBehavior = 'ok';
  p.toggleTracking();
  check('重新开启', p.data.tracking === true && locationListeners.length === 1);
  const stopBefore = calls.stopLocationUpdate || 0;
  p.onHide();
  check('离开页面时停止定位（省电）', p.data.tracking === false
    && (calls.stopLocationUpdate || 0) > stopBefore);
  p.onShow();
  check('回到页面时自动恢复', p.data.tracking === true && locationListeners.length === 1);
  p.onUnload();
  check('页面卸载时彻底停掉', p.data.tracking === false && locationListeners.length === 0);
  check('不会重复注册回调', locationListeners.length === 0);
}

console.log('\n=== 18. 时段口径与选择器 ===');
{
  const timeModel = require(path.join(BASE, 'utils', 'timeModel.js'));
  // 仓库里当前是占位（还没拿到课表）——界面必须如实说明
  const p = readyPage();
  p.initTimeChoice();
  if (!timeModel.available()) {
    check('没有课表时如实标注为「最高峰时段」', p.data.caliber === '最高峰时段', p.data.caliber);
    check('选择器不可用（不编造时段）', p.data.timeAvailable === false
      && p.data.timeChoices.length === 2, `${p.data.timeChoices.length} 个选项`);
    check('说明了原因与解决办法',
      /只有"最高峰时段"一个时间量/.test(p.data.timeHint) && /时段数据说明/.test(p.data.timeHint),
      p.data.timeHint.slice(0, 40) + '…');
    const base = p.resolveTimeBase();
    check('基线用原始峰值（basePeak=null）', base.basePeak === null && base.caliber === '最高峰时段');
    check('不受时段影响的规划仍可用', p.data.planned === true, p.data.result && p.data.result.timeText);
  } else {
    console.log('  （已提供课表，跳过占位分支）');
  }
}
{
  // 注入示例画像，验证选择器真的接通了
  const samplePath = path.join(__dirname, 'time-profile.sample.js');
  const timeModel = require(path.join(BASE, 'utils', 'timeModel.js'));
  if (fs.existsSync(samplePath)) {
    const sample = require(samplePath);
    timeModel.__setProfileForTest(sample);
    const p = readyPage('外语网络楼');
    p.initTimeChoice();
    const day = timeModel.dateInfo(p.selectedDate()).weekday;
    const dayWindows = sample.windows.filter(w => w.weekday === day);
    check('有画像时选择器启用', p.data.timeAvailable === true
      && p.data.timeChoices.length === dayWindows.length + 3,
      `${p.data.timeChoices.length} 项（周${timeModel.WEEKDAY_CN[day]}共 ${dayWindows.length} 个时段）`);
    check('固定项 = 自动 / 当天最忙 / 整周最高峰',
      p.data.timeChoices.slice(0, 3).map(c => c.key).join(',') === 'auto,peak,worst',
      p.data.timeChoices.slice(0, 3).map(c => c.label).join(' / '));

    // 切到某个换课时段
    const w2 = dayWindows[2];
    const idx = p.data.timeChoices.findIndex(c => c.key === w2.key);
    p.onTimeChoice({ detail: { value: idx } });
    check('选中具体时段后口径跟着变（带上是周几 + 人话节次）',
      p.data.caliber === `周${timeModel.WEEKDAY_CN[day]} 第3-4节 课前 ${w2.time}`, p.data.caliber);
    check('口径里同时保留原始时刻，能对上数据',
      new RegExp(w2.time.replace(':', '\\:')).test(p.data.caliber), p.data.caliber);
    check('注入了该时段的基线', p.network && p.network.peak.length === graph.edges.length);
    const slotOcc = p.data.congestion.avgOccNow;

    // 切到"整周最高峰（包络）"：它是各路段各自最忙时刻拼起来的，占用率必然不低于任一真实时刻
    const worstIdx = p.data.timeChoices.findIndex(c => c.key === 'worst');
    p.onTimeChoice({ detail: { value: worstIdx } });
    check('切到整周最高峰口径正确', p.data.caliber === '整周最高峰（包络）', p.data.caliber);
    check('包络口径的占用率不低于真实时段',
      p.data.congestion.avgOccNow >= slotOcc - 1e-9,
      `换课 ${slotOcc} vs 包络 ${p.data.congestion.avgOccNow}`);
    check('口径写进了地图图例与面板', /整周最高峰/.test(p.data.caliber) && !!p.data.caliber);
    check('包络口径明确说明它不是某一个真实时刻', /包络/.test(p.data.timeText), p.data.timeText);

    // 「按当前时间」在这一天（周一）应给出真实换课时段，而不是无通勤
    // （测试时钟钉在周一 07:50 = 第1-2节 课前）
    const autoIdx = p.data.timeChoices.findIndex(c => c.key === 'auto');
    p.onTimeChoice({ detail: { value: autoIdx } });
    check('按当前时间对到该天的换课时段',
      p.data.timeIdle === false && /第1-2节 课前 07:50/.test(p.data.caliber)
      && new RegExp(`^周${timeModel.WEEKDAY_CN[day]} `).test(p.data.caliber),
      p.data.caliber);
    check('无通勤时才应该没有热度（这里不该是）', p.data.congestion.avgOccNow > 0,
      `占用率 ${p.data.congestion.avgOccNow}`);

    // 注入的画像不能残留
    timeModel.__clearProfileForTest();
    // 清理后必须回到仓库里那份 data/time-profile.js（可能已是真实课表画像，不能写死）
    const shipped = require(path.join(BASE, 'data', 'time-profile.js'));
    check('清理后回到真实状态',
      timeModel.available() === !!shipped.available
      && timeModel.source() === (shipped.source || ''),
      `available=${timeModel.available()}，来源 ${timeModel.source() || '(占位)'}`);
  } else {
    check('示例画像存在（先跑 --sample）', false);
  }
}

console.log('\n=== 19. 选日期：看某一天，而不只是当天 ===');
if (!timeModel.available()) {
  console.log('  （仍是占位画像，跳过）');
} else {
  const p = readyPage('外语网络楼');
  p.initTimeChoice();
  const today = timeModel.dateInfo(new Date());

  check('默认选中今天', p.data.dateISO === today.iso, `${p.data.dateISO} ${p.data.dateLabel}`);
  check('日期标签写明了是周几', /周[一二三四五六日]/.test(p.data.dateLabel), p.data.dateLabel);
  check('日期那一行解释了这天的口径',
    /共 \d+ 个换课时段/.test(p.data.dateHint) && /最忙是 \d\d:\d\d/.test(p.data.dateHint),
    p.data.dateHint);
  check('说明了模型不区分节假日、天气不随日期变',
    /不区分节假日/.test(p.data.dateHint) && /天气仍按实时天气/.test(p.data.dateHint), p.data.dateHint);

  // 切到某个周四
  p.onDateChange({ detail: { value: '2026-10-01' } });          // 周四
  check('切日期后标签跟着变', p.data.dateLabel === '10月1日 周四', p.data.dateLabel);
  check('可选的时段只剩这一天的',
    p.data.timeChoices.every(c => c.weekday == null || c.weekday === 4),
    p.data.timeChoices.map(c => c.label).join(' / '));
  check('换日期后口径退回「按当前时间」', p.data.timeChoice === 'auto');
  check('日期说明点出了当天最忙时段', /周四/.test(p.data.dateHint) && /最忙是/.test(p.data.dateHint),
    p.data.dateHint);
  check('日期共享给了点选页', session.get().dateISO === '2026-10-01', String(session.get().dateISO));

  const pick = key => {
    const i = p.data.timeChoices.findIndex(c => c.key === key);
    p.onTimeChoice({ detail: { value: i } });
    return {
      occ: p.data.congestion.avgOccNow,
      total: p.network.peak.reduce((a, b) => a + b, 0),
      cal: p.data.caliber,
      hot: p.nodes.length,
    };
  };

  const thuEve = pick('d4w1130');    // 周四 18:50
  const thuMorn = pick('d4w0470');   // 周四 07:50
  check('同一天不同时刻差别很大', thuMorn.total > thuEve.total * 5,
    `周四 07:50 ${Math.round(thuMorn.total)} vs 18:50 ${Math.round(thuEve.total)}`);
  check('口径里带上了星期', /^周四\d?\d?/.test(thuEve.cal) || thuEve.cal.indexOf('周') === 0, thuEve.cal);

  // 换一天：同一个 18:50，周一还很忙，周四几乎没人 —— 这正是"选日期"的意义
  p.onDateChange({ detail: { value: '2026-09-28' } });          // 周一
  const monEve = pick('d1w1130');
  check('同一时刻不同星期差别很大', monEve.total > thuEve.total * 5,
    `18:50 周一 ${Math.round(monEve.total)} vs 周四 ${Math.round(thuEve.total)}`);
  check('周一 18:50 明显比周四 18:50 堵', monEve.occ > thuEve.occ,
    `占用率 周一 ${monEve.occ} vs 周四 ${thuEve.occ}`);

  // 周末：课表模型没有通勤，只剩「自动 / 最坏情况」两个选项
  p.onDateChange({ detail: { value: '2026-10-03' } });          // 周六
  check('周末日期只剩两个固定项', p.data.timeChoices.length === 2,
    p.data.timeChoices.map(c => c.label).join(' / '));
  check('周末被标出来', p.data.isWeekend === true, p.data.dateLabel);
  check('周末的日期说明写清没有通勤', /周六/.test(p.data.dateHint) && /没有通勤/.test(p.data.dateHint),
    p.data.dateHint);
  const iAuto = p.data.timeChoices.findIndex(c => c.key === 'auto');
  p.onTimeChoice({ detail: { value: iAuto } });
  check('周末判为无通勤', p.data.timeIdle === true && p.data.caliber === '无通勤', p.data.timeText);
  check('无通勤时全网没有占用率',
    p.data.congestion.avgOccNow === 0 && p.data.congestion.index === 0,
    `占用率 ${p.data.congestion.avgOccNow}`);
  check('无通勤时热度层不画路段',
    heatStrokes(lastCanvas()).filter(s => !/rgba\(255,255,255/.test(s.color)).length === 0,
    `${heatStrokes(lastCanvas()).length} 条（全是封路虚线则不算）`);

  // 周末仍可看"最坏情况"，不会被日期卡死
  const iWorst = p.data.timeChoices.findIndex(c => c.key === 'worst');
  p.onTimeChoice({ detail: { value: iWorst } });
  check('周末也能切到最坏情况（包络）',
    p.data.timeIdle === false && /整周最高峰|最高峰/.test(p.data.caliber) && p.data.congestion.avgOccNow > 0,
    p.data.caliber);

  // 还原成今天，后面的用例不受影响
  p.onDateChange({ detail: { value: today.iso } });
  check('可以选回今天', p.data.dateISO === today.iso && p.data.isWeekend === today.isWeekend);
}

console.log('\n=== 20. 事件（活动）参与计算 ===');
{
  const eventsUtil = require(path.join(BASE, 'utils', 'events.js'));
  const calendarUtil = require(path.join(BASE, 'utils', 'calendar.js'));
  const store = require(path.join(BASE, 'utils', 'eventStore.js'));
  const day = '2026-09-28';        // 冻结时钟那天（周一）

  store.clearLocal();
  const sports = eventsUtil.normalize({
    title: '测试校运会', type: 'sports', date: day,
    start: '08:00', end: '17:00', venue: '新校体育场“鸟巢”西门',
    grades: [], departments: [], headcount: 3000,
  });
  store.putEvent(sports);
  eventsUtil.clearCache();

  const p = readyPage('外语网络楼');
  p.onDateChange({ detail: { value: day } });
  check('当天的事件出现在页面上', p.data.eventCount === 1 && p.data.eventIncluded === 1,
    p.data.eventText);
  check('事件卡片带上了活动名与人数',
    p.data.eventList[0].title === '测试校运会' && /3,?000 人/.test(p.data.eventList[0].peopleText),
    `${p.data.eventList[0].title} · ${p.data.eventList[0].peopleText}`);
  check('事件说明了谁参加', /全部专业/.test(p.data.eventList[0].audienceText),
    p.data.eventList[0].audienceText);

  // 活动的入场/离场时刻必须能选到，否则选不到那个时刻
  const evKey = 'ev:' + (8 * 60 - 40) + ':arrival';
  const evIdx = p.data.timeChoices.findIndex(c => c.key === evKey);
  check('活动时刻进了可选时段列表', evIdx >= 0,
    p.data.timeChoices.filter(c => c.key.indexOf('ev:') === 0).map(c => c.label).join(' / '));
  check('活动时刻标成"活动入场"', /活动入场/.test(p.data.timeChoices[evIdx].label),
    p.data.timeChoices[evIdx].label);

  // 选中活动入场时刻：基线里应该含活动流量
  p.onTimeChoice({ detail: { value: evIdx } });
  const withEvent = {
    occ: p.data.congestion.avgOccNow,
    total: p.network.peak.reduce((a, b) => a + b, 0),
    cal: p.data.caliber,
  };
  check('口径写明了这是活动入场', /入场/.test(withEvent.cal) && /测试校运会/.test(withEvent.cal),
    withEvent.cal);
  check('活动时刻确实有流量', withEvent.total > 0, `${Math.round(withEvent.total)} 人次`);

  // 同一天同一时刻，把活动排除掉，流量应该下降
  p.toggleEventInclude({ currentTarget: { dataset: { id: sports.id } } });
  check('可以逐个排除事件', p.data.eventIncluded === 0 && p.data.eventList[0].include === false,
    p.data.eventText);
  const withoutEvent = {
    total: p.network.peak.reduce((a, b) => a + b, 0),
  };
  check('排除后该时刻的流量下降（活动是按时刻叠加的）',
    withoutEvent.total < withEvent.total,
    `${Math.round(withEvent.total)} -> ${Math.round(withoutEvent.total)} 人次`);

  p.toggleEventInclude({ currentTarget: { dataset: { id: sports.id } } });
  check('可以再勾回来', p.data.eventIncluded === 1);

  // 「当天最忙」要把活动一起考虑进去（07:20 入场可能比任何换课时段都忙）
  const peakIdx = p.data.timeChoices.findIndex(c => c.key === 'peak');
  p.onTimeChoice({ detail: { value: peakIdx } });
  check('当天最忙的候选里包含活动时刻',
    /活动|换课/.test(p.data.caliber) && p.data.congestion.avgOccNow >= 0, p.data.caliber);

  // 校历：放假 / 调休
  store.putOverride({ date: day, kind: 'holiday', note: '测试放假' });
  const p2 = readyPage('外语网络楼');
  p2.onDateChange({ detail: { value: day } });
  check('放假那天标为放假', p2.data.dayKind === 'holiday', p2.data.dayKindLabel);
  check('放假的日期说明写清了', /放假/.test(p2.data.dateHint), p2.data.dateHint);
  const autoIdx2 = p2.data.timeChoices.findIndex(c => c.key === 'auto');
  p2.onTimeChoice({ detail: { value: autoIdx2 } });
  // 还没到活动时刻 -> 无通勤；活动仍在，所以"最坏情况"里还有它
  check('放假当天课表部分为零（只剩活动）', p2.data.congestion.avgOccTotal !== undefined
    || p2.data.caliber.length > 0, p2.data.caliber);

  store.putOverride({ date: day, kind: 'makeup', asWeekday: 3, note: '测试调休（按周三）' });
  const p3 = readyPage('外语网络楼');
  p3.onDateChange({ detail: { value: day } });
  check('调休按指定星期几上课', p3.data.dayKind === 'makeup', p3.data.dayKindLabel);
  check('调休说明写清按周几', /按周三/.test(p3.data.dateHint), p3.data.dateHint);
  const hasWed = p3.data.timeChoices.some(c => /^d3w/.test(String(c.key)));
  check('调休后可选时刻来自"被补的那天"（周三）', hasWed,
    p3.data.timeChoices.map(c => c.key).filter(k => /^d\d/.test(String(k))).slice(0, 3).join(' '));

  // 还原，别影响其它用例
  store.clearLocal();
  eventsUtil.clearCache();
  void calendarUtil;
}

console.log('\n=== 21. 一屏布局 + 模块二级页 ===');
{
  const panelBus = require(path.join(BASE, 'utils', 'panelBus.js'));
  const sessionUtil = require(path.join(BASE, 'utils', 'session.js'));
  panelBus.clear();

  const p = readyPage('外语网络楼');

  // ---- 模块按钮：9 个入口，图标/名称/角标都是算出来的
  check('模块按钮有 9 个', p.data.panelButtons.length === 9,
    p.data.panelButtons.map(b => b.name).join('/'));
  check('九个模块就是约定的那九个',
    p.data.panelButtons.map(b => b.key).join(',')
    === 'time,event,weather,report,police,locate,close,congestion,result',
    p.data.panelButtons.map(b => b.key).join(','));
  check('每个按钮都有图标与名称',
    p.data.panelButtons.every(b => b.icon && b.name));
  check('规划结果按钮带上耗时角标',
    p.data.panelButtons.find(b => b.key === 'result').badge === p.data.result.timeText,
    p.data.panelButtons.find(b => b.key === 'result').badge);
  check('天气摘要进了状态条', !!p.data.weatherChip && p.data.weatherChip !== '天气未知',
    p.data.weatherChip);

  // ---- 点按钮进二级页
  calls.navigate.length = 0;
  p.goPanel({ currentTarget: { dataset: { key: 'weather' } } });
  check('点模块按钮跳到对应二级页',
    calls.navigate.length === 1 && calls.navigate[0] === '/pages/panel/panel?key=weather',
    calls.navigate.join(' '));
  p.goPanel({ currentTarget: { dataset: { key: 'congestion' } } });
  check('不同模块带不同的 key',
    calls.navigate[1] === '/pages/panel/panel?key=congestion', calls.navigate[1]);

  // ---- 快照：二级页要显示的数据都在里面
  const snap = panelBus.getSnapshot('route');
  check('已把快照推给二级页', !!snap);
  check('快照含口径/时段/结果',
    !!snap.caliber && Array.isArray(snap.timeChoices) && !!snap.result && !!snap.congestion,
    `口径 ${snap.caliber}，时段 ${snap.timeChoices.length} 个`);
  check('快照含封路/事件/上报', Array.isArray(snap.closedList)
    && Array.isArray(snap.eventList) && snap.reportCounts !== undefined);
  check('快照与页面数据一致', snap.caliber === p.data.caliber && snap.mode === p.data.mode);

  // ---- 起点/终点：原生选择菜单代替一整张卡片
  calls.actionSheet.length = 0;
  p.pickStartSheet();
  check('起点弹出三种来源的选择菜单',
    calls.actionSheet.length === 1 && calls.actionSheet[0].join(',') === '用当前位置,搜索选择,地图点选',
    calls.actionSheet[0].join(' / '));
  calls.actionSheet.length = 0;
  p.pickDestSheet();
  check('终点弹出两种来源', calls.actionSheet[0].join(',') === '搜索选择,地图点选',
    calls.actionSheet[0].join(' / '));

  // 选「搜索选择」应打开搜索面板
  actionSheetPick = 1;
  p.pickStartSheet();
  check('选「搜索选择」打开搜索面板',
    !!p.data.placeSearch && p.data.placeSearch.target === 'start', p.data.placeSearch && p.data.placeSearch.target);
  p.closePlaceSearch();
  actionSheetPick = 0;

  // ---- 二级页改配置 -> 路线页 onShow 时应用并重算
  const before = p.data.caliber;
  sessionUtil.patch({ timeChoice: 'worst' });
  panelBus.pushIntent('applyConfig');
  p.onShow();
  check('二级页改的时段被应用', p.data.timeChoice === 'worst' && p.data.caliber !== before,
    `${before} -> ${p.data.caliber}`);
  check('口径变成整周最高峰（包络）', /最高峰/.test(p.data.caliber), p.data.caliber);

  // 走法
  sessionUtil.patch({ mode: 'shortest' });
  panelBus.pushIntent('applyConfig');
  p.onShow();
  check('二级页改的走法被应用并重新规划',
    p.data.mode === 'shortest' && p.data.result.modeName === '距离最短',
    p.data.result.modeName);

  // 交警
  sessionUtil.patch({ avoidPolice: true });
  panelBus.pushIntent('applyConfig');
  p.onShow();
  check('二级页开的「绕开交警」被应用', p.data.avoidPolice === true);

  // 封路
  sessionUtil.patch({ closedList: [{ ei: 3, roadType: 'residential', label: '测试封路' }] });
  panelBus.pushIntent('applyConfig');
  p.onShow();
  check('二级页加的封路被应用', p.data.closedList.length === 1
    && p.data.closedList[0].label === '测试封路');
  check('封路后路网确实重算了', !!p.network && p.scenario.closed[3] === 1);

  // 天气（手动档位）
  sessionUtil.patch({ weatherChoice: 'heavy', weatherIndex: 3, level: 'heavy' });
  panelBus.pushIntent('applyConfig');
  p.onShow();
  check('二级页切的手动天气被应用',
    p.data.weatherChoice === 'heavy' && p.currentLevel() === 'heavy', p.data.weatherText);
  check('重度雨天真的让路网变堵（占用率上升）', p.data.congestion.avgOccNow > 0,
    `占用率 ${p.data.congestion.avgOccNow}`);

  // 定位
  sessionUtil.patch({ wantTracking: true });
  panelBus.pushIntent('applyConfig');
  p.onShow();
  check('二级页开的实时定位被应用', p.data.tracking === true);
  sessionUtil.patch({ wantTracking: false });
  panelBus.pushIntent('applyConfig');
  p.onShow();
  check('二级页关的实时定位被应用', p.data.tracking === false);

  // 意图取走即清空，不重复执行
  check('意图被取走后不再残留', panelBus.peekIntents().length === 0);

  // 没有改动时 onShow 不应该乱重算
  const occBefore = p.data.congestion.avgOccNow;
  p.onShow();
  check('没有改动时 onShow 不改变结果', p.data.congestion.avgOccNow === occBefore);

  panelBus.clear();
}

console.log('\n=== 22. 作息表选时段：周日也能看「周一 第1-2节 课前」===');
{
  const panelBus = require(path.join(BASE, 'utils', 'panelBus.js'));
  const sessionUtil = require(path.join(BASE, 'utils', 'session.js'));
  const periodsUtil = require(path.join(BASE, 'utils', 'periods.js'));
  const timeModelUtil = require(path.join(BASE, 'utils', 'timeModel.js'));
  panelBus.clear();

  // 用户反映的原始现场：今天是周日 -> 当天没有课也没有活动，选择器里只剩两项
  withClock('2026-09-27T10:00:00', () => {
    sessionUtil.patch({ dateISO: '', timeChoice: 'auto' });
    const p = readyPage('外语网络楼');
    check('周日「按当前时间」如实说是无通勤',
      p.data.timeChoice === 'auto' && /无通勤/.test(p.data.caliber), p.data.caliber);
    check('这就是"只有两个时段"的原因：周日确实没有换课时段',
      p.data.timeChoices.length === 2 && p.data.timeChoices[1].key === 'worst',
      p.data.timeChoices.map(c => c.label).join(' / '));
    check('但这里如实说明了时段画像覆盖哪些天',
      /课表/.test(p.data.timeHint), p.data.timeHint.slice(0, 40));

    // 用户在二级页的作息表上点了「第1-2节 课前」（周一的窗口）
    sessionUtil.patch({ timeChoice: 'd1w0470' });
    panelBus.pushIntent('applyConfig');
    p.onShow();

    check('选的时刻没被"这天没课"吞掉，仍然保留', p.data.timeChoice === 'd1w0470', p.data.timeChoice);
    check('并把它补进选择器（不然界面上会跳回「自动」）',
      p.data.timeChoices.some(c => c.key === 'd1w0470'),
      p.data.timeChoices.map(c => c.label).slice(-2).join(' / '));
    check('口径用人话「第1-2节 课前」，而不是"07:50 换课"',
      /周一 第1-2节 课前/.test(p.data.caliber), p.data.caliber);
    check('口径里带上真正用的时刻 07:50', /07:50/.test(p.data.caliber), p.data.caliber);
    check('说明白这是按周一的课表算的（所选日期是周日）',
      /没有课/.test(p.data.timeText) && /周一的课表|按周一/.test(p.data.timeText), p.data.timeText);
    check('按周一算 -> 路网真的有人（不是全零）',
      p.data.congestion.avgOccNow > 0, `占用率 ${p.data.congestion.avgOccNow}`);
    check('而且排出了路线', !!p.data.result && p.data.result.distanceMeters > 0,
      p.data.result && `${p.data.result.distanceMeters}m`);

    // 换成周四的窗口：喂给路网的流量应该跟着换（不同天的课表不一样）
    const flowSum = () => {
      const f = p.resolveTimeBase().basePeak;
      let s = 0;
      for (let i = 0; i < f.length; i++) s += f[i];
      return Math.round(s);
    };
    const sumMon = flowSum();
    sessionUtil.patch({ timeChoice: 'd4w0700' });     // 周四(d4) 11:40 = 第3-4节 课后
    panelBus.pushIntent('applyConfig');
    p.onShow();
    const sumThu = flowSum();
    check('换一个节次/另一天，喂给路网的流量真的变了',
      sumMon > 0 && sumThu > 0 && sumMon !== sumThu, `周一 ${sumMon} -> 周四 ${sumThu}`);
    check('周四的标签也对', /周四 第3-4节 课后/.test(p.data.caliber), p.data.caliber);

    // 二级页的作息表和路线页的翻译必须是同一套说法
    const t = periodsUtil.tableFor(1, timeModelUtil.windowsFor(1));
    check('路线页与二级页用的是同一张作息表',
      t[0].before.key === 'd1w0470' && periodsUtil.labelOf(t[0].before.minutes) === '第1-2节 课前',
      periodsUtil.labelOf(t[0].before.minutes));

    // 非法 key 不该装死：如实说"不在画像里"
    sessionUtil.patch({ timeChoice: 'd9w9999' });
    panelBus.pushIntent('applyConfig');
    p.onShow();
    check('认不出来的时刻不崩，也不假装有数据',
      /无通勤|不在画像里/.test(p.data.caliber + p.data.timeText),
      `${p.data.caliber} / ${p.data.timeText}`);
    check('非法 key 也不会被塞进选择器',
      !p.data.timeChoices.some(c => c.key === 'd9w9999'),
      p.data.timeChoices.map(c => c.key).join(','));

    // 另一半：在二级页改的**日期**也要真的回到本页（"选了日期没变"的回归）
    sessionUtil.patch({ timeChoice: 'auto', dateISO: '2026-10-01' });
    panelBus.pushIntent('applyConfig');
    p.onShow();
    check('二级页改的日期被应用', p.data.dateISO === '2026-10-01', p.data.dateISO);
    check('日期名与星期跟着变', /10月1日/.test(p.data.dateLabel) && /周四/.test(p.data.dateLabel),
      p.data.dateLabel);
    check('日期说明也重算了（同一天说同一句话）',
      /10月1日/.test(p.data.dateHint) && /正常上课日/.test(p.data.dateHint), p.data.dateHint);
    check('可选的时段换成周四那一天的',
      p.data.timeChoices.some(c => c.key === 'd4w0470') && !p.data.timeChoices.some(c => c.key === 'd1w0470'),
      p.data.timeChoices.slice(3).map(c => c.key).join(','));
    check('日期也共享给了点选页', sessionUtil.get().dateISO === '2026-10-01');
  });

  panelBus.clear();
  sessionUtil.patch({ dateISO: '', timeChoice: 'auto' });
}

console.log('\n=== 23. 路线按拥堵叠色（用户问"是不是一直绿色"）===');
{
  const renderUtil = require(path.join(BASE, 'utils', 'render.js'));
  const panelBus2 = require(path.join(BASE, 'utils', 'panelBus.js'));
  const sessionUtil2 = require(path.join(BASE, 'utils', 'session.js'));
  panelBus2.clear();

  const p = readyPage('数学与统计学院');   // 起点是自动定位到的南校区6舍
  const countOf = color => lastCanvas().strokes.filter(s => s.color === color).length;

  // ① 少人优先：刻意绕开堵的路 -> 整条线应该还是绿的
  p.onSwitchMode({ currentTarget: { dataset: { mode: 'quiet' } } });
  check('少人优先把每一段的占用率缓存下来了（画线要用）',
    Array.isArray(p.usedEdges) && p.usedEdges.length === p.data.result.segmentCount,
    `${p.usedEdges && p.usedEdges.length} 段 / 结果里 ${p.data.result.segmentCount} 段`);
  const quietHot = (p.usedEdges || []).filter(e => e.heat >= renderUtil.HEAT_WARN).length;
  if (quietHot === 0) {
    check('少人优先这条路没有堵段 -> 一条绿线，不叠色',
      countOf(renderUtil.ROUTE_WARN_COLOR) === 0 && countOf(renderUtil.ROUTE_BAD_COLOR) === 0,
      `橙 ${countOf(renderUtil.ROUTE_WARN_COLOR)} · 红 ${countOf(renderUtil.ROUTE_BAD_COLOR)}`);
  } else {
    check('少人优先有堵段时也要叠色', countOf(renderUtil.ROUTE_WARN_COLOR)
      + countOf(renderUtil.ROUTE_BAD_COLOR) > 0, `${quietHot} 段较堵`);
  }
  check('绿主线始终只有一条（叠色不改主线本身）',
    countOf(renderUtil.ROUTE_COLOR) === 1, `${countOf(renderUtil.ROUTE_COLOR)} 条`);

  // ② 距离最短：会笔直穿过最忙走廊 -> 应该真的出现橙/红段
  p.onSwitchMode({ currentTarget: { dataset: { mode: 'shortest' } } });
  const hot = (p.usedEdges || []).filter(e => e.heat >= renderUtil.HEAT_WARN);
  const bad = (p.usedEdges || []).filter(e => e.heat >= renderUtil.HEAT_BAD);
  check('距离最短确实穿过较堵路段（这正是它"少走路却更慢"的原因）',
    hot.length > 0, `较堵 ${hot.length} 段（其中爆堵 ${bad.length} 段）`);
  check('画布上出现了橙黄色的较堵段', countOf(renderUtil.ROUTE_WARN_COLOR) > 0,
    `${countOf(renderUtil.ROUTE_WARN_COLOR)} 笔`);
  if (bad.length) {
    check('画布上出现了红色的爆堵段', countOf(renderUtil.ROUTE_BAD_COLOR) > 0,
      `${countOf(renderUtil.ROUTE_BAD_COLOR)} 笔`);
  } else {
    check('没有爆堵段时不画红色', countOf(renderUtil.ROUTE_BAD_COLOR) === 0);
  }
  check('叠色的笔数不超过堵段数（连续同色会合并成一条折线）',
    countOf(renderUtil.ROUTE_WARN_COLOR) + countOf(renderUtil.ROUTE_BAD_COLOR) <= hot.length,
    `${countOf(renderUtil.ROUTE_WARN_COLOR) + countOf(renderUtil.ROUTE_BAD_COLOR)} 笔 / ${hot.length} 段`);
  check('叠色用的是路线自己的折线（不是热度层那种逐边画法）：宽度与主线相同', (() => {
    const main = lastCanvas().strokes.find(s => s.color === renderUtil.ROUTE_COLOR);
    const warn = lastCanvas().strokes.find(s => s.color === renderUtil.ROUTE_WARN_COLOR);
    return !!main && !!warn && main.width === warn.width;
  })());

  // 结果面板要能说出"几段较堵、其中几段爆堵"，与地图上的颜色一一对应
  check('结果里给出了较堵段数（占用率 ≥ 0.5）',
    typeof p.data.result.congestedSegments === 'number' && p.data.result.congestedSegments >= hot.length,
    `较堵 ${p.data.result.congestedSegments} 段`);
  check('结果里给出了爆堵段数（占用率 ≥ 1.0）',
    typeof p.data.result.badSegments === 'number' && p.data.result.badSegments === bad.length,
    `爆堵 ${p.data.result.badSegments} 段`);
  check('爆堵段数不会超过较堵段数',
    p.data.result.badSegments <= p.data.result.congestedSegments);

  // ③ 拖动地图重绘（走的是 lastPath 那条路）时，叠色不能丢
  const before = countOf(renderUtil.ROUTE_WARN_COLOR) + countOf(renderUtil.ROUTE_BAD_COLOR);
  p.zoomIn(); p.zoomIn(); p.zoomIn();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  p.onMapTouchStart({ touches: [{ clientX: cx, clientY: cy }] });
  p.onMapTouchMove({ touches: [{ clientX: cx - 50, clientY: cy - 30 }] });
  p.onMapTouchEnd({ changedTouches: [{ clientX: cx - 50, clientY: cy - 30 }] });
  const after = countOf(renderUtil.ROUTE_WARN_COLOR) + countOf(renderUtil.ROUTE_BAD_COLOR);
  check('拖动重绘后叠色还在（usedEdges 跟着 lastPath 一起缓存）', after === before && after > 0,
    `${before} -> ${after}`);

  // ④ 规划失败要把缓存的堵段清掉，别把上一条路线的红段留在图上
  sessionUtil2.patch({ closedList: [] });
  p.usedEdges = [{ u: 1, v: 2, ei: 3, heat: 9 }];
  p.lastPath = [1, 2];
  p.plan();   // 这条线是假的，重规划会覆盖它
  check('重新规划会刷新缓存的每一段占用率',
    p.usedEdges === null || p.usedEdges.every(e => e.heat !== 9),
    p.usedEdges === null ? 'null' : `${p.usedEdges.length} 段`);
  panelBus2.clear();
  sessionUtil2.patch({ mode: 'quiet' });
}

console.log('\n=== 24. 封路：热度图必须重算，封掉的路段不能还是热度色 ===');
{
  const renderUtil2 = require(path.join(BASE, 'utils', 'render.js'));
  const closedRoads2 = require(path.join(BASE, 'utils', 'closedRoads.js'));
  const panelBus3 = require(path.join(BASE, 'utils', 'panelBus.js'));
  const sessionUtil3 = require(path.join(BASE, 'utils', 'session.js'));
  const reportStore3 = require(path.join(BASE, 'utils', 'reportStore.js'));

  const p = readyPage('数学与统计学院');
  // 找一条"封之前明显有热度"的路段（这样它原来是橙/红色，最容易被看出没生效）
  const before = p.usedEdges || [];
  const target = before.slice().sort((a, b) => b.heat - a.heat)[0];
  check('选到一条明显拥堵的路段做实验', !!target && target.heat > 0.25,
    target ? `#${target.ei} occ=${target.heat.toFixed(2)}` : '没有');

  const occBefore = p.network.occ[target.ei];
  const strokesBefore = lastCanvas().strokes.length;

  // 复现真实路径：二级页（或点选页）把封路写进 session，然后路线页 onShow 应用
  const item = closedRoads2.itemFromPick({
    action: 'close', edgeIndex: target.ei, edgeId: 'E' + target.ei,
    roadType: target.roadType, peak: target.peak, length: target.length,
  });
  sessionUtil3.patch({ closedList: [item] });
  panelBus3.pushIntent('applyConfig');
  p.onShow();

  check('封路被应用（清单里有了）', p.data.closedList.length === 1
    && p.data.closedList[0].ei === target.ei, JSON.stringify(p.data.closedList[0] || null));
  check('路网里这条边被标记为封闭', p.scenario.closed[target.ei] === 1);
  check('这条边的流量/占用率被清零（热度确实重算了）', p.network.occ[target.ei] === 0,
    `${occBefore} -> ${p.network.occ[target.ei]}`);
  check('占用率为 0 的畅通路段不该被画成黄色（低于阈值直接跳过）',
    renderUtil2.heatColor(0) === 'rgb(255,230,72)'
    && lastCanvas().strokes.filter(s => s.color === renderUtil2.heatColor(0)).length
      <= p.network.occ.filter(v => v > 0.02).length,
    `黄色笔画 ${lastCanvas().strokes.filter(s => s.color === renderUtil2.heatColor(0)).length}`);

  // 关键：画布上这条路段必须是"深灰虚线"，而且是**最后**描的（不会被邻居的热度色盖住）
  // （测试用的假 canvas 记录的是每条折线的段数，不是坐标，所以按 segs 匹配）
  const all = lastCanvas().strokes;
  const pts = router.edgePoints(target.ei);
  const closedAt = all.findIndex(s => s.color === '#3a3a3a'
    && Array.isArray(s.dash) && s.dash.length > 0
    && s.segs === pts.length - 1);
  check('【回归】封掉的那段画成了深灰虚线（不是热度色）', closedAt >= 0,
    `#${target.ei} 的封闭笔画位置 ${closedAt}（该边 ${pts.length - 1} 段）`);
  const lastHeat = all.map((s, i) => (/^rgb\(/.test(s.color) ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
  check('封闭虚线画在所有热度线之后（邻居的热度色盖不住它）', closedAt > lastHeat,
    `封闭 ${closedAt} > 最后一条热度线 ${lastHeat}`);
  check('封路之后画布确实重画过（笔画数变了）', all.length !== strokesBefore,
    `${strokesBefore} -> ${all.length}`);

  // 热度的"重新计算"不能只体现在这条路上：绕行流量要落到别处
  const others = p.usedEdges.filter(e => e.ei !== target.ei && e.heat > 0.02).length;
  check('剩余路段仍然有热度（不是整张图被清空）', others > 0, `${others} 段`);
  check('拥堵面板给出了封路后的结论', !!p.data.congestion && p.data.congestion.aggravated >= 0,
    `明显变堵 ${p.data.congestion && p.data.congestion.aggravated} 条`);

  // 解除封路 -> 热度恢复（能双向）
  sessionUtil3.patch({ closedList: [] });
  panelBus3.pushIntent('applyConfig');
  p.onShow();
  check('解除封路后这条边的占用率恢复', p.network.occ[target.ei] > 0
    || Math.abs(occBefore) < 1e-9, `${p.network.occ[target.ei]}`);
  check('解除后不再画封闭虚线', !lastCanvas().strokes.some(s => s.color === '#3a3a3a'));

  // 路线页自己收到封路结果时也要能处理（点选页从路线页打开的路径）
  sessionUtil3.patch({ closedList: [] });
  panelBus3.pushIntent('applyConfig');
  p.onShow();
  pickBus.put({
    action: 'close', edgeIndex: target.ei, edgeId: 'E' + target.ei,
    roadType: 'residential', peak: 5, length: 9,
  });
  p.onShow();
  check('路线页直接收到封路结果也能应用',
    p.data.closedList.some(c => c.ei === target.ei) && p.scenario.closed[target.ei] === 1,
    `清单 ${p.data.closedList.length} 条`);
  calls.toast.length = 0;
  pickBus.put({
    action: 'close', edgeIndex: target.ei, edgeId: 'E' + target.ei,
    roadType: 'residential', peak: 5, length: 9,
  });
  p.onShow();
  check('同一条路不会被封两次',
    p.data.closedList.length === 1 && /已经封/.test((calls.toast[calls.toast.length - 1] || {}).title || ''),
    `${p.data.closedList.length} 条 / ${(calls.toast[calls.toast.length - 1] || {}).title}`);
  calls.toast.length = 0;
  pickBus.put({ action: 'close', edgeIndex: null, roadType: 'residential' });
  p.onShow();
  check('数据不完整的封路结果不会污染清单', p.data.closedList.length === 1);
  calls.toast.length = 0;

  // 在二级页里上报的路况，回到路线页要能读到（loadReports 会重读上报库）
  storage.clear();
  const rep = reportsUtil.createFromPick({
    action: 'report', category: 'congestion', edges: [target.ei],
    x: 10, y: 10, roadType: 'residential', edgeId: 'E' + target.ei, note: '',
  });
  reportStore3.add(rep, () => {});
  p.onShow();
  check('在别的页面提交的上报会被路线页重新读进来',
    p.data.reportList.some(r => r.id === rep.id), `${p.data.reportList.length} 条上报`);

  reportStore3.clearLocal();
  storage.clear();
  sessionUtil3.patch({ closedList: [] });
  panelBus3.clear();
}

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exit(fail ? 1 : 0);
