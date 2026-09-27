/**
 * 构建脚本：把 data/ 下的原始数据编译成小程序运行时可直接 require 的紧凑路由数据包。
 *
 * 输入：data/graph-nodes.json, data/graph-edges.json, data/traffic-flow.json, assets/traffic-heatmap.svg
 * 输出：data/route-graph.js
 *
 * 做四件事：
 *   1. 用 SVG 路网顶点拟合出「经纬度 -> SVG 像素」投影（Web Mercator + 均匀缩放）
 *   2. 组装可路由图：graph-edges + 现场补充连接 C001/C002 + 隐形连接 V001/V002
 *   3. 把 traffic-flow.json 的峰值人流量归一化成 0~1 热度权重
 *   4. 生成常用地点（宿舍 / 教学点）到最近道路节点的映射
 *
 * 用法：node tools/build-route-graph.js
 */
const fs = require('fs');
const path = require('path');

const { ROOT } = require('./paths.js');
const D = path.join(ROOT, 'data');
const read = f => JSON.parse(fs.readFileSync(path.join(D, f), 'utf8'));

const R = 6378137;
const RAD = Math.PI / 180;
const mercX = lon => R * lon * RAD;
const mercY = lat => R * Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2));

const nodes = read('graph-nodes.json');
const graphEdges = read('graph-edges.json');
const flow = read('traffic-flow.json');
const svg = fs.readFileSync(path.join(ROOT, 'assets', 'traffic-heatmap.svg'), 'utf8');

const VB = (svg.match(/viewBox="([^"]+)"/) || [, ''])[1].split(/\s+/).map(Number);
const VIEW = { w: VB[2], h: VB[3] };

// ---------------------------------------------------------------- 1. 投影拟合
// SVG 里的道路路径就是同一份 OSM 数据渲染出来的，因此直接拿两者的顶点做最小二乘/
// 坐标下降拟合，可以拿到像素级精确的投影。
function collectSvgRoadPoints() {
  const pts = [];
  for (const m of svg.matchAll(/<path\b([^>]*)\/?>/g)) {
    const a = m[1];
    const cls = (a.match(/class="([^"]*)"/) || [, ''])[1];
    const stroke = (a.match(/stroke="([^"]*)"/) || [, ''])[1];
    const isRoad = cls === 'road' || /^#(c5bfad|ffe|ffc|ffd|ffb|ff9|ffa|f7|fb|d1|de|8f)/.test(stroke);
    if (!isRoad) continue;
    const d = (a.match(/d="([^"]*)"/) || [, ''])[1];
    for (const seg of d.split(/[ML]/).filter(Boolean)) {
      const [x, y] = seg.trim().split(/[ ,]+/).map(Number);
      if (isFinite(x) && isFinite(y)) pts.push([x, y]);
    }
  }
  return pts;
}

function makeLocator(pts, cell) {
  const g = new Map();
  pts.forEach(([x, y]) => {
    const k = `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
    if (!g.has(k)) g.set(k, []);
    g.get(k).push([x, y]);
  });
  return (x, y) => {
    let best = Infinity;
    for (let r = 0; r <= 8; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const b = g.get(`${Math.floor(x / cell) + dx},${Math.floor(y / cell) + dy}`);
          if (b) for (const [px, py] of b) {
            const d = (px - x) ** 2 + (py - y) ** 2;
            if (d < best) best = d;
          }
        }
      }
      if (best < (r * cell) ** 2) break;
    }
    return Math.sqrt(best);
  };
}

function fitProjection() {
  const roadPts = collectSvgRoadPoints();
  const distToRoad = makeLocator(roadPts, 25);

  // 采样图边顶点（墨卡托米）
  const samples = [];
  for (const e of graphEdges.features) {
    for (const c of e.geometry.coordinates) samples.push([mercX(c[0]), mercY(c[1])]);
  }
  const MX = samples.map(s => s[0]);
  const MY = samples.map(s => s[1]);
  const minMX = Math.min(...MX), maxMX = Math.max(...MX);
  const minMY = Math.min(...MY), maxMY = Math.max(...MY);
  const bx = roadPts.map(p => p[0]), by = roadPts.map(p => p[1]);
  const minBX = Math.min(...bx), maxBX = Math.max(...bx);
  const minBY = Math.min(...by), maxBY = Math.max(...by);

  // px = S*(mercX - X0); py = S*(Y0 - mercY)，S 单位 px/m
  const err = (S, X0, Y0) => {
    let sum = 0, n = 0;
    for (let i = 0; i < samples.length; i += 2) {
      sum += distToRoad(S * (samples[i][0] - X0), S * (Y0 - samples[i][1]));
      n++;
    }
    return sum / n;
  };

  let S = (maxBX - minBX) / (maxMX - minMX);
  let X0 = minMX - minBX / S;
  let Y0 = minMY + maxBY / S;
  let bestErr = err(S, X0, Y0);

  for (const f of [0.05, 0.02, 0.008, 0.003, 0.001, 0.0004]) {
    let improved = true;
    while (improved) {
      improved = false;
      for (const [k, step] of [['S', S * f], ['X0', f * 500], ['Y0', f * 500]]) {
        for (const dir of [1, -1]) {
          const c = { S, X0, Y0 };
          c[k] += dir * step;
          const e = err(c.S, c.X0, c.Y0);
          if (e < bestErr - 1e-6) { S = c.S; X0 = c.X0; Y0 = c.Y0; bestErr = e; improved = true; }
        }
      }
    }
  }
  return { S, X0, Y0, meanErrPx: bestErr, svgRoadPoints: roadPts.length, samples: samples.length };
}

// ---------------------------------------------------------------- 2. 组装路由图
const routable = nodes.features.filter(f => f.properties.kind !== 'building');
const indexOf = new Map(routable.map((f, i) => [f.properties.id, i]));
const coordById = new Map(nodes.features.map(f => [f.properties.id, f.geometry.coordinates]));

const heatById = new Map(flow.edges.map(e => [e.id, e]));
const MAX_PEAK = Math.max(...flow.edges.map(e => e.peak_slot_person_trips));

/** 收集所有应当参与步行/骑行规划的边。 */
function collectEdges() {
  const list = [];
  const skipped = [];

  for (const e of graphEdges.features) {
    const p = e.properties;
    list.push({
      id: p.id, source: p.source, target: p.target, length: p.length_m,
      highway: p.highway || 'unclassified', origin: 'osm',
    });
  }
  // 现场补充连接（打通新校区与南校区的两个缺口）与隐形步行连接
  for (const c of [...flow.surveyed_connectors, ...flow.virtual_connectors]) {
    if (!indexOf.has(c.source) || !indexOf.has(c.target)) {
      skipped.push({ id: c.id, reason: '端点不在路网节点中' });
      continue;
    }
    list.push({
      id: c.id, source: c.source, target: c.target, length: c.length_m,
      // 隐形连接长度只有几米，按人行道处理
      highway: c.highway || 'footway',
      origin: c.surveyed_connector ? 'surveyed' : 'virtual',
    });
  }
  // U001 是用户手绘的合成走廊（user_drawn），不是真实道路，画出来会横穿建筑，故排除
  for (const e of flow.edges) {
    if (e.highway === 'user_route') skipped.push({ id: e.id, reason: '合成走廊，非真实道路' });
  }
  return { list, skipped };
}

// ---------------------------------------------------------------- 3. 连通分量 / 校区归属
function computeComponents(edgeList) {
  const adj = routable.map(() => []);
  for (const e of edgeList) {
    const u = indexOf.get(e.source), v = indexOf.get(e.target);
    if (u === undefined || v === undefined) continue;
    adj[u].push(v); adj[v].push(u);
  }
  const comp = new Array(routable.length).fill(-1);
  const sizes = [];
  for (let i = 0; i < routable.length; i++) {
    if (comp[i] !== -1) continue;
    const id = sizes.length;
    const stack = [i]; comp[i] = id;
    let n = 0;
    while (stack.length) {
      const cur = stack.pop(); n++;
      for (const nb of adj[cur]) if (comp[nb] === -1) { comp[nb] = id; stack.push(nb); }
    }
    sizes.push(n);
  }
  return { comp, sizes };
}

// ---------------------------------------------------------------- 主流程
const proj = fitProjection();
console.log(`投影拟合: S=${proj.S.toFixed(8)} px/m  X0=${proj.X0.toFixed(2)}  Y0=${proj.Y0.toFixed(2)}  平均误差=${proj.meanErrPx.toFixed(3)} px`);
if (!(proj.meanErrPx < 1)) throw new Error(`投影拟合误差过大：${proj.meanErrPx} px，请检查 SVG 与路网数据是否匹配`);

const project = (lon, lat) => [
  Math.round(proj.S * (mercX(lon) - proj.X0) * 10) / 10,
  Math.round(proj.S * (proj.Y0 - mercY(lat)) * 10) / 10,
];

const { list: edgeList, skipped } = collectEdges();
const { comp, sizes } = computeComponents(edgeList);
console.log(`连通分量: ${sizes.join(', ')}（最大 ${sizes[0]} 个节点）`);
if (skipped.length) console.log('被排除的边:', JSON.stringify(skipped));

// 校区归属：直接用数据自带的 campus 字段（宿舍按 dorms.new / dorms.south 分组，
// 教学点用 locations[].campus）。地图上两个校区的宿舍在南北方向本就交错，
// 用几何位置猜会猜错，这里以数据为准。
const CAMPUS_NAME = { new: '新校区', south: '南校区' };
[...svg.matchAll(/<text class="campus-label"[^>]*y="([\d.]+)"[^>]*>([^<]+)<\/text>/g)]
  .forEach(m => console.log(`  SVG 校区标题: ${m[2].trim()} @y=${Number(m[1]).toFixed(0)}`));

// ---------------------------------------------------------------- 输出数据
const px = [], py = [];
routable.forEach(f => { const [x, y] = project(...f.geometry.coordinates); px.push(x); py.push(y); });

const edges = [];
const seen = new Set();
// 道路类型只存一份，边里存下标，省体积（速度表放在 utils/router.js，属于"模型"不属于"数据"）
const roadTypes = [...new Set(edgeList.map(e => e.highway))].sort();
const kindOf = new Map(roadTypes.map((t, i) => [t, i]));

// 逐边几何：折线的中间点（首尾就是节点本身，不重复存）。
// 封路重分配、地图点选最近路段、画动态热度层都需要它。
const edgeGeom = [];
const edgeIds = [];
const coordToPx = c => project(c[0], c[1]);

for (const e of edgeList) {
  const u = indexOf.get(e.source), v = indexOf.get(e.target);
  if (u === undefined || v === undefined) continue;
  const key = u < v ? `${u}-${v}` : `${v}-${u}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const h = heatById.get(e.id);
  // peak 存"绝对峰值人次"，运行时再归一化：封路重分配需要绝对量才能做加法
  const peak = h ? h.peak_slot_person_trips : 0;
  edges.push([u, v, Math.round(e.length * 10) / 10, peak, kindOf.get(e.highway)]);

  // 几何点：优先用原始 GeoJSON 折线，取内部点
  const src = graphEdges.features.find(f => f.properties.id === e.id);
  const line = src ? src.geometry.coordinates : null;
  const inner = [];
  if (line && line.length > 2) {
    for (let i = 1; i < line.length - 1; i++) {
      const p = coordToPx(line[i]);
      inner.push(Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10);
    }
  } else if (e.origin !== 'osm') {
    // 补充连接在 flow 里自带坐标
    const f = flow.edges.find(x => x.id === e.id) || flow.surveyed_connectors.find(x => x.id === e.id);
    if (f && f.coordinates && f.coordinates.length > 2) {
      for (let i = 1; i < f.coordinates.length - 1; i++) {
        const p = coordToPx(f.coordinates[i]);
        inner.push(Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10);
      }
    }
  }
  edgeGeom.push(inner);
  edgeIds.push(e.id);
}

// 热度的归一化基准：全网单路段峰值人次最大值（与 flow 里的口径一致，都是 19220）
console.log(`道路类型: ${roadTypes.join(', ')}`);
console.log(`峰值流量基准 MAX_PEAK = ${MAX_PEAK}（图内实际最大 ${Math.max(...edges.map(e => e[3]))}）`);
console.log(`逐边几何: ${edgeGeom.filter(g => g.length).length} 条带中间点，共 ${edgeGeom.reduce((s, g) => s + g.length / 2, 0)} 个点`);

// 常用地点 -> 最近道路节点
const nearestNode = (lon, lat) => {
  let bi = -1, bd = Infinity;
  routable.forEach((f, i) => {
    const [nlon, nlat] = f.geometry.coordinates;
    const dx = (nlon - lon) * RAD * R * Math.cos(lat * RAD);
    const dy = (nlat - lat) * RAD * R;
    const d = dx * dx + dy * dy;
    if (d < bd) { bd = d; bi = i; }
  });
  return { i: bi, d: Math.round(Math.sqrt(bd) * 10) / 10 };
};

const places = [];
const pushPlace = (name, kind, i, snap, campus) => {
  if (i < 0) return;
  places.push({
    n: name,
    k: kind,
    i,
    c: CAMPUS_NAME[campus] || '未知',
    s: snap,
  });
};
for (const key of ['south', 'new']) {
  for (const d of flow.dorms[key]) {
    const r = nearestNode(...d.coordinates);
    pushPlace(d.name, '宿舍', r.i, r.d, key);
  }
}
const distBetween = (a, b) => Math.hypot(
  (b[0] - a[0]) * RAD * R * Math.cos(a[1] * RAD),
  (b[1] - a[1]) * RAD * R,
);
for (const [name, v] of Object.entries(flow.locations)) {
  const i = indexOf.get(v.road_node);
  if (i === undefined) { console.warn(`  教学点「${name}」的 road_node ${v.road_node} 不在路网中，已跳过`); continue; }
  const coord = coordById.get(v.road_node);
  pushPlace(name, '教学点', i, Math.round(distBetween(v.coordinates, coord) * 10) / 10, v.campus);
}
places.sort((a, b) => (a.k !== b.k ? (a.k === '宿舍' ? -1 : 1) : a.n.localeCompare(b.n, 'zh')));
const byCampus = {};
places.forEach(p => { byCampus[p.c] = (byCampus[p.c] || 0) + 1; });
console.log('地点校区分布:', JSON.stringify(byCampus));
console.log('地点吸附距离 最大:', Math.max(...places.map(p => p.s)).toFixed(1), 'm');

const payload = {
  meta: {
    generatedBy: 'tools/build-route-graph.js',
    source: 'graph-nodes/graph-edges/traffic-flow + traffic-heatmap.svg',
    projectionMeanErrPx: Math.round(proj.meanErrPx * 1000) / 1000,
    viewBox: [VIEW.w, VIEW.h],
    nodeCount: routable.length,
    edgeCount: edges.length,
    maxPeakPersonTrips: MAX_PEAK,
    componentSizes: sizes,
    campuses: Object.values(CAMPUS_NAME),
  },
  // px = S*(mercX(lon) - X0); py = S*(Y0 - mercY(lat))
  proj: [proj.S, proj.X0, proj.Y0],
  px,
  py,
  // 节点 id（与 px/py 同序）。课表类构建脚本要靠它把 dorm_node / road_node 换成下标
  nodeIds: routable.map(f => f.properties.id),
  comp,
  roadTypes,
  edges,
  edgeIds,
  edgeGeom,
  places,
};

const out = path.join(D, 'route-graph.js');
const body = `// 由 tools/build-route-graph.js 自动生成，请勿手工编辑。\n`
  + `// 节点 ${payload.meta.nodeCount} 个 / 路段 ${payload.meta.edgeCount} 条 / 投影误差 ${payload.meta.projectionMeanErrPx}px\n`
  + `module.exports = ${JSON.stringify(payload)};\n`;
fs.writeFileSync(out, body, 'utf8');

console.log(`\n已生成 ${path.relative(process.cwd(), out)}  ${(Buffer.byteLength(body) / 1024).toFixed(1)} KB`);
console.log(`  节点 ${payload.meta.nodeCount} / 路段 ${payload.meta.edgeCount} / 地点 ${places.length}`);
const withHeat = edges.filter(e => e[3] > 0).length;
console.log(`  有热度路段 ${withHeat} / ${edges.length}`);
console.log('  地点示例:', places.slice(0, 3).map(p => `${p.c}·${p.k}·${p.n}(节点${p.i}, ${p.s}m)`).join(' | '));
