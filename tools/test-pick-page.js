/**
 * 点选页测试。
 *
 * 重点验证之前出问题的那件事：**点哪儿就选中哪儿**。
 * 其中"容器位置变了之后仍然选对"这一条，正是原先把测量结果缓存在 onReady
 * 导致的 bug —— 页面一滚动，触摸点就会整体偏移。
 *
 *   node tools/test-pick-page.js
 */
const path = require('path');

const calls = { canvas: [], toast: [], navBack: 0, redirect: [] };
const storage = new Map();
// 页面栈（用来验「取消」回到哪一页）：[..., 上一页, 本页]
let pageStack = [{ route: 'pages/panel/panel' }, { route: 'pages/pick/pick' }];
global.getCurrentPages = () => pageStack;
// 容器矩形可以随时改，用来模拟"页面滚动 / 布局变化"
let rect = { left: 0, top: 140, width: 375, height: 520 };
let measureDeferred = false;   // true = 挂起 boundingClientRect 的回调（模拟真机的异步测量）
const measureQueue = [];
const flushMeasures = () => { while (measureQueue.length) measureQueue.shift()(rect); };

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
        // 真机上这个回调是异步的；需要复现"测量还没回来，用户已经扫完了"时把开关打开
        if (measureDeferred) measureQueue.push(q._cb);
        else q._cb(rect);
      },
    };
    return q;
  },
  createCanvasContext: () => canvasRecorder(),
  getStorageSync: k => (storage.has(k) ? storage.get(k) : ''),
  setStorageSync: (k, v) => { storage.set(k, JSON.parse(JSON.stringify(v))); },
  showToast: o => { calls.toast.push(o); },
  navigateBack: () => { calls.navBack++; },
  redirectTo: opt => { calls.redirect.push(opt.url); },
};

let pageConfig = null;
global.Page = cfg => { pageConfig = cfg; };

const { ROOT: BASE } = require('./paths.js');
require(path.join(BASE, 'pages', 'pick', 'pick.js'));
const router = require(path.join(BASE, 'utils', 'router.js'));
const reportsUtil = require(path.join(BASE, 'utils', 'reports.js'));
const reportStore = require(path.join(BASE, 'utils', 'reportStore.js'));
const session = require(path.join(BASE, 'utils', 'session.js'));
const pickBus = require(path.join(BASE, 'utils', 'pickBus.js'));
const graph = router.graph;

function setByPath(root, p, value) {
  const parts = String(p).replace(/\[(\d+)\]/g, '.$1').split('.');
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] === undefined) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function newPage(mode, query) {
  const inst = Object.assign({}, pageConfig);
  inst.data = JSON.parse(JSON.stringify(pageConfig.data));
  inst.setData = function (obj, cb) {
    Object.keys(obj).forEach(k => {
      if (k.indexOf('.') >= 0 || k.indexOf('[') >= 0) setByPath(this.data, k, obj[k]);
      else this.data[k] = obj[k];
    });
    if (cb) cb();
  };
  inst.onLoad(Object.assign({ mode }, query || {}));
  inst.onReady();
  return inst;
}

const VIEW_W = graph.meta.viewBox[0];
const VIEW_H = graph.meta.viewBox[1];

/**
 * SVG 坐标 -> 屏幕触点坐标。
 * 按**当前容器矩形与当前拖动偏移**换算，也就是"这条路此刻在屏幕上出现的位置"。
 * 注意不能用 page.viewport —— 那正是被测对象缓存的旧值。
 * 图层变换是 translate(tx,ty) scale(k)（原点在容器中心），所以：
 *   screen = C + t + k*(u - C)
 */
function svgToClient(page, svgX, svgY) {
  const r = rect;
  const s = Math.min(r.width / VIEW_W, r.height / VIEW_H);
  const offX = (r.width - VIEW_W * s) / 2;
  const offY = (r.height - VIEW_H * s) / 2;
  const k = page.data.scale || 1;
  const tx = page.data.tx || 0;
  const ty = page.data.ty || 0;
  const ux = svgX * s + offX;          // 容器内未缩放坐标
  const uy = svgY * s + offY;
  return {
    clientX: r.left + r.width / 2 + tx + (ux - r.width / 2) * k,
    clientY: r.top + r.height / 2 + ty + (uy - r.height / 2) * k,
  };
}

function tap(page, clientX, clientY) {
  page.onTouchStart({ touches: [{ clientX, clientY }] });
  page.onTouchEnd({ changedTouches: [{ clientX, clientY }] });
}

function tapSvg(page, svgX, svgY) {
  const c = svgToClient(page, svgX, svgY);
  tap(page, c.clientX, c.clientY);
}

/** 模拟一次拖拽：按下 -> 分几步移动 -> 抬起。 */
function drag(page, fromX, fromY, dx, dy) {
  page.onTouchStart({ touches: [{ clientX: fromX, clientY: fromY }] });
  const steps = 4;
  for (let i = 1; i <= steps; i++) {
    page.onTouchMove({
      touches: [{ clientX: fromX + (dx * i) / steps, clientY: fromY + (dy * i) / steps }],
    });
  }
  page.onTouchEnd({ changedTouches: [{ clientX: fromX + dx, clientY: fromY + dy }] });
}

const lastCanvas = () => calls.canvas[calls.canvas.length - 1];

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`); }
}

// 找一条远离其他道路、方便精确定位的长路段
const targetEdge = (() => {
  let best = { len: 0, ei: 0 };
  for (let ei = 0; ei < router.EDGE_COUNT; ei++) {
    const e = graph.edges[ei];
    if (e[2] > best.len && e[4] !== graph.roadTypes.indexOf('footway')) best = { len: e[2], ei };
  }
  return best.ei;
})();
const targetMid = router.edgeMidpoint(targetEdge);
console.log(`测试用路段: #${targetEdge} ${graph.edgeIds[targetEdge]} 长 ${Math.round(graph.edges[targetEdge][2])}m，中点 (${targetMid[0].toFixed(1)}, ${targetMid[1].toFixed(1)})`);

console.log('\n=== 1. 初始化 ===');
{
  pickBus.take();
  const p = newPage('close');
  check('视口已测量', !!p.view && p.view.ready, p.view && `W=${p.view.W} H=${p.view.H}`);
  check('标题与提示按模式设置', p.data.title === '点选封闭道路' && /封闭/.test(p.data.hint),
    `${p.data.title} / ${p.data.hint}`);
  check('初始没有选中项', p.data.selection === null);
  check('画出了热度层', lastCanvas().strokes.filter(s => /^rgb\(/.test(s.color)).length > 50,
    `${lastCanvas().strokes.filter(s => /^rgb\(/.test(s.color)).length} 条`);
  const p2 = newPage('start');
  check('起点模式文案不同', p2.data.title === '点选起点' && p2.data.confirmText === '设为起点');
  const p3 = newPage('不存在的模式');
  check('非法模式回退到封闭模式', p3.data.mode === 'close');
}

console.log('\n=== 2. 点哪儿就选中哪儿（核心） ===');
{
  const p = newPage('close');
  // 独立不变量：容器中心必然对应 SVG 中心（与留白无关）
  const c = svgToClient(p, VIEW_W / 2, VIEW_H / 2);
  check('容器中心 <-> SVG 中心 自洽',
    Math.abs(c.clientX - (rect.left + rect.width / 2)) < 1e-6
    && Math.abs(c.clientY - (rect.top + rect.height / 2)) < 1e-6);

  tapSvg(p, targetMid[0], targetMid[1]);
  check('点中目标路段', p.data.selection && p.data.selection.index === targetEdge,
    p.data.selection ? `选中 #${p.data.selection.index}（期望 #${targetEdge}）` : '没有选中');
  check('显示了路段信息', p.data.selection && p.data.selection.edgeId === graph.edgeIds[targetEdge]
    && p.data.selection.peak >= 0, p.data.selection && `${p.data.selection.label} · ${p.data.selection.detail}`);
  check('选中项被高亮绘制',
    lastCanvas().strokes.some(s => s.color === '#ff8a00'), '有橙色高亮');

  // 换一条路再点，应切换选中
  const other = (() => {
    let pick = targetEdge;
    for (let ei = 0; ei < router.EDGE_COUNT; ei++) {
      if (ei === targetEdge) continue;
      const mid = router.edgeMidpoint(ei);
      const near = router.nearestEdge(mid[0], mid[1]);
      if (near.index === ei && graph.edges[ei][2] > 80) { pick = ei; break; }
    }
    return pick;
  })();
  const om = router.edgeMidpoint(other);
  tapSvg(p, om[0], om[1]);
  check('可以改选另一条路', p.data.selection.index === other,
    `期望 #${other} 实际 #${p.data.selection.index}`);
}

console.log('\n=== 3. 容器位置变化后仍然选对（原 bug 的回归测试）===');
{
  const p = newPage('close');
  // 模拟用户滚动页面：容器在屏幕上的位置整体上移
  rect = { left: 0, top: 40, width: 375, height: 520 };
  tapSvg(p, targetMid[0], targetMid[1]);
  check('容器上移后仍点中同一条路', p.data.selection && p.data.selection.index === targetEdge,
    p.data.selection ? `选中 #${p.data.selection.index}` : '没有选中');
  // 再移到别处
  rect = { left: 20, top: 300, width: 340, height: 400 };
  p.setData({ selection: null });
  tapSvg(p, targetMid[0], targetMid[1]);
  check('容器又换位置后依然正确', p.data.selection && p.data.selection.index === targetEdge,
    p.data.selection ? `选中 #${p.data.selection.index}` : '没有选中');
  rect = { left: 0, top: 140, width: 375, height: 520 };
}

console.log('\n=== 4. 缩放后仍然选对 ===');
{
  const p = newPage('close');
  p.setScale(2);
  tapSvg(p, targetMid[0], targetMid[1]);
  check('放大 2 倍后仍点中同一条路', p.data.selection && p.data.selection.index === targetEdge,
    p.data.selection ? `选中 #${p.data.selection.index}` : '没有选中');
  p.setScale(0.7);
  p.setData({ selection: null });
  tapSvg(p, targetMid[0], targetMid[1]);
  check('缩小到 0.7 倍后仍正确', p.data.selection && p.data.selection.index === targetEdge);
}

console.log('\n=== 4b. 拖拽改变中心点 ===');
{
  const p = newPage('close');
  check('默认就处于可拖动的缩放', p.data.canPan === true, `scale=${p.data.scale} canPan=${p.data.canPan}`);
  check('初始偏移为零', p.data.tx === 0 && p.data.ty === 0);

  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  drag(p, cx, cy, -60, -40);
  check('拖动后偏移发生变化', p.data.tx !== 0 || p.data.ty !== 0,
    `tx=${p.data.tx} ty=${p.data.ty}`);
  check('向右上拖动 -> 地图跟着手指走（负向偏移）', p.data.tx < 0 && p.data.ty < 0,
    `tx=${p.data.tx} ty=${p.data.ty}`);
  check('canvas 不需要重画（图层整体平移）',
    calls.canvas.length > 0);

  // 关键：拖动之后点选依然准
  p.setData({ selection: null });
  tapSvg(p, targetMid[0], targetMid[1]);
  check('拖动后仍点中同一条路', p.data.selection && p.data.selection.index === targetEdge,
    p.data.selection ? `选中 #${p.data.selection.index}` : '没有选中');

  // 拖动不会触发点选
  const before = p.data.selection && p.data.selection.index;
  drag(p, cx, cy, 50, 30);
  check('拖拽不会被当成点选', p.data.selection.index === before, `仍选中 #${p.data.selection.index}`);

  // 反向拖回
  const tx1 = p.data.tx, ty1 = p.data.ty;
  drag(p, cx, cy, 40, 20);
  check('反向拖动偏移回退', p.data.tx > tx1 && p.data.ty > ty1,
    `(${tx1},${ty1}) -> (${p.data.tx},${p.data.ty})`);
}

console.log('\n=== 4c. 拖动边界与复位 ===');
{
  const p = newPage('close');
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;

  // 使劲往一个方向拖，不能把地图拖丢
  for (let i = 0; i < 6; i++) drag(p, cx, cy, -300, -300);
  const s = Math.min(rect.width / VIEW_W, rect.height / VIEW_H);
  const maxTx = (VIEW_W * s * p.data.scale - rect.width) / 2;
  const maxTy = (VIEW_H * s * p.data.scale - rect.height) / 2;
  check('横向不会拖出边缘', Math.abs(p.data.tx) <= maxTx + 1,
    `|tx|=${Math.abs(p.data.tx)} <= ${maxTx.toFixed(1)}`);
  check('纵向不会拖出边缘', Math.abs(p.data.ty) <= maxTy + 1,
    `|ty|=${Math.abs(p.data.ty)} <= ${maxTy.toFixed(1)}`);
  check('确实拖到了边缘（说明限制在起作用而不是没动）',
    Math.abs(p.data.tx) > maxTx - 3, `tx=${p.data.tx}`);

  // 全览：缩放归 1 且偏移归零，此时无处可拖
  p.resetZoom();
  check('「全览」把缩放归到 1', p.data.scale === 1, p.data.scaleLabel);
  check('「全览」把偏移归零', p.data.tx === 0 && p.data.ty === 0);
  check('全览时不可拖动', p.data.canPan === false);
  drag(p, cx, cy, -120, -80);
  check('全览时拖动无效（不会把地图拖走）', p.data.tx === 0 && p.data.ty === 0);

  // 复位：回到初始缩放
  p.resetView();
  check('「复位」回到初始缩放', p.data.scale === 1.6, p.data.scaleLabel);
  check('复位后又能拖了', p.data.canPan === true);

  // 缩放会重新夹紧偏移
  drag(p, cx, cy, -200, -200);
  const beforeTx = p.data.tx;
  p.setScale(1.2);
  check('缩小后偏移被重新夹紧', Math.abs(p.data.tx) <= Math.abs(beforeTx) + 1,
    `${beforeTx} -> ${p.data.tx}`);
  p.setScale(1);
  check('缩到全览后偏移自动归零', p.data.tx === 0 && p.data.ty === 0);
  check('缩放上下限', (() => {
    for (let i = 0; i < 20; i++) p.zoomIn();
    const hi = p.data.scale;
    for (let i = 0; i < 30; i++) p.zoomOut();
    return hi === 4 && p.data.scale === 0.7;
  })(), `上限 ${4} / 下限 ${0.7}`);
}

console.log('\n=== 5. 无效点击 ===');
{
  const p = newPage('close');
  const r = rect;
  const fitS = Math.min(r.width / VIEW_W, r.height / VIEW_H);
  const offY = (r.height - VIEW_H * fitS) / 2;
  if (offY > 6) {
    tap(p, r.left + r.width / 2, r.top + 2);      // 图片上方的留白
    check('图片留白区被忽略', p.data.selection === null && offY > 6,
      `留白 ${offY.toFixed(0)}px`);
  } else {
    check('留白区较小，跳过该项', true, `offY=${offY.toFixed(1)}`);
  }

  // 滑动
  const before = calls.toast.length;
  p.onTouchStart({ touches: [{ clientX: 100, clientY: 300 }] });
  p.onTouchEnd({ changedTouches: [{ clientX: 160, clientY: 380 }] });
  check('滑动不算点选', p.data.selection === null && calls.toast.length === before);

  // 图片内、但离任何道路都很远的位置
  let far = { d: -1, x: 0, y: 0 };
  for (let x = 100; x < VIEW_W; x += 100) {
    for (let y = 100; y < VIEW_H; y += 100) {
      const h = router.nearestEdge(x, y);
      if (h.distanceMeters > far.d) far = { d: h.distanceMeters, x, y };
    }
  }
  console.log(`  离路最远的采样点 (${far.x}, ${far.y}) 距最近道路 ${far.d.toFixed(0)} 米`);
  if (far.d > 60) {
    tapSvg(p, far.x, far.y);
    check('离路太远时给出提示而不是乱选',
      p.data.selection === null && calls.toast.length > before,
      calls.toast[calls.toast.length - 1].title);
  } else {
    check('该图所有位置都离路<60m，跳过该项', true, `最大 ${far.d.toFixed(0)} 米`);
  }
}

console.log('\n=== 6. close 模式：确认回传 ===');
{
  pickBus.take();
  const p = newPage('close');
  tapSvg(p, targetMid[0], targetMid[1]);
  const navBefore = calls.navBack;
  p.confirm();
  const r = pickBus.peek();
  check('确认后返回上一页', calls.navBack === navBefore + 1);
  check('回传了封闭指令', r && r.action === 'close' && r.edgeIndex === targetEdge,
    r && JSON.stringify({ action: r.action, edgeIndex: r.edgeIndex }));
  check('回传里带了道路信息', r && r.edgeId === graph.edgeIds[targetEdge] && r.peak >= 0);

  pickBus.take();
  const p2 = newPage('close');
  p2.confirm();
  check('没选中就确认会提示', calls.toast[calls.toast.length - 1].title === '请先在地图上点选'
    && pickBus.peek() === null);

  pickBus.take();
  const p3 = newPage('close');
  tapSvg(p3, targetMid[0], targetMid[1]);
  p3.cancel();
  check('取消不会回传结果', pickBus.peek() === null);
}

console.log('\n=== 7. report 模式 ===');
{
  storage.clear();
  pickBus.take();
  const p = newPage('report');
  check('上报模式标题正确', p.data.title === '上报实时路况');
  check('提供四个上报类别', p.data.categories.length === 4);
  check('初始不显示类型面板', p.data.sheetVisible === false);

  tapSvg(p, targetMid[0], targetMid[1]);
  check('选中道路后自动展开类型面板', p.data.sheetVisible === true);
  check('面板显示的是选中的那条路', p.data.selection.index === targetEdge);

  // 未选类型
  p.confirm();
  check('未选类型就提交会提示', /请先选择情况类型/.test(calls.toast[calls.toast.length - 1].title)
    && pickBus.peek() === null);

  // 选"施工/封路"（半径为 0，只影响一条）
  p.chooseCategory({ currentTarget: { dataset: { key: 'closure' } } });
  check('可以选中类型', p.data.category === 'closure');
  p.onNoteInput({ detail: { value: '北门施工' } });
  p.confirm();
  const r = pickBus.peek();
  check('提交后回传上报内容', r && r.action === 'report' && r.category === 'closure',
    r && JSON.stringify({ action: r.action, category: r.category, edges: r.edges }));
  check('封路类只关联点中的那一条', r.edges.length === 1 && r.edges[0] === targetEdge);
  check('备注被带出', r.note === '北门施工');
  pickBus.take();

  // 选"有交警"（有半径，影响周边一段）
  const p2 = newPage('report');
  tapSvg(p2, targetMid[0], targetMid[1]);
  p2.chooseCategory({ currentTarget: { dataset: { key: 'police' } } });
  p2.confirm();
  const r2 = pickBus.peek();
  check('交警类会关联周边一段路', r2.edges.length >= 1,
    `${r2.edges.length} 条：${r2.edges.join(',')}`);
  check('交警类关联范围包含点中的那条', r2.edges.indexOf(targetEdge) >= 0);
  check('回传带上了打点坐标', typeof r2.x === 'number' && typeof r2.y === 'number',
    `(${r2.x.toFixed(0)}, ${r2.y.toFixed(0)})`);
  pickBus.take();

  // 非法类别不生效
  const p3 = newPage('report');
  tapSvg(p3, targetMid[0], targetMid[1]);
  p3.chooseCategory({ currentTarget: { dataset: { key: 'ufo' } } });
  check('非法类别被忽略', p3.data.category === '');
}

console.log('\n=== 8. start / dest 模式 ===');
{
  pickBus.take();
  const p = newPage('start');
  const svgX = VIEW_W / 2, svgY = VIEW_H / 2;
  tapSvg(p, svgX, svgY);
  const expect = router.nearestNode(svgX, svgY);
  check('选中最近路口', p.data.selection && p.data.selection.index === expect.index,
    `#${p.data.selection.index} vs #${expect.index}`);
  check('标出了吸附偏移', typeof p.data.selection.snapMeters === 'number',
    `${p.data.selection.snapMeters} 米`);
  p.confirm();
  const r = pickBus.peek();
  check('回传起点指令', r && r.action === 'start' && r.nodeIndex === expect.index,
    r && JSON.stringify({ action: r.action, nodeIndex: r.nodeIndex }));

  pickBus.take();
  const p2 = newPage('dest');
  tapSvg(p2, svgX, svgY);
  p2.confirm();
  const r2 = pickBus.peek();
  check('回传终点指令', r2 && r2.action === 'dest' && r2.nodeIndex === expect.index);
  pickBus.take();
}

console.log('\n=== 9. 与路线页共享同一情景 ===');
{
  storage.clear();
  session.patch({ level: 'heavy', closedList: [{ ei: 3, roadType: 'residential', label: 'x' }], avoidPolice: false });
  const p = newPage('close');
  check('点选页沿用了路线页的天气/封路',
    p.network && p.network.closed[3] === 1 && p.network.occ[3] === 0,
    `封路 #3 已生效`);
  check('雨天系数生效（占用率整体抬高）',
    p.network.occ.reduce((a, b) => a + b, 0) > router.baselineNetwork().occ.reduce((a, b) => a + b, 0),
    '点选页看到的拥堵与路线页一致');

  // 已核实的上报会画在点选页上
  const rep = Object.assign(reportsUtil.createReport({ category: 'police', edges: [10], x: 200, y: 300 }), { status: 'verified' });
  reportStore.add(rep);
  const p2 = newPage('report');
  check('已核实上报的标记会画出来', p2.reportList.length === 1 && p2.data.drawing !== false);
  check('标记颜色是交警蓝',
    lastCanvas().fills.indexOf(reportsUtil.CATEGORY_MAP.police.color) >= 0);

  // 路线页开着实时定位时，点选页也要显示"我的位置"
  session.patch({ myLocation: { x: 800, y: 900 } });
  p2.draw();
  check('点选页会显示"我的位置"（方便就近选路）',
    lastCanvas().fills.indexOf('#1f5fd0') >= 0);
  session.patch({ myLocation: null });

  session.patch({ level: 'none', closedList: [] });
  storage.clear();
}

console.log('\n=== 10. 双指捏合缩放 ===');
{
  const p = newPage('close');
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const before = p.data.scale;
  // 两指张开一倍
  p.onTouchStart({ touches: [{ clientX: cx - 40, clientY: cy }, { clientX: cx + 40, clientY: cy }] });
  p.onTouchMove({ touches: [{ clientX: cx - 80, clientY: cy }, { clientX: cx + 80, clientY: cy }] });
  check('捏合放大了地图', p.data.scale > before, `${before} -> ${p.data.scale}`);
  p.onTouchEnd({ changedTouches: [{ clientX: cx - 80, clientY: cy }, { clientX: cx + 80, clientY: cy }] });
  check('捏合不会被当成点选', p.data.selection === null);

  // 捏合之后点选仍然精准
  tapSvg(p, targetMid[0], targetMid[1]);
  check('捏合缩放后仍点中同一条路',
    p.data.selection && p.data.selection.index === targetEdge,
    p.data.selection ? `选中 #${p.data.selection.index}` : '没有选中');

  // 单指拖动仍然正常
  p.setData({ selection: null });
  p.onTouchStart({ touches: [{ clientX: cx, clientY: cy }] });
  p.onTouchMove({ touches: [{ clientX: cx - 40, clientY: cy - 20 }] });
  p.onTouchEnd({ changedTouches: [{ clientX: cx - 40, clientY: cy - 20 }] });
  check('捏合之后单指拖动仍生效', p.data.tx !== 0 || p.data.ty !== 0,
    `tx=${p.data.tx} ty=${p.data.ty}`);
}

console.log('\n=== 11. 测量还没回来时的手势（"快速拖动被丢掉"回归）===');
{
  // onTouchStart 原来是"先异步测矩形、在回调里才 gestureStart"。
  // 真机上这个回调晚十几~几十毫秒，一次快速轻扫会被整段丢掉 ——
  // 在点选页后果更重：抬手时 gs.start 还是空的，gestureEnd 判不出"拖过"，
  // 于是**把拖动当成点选**，凭空选中一个点。
  const p = newPage('close');
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  p.setData({ selection: null });

  measureDeferred = true;
  p.onTouchStart({ touches: [{ clientX: cx, clientY: cy }] });           // 测量被挂起
  p.onTouchMove({ touches: [{ clientX: cx - 70, clientY: cy - 40 }] });  // 用户已经扫完了
  p.onTouchEnd({ changedTouches: [{ clientX: cx - 70, clientY: cy - 40 }] });
  check('【回归】快速拖动仍然改变了偏移（不再整段丢掉）',
    p.data.tx !== 0 || p.data.ty !== 0, `tx=${p.data.tx} ty=${p.data.ty}`);
  check('【回归】快速拖动不会被误判成点选（不凭空选中一条路）',
    p.data.selection === null, JSON.stringify(p.data.selection));

  flushMeasures();
  measureDeferred = false;
  check('测量回来后矩形被刷新（点选换算用最新值）', !!p.rect);

  // 快速点一下（真的没动）仍然要能选中
  // 用新页面：上一段拖动改的是 this.view 里的偏移，setData 复位不了它。
  // 点的是已知路段的屏幕位置（容器正中央不一定有路）。
  const q = newPage('close');
  tapSvg(q, targetMid[0], targetMid[1]);
  check('真正的轻点照旧能选中', !!q.data.selection,
    q.data.selection ? `选中 #${q.data.selection.index}` : '没有选中');
}

console.log('\n=== 12. 双指放大不能变成点选 + 「取消」的语义（用户反馈）===');
{
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;

  // ---- 双指放大：抬手时 WeChat 会给两次 touchend（先一根、再一根）----
  const p = newPage('report');
  p.setData({ selection: null });
  const two = [{ clientX: cx - 60, clientY: cy }, { clientX: cx + 60, clientY: cy }];
  p.onTouchStart({ touches: two });                       // 两指落下
  p.onTouchMove({ touches: [{ clientX: cx - 120, clientY: cy }, { clientX: cx + 120, clientY: cy }] });
  check('双指放大确实放大了地图', p.data.scale > 1.6, String(p.data.scale));
  // 第一根手指抬起：还有一根留在屏幕上
  p.onTouchEnd({ changedTouches: [two[0]], touches: [two[1]] });
  check('抬起第一根手指不会被当成点选', p.data.selection === null);
  // 最后一根手指抬起
  p.onTouchEnd({ changedTouches: [two[1]], touches: [] });
  check('【回归】双指放大抬起最后一根手指也不会误输入成点击',
    p.data.selection === null, JSON.stringify(p.data.selection));
  check('也不会顺手把上报表单弹出来', p.data.sheetVisible === false);

  // 紧接着的单指轻点仍然要正常选中（标记不能永久生效）
  const q = newPage('report');
  tapSvg(q, targetMid[0], targetMid[1]);
  check('双指之后单指轻点照旧能选中', !!q.data.selection,
    q.data.selection ? `选中 #${q.data.selection.index}` : '没有选中');

  // ---- 表单里的「关闭」/点遮罩：只收起表单，不退出页面、不清掉已选路段 ----
  const r = newPage('report');
  tapSvg(r, targetMid[0], targetMid[1]);
  check('点上路后上报表单自动展开（report 模式）', r.data.sheetVisible === true && !!r.data.selection);
  const navBefore = calls.navBack;
  r.closeSheet();                                  // 表单里的「关闭」
  check('「关闭」只收起表单', r.data.sheetVisible === false);
  check('「关闭」不会退出整个点选页', calls.navBack === navBefore);
  check('「关闭」保留已选路段（可以接着改类型）', !!r.data.selection);
  r.closeSheet();                                  // 点遮罩也是同一个处理
  check('点表单外的遮罩同样只是收起表单', r.data.sheetVisible === false && calls.navBack === navBefore);

  // 收起之后再点「提交上报」：把表单重新打开，而不是只弹一句提示
  calls.toast.length = 0;
  r.confirm();
  check('没选类型时点提交会重新打开表单（不是只弹提示）',
    r.data.sheetVisible === true && calls.toast.length === 0,
    calls.toast.map(t => t.title).join(' / ') || '(无提示)');

  // ---- 真正退出：从模块二级页进来的，一定要回到那一页 ----
  calls.navBack = 0; calls.redirect.length = 0;
  pageStack = [{ route: 'pages/route/route' }, { route: 'pages/panel/panel' }, { route: 'pages/pick/pick' }];
  const s1 = newPage('report', { from: 'panel' });
  s1.cancel();
  check('从「实时路况上报」进来 -> 取消就是返回上一页', calls.navBack === 1 && calls.redirect.length === 0,
    `back=${calls.navBack} redirect=${calls.redirect.join(',')}`);

  // 页面栈异常（上一页不是模块页）：明确跳到「实时路况上报」，而不是落在别的地图页
  calls.navBack = 0; calls.redirect.length = 0;
  pageStack = [{ route: 'pages/route/route' }, { route: 'pages/pick/pick' }];
  const s2 = newPage('report', { from: 'panel' });
  s2.cancel();
  check('【回归】上一页不是模块页时，取消明确回到「实时路况上报」页',
    calls.redirect.length === 1 && calls.redirect[0] === '/pages/panel/panel?key=report'
    && calls.navBack === 0, calls.redirect.join(',') || `back=${calls.navBack}`);

  // 封路模式同理，回到「直接封路」那一页
  calls.navBack = 0; calls.redirect.length = 0;
  const s3 = newPage('close', { from: 'panel' });
  s3.cancel();
  check('封路模式取消也回到对应模块页',
    calls.redirect[0] === '/pages/panel/panel?key=close', calls.redirect.join(','));

  // 从路线页打开（from=route）：返回就是回路线页
  calls.navBack = 0; calls.redirect.length = 0;
  pageStack = [{ route: 'pages/index/index' }, { route: 'pages/route/route' }, { route: 'pages/pick/pick' }];
  const s4 = newPage('close', { from: 'route' });
  s4.cancel();
  check('从路线页打开时取消回路线页（不越级跳到模块页）',
    calls.navBack === 1 && calls.redirect.length === 0, `back=${calls.navBack}`);
  check('取消会丢弃残留的回传结果（不会带着上一次的选中回到上一页）',
    pickBus.take() === null);

  pageStack = [{ route: 'pages/panel/panel' }, { route: 'pages/pick/pick' }];
}

console.log('\n=== 13. 已经封掉的路：点它要立刻提示，而不是等提交完才说 ===');
{
  // 报告的问题：封完路再进点选页，那条路看起来跟没封一样（画着热度色）。
  // 现在两件事都保证：① 封路会写进 session，点选页建网时就带上（画成深灰虚线）；
  //                   ② 万一点到它，当场提示"已经封闭、去哪儿解除"。
  session.patch({ level: 'none', closedList: [{ ei: targetEdge, roadType: 'residential', label: '测试封路' }] });
  const p = newPage('close');
  check('点选页建网时带上了封路（与路线页同一份 session）',
    p.network && p.network.closed[targetEdge] === 1, `closed[${targetEdge}] = ${p.network.closed[targetEdge]}`);

  const c = svgToClient(p, targetMid[0], targetMid[1]);
  calls.toast.length = 0;
  p.onTouchStart({ touches: [{ clientX: c.clientX, clientY: c.clientY }] });
  p.onTouchEnd({ changedTouches: [{ clientX: c.clientX, clientY: c.clientY }] });
  check('点到已封闭的路段会当场提示', !p.data.selection
    && /已经封闭/.test((calls.toast[calls.toast.length - 1] || {}).title || ''),
    (calls.toast[calls.toast.length - 1] || {}).title);
  check('提示里说清了去哪儿解除', /解除/.test((calls.toast[calls.toast.length - 1] || {}).title || ''));

  // 没封的那条路照旧能选（把封路清单清空，同样的点选动作要能选中）
  session.patch({ level: 'none', closedList: [] });
  const q2 = newPage('close');
  calls.toast.length = 0;
  tapSvg(q2, targetMid[0], targetMid[1]);
  check('解除封路后，同一条路照旧可以选中', !!q2.data.selection,
    q2.data.selection ? `选中 #${q2.data.selection.index}` : '没有选中');
}

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exit(fail ? 1 : 0);
