/**
 * 生成"特殊情况"对比预览图：左=基线，右=中到大雨 + 封掉一条主要道路。
 * 两个面板里的热度层都是按各自情景的占用率重新画的，用浏览器打开即可对比。
 *
 *   node tools/make-scenario-preview.js
 */
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./paths.js');
const router = require(path.join(ROOT, 'utils', 'router.js'));
const scenarioEngine = require(path.join(ROOT, 'utils', 'scenario.js'));
const graph = router.graph;

const VIEW_W = graph.meta.viewBox[0];
const VIEW_H = graph.meta.viewBox[1];
const GAP = 40;
const TOP = 150;

const P = require('./preview-common.js');
const basemapRaw = fs.readFileSync(path.join(ROOT, 'assets', 'campus-map.svg'), 'utf8');
const inner = basemapRaw.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');

const ROAD_TYPE_CN = {
  primary: '城市主干道', secondary: '次干道', tertiary: '支路',
  residential: '生活区道路', unclassified: '一般道路', service: '内部通道',
  track: '小路', path: '小径', footway: '人行道',
};

// 颜色/线宽/箭头全部沿用 preview-common（与小程序的 render.js 同源）
const heatColor = P.heatColor;
const d = P.d;

/** 画一个面板：底图 + 该情景的热度层 + 封闭路段 + 时间最短路线。 */
function panel(name, result, route, x0) {
  let s = `<g transform="translate(${x0},${TOP})">`;
  s += `<clipPath id="clip${x0}"><rect x="0" y="0" width="${VIEW_W}" height="${VIEW_H}"/></clipPath>`;
  s += `<g clip-path="url(#clip${x0})">`;
  s += `<rect x="0" y="0" width="${VIEW_W}" height="${VIEW_H}" fill="#f8faf7"/>`;
  s += inner;                                   // 原始底图（灰色路网、建筑、标注）
  // 热度层：按占用率着色，占用越高线越粗
  for (let ei = 0; ei < router.EDGE_COUNT; ei++) {
    const closed = result.closed[ei];
    const occ = result.network.occ[ei];
    if (!closed && occ < 0.02) continue;
    const pts = router.edgePoints(ei);
    s += closed ? P.closedSegSvg(pts) : P.heatSegSvg(pts, occ);
  }
  // 时间最短路线（含方向箭头，堵的段按占用率叠色，与小程序一致）
  if (route && route.ok) {
    const pts = router.pathToPoints(route.path);
    s += P.routeSvg(pts, '#146b55', route.path, route.usedEdges);
    s += P.endpointSvg(router.graph.px[from.i], router.graph.py[from.i], '#167052');
    s += P.endpointSvg(router.graph.px[to.i], router.graph.py[to.i], '#d22626');
  }
  s += '</g>';

  // 标题与指标
  s += `<text x="0" y="-96" font-size="30" font-weight="bold" fill="#146b55">${name}</text>`;
  s += `<text x="0" y="-56" font-size="22" fill="#2c4a3f">全网拥堵指数 ${result.congestionIndex}（基线=1）`
    + ` · 明显变堵 ${result.aggravated} 条 · 新增堵点 ${result.newHotspots} 处`
    + (result.closedEdges.length ? ` · 封闭 ${result.closedEdges.length} 条` : '') + `</text>`;
  if (route && route.ok) {
    s += `<text x="0" y="-24" font-size="22" fill="#2c4a3f">时间最短路线：`
      + `${route.distanceMeters} m / ${route.timeMinutes} 分 / 平均占用率 ${route.avgCongestion}</text>`;
  }
  s += '</g>';
  return s;
}

// ---- 情景 A：基线
const a = place => graph.places.find(p => p.n === place);
const from = a('南校区6舍');
const to = a('数学与统计学院');
console.log(`出行对：${from.n} → ${to.n}`);

const base = scenarioEngine.applyScenario({});
const baseRoute = router.planOn(base.network, from.i, to.i, 'fastest');

// ---- 情景 B：中到大雨 + 封掉基线最快路线中间的一条路
const victim = baseRoute.usedEdges[Math.floor(baseRoute.usedEdges.length / 2)];
const wet = scenarioEngine.applyScenario({ level: 'heavy', closedEdges: [victim.ei] });
const wetRoute = router.planOn(wet.network, from.i, to.i, 'fastest');

console.log(`基线:   拥堵指数 ${base.congestionIndex}, 最快 ${baseRoute.distanceMeters}m/${baseRoute.timeMinutes}分, 平均占用 ${baseRoute.avgCongestion}`);
console.log(`雨天+封路(封 ${graph.edgeIds[victim.ei]} ${ROAD_TYPE_CN[graph.roadTypes[graph.edges[victim.ei][4]]]}, 峰值 ${graph.edges[victim.ei][3]} 人):`);
console.log(`        拥堵指数 ${wet.congestionIndex}, 明显变堵 ${wet.aggravated} 条, 新增堵点 ${wet.newHotspots} 处`);
console.log(`        最快 ${wetRoute.distanceMeters}m/${wetRoute.timeMinutes}分, 平均占用 ${wetRoute.avgCongestion}`);

const W = VIEW_W * 2 + GAP;
const H = TOP + VIEW_H + 60;
const out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`
  + `<rect width="100%" height="100%" fill="#eef3ef"/>`
  + panel('① 基线情景（无雨、无施工）', base, baseRoute, 0)
  + panel('② 特殊情况：中到大雨 + 主干道施工封闭', wet, wetRoute, VIEW_W + GAP)
  + `<text x="0" y="${H - 20}" font-size="20" fill="#6b7d74">`
  + `热度层按当前情景的“占用率”绘制（占用率 ∝ 流量 ÷ 车速）：颜色越红、线越粗表示越堵；深灰虚线为封闭路段。`
  + `雨天系数为可解释的假设值，非实测数据。生成脚本：tools/make-scenario-preview.js`
  + `</text></svg>`;

const dest = path.join(__dirname, 'preview-scenario.svg');
fs.writeFileSync(dest, out, 'utf8');
console.log(`\n已生成 ${path.relative(process.cwd(), dest)}  ${(Buffer.byteLength(out) / 1024).toFixed(0)} KB`);
console.log('用浏览器打开即可左右对比两个情景。');
