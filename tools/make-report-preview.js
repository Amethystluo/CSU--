/**
 * 生成"众包路况 -> 交警绕行"对比预览图：
 *   左 = 收到上报但未开启规避（会经过交警）
 *   右 = 开启规避（绕开交警）
 * 用浏览器打开即可看到上报标记与两条不同路线。
 *
 *   node tools/make-report-preview.js
 */
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./paths.js');
const router = require(path.join(ROOT, 'utils', 'router.js'));
const scenarioEngine = require(path.join(ROOT, 'utils', 'scenario.js'));
const reportsUtil = require(path.join(ROOT, 'utils', 'reports.js'));
const graph = router.graph;

const VIEW_W = graph.meta.viewBox[0];
const VIEW_H = graph.meta.viewBox[1];
const GAP = 40, TOP = 150;

const P = require('./preview-common.js');
const basemap = fs.readFileSync(path.join(ROOT, 'assets', 'campus-map.svg'), 'utf8');
const inner = basemap.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');

const ROAD_TYPE_CN = {
  primary: '城市主干道', secondary: '次干道', tertiary: '支路',
  residential: '生活区道路', unclassified: '一般道路', service: '内部通道',
  track: '小路', path: '小径', footway: '人行道',
};

// 颜色/线宽/箭头全部沿用 preview-common（与小程序的 render.js 同源）
const heatColor = P.heatColor;
const d = P.d;

// ---- 出行对与上报
const from = graph.places.find(p => p.n === '南校区6舍');
const to = graph.places.find(p => p.n === '数学与统计学院');
const baseRoute = router.planOn(router.baselineNetwork(), from.i, to.i, 'fastest');

// 挑一条"绕开代价接近但低于 3 分钟"的路段放交警：
// 这样才看得出取舍（绕行 2 分多钟 vs 被拦下 3 分钟），而不是随手绕一下就完事
let policeEdge = null, fallback = null;
for (const e of baseRoute.usedEdges) {
  if (e.len < 80) continue;
  const m = new Uint8Array(router.EDGE_COUNT); m[e.ei] = 1;
  const r = router.planOn(router.buildNetwork({ closed: m }), from.i, to.i, 'fastest');
  if (!r.ok) continue;                                     // 桥边，绕不开
  const detour = r.timeMinutes - baseRoute.timeMinutes;
  if (!fallback || detour < fallback.detour) fallback = { ei: e.ei, detour, edge: e };
  if (detour >= router.POLICE_DELAY_MINUTES) continue;      // 本来就该绕，不是好例子
  if (!policeEdge || detour > policeEdge.detour) policeEdge = { ei: e.ei, detour, edge: e };
}
if (!policeEdge) policeEdge = fallback;
const congEdge = baseRoute.usedEdges.slice().sort((a, b) => b.flow - a.flow)[0];

const reps = [
  Object.assign(reportsUtil.createReport({
    category: 'police', edges: [policeEdge.ei], roadType: policeEdge.edge.roadType,
    x: router.edgeMidpoint(policeEdge.ei)[0], y: router.edgeMidpoint(policeEdge.ei)[1],
    note: '路口查车',
  }), { status: 'verified' }),
  Object.assign(reportsUtil.createReport({
    category: 'congestion', edges: [congEdge.ei], roadType: congEdge.roadType,
    x: router.edgeMidpoint(congEdge.ei)[0], y: router.edgeMidpoint(congEdge.ei)[1],
  }), { status: 'verified' }),
  // 一条待核实的，用来展示"空心标记、不影响规划"
  reportsUtil.createReport({
    category: 'closure', edges: [baseRoute.usedEdges[3].ei],
    roadType: baseRoute.usedEdges[3].roadType,
    x: router.edgeMidpoint(baseRoute.usedEdges[3].ei)[0],
    y: router.edgeMidpoint(baseRoute.usedEdges[3].ei)[1],
  }),
];

const agg = reportsUtil.aggregate(reps);
const opts = {
  level: 'none',
  closedEdges: Array.from(agg.closed),
  congestion: agg.congestion,
  policeEdges: Array.from(agg.police),
};
const off = scenarioEngine.applyScenario(Object.assign({}, opts, { avoidPolice: false }));
const on = scenarioEngine.applyScenario(Object.assign({}, opts, { avoidPolice: true }));
const rOff = router.planOn(off.network, from.i, to.i, 'fastest');
const rOn = router.planOn(on.network, from.i, to.i, 'fastest');

function panel(title, result, route, x0, note) {
  let s = `<g transform="translate(${x0},${TOP})">`;
  s += `<clipPath id="c${x0}"><rect x="0" y="0" width="${VIEW_W}" height="${VIEW_H}"/></clipPath><g clip-path="url(#c${x0})">`;
  s += `<rect x="0" y="0" width="${VIEW_W}" height="${VIEW_H}" fill="#f8faf7"/>${inner}`;
  // 热度层
  for (let ei = 0; ei < router.EDGE_COUNT; ei++) {
    const closed = result.closed[ei];
    const occ = result.network.occ[ei];
    if (!closed && occ < 0.02) continue;
    const pts = router.edgePoints(ei);
    s += closed ? P.closedSegSvg(pts) : P.heatSegSvg(pts, occ);
  }
  // 上报标记
  for (const r of reps) {
    const cat = reportsUtil.CATEGORY_MAP[r.category];
    const x = r.x, y = r.y;
    if (r.status === 'verified') {
      s += `<circle cx="${x}" cy="${y}" r="17" fill="#fff" opacity="0.95"/>`
        + `<circle cx="${x}" cy="${y}" r="11" fill="${cat.color}"/>`
        + `<text x="${x}" y="${y + 5}" font-size="14" fill="#fff" text-anchor="middle" font-weight="bold">${cat.short}</text>`;
    } else {
      s += `<circle cx="${x}" cy="${y}" r="17" fill="none" stroke="#fff" stroke-width="6" opacity="0.95"/>`
        + `<circle cx="${x}" cy="${y}" r="13" fill="none" stroke="${cat.color}" stroke-width="4" stroke-dasharray="6 4"/>`;
    }
  }
  // 路线（含方向箭头）
  if (route && route.ok) {
    s += P.routeSvg(router.pathToPoints(route.path), '#146b55');
  }
  s += P.endpointSvg(graph.px[from.i], graph.py[from.i], '#167052');
  s += P.endpointSvg(graph.px[to.i], graph.py[to.i], '#d22626');
  s += '</g>';
  s += `<text x="0" y="-96" font-size="30" font-weight="bold" fill="#146b55">${title}</text>`;
  s += `<text x="0" y="-56" font-size="22" fill="#2c4a3f">${note}</text>`;
  s += `<text x="0" y="-24" font-size="22" fill="#2c4a3f">时间最短路线：${route.distanceMeters} m / ${route.timeMinutes} 分`
    + ` · 经过交警 ${route.policeSegments} 段</text>`;
  s += '</g>';
  return s;
}

console.log(`出行对：${from.n} → ${to.n}`);
console.log(`上报：1 处交警(#${policeEdge.ei} ${ROAD_TYPE_CN[policeEdge.edge.roadType]})、`
  + `1 处异常拥堵(#${congEdge.ei})、1 条待核实的施工（不影响规划）`);
console.log(`不开启规避：${rOff.distanceMeters}m/${rOff.timeMinutes}分，经过交警 ${rOff.policeSegments} 段`);
console.log(`开启规避  ：${rOn.distanceMeters}m/${rOn.timeMinutes}分，经过交警 ${rOn.policeSegments} 段`);
console.log(`绕开代价：多 ${(rOn.timeMinutes - rOff.timeMinutes).toFixed(1)} 分钟 / ${rOn.distanceMeters - rOff.distanceMeters} 米`);

const W = VIEW_W * 2 + GAP;
const H = TOP + VIEW_H + 70;
const out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`
  + `<rect width="100%" height="100%" fill="#eef3ef"/>`
  + panel('① 收到上报 · 未开启规避', off, rOff, 0,
    `已核实：1 处交警 + 1 处异常拥堵；另有 1 条待核实（虚线空心标记，不计入计算）`)
  + panel('② 开启「绕开交警」', on, rOn, VIEW_W + GAP,
    `同样的上报，只是换了规划偏好：交警路段按「被拦下耽误 ${router.POLICE_DELAY_MINUTES} 分钟」计入代价`)
  + `<text x="0" y="${H - 24}" font-size="20" fill="#6b7d74">`
  + `标记：实心=已核实（影响规划），虚线空心=待核实（只提醒不影响规划）。`
  + `绿色为时间最短路线。生成脚本：tools/make-report-preview.js`
  + `</text></svg>`;

const dest = path.join(__dirname, 'preview-reports.svg');
fs.writeFileSync(dest, out, 'utf8');
console.log(`\n已生成 ${path.relative(process.cwd(), dest)}  ${(Buffer.byteLength(out) / 1024).toFixed(0)} KB`);
