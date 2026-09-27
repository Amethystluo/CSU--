/**
 * 画布绘制：热度层 / 封路 / 上报标记 / 路线 / 起终点 / 选中高亮。
 *
 * 路线页和点选页都要画同一套东西，所以抽到这里，避免两边视觉分叉。
 * 本文件不依赖 wx.*，只调用传入的 canvas context，因此可以在 Node 里用假 context 测试。
 *
 * 坐标：全部在 SVG 坐标系里绘制。调用方先用 beginFrame() 把画布对齐到底图，
 * 之后的坐标就直接是节点的 SVG 像素；需要"屏幕上粗细恒定"的线宽用 view.pxPerSvg 换算。
 */
const router = require('./router.js');
const reportsUtil = require('./reports.js');

const graph = router.graph;

/** 占用率 -> 颜色：黄 -> 橙 -> 红 -> 深红。 */
function heatColor(occ) {
  const stops = [
    [0.00, [255, 230, 72]],
    [0.35, [255, 157, 39]],
    [0.70, [209, 38, 38]],
    [1.40, [143, 20, 44]],
  ];
  const v = Math.max(0, Math.min(1.4, occ));
  for (let i = 0; i + 1 < stops.length; i++) {
    const t0 = stops[i][0], c0 = stops[i][1];
    const t1 = stops[i + 1][0], c1 = stops[i + 1][1];
    if (v <= t1 || i === stops.length - 2) {
      const k = Math.max(0, Math.min(1, t1 > t0 ? (v - t0) / (t1 - t0) : 0));
      return 'rgb('
        + Math.round(c0[0] + (c1[0] - c0[0]) * k) + ','
        + Math.round(c0[1] + (c1[1] - c0[1]) * k) + ','
        + Math.round(c0[2] + (c1[2] - c0[2]) * k) + ')';
    }
  }
  return 'rgb(143,20,44)';
}

/**
 * 开始一帧：清屏并把画布对齐到 SVG 坐标系。
 * @param {object} view {W,H,s,offX,offY,scale}
 * @returns {object} 供后续绘制函数使用的视图参数（含 pxPerSvg）
 */
function beginFrame(ctx, view) {
  const scale = view.scale || 1;
  ctx.clearRect(0, 0, view.W, view.H);
  ctx.save();
  ctx.translate(view.offX, view.offY);
  ctx.scale(view.s, view.s);
  ctx.setLineCap('round');
  ctx.setLineJoin('round');
  return { pxPerSvg: view.s * scale, scale };
}

function endFrame(ctx) {
  ctx.restore();
  ctx.draw();
}

/** 描一条折线（只建路径，不 stroke）。 */
function tracePath(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
}

/**
 * 热度层：有占用的路段按占用率着色，占用率越高线越粗；
 * 已封闭的路段画成深灰虚线。没占用的路交给底图，不重复画。
 *
 * **封闭的路段分两趟画**：第一趟画热度，第二趟才画封闭。
 * 否则两条几何几乎重合的路段（同一段路的两侧/数据里的重复段，本路网里有 4 对，
 * 最短只差 1.6 米）只要有一条没封，它的热度色就会盖在封闭虚线上，
 * 看起来就是"封了的路还是黄的"。
 */
function drawHeat(ctx, network, view, opts) {
  if (!network) return;
  const o = opts || {};
  const skip = o.skipEdges;          // 需要单独高亮的路段可以跳过
  const occ = network.occ;
  const closed = network.closed;
  const closedList = [];
  for (let ei = 0; ei < router.EDGE_COUNT; ei++) {
    if (skip && skip[ei]) continue;
    const isClosed = !!(closed && closed[ei]);
    const value = occ[ei];
    if (isClosed) { closedList.push(ei); continue; }   // 第二趟再画
    if (value < 0.02) continue;
    const pts = router.edgePoints(ei);
    if (pts.length < 2) continue;
    tracePath(ctx, pts);
    ctx.setStrokeStyle(heatColor(value));
    ctx.setLineWidth(4 + Math.min(value, 1.4) * 9);
    ctx.stroke();
  }
  // 第二趟：封闭的路段永远在最上层
  for (const ei of closedList) {
    const pts = router.edgePoints(ei);
    if (pts.length < 2) continue;
    tracePath(ctx, pts);
    ctx.setStrokeStyle('#3a3a3a');
    ctx.setLineWidth(5 / view.pxPerSvg);
    if (ctx.setLineDash) ctx.setLineDash([10 / view.pxPerSvg, 7 / view.pxPerSvg], 0);
    ctx.stroke();
    if (ctx.setLineDash) ctx.setLineDash([], 0);
  }
}

/** 用户上报标记：属实=实心，待核实=虚线空心，已否决不画。 */
function drawReports(ctx, list, view) {
  if (!list || !list.length) return;
  for (const r of list) {
    const cat = reportsUtil.CATEGORY_MAP[r.category];
    if (!cat || r.status === 'rejected') continue;
    let x = r.x, y = r.y;
    if (x === undefined || x === null) {
      const mid = router.edgeMidpoint((r.edges || [0])[0]);
      x = mid[0]; y = mid[1];
    }
    const rad = 8 / view.pxPerSvg;
    ctx.beginPath();
    ctx.arc(x, y, rad * 1.8, 0, Math.PI * 2);
    ctx.setFillStyle('rgba(255,255,255,0.95)');
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    if (r.status === 'verified') {
      ctx.setFillStyle(cat.color);
      ctx.fill();
    } else {
      ctx.setStrokeStyle(cat.color);
      ctx.setLineWidth(3 / view.pxPerSvg);
      if (ctx.setLineDash) ctx.setLineDash([5 / view.pxPerSvg, 4 / view.pxPerSvg], 0);
      ctx.stroke();
      if (ctx.setLineDash) ctx.setLineDash([], 0);
    }
  }
}

/**
 * 规划路线：白色描边打底 + 绿色主线 + 行进方向箭头。
 *
 * 以下数值都是**屏幕像素**（不是 SVG 单位），缩放时会自动换算，
 * 所以放大后线不会跟着变粗、箭头也不会跟着变大。
 * 观感取舍：主线原来是 6px（+13px 白边），比底图道路(约1.4px)与热度层(0.7~3px)
 * 粗太多，显得笨重；箭头又比白边还窄，看着只像个小凸起。现在改成细线 + 大箭头。
 */
const ROUTE_COLOR = '#146b55';
const ROUTE_WIDTH_PX = 4;          // 绿色主线宽度
const ROUTE_HALO_SCALE = 2.0;      // 白色打底描边 = 主线宽度 × 该系数（保证在热度层上看得清）

/**
 * 路线按"这一段有多堵"叠色。
 *
 * 为什么主线还要留绿：绿线一眼就是"这是我的路线"；如果整条按占用率染色，
 * 就和底下的热度层糊在一起分不清了。所以做法是**绿线打底，堵的那一段在它上面叠色**，
 * 白边仍然露着，看上去就是"这一段变色了"。
 *
 * 分界值必须与页面上"较堵路段"的统计口径一致（`metricsOfOn` 里数的是 占用率 ≥ 0.5），
 * 也正因为如此 route.js 的拥堵节点阈值直接引用 HEAT_WARN，不再各写一份。
 */
const HEAT_WARN = 0.5;             // 较堵
const HEAT_BAD = 1.0;              // 爆堵（1.0 ≈ 基线最挤路段的水平）
const ROUTE_WARN_COLOR = '#ef9d1f';
const ROUTE_BAD_COLOR = '#e0473a';

/** 某一段该用什么颜色：畅通 -> 绿主线，较堵 -> 橙黄，爆堵 -> 红。 */
function routeHeatColor(heat) {
  const h = Number(heat);
  if (!isFinite(h)) return ROUTE_COLOR;
  if (h >= HEAT_BAD) return ROUTE_BAD_COLOR;
  if (h >= HEAT_WARN) return ROUTE_WARN_COLOR;
  return ROUTE_COLOR;
}

/**
 * 折线上每一段对应的占用率（下标 0 = 第 1 段）。
 *
 * **按节点对匹配，不靠数组下标对齐**：`metricsOfOn` 在找不到边时会 `continue`
 * （usedEdges 就会比折线段少一条），按下标对齐会在那种情况下整条错位。
 * @param {array} path 节点下标序列（与 pathToPoints 的输入同一份）
 * @param {array} usedEdges plan.usedEdges（含 u/v/heat）
 * @returns {array|null} 长度 = path.length-1
 */
function segmentHeats(path, usedEdges) {
  if (!path || !usedEdges || !usedEdges.length) return null;
  const out = [];
  for (let i = 0; i + 1 < path.length; i++) {
    const u = path[i], v = path[i + 1];
    const e = usedEdges.find(x => (x.u === u && x.v === v) || (x.u === v && x.v === u));
    out.push(e ? e.heat : null);
  }
  return out;
}

const ARROW_LEN_PX = 13;           // 箭头长度（沿行进方向）
const ARROW_HALF_W_PX = 9;         // 箭头半宽（垂直方向），2×9=18px 明显宽于白边
const ARROW_SPACING_PX = 100;      // 箭头间距
const ARROW_MIN_EDGE_PX = 40;      // 离起点太近不画箭头

/**
 * 沿折线按屏幕间距画方向箭头（燕尾形：尾部内凹，比三角形更清楚）。
 * 用 fill 而不是 stroke，这样"绿色主线"仍只有一条描边，测试断言不受影响。
 *
 * @param {array} [heats] 每一段的占用率（segmentHeats 的结果）。传了就让箭头跟着那一段的颜色，
 *   否则一个绿箭头会顶在红色的堵段上，看着很别扭。
 */
function drawArrows(ctx, pts, view, heats) {
  const spacing = ARROW_SPACING_PX / view.pxPerSvg;
  const skipStart = ARROW_MIN_EDGE_PX / view.pxPerSvg;
  const len = ARROW_LEN_PX / view.pxPerSvg;
  const halfW = ARROW_HALF_W_PX / view.pxPerSvg;
  const back = len * 0.32;         // 尾部相对中心的内凹量
  let acc = 0;
  let next = skipStart;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (seg < 1e-6) continue;
    while (next <= acc + seg) {
      const t = (next - acc) / seg;
      const x = a[0] + (b[0] - a[0]) * t;
      const y = a[1] + (b[1] - a[1]) * t;
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const dx = Math.cos(ang), dy = Math.sin(ang);
      const nx = -dy, ny = dx;               // 法向
      ctx.setFillStyle(heats ? routeHeatColor(heats[i]) : ROUTE_COLOR);
      ctx.beginPath();
      ctx.moveTo(x + dx * len, y + dy * len);                        // 箭尖
      ctx.lineTo(x - dx * back + nx * halfW, y - dy * back + ny * halfW);
      ctx.lineTo(x - dx * back - nx * halfW, y - dy * back - ny * halfW);
      ctx.closePath();
      ctx.fill();
      next += spacing;
    }
    acc += seg;
  }
}

/**
 * 把堵的那几段在绿线之上叠色（同宽度，所以看到的就是"这一段变色了"）。
 * 相邻同色的段合并成一条折线再描边，避免在拐点上留下接头。
 */
function drawCongestedSegments(ctx, pts, heats, view) {
  if (!heats || !heats.length || pts.length < 2) return;
  const lineW = ROUTE_WIDTH_PX / view.pxPerSvg;
  let i = 0;
  while (i < heats.length && i + 1 < pts.length) {
    const color = routeHeatColor(heats[i]);
    if (color === ROUTE_COLOR) { i++; continue; }        // 畅通段保持绿主线
    let j = i;
    while (j + 1 < heats.length && j + 2 < pts.length && routeHeatColor(heats[j + 1]) === color) j++;
    ctx.beginPath();
    ctx.moveTo(pts[i][0], pts[i][1]);
    for (let k = i + 1; k <= j + 1; k++) ctx.lineTo(pts[k][0], pts[k][1]);
    ctx.setStrokeStyle(color);
    ctx.setLineWidth(lineW);
    ctx.stroke();
    i = j + 1;
  }
}

/**
 * @param {object} [opts] { usedEdges } —— plan.usedEdges；给了就按占用率给堵的段叠色。
 *   （path 是节点序列，本身不带流量信息，所以得把 usedEdges 一起传进来。）
 */
function drawRoute(ctx, path, view, opts) {
  if (!path || path.length < 2) return;
  const pts = router.pathToPoints(path);
  const lineW = ROUTE_WIDTH_PX / view.pxPerSvg;
  const heats = segmentHeats(path, opts && opts.usedEdges);
  tracePath(ctx, pts);
  ctx.setStrokeStyle('rgba(255,255,255,0.85)');
  ctx.setLineWidth(lineW * ROUTE_HALO_SCALE);
  ctx.stroke();
  tracePath(ctx, pts);
  ctx.setStrokeStyle(ROUTE_COLOR);
  ctx.setLineWidth(lineW);
  ctx.stroke();
  drawCongestedSegments(ctx, pts, heats, view);
  // 箭头最后画，并且用所在那一段的颜色
  if (view.arrows !== false) drawArrows(ctx, pts, view, heats);
}

/**
 * 拥堵节点：路线上极堵路段上的可点小圆点，点一下弹趣味提示。
 * @param {array} nodes [{x, y}]
 */
const NODE_COLOR = '#e8720c';
function drawCongestionNodes(ctx, nodes, view) {
  if (!nodes || !nodes.length) return;
  const r = 9 / view.pxPerSvg;
  for (const n of nodes) {
    ctx.beginPath();
    ctx.arc(n.x, n.y, r * 1.75, 0, Math.PI * 2);
    ctx.setFillStyle('rgba(255,255,255,0.95)');
    ctx.fill();
    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    ctx.setFillStyle(NODE_COLOR);
    ctx.fill();
    // 中间点一个小白点，避免看起来像纯色按钮
    ctx.beginPath();
    ctx.arc(n.x, n.y, r * 0.32, 0, Math.PI * 2);
    ctx.setFillStyle('#ffffff');
    ctx.fill();
  }
}

/** "我的位置"标记（持续定位用）。 */
const ME_COLOR = '#1f5fd0';
function drawMyLocation(ctx, point, view) {
  if (!point) return;
  const r = 10 / view.pxPerSvg;
  ctx.beginPath();
  ctx.arc(point.x, point.y, r * 2, 0, Math.PI * 2);
  ctx.setFillStyle('rgba(31,95,208,0.18)');
  ctx.fill();
  ctx.beginPath();
  ctx.arc(point.x, point.y, r * 1.6, 0, Math.PI * 2);
  ctx.setFillStyle('rgba(255,255,255,0.95)');
  ctx.fill();
  ctx.beginPath();
  ctx.arc(point.x, point.y, r, 0, Math.PI * 2);
  ctx.setFillStyle(ME_COLOR);
  ctx.fill();
}

/** 起终点标记。 */
const START_COLOR = '#167052';
const DEST_COLOR = '#d22626';
function drawEndpoints(ctx, startIdx, destIdx, view) {
  const marker = (idx, fill) => {
    if (idx === undefined || idx === null || idx < 0) return;
    const x = graph.px[idx], y = graph.py[idx];
    const r = 9 / view.pxPerSvg;
    ctx.beginPath();
    ctx.arc(x, y, r * 1.7, 0, Math.PI * 2);
    ctx.setFillStyle('rgba(255,255,255,0.95)');
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.setFillStyle(fill);
    ctx.fill();
  };
  marker(startIdx, START_COLOR);
  marker(destIdx, DEST_COLOR);
}

/**
 * 选中高亮：点选页里把用户选中的那条路/那个点画出来。
 * @param {object} sel {kind:'edge'|'node', index}
 */
const SELECT_COLOR = '#ff8a00';
function drawSelection(ctx, sel, view) {
  if (!sel) return;
  if (sel.kind === 'edge') {
    const pts = router.edgePoints(sel.index);
    tracePath(ctx, pts);
    ctx.setStrokeStyle('rgba(255,255,255,0.9)');
    ctx.setLineWidth(14 / view.pxPerSvg);
    ctx.stroke();
    tracePath(ctx, pts);
    ctx.setStrokeStyle(SELECT_COLOR);
    ctx.setLineWidth(7 / view.pxPerSvg);
    ctx.stroke();
    const mid = router.edgeMidpoint(sel.index);
    const r = 10 / view.pxPerSvg;
    ctx.beginPath();
    ctx.arc(mid[0], mid[1], r * 1.8, 0, Math.PI * 2);
    ctx.setFillStyle('rgba(255,255,255,0.95)');
    ctx.fill();
    ctx.beginPath();
    ctx.arc(mid[0], mid[1], r, 0, Math.PI * 2);
    ctx.setFillStyle(SELECT_COLOR);
    ctx.fill();
  } else if (sel.kind === 'node') {
    const x = graph.px[sel.index], y = graph.py[sel.index];
    const r = 10 / view.pxPerSvg;
    ctx.beginPath();
    ctx.arc(x, y, r * 1.8, 0, Math.PI * 2);
    ctx.setFillStyle('rgba(255,255,255,0.95)');
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.setFillStyle(SELECT_COLOR);
    ctx.fill();
  }
}

module.exports = {
  heatColor,
  beginFrame,
  endFrame,
  tracePath,
  drawHeat,
  drawReports,
  drawRoute,
  drawArrows,
  drawCongestedSegments,
  segmentHeats,
  routeHeatColor,
  drawCongestionNodes,
  drawMyLocation,
  drawEndpoints,
  drawSelection,
  ROUTE_COLOR,
  ROUTE_WIDTH_PX,
  ROUTE_HALO_SCALE,
  HEAT_WARN,
  HEAT_BAD,
  ROUTE_WARN_COLOR,
  ROUTE_BAD_COLOR,
  ARROW_LEN_PX,
  ARROW_HALF_W_PX,
  ARROW_SPACING_PX,
  ARROW_MIN_EDGE_PX,
  NODE_COLOR,
  ME_COLOR,
  START_COLOR,
  DEST_COLOR,
  SELECT_COLOR,
};
