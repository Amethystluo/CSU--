/**
 * 绘制层测试：线宽、箭头几何、各部分画法约定。
 *
 * render.js 之前只被页面测试间接覆盖，这里直接喂一个记录型的假 canvas，
 * 把"线要多细、箭头要多大"这类**观感意图**变成可断言的数字，
 * 免得以后改别的功能时手一抖又变粗/变小。
 *
 *   node tools/test-render.js
 */
const { ROOT } = require('./paths.js');
const path = require('path');
const render = require(path.join(ROOT, 'utils', 'render.js'));
const router = require(path.join(ROOT, 'utils', 'router.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`); }
}
const near = (a, b, eps) => Math.abs(a - b) <= (eps === undefined ? 0.05 : eps);

/** 记录型假 canvas：把每次描边/填充连同当时的样式与顶点都记下来。 */
function recorder() {
  const rec = { ops: [], strokes: [], fills: [] };
  let path_ = null;
  const push = (n, a) => rec.ops.push([n].concat(a || []));
  const api = {
    rec,
    clearRect: () => {}, save: () => {}, restore: () => {},
    translate: () => {}, scale: () => {}, draw: () => {},
    setLineCap: () => {}, setLineJoin: () => {},
    setLineDash: p => { rec.curDash = p; },
    setStrokeStyle: c => { rec.curColor = c; },
    setFillStyle: c => { rec.curFill = c; },
    setLineWidth: w => { rec.curWidth = w; },
    beginPath: () => { path_ = []; },
    closePath: () => push('closePath'),
    moveTo: (x, y) => { if (path_) path_.push([x, y]); },
    lineTo: (x, y) => { if (path_) path_.push([x, y]); },
    stroke: () => { rec.strokes.push({ color: rec.curColor, width: rec.curWidth, dash: rec.curDash, pts: (path_ || []).slice() }); path_ = null; },
    arc: (x, y, r) => { path_ = path_ || []; push('arc', [x, y, r]); },
    fill: () => { rec.fills.push({ color: rec.curFill, pts: (path_ || []).slice() }); path_ = null; },
  };
  return api;
}

// 12 个点的折线，够长以便放下多个箭头
const LINE = [];
for (let i = 0; i <= 11; i++) LINE.push([i * 120, 0]);

console.log('=== 1. 观感意图（线要细、箭头要大）===');
{
  console.log(`  主线 ${render.ROUTE_WIDTH_PX}px · 白边 ×${render.ROUTE_HALO_SCALE} = `
    + `${(render.ROUTE_WIDTH_PX * render.ROUTE_HALO_SCALE).toFixed(1)}px · `
    + `箭头 ${render.ARROW_LEN_PX}×${render.ARROW_HALF_W_PX * 2}px · 间距 ${render.ARROW_SPACING_PX}px`);
  check('主线不超过 4px（原来是 6px，比底图道路粗太多）', render.ROUTE_WIDTH_PX <= 4);
  check('白边是主线的 2 倍左右（够对比但别显粗）',
    render.ROUTE_HALO_SCALE >= 1.6 && render.ROUTE_HALO_SCALE <= 2.4);
  check('箭头明显宽于白边（否则看着只像个小凸起）',
    render.ARROW_HALF_W_PX * 2 > render.ROUTE_WIDTH_PX * render.ROUTE_HALO_SCALE,
    `箭头宽 ${render.ARROW_HALF_W_PX * 2}px > 白边 ${render.ROUTE_WIDTH_PX * render.ROUTE_HALO_SCALE}px`);
  check('箭头长度至少是主线宽的 3 倍', render.ARROW_LEN_PX >= render.ROUTE_WIDTH_PX * 3);
  check('箭头间距大于箭头长度（不挤在一起）',
    render.ARROW_SPACING_PX > render.ARROW_LEN_PX * 4,
    `${render.ARROW_SPACING_PX} > ${render.ARROW_LEN_PX * 4}`);
}

console.log('\n=== 2. 路线的实际线宽（换算成屏幕像素）===');
{
  const view = { pxPerSvg: 0.2 };        // 1 SVG 单位 = 0.2 屏幕像素
  const ctx = recorder();
  render.drawRoute(ctx, [0, 1, 2], view);
  const widths = ctx.rec.strokes.map(s => s.width * view.pxPerSvg);
  check('画了两次描边（白边 + 主线）', ctx.rec.strokes.length >= 2, `${ctx.rec.strokes.length} 次`);
  check('白边在屏幕上是 ' + (render.ROUTE_WIDTH_PX * render.ROUTE_HALO_SCALE) + 'px',
    near(widths[0], render.ROUTE_WIDTH_PX * render.ROUTE_HALO_SCALE),
    `${widths[0].toFixed(2)}px`);
  check('主线在屏幕上是 ' + render.ROUTE_WIDTH_PX + 'px',
    near(widths[1], render.ROUTE_WIDTH_PX), `${widths[1].toFixed(2)}px`);
  check('只画一条绿色主线', ctx.rec.strokes.filter(s => s.color === render.ROUTE_COLOR).length === 1);
  check('白边打底在先、主线在后', ctx.rec.strokes[0].color !== render.ROUTE_COLOR);

  // 放大 3 倍时，屏幕粗细应保持不变
  const view3 = { pxPerSvg: 0.6 };
  const ctx3 = recorder();
  render.drawRoute(ctx3, [0, 1, 2], view3);
  const w3 = ctx3.rec.strokes.map(s => s.width * view3.pxPerSvg);
  check('放大后线宽在屏幕上不变（换算正确）', near(w3[1], render.ROUTE_WIDTH_PX),
    `${w3[1].toFixed(2)}px`);
}

console.log('\n=== 3. 箭头几何 ===');
{
  const view = { pxPerSvg: 0.2 };
  const ctx = recorder();
  render.drawArrows(ctx, LINE, view);
  const tri = ctx.rec.fills.filter(f => f.color === render.ROUTE_COLOR && f.pts.length === 3);
  check('画出了多个箭头', tri.length >= 3, `${tri.length} 个`);
  check('每个箭头都是三角形（3 个顶点）', tri.every(t => t.pts.length === 3));

  // 第一个箭头：水平线，方向朝 +x
  const p = tri[0].pts;
  const nose = p[0];
  const c1 = p[1], c2 = p[2];
  const baseX = (c1[0] + c2[0]) / 2;
  const baseY = (c1[1] + c2[1]) / 2;
  const lenPx = (nose[0] - baseX) * view.pxPerSvg;
  const widthPx = Math.hypot(c1[0] - c2[0], c1[1] - c2[1]) * view.pxPerSvg;
  check('箭头总长（含燕尾）符合预期',
    near(lenPx, render.ARROW_LEN_PX * 1.32, 0.2), `${lenPx.toFixed(1)}px`);
  check('箭头底宽 = 2×半宽', near(widthPx, render.ARROW_HALF_W_PX * 2, 0.2),
    `${widthPx.toFixed(1)}px`);
  check('箭尖朝向路线前进方向（+x）', nose[0] > c1[0] && nose[0] > c2[0]);
  check('箭头沿线的间距符合设定', (() => {
    const xs = tri.map(t => t.pts[0][0]).sort((a, b) => a - b);
    const gaps = xs.slice(1).map((x, i) => (x - xs[i]) * view.pxPerSvg);
    return gaps.every(g => near(g, render.ARROW_SPACING_PX, 1));
  })());

  // 离起点太近不画
  const ctx2 = recorder();
  render.drawArrows(ctx2, [[0, 0], [50, 0]], view);      // 50 SVG 单位 = 10px，短于起始留白
  check('很短的路段不画箭头（避免堆在起点）',
    ctx2.rec.fills.filter(f => f.color === render.ROUTE_COLOR).length === 0);

  // 反向折线：箭头要跟着转弯
  const ctx3 = recorder();
  render.drawArrows(ctx3, [[0, 0], [600, 0], [600, 600]], view);
  const tri3 = ctx3.rec.fills.filter(f => f.color === render.ROUTE_COLOR && f.pts.length === 3);
  const dirs = tri3.map(t => {
    const n = t.pts[0], b = [(t.pts[1][0] + t.pts[2][0]) / 2, (t.pts[1][1] + t.pts[2][1]) / 2];
    return Math.atan2(n[1] - b[1], n[0] - b[0]);
  });
  check('箭头会跟着路线转弯（方向不止一种）',
    new Set(dirs.map(d => Math.round(d * 10) / 10)).size >= 2, `方向数 ${new Set(dirs.map(d => Math.sign(d))).size}`);
}

console.log('\n=== 4. 热度层约定 ===');
{
  const net = router.baselineNetwork();
  const view = { pxPerSvg: 0.2 };
  const ctx = recorder();
  render.drawHeat(ctx, net, view);
  const heat = ctx.rec.strokes.filter(s => /^rgb\(/.test(s.color));
  const closed = ctx.rec.strokes.filter(s => s.color === '#3a3a3a');
  check('只画有占用的路段（其余交给底图）', heat.length > 50 && heat.length < router.EDGE_COUNT,
    `${heat.length} / ${router.EDGE_COUNT}`);
  check('占用率越高的线越粗（颜色与粗细同时表达）',
    new Set(heat.map(s => Math.round(s.width))).size > 3,
    `线宽种类 ${new Set(heat.map(s => Math.round(s.width))).size}`);
  check('颜色是热度色阶（黄→红）',
    heat.every(s => /^rgb\(\d+,\d+,\d+\)$/.test(s.color)));
  check('封路后会用深灰虚线画', (() => {
    const mask = new Uint8Array(router.EDGE_COUNT);
    mask[3] = 1;
    const c2 = recorder();
    render.drawHeat(c2, router.buildNetwork({ closed: mask }), view);
    const cl = c2.rec.strokes.filter(s => s.color === '#3a3a3a');
    return cl.length === 1 && Array.isArray(cl[0].dash) && cl[0].dash.length > 0;
  })());
  check('基线没有封路时不会画虚线', closed.length === 0);

  // ---- 封闭的路段必须画在热度层**之上** ----
  // 本路网里有 4 对"几何几乎重合"的路段（最近只差 1.6 米）。若其中一条封了、另一条没封，
  // 邻居的热度色会盖住封闭虚线 —— 看到的就是"封了的路还是黄的"。
  check('封闭的路段在所有热度线之后才描边（不会被邻居盖住）', (() => {
    const mask = new Uint8Array(router.EDGE_COUNT);
    // 挑一对几何几乎重合、且其中一条有热度的路段
    mask[499] = 1;
    const c3 = recorder();
    render.drawHeat(c3, router.buildNetwork({ closed: mask }), view);
    const all = c3.rec.strokes;
    const lastHeat = all.map((s, i) => (/^rgb\(/.test(s.color) ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    const closedAt = all.findIndex(s => s.color === '#3a3a3a');
    return closedAt > lastHeat && closedAt >= 0;
  })());

  check('封闭路段用的是屏幕 5px 宽（比热度线醒目）', (() => {
    const mask = new Uint8Array(router.EDGE_COUNT);
    mask[3] = 1;
    const c4 = recorder();
    render.drawHeat(c4, router.buildNetwork({ closed: mask }), view);
    const cl = c4.rec.strokes.filter(s => s.color === '#3a3a3a');
    return cl.length === 1 && Math.abs(cl[0].width * view.pxPerSvg - 5) < 1e-6;
  })());

  check('封闭路段的占用率为 0 也照样画（不会被"占用太低就跳过"吃掉）', (() => {
    const mask = new Uint8Array(router.EDGE_COUNT);
    mask[3] = 1;
    const c5 = recorder();
    const net5 = router.buildNetwork({ closed: mask });
    render.drawHeat(c5, net5, view);
    return net5.occ[3] === 0 && c5.rec.strokes.some(s => s.color === '#3a3a3a');
  })());
}

console.log('\n=== 5. 标记类绘制 ===');
{
  const view = { pxPerSvg: 0.2 };
  // 我的位置
  const c1 = recorder();
  render.drawMyLocation(c1, { x: 100, y: 200 }, view);
  check('"我的位置"画了蓝色圆点', c1.rec.fills.some(f => f.color === render.ME_COLOR));
  const empty = recorder();
  render.drawMyLocation(empty, null, view);
  check('没有位置时什么都不画', empty.rec.fills.length === 0);

  // 拥堵节点
  const c2 = recorder();
  render.drawCongestionNodes(c2, [{ x: 10, y: 20 }, { x: 30, y: 40 }], view);
  check('拥堵节点画成橙色圆点',
    c2.rec.fills.filter(f => f.color === render.NODE_COLOR).length === 2);
  check('节点没有时什么都不画', (() => {
    const c = recorder();
    render.drawCongestionNodes(c, [], view);
    return c.rec.fills.length === 0;
  })());

  // 起终点
  const c3 = recorder();
  render.drawEndpoints(c3, 5, 9, view);
  check('起终点用两种颜色区分',
    c3.rec.fills.some(f => f.color === render.START_COLOR)
    && c3.rec.fills.some(f => f.color === render.DEST_COLOR));

  // 选中高亮
  const c4 = recorder();
  render.drawSelection(c4, { kind: 'edge', index: 3 }, view);
  check('选中的路段用高亮色描边',
    c4.rec.strokes.some(s => s.color === render.SELECT_COLOR));
}

console.log('\n=== 6. 预览图与小程序保持一致 ===');
{
  // 预览脚本按"手机 375px 屏宽"折算线宽与箭头，靠的是 render 暴露的常量。
  // 少导出一个常量就会算出 NaN，箭头会整体消失——正是开发中踩到过的坑，这里钉死。
  const KEYS = ['ROUTE_WIDTH_PX', 'ROUTE_HALO_SCALE', 'ARROW_LEN_PX',
    'ARROW_HALF_W_PX', 'ARROW_SPACING_PX', 'ARROW_MIN_EDGE_PX'];
  const missing = KEYS.filter(k => typeof render[k] !== 'number' || !isFinite(render[k]));
  check('预览需要的常量全部已导出且是有限数字', missing.length === 0,
    missing.length ? `缺失：${missing.join(', ')}` : KEYS.join(', '));

  const P = require('./preview-common.js');
  const pts = [[0, 0], [1200, 0], [2400, 0]];
  const arrows = P.arrowsSvg(pts, '#146b55');
  const tri = [...arrows.matchAll(/<path d="M([\d.]+),([\d.-]+) L([\d.]+),([\d.-]+) L([\d.]+),([\d.-]+) Z"/g)];
  check('预览能画出箭头（常量齐全时）', tri.length >= 2, `${tri.length} 个`);
  check('预览里没有 NaN 坐标', !/NaN/.test(arrows));
  if (tri.length) {
    const g = tri[0].slice(1).map(Number);
    const nose = [g[0], g[1]], c1 = [g[2], g[3]], c2 = [g[4], g[5]];
    const bx = (c1[0] + c2[0]) / 2, by = (c1[1] + c2[1]) / 2;
    const lenPx = Math.hypot(nose[0] - bx, nose[1] - by) / P.SVG_PER_PX;
    const wPx = Math.hypot(c1[0] - c2[0], c1[1] - c2[1]) / P.SVG_PER_PX;
    check('预览箭头尺寸与小程序一致（长）', near(lenPx, render.ARROW_LEN_PX * 1.32, 0.2),
      `${lenPx.toFixed(1)}px`);
    check('预览箭头尺寸与小程序一致（宽）', near(wPx, render.ARROW_HALF_W_PX * 2, 0.2),
      `${wPx.toFixed(1)}px`);
  }

  const route = P.routeSvg(pts, '#146b55');
  check('预览路线含白描边 + 主线 + 箭头',
    /stroke="#ffffff"/.test(route) && /stroke="#146b55"/.test(route) && /Z"/.test(route));
  check('预览线宽按 375px 屏宽折算正确', (() => {
    const m = /stroke="#146b55" stroke-width="([\d.]+)"/.exec(route);
    return m && near(Number(m[1]) / P.SVG_PER_PX, render.ROUTE_WIDTH_PX, 0.1);
  })());
  check('预览的配色函数与小程序同一个', P.heatColor === render.heatColor);
}

console.log('\n=== 7. 路线按拥堵叠色（用户问"是不是一直绿色"）===');
{
  const view = { pxPerSvg: 0.2 };
  const PATH = [10, 11, 12, 13];          // 4 个节点 = 3 段
  const edge = (u, v, heat) => ({ u, v, ei: 0, heat });
  const colorsOf = ctx => ctx.rec.strokes.map(s => s.color);

  check('分界值与页面上"较堵"的统计口径一致（占用率 0.5 / 1.0）',
    render.HEAT_WARN === 0.5 && render.HEAT_BAD === 1.0,
    `${render.HEAT_WARN} / ${render.HEAT_BAD}`);

  // 畅通：只有白边 + 绿主线，不多画
  const ok = recorder();
  render.drawRoute(ok, PATH, view, { usedEdges: [edge(10, 11, 0.2), edge(11, 12, 0.3), edge(12, 13, 0.1)] });
  check('全畅通时仍然是一条绿线',
    colorsOf(ok).filter(c => c === render.ROUTE_COLOR).length === 1
    && !colorsOf(ok).some(c => c === render.ROUTE_WARN_COLOR || c === render.ROUTE_BAD_COLOR),
    colorsOf(ok).join(' '));

  // 中间一段较堵、最后一段爆堵
  const bad = recorder();
  render.drawRoute(bad, PATH, view, {
    usedEdges: [edge(10, 11, 0.2), edge(11, 12, 0.7), edge(12, 13, 1.4)],
  });
  const cs = colorsOf(bad);
  const px11 = router.graph.px[11];
  const warnStroke = bad.rec.strokes.find(s => s.color === render.ROUTE_WARN_COLOR);
  check('叠色只画在堵的那一段上（第一段畅通就一点色都不叠）',
    !!warnStroke && warnStroke.pts[0][0] === px11, warnStroke ? String(warnStroke.pts[0][0]) : '没画');
  check('较堵的那段叠橙黄', cs.includes(render.ROUTE_WARN_COLOR));
  check('爆堵的那段叠红', cs.includes(render.ROUTE_BAD_COLOR));
  check('绿主线仍然只画一条（叠色是"在它上面加"，不是改它）',
    cs.filter(c => c === render.ROUTE_COLOR).length === 1);
  check('叠色段的宽度 = 主线宽度（所以看起来是"这一段变色"）', (() => {
    const main = bad.rec.strokes.find(s => s.color === render.ROUTE_COLOR);
    return warnStroke && main && warnStroke.width === main.width;
  })());
  check('叠色段只覆盖自己那一段（2 个点 = 一条直线段）', (() => {
    const red = bad.rec.strokes.find(s => s.color === render.ROUTE_BAD_COLOR);
    return warnStroke.pts.length === 2 && red.pts.length === 2;
  })());

  // 相邻同色要合并成一条折线（避免拐点上留接头）
  const run = recorder();
  render.drawRoute(run, PATH, view, {
    usedEdges: [edge(10, 11, 0.7), edge(11, 12, 0.8), edge(12, 13, 0.9)],
  });
  const warnRuns = run.rec.strokes.filter(s => s.color === render.ROUTE_WARN_COLOR);
  check('连续同色的段合并成一条折线（一次描边画 4 个点）',
    warnRuns.length === 1 && warnRuns[0].pts.length === 4,
    `${warnRuns.length} 条，点数 ${warnRuns[0] && warnRuns[0].pts.length}`);

  // 方向箭头跟着所在段的颜色，不能红段上顶个绿箭头
  const arrowFill = run.rec.fills.map(f => f.color);
  check('箭头颜色跟着它所在的那一段（不再永远绿色）',
    arrowFill.length > 0 && arrowFill.every(c => c === render.ROUTE_WARN_COLOR),
    arrowFill.join(' '));

  // 不传 usedEdges（旧调用方式）不能崩，也不该多画
  const plain = recorder();
  render.drawRoute(plain, PATH, view);
  check('不传 usedEdges 时行为与以前完全一样（只有白边 + 绿线 + 绿箭头）',
    plain.rec.strokes.length === 2 && plain.rec.fills.every(f => f.color === render.ROUTE_COLOR));

  // 按节点对匹配，不靠下标对齐：usedEdges 少一条时不能整条错位
  const shifted = recorder();
  render.drawRoute(shifted, PATH, view, { usedEdges: [edge(12, 13, 1.4)] });
  const sh = shifted.rec.strokes.filter(s => s.color === render.ROUTE_BAD_COLOR);
  check('usedEdges 与折线段数不一致时按节点对定位（不是按下标）',
    sh.length === 1 && sh[0].pts[0][0] === router.graph.px[12] && sh[0].pts[1][0] === router.graph.px[13],
    sh.length ? `${sh[0].pts[0][0].toFixed(1)} -> ${sh[0].pts[1][0].toFixed(1)}` : '没画');

  // 反向的 usedEdges（v->u）也要认得出来
  const rev = recorder();
  render.drawRoute(rev, PATH, view, { usedEdges: [edge(12, 11, 1.4)] });
  check('反向记录的边也认得出来（u/v 谁先谁后都行）',
    rev.rec.strokes.some(s => s.color === render.ROUTE_BAD_COLOR));

  // 颜色函数本身
  check('routeHeatColor 的边界：0.49 绿 / 0.5 橙 / 0.99 橙 / 1.0 红',
    render.routeHeatColor(0.49) === render.ROUTE_COLOR
    && render.routeHeatColor(0.5) === render.ROUTE_WARN_COLOR
    && render.routeHeatColor(0.99) === render.ROUTE_WARN_COLOR
    && render.routeHeatColor(1.0) === render.ROUTE_BAD_COLOR);
  check('没有占用率信息时退回绿线（不瞎标红）',
    render.routeHeatColor(null) === render.ROUTE_COLOR
    && render.routeHeatColor(undefined) === render.ROUTE_COLOR
    && render.routeHeatColor(NaN) === render.ROUTE_COLOR);

  // 真实数据：距离最短会穿过最忙走廊，应该真的出现橙/红段
  const g = router.graph;
  const byName = {};
  g.places.forEach(p => { byName[p.n] = p.i; });
  const net = router.baselineNetwork();
  const shortest = router.planOn(net, byName['南校区6舍'], byName['数学与统计学院'], 'shortest');
  if (shortest.ok) {
    const hs = render.segmentHeats(shortest.path, shortest.usedEdges);
    const red = hs.filter(h => render.routeHeatColor(h) === render.ROUTE_BAD_COLOR).length;
    const orange = hs.filter(h => render.routeHeatColor(h) === render.ROUTE_WARN_COLOR).length;
    const real = recorder();
    render.drawRoute(real, shortest.path, { pxPerSvg: 1 }, { usedEdges: shortest.usedEdges });
    check('真实数据：距离最短确实穿过爆堵路段（所以会看到红线）', red > 0 && orange > 0,
      `橙 ${orange} 段 · 红 ${red} 段`);
    check('真实数据的叠色笔画数与"有没有堵段"一致',
      real.rec.strokes.some(s => s.color === render.ROUTE_BAD_COLOR)
      && real.rec.strokes.some(s => s.color === render.ROUTE_WARN_COLOR));
    check('segmentHeats 长度 = 折线段数', hs.length === shortest.path.length - 1,
      `${hs.length} / ${shortest.path.length - 1}`);
  }

  // 少人优先是刻意绕开堵的，所以不该满屏红
  const quiet = router.planOn(net, byName['南校区6舍'], byName['数学与统计学院'], 'quiet');
  if (quiet.ok) {
    const hs = render.segmentHeats(quiet.path, quiet.usedEdges);
    const red = hs.filter(h => render.routeHeatColor(h) === render.ROUTE_BAD_COLOR).length;
    check('少人优先刻意避开爆堵路段（红线不该比距离最短还多）', red === 0, `红 ${red} 段`);
  }
}

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exit(fail ? 1 : 0);
