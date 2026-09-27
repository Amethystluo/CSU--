/**
 * 路线规划核心：投影、最近节点/路段吸附、三种代价的最短路、以及可替换的"路网情景"。
 *
 * 本文件不依赖任何 wx.* 接口，因此既能在小程序里运行，也能被 Node 直接测试。
 * 数据来自 data/route-graph.js（由 tools/build-route-graph.js 生成）。
 *
 * 两种坐标：
 *   原始数据是经纬度（WGS84），画图用的是 SVG 像素坐标。
 *   构建阶段已拟合出投影 px = S*(mercX(lon)-X0), py = S*(Y0-mercY(lat))，平均误差 0.03px。
 *   吸附、规划、绘制全部在 SVG 像素坐标里做。
 *
 * 路网情景（scenario）：
 *   默认用数据里的基线流量；但也可以传入一份"改过的流量表 + 封路边集"，
 *   于是封路、下雨等情景都能在同一套算法上重算（见 utils/scenario.js）。
 */
const graph = require('../data/route-graph.js');

const R = 6378137;
const RAD = Math.PI / 180;
const [S, X0, Y0] = graph.proj;
const MAX_PEAK = graph.meta.maxPeakPersonTrips;
const EDGE_COUNT = graph.edges.length;

// ---------------------------------------------------------------- 电动自行车速度模型
/**
 * 各道路类型的电动自行车基准速度（米/分钟）。
 * 依据：校园电动自行车正常骑行 15~25 km/h（新国标限速 25 km/h），
 * 取各等级道路的典型巡航速度并折成米/分钟（1 km/h ≈ 16.7 m/min）：
 *   城市主干道/次干道路面宽、标线清晰 -> 22~24 km/h
 *   校内居住区道路、支路             -> 18~20 km/h
 *   人行道、绿地小径：按交规应推行或混行 -> 7 km/h
 * 这是经验取值，不是实测数据——要调只改这一张表。
 * 想换成步行模型，把这张表整体替换即可（步行约 62~82 m/min）。
 */
const ROAD_SPEED = {
  primary: 400,      // 24 km/h
  secondary: 383,    // 23 km/h
  tertiary: 367,     // 22 km/h
  residential: 333,  // 20 km/h
  unclassified: 317, // 19 km/h
  service: 300,      // 18 km/h
  track: 250,        // 15 km/h
  path: 200,         // 12 km/h
  footway: 117,      // 7 km/h：人行道，应推行/混行
};
const DEFAULT_SPEED = 300;

/**
 * 拥挤减速系数：路段"占用率"= 1（相当于基线最挤路段）时，车速下降 40%。
 * 这是本项目的建模假设（数据里没有实测通行速度）。
 */
const CROWD_SLOWDOWN = 0.4;
/** 速度最多降到基准的多少倍，避免极端占用算出不合理的慢速。 */
const MIN_SPEED_FACTOR = 0.4;
/** 占用率显示上限（封路/下雨会让某些路远超基线）。 */
const MAX_HEAT = 3.5;

/**
 * 由"流量 + 速度"自洽求解路段占用率与车速。
 *
 * 关键关系：路段上同一时刻有多少人，取决于 流量 ÷ 速度。
 *   占用率 occ ∝ 流量 N ÷ 车速 v
 *   车速   v   = 自由流速度 v_ff × 天气系数 w × (1 - K×occ)
 * 两者互相依赖，因此用不动点迭代求解（速度单调下降，必然收敛）。
 *
 * 这带来一个重要的现实效果：**下雨即使出行人数完全不变，只要速度下降，
 * 占用率就会上升，路网会明显变堵**——而不是"只把时间乘个系数"。
 *
 * @param {number} vff 该道路类型的自由流速度（米/分钟）
 * @param {number} w   天气/路况速度系数
 * @param {number} flow 该路段峰值人次（人/时段）
 * @returns {{occ:number, speed:number}} 占用率（1 ≈ 基线最挤水平）与车速
 */
function solveEdgeState(vff, w, flow) {
  let speed = vff * w;
  let occ = 0;
  for (let it = 0; it < 12; it++) {
    occ = (flow / MAX_PEAK) * (vff / speed);
    const factor = Math.max(MIN_SPEED_FACTOR, 1 - CROWD_SLOWDOWN * occ);
    const next = vff * w * factor;
    if (Math.abs(next - speed) < 1e-4) { speed = next; break; }
    speed = next;
  }
  occ = (flow / MAX_PEAK) * (vff / speed);
  return { occ, speed };
}

/** 某条路段的实际车速（米/分钟）——只按占用率算，供外部单独调用。 */
function speedOf(roadType, heat) {
  const base = ROAD_SPEED[roadType] || DEFAULT_SPEED;
  const h = Math.min(MAX_HEAT, Math.max(0, heat));
  const factor = Math.max(MIN_SPEED_FACTOR, 1 - CROWD_SLOWDOWN * h);
  return base * factor;
}

// ---------------------------------------------------------------- 三种出行偏好
/**
 * 三种模式共用同一套 Dijkstra，只是"边长"不同：
 *   shortest 边长 = 距离(米)          -> 距离最短
 *   fastest  边长 = 时间(分钟)        -> 时间最短（按电动车速 + 拥挤减速）
 *   quiet    边长 = 距离 ×(1+α×热度)  -> 最少人（愿意绕路换清净）
 */
const QUIET_ALPHA = 4;
/**
 * 交警规避的等效延误（分钟）：被拦下检查/罚款平均耽误的时间。
 * 用**固定延误**而不是"代价乘一个倍数"：乘倍数会随边长变化，
 * 短路段上惩罚小到足以忽略、长路段上又大到离谱；固定延误才符合"拦下就是耽误几分钟"。
 * 调大 → 更极力避开交警（可能绕很远）；调小 → 只在顺路时避开。
 */
const POLICE_DELAY_MINUTES = 3;
const MODES = [
  { key: 'quiet', name: '少人优先', unit: '米', desc: '按人流热度绕路，尽量避开高峰路段' },
  { key: 'fastest', name: '时间最短', unit: '分钟', desc: '按电动车实际骑行时间，含路型与拥挤减速' },
  { key: 'shortest', name: '距离最短', unit: '米', desc: '只看路程长短，不管路上挤不挤' },
];
const MODE_KEYS = MODES.map(m => m.key);
const isMode = k => MODE_KEYS.indexOf(k) >= 0;

const mercX = lon => R * lon * RAD;
const mercY = lat => R * Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2));

/** 经纬度 -> SVG 像素。 */
function project(lon, lat) {
  return [S * (mercX(lon) - X0), S * (Y0 - mercY(lat))];
}

/** 两点间的近似实际距离（米）。 */
function metersBetween(lon1, lat1, lon2, lat2) {
  const dx = (lon2 - lon1) * RAD * R * Math.cos(lat1 * RAD);
  const dy = (lat2 - lat1) * RAD * R;
  return Math.sqrt(dx * dx + dy * dy);
}

/** 基线流量表：每条边的绝对峰值人次（时间步人次）。 */
function baselinePeak() {
  const peak = new Float64Array(EDGE_COUNT);
  for (let i = 0; i < EDGE_COUNT; i++) peak[i] = graph.edges[i][3];
  return peak;
}

// ---------------------------------------------------------------- 路网构建
/**
 * 用一份流量表构建可路由网络。
 * 每条边的车速由「流量 + 速度」自洽求出（见 solveEdgeState），
 * 因此天气（速度系数）会通过占用率反过来加剧拥堵。
 *
 * @param {object} opts
 * @param {Float64Array|number[]} [opts.peak]  每条边的峰值人次；默认取基线
 * @param {Uint8Array|boolean[]} [opts.closed] 每条边是否封闭
 * @param {object|number} [opts.speedScale]    速度修正：数字=全局系数，对象=按路型系数
 * @param {Uint8Array|boolean[]} [opts.police] 每条边是否有交警（用户上报 + 审核通过）
 * @param {boolean} [opts.policeActive]        本次规划是否启用交警规避
 */
function buildNetwork(opts) {
  const o = opts || {};
  const peak = o.peak || baselinePeak();
  const closed = o.closed || null;
  const police = o.police || null;
  const scale = o.speedScale || null;
  const scaleOf = typeof scale === 'number'
    ? () => scale
    : (scale ? (t => (scale[t] === undefined ? 1 : scale[t])) : (() => 1));

  const n = graph.px.length;
  const adj = new Array(n);
  for (let i = 0; i < n; i++) adj[i] = [];

  // 逐边状态：占用率（≈拥堵程度）、车速、时间
  const occ = new Float64Array(EDGE_COUNT);
  const speed = new Float64Array(EDGE_COUNT);
  const time = new Float64Array(EDGE_COUNT);
  const freeTime = new Float64Array(EDGE_COUNT);

  for (let i = 0; i < EDGE_COUNT; i++) {
    const e = graph.edges[i];
    const len = e[2];
    const roadType = graph.roadTypes[e[4]];
    const vff = ROAD_SPEED[roadType] || DEFAULT_SPEED;
    const w = scaleOf(roadType);
    const isClosed = !!(closed && closed[i]);
    const flow = isClosed ? 0 : peak[i];

    const st = solveEdgeState(vff, w, flow);
    occ[i] = st.occ;
    speed[i] = st.speed;
    time[i] = len / st.speed;
    freeTime[i] = len / (vff * w);

    if (isClosed) continue;              // 封路：整条边从可路由图里移除
    const entry = {
      len, roadType, ei: i, flow,
      heat: st.occ,                      // 热度 = 占用率，用于配色与"少人"代价
      speed: st.speed,
      time: time[i],
      freeTime: freeTime[i],
      police: !!(police && police[i]),
    };
    adj[e[0]].push(Object.assign({ v: e[1] }, entry));
    adj[e[1]].push(Object.assign({ v: e[0] }, entry));
  }

  return {
    adj, peak, closed, speedScale: scale,
    occ, speed, time, freeTime,
    police, policeActive: !!o.policeActive,
  };
}

/** 复制一份路网，只切换"是否启用交警规避"——不需要重算流量，很便宜。 */
function withPolice(network, active) {
  return Object.assign({}, network, { policeActive: !!active });
}

let baselineCache = null;
function baselineNetwork() {
  if (!baselineCache) baselineCache = buildNetwork({});
  return baselineCache;
}

/**
 * 按模式取一条边的代价；启用交警规避时，有交警的路段再加一份"等效延误"。
 * 三种模式的代价单位不同（米 / 分钟 / 米），所以按该路段的实际车速把
 * 「被拦下耽误 N 分钟」折算成当前模式的等效量，保证三种走法的规避倾向一致。
 */
function edgeCost(edge, mode, network) {
  let c;
  if (mode === 'shortest') c = edge.len;
  else if (mode === 'fastest') c = edge.time;
  else c = edge.len * (1 + QUIET_ALPHA * edge.heat);
  if (network && network.policeActive && edge.police) {
    c += mode === 'fastest'
      ? POLICE_DELAY_MINUTES
      : POLICE_DELAY_MINUTES * edge.speed;
  }
  return c;
}

// ---------------------------------------------------------------- 吸附
/** 找到离 SVG 像素点最近的路网节点。 */
function nearestNode(x, y) {
  const px = graph.px, py = graph.py;
  let best = 0, bd = Infinity;
  for (let i = 0; i < px.length; i++) {
    const dx = px[i] - x, dy = py[i] - y;
    const d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = i; }
  }
  return {
    index: best,
    distanceMeters: Math.sqrt(bd) / S,   // 投影等比，1 米 = S 像素
    component: graph.comp[best],
    x: px[best],
    y: py[best],
  };
}

/** 由经纬度直接吸附到最近节点。 */
function nearestNodeByLonLat(lon, lat) {
  const xy = project(lon, lat);
  const hit = nearestNode(xy[0], xy[1]);
  const dx = (hit.x - xy[0]) / S;
  const dy = (hit.y - xy[1]) / S;
  hit.snapMeters = Math.round(Math.sqrt(dx * dx + dy * dy) * 10) / 10;
  hit.svgPoint = xy;
  return hit;
}

// ---------------------------------------------------------------- 给一个坐标起个"人话"名字
/**
 * 定位回来的是一串经纬度，直接显示对用户没有意义（"当前位置 28.16278, 112.93324"）。
 * 这里用「常用地点」给坐标命名：58 个宿舍 / 教学点覆盖了校区主要区域，
 * 取最近的那个，按距离远近决定措辞：
 *   ≤150 m   「升华学生公寓 7 栋」          —— 基本就在这个地点
 *   ≤600 m   「升华学生公寓 7 栋附近」       —— 在这个地点一带
 *   更远     「距升华学生公寓 7 栋约 820 米」  —— 说清离哪个地标多远
 * 经纬度仍然保留在 `coord` 里，需要核对时还能看到。
 */
const NEAR_PLACE_M = 150;
const AROUND_PLACE_M = 600;

/** 离某个 SVG 像素点最近的常用地点。 */
function nearestPlace(x, y) {
  const px = graph.px, py = graph.py, places = graph.places;
  let best = null, bd = Infinity;
  for (let i = 0; i < places.length; i++) {
    const p = places[i];
    const dx = px[p.i] - x, dy = py[p.i] - y;
    const d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = p; }
  }
  if (!best) return null;
  return { place: best, distanceMeters: Math.sqrt(bd) / S };
}

/**
 * SVG 像素点 + 原始经纬度 -> 可读地点名。
 * @returns {{label:string, detail:string, coord:string, place:object|null, distanceMeters:number|null}}
 */
function describePoint(x, y, lon, lat) {
  const hit = nearestPlace(x, y);
  const lat5 = Number(lat).toFixed(5);
  const lon5 = Number(lon).toFixed(5);
  if (!hit) {
    return { label: '当前位置', detail: '附近没有已收录的地点', coord: `${lat5}, ${lon5}`, place: null, distanceMeters: null };
  }
  const d = hit.distanceMeters;
  const name = hit.place.n;
  let label;
  if (d <= NEAR_PLACE_M) label = name;
  else if (d <= AROUND_PLACE_M) label = name + '附近';
  else if (d < 1000) label = `距${name}约 ${Math.max(10, Math.round(d / 10) * 10)} 米`;
  else label = `距${name}约 ${(d / 1000).toFixed(1)} 公里`;
  return {
    label,
    // 名称已经在 label 里了，这里只补充「哪个校区 / 什么类型 / 精确距离」
    detail: `${hit.place.c} · ${hit.place.k} · 距该地点约 ${Math.round(d)} 米`,
    coord: `${lat5}, ${lon5}`,
    place: hit.place,
    distanceMeters: d,
  };
}

/** 经纬度 -> 可读地点名（内部会做一次投影）。 */
function describeLonLat(lon, lat) {
  const xy = project(lon, lat);
  return describePoint(xy[0], xy[1], lon, lat);
}

/** 一条边的完整折线（首尾是节点，中间点来自 edgeGeom）。 */
function edgePoints(ei) {
  const e = graph.edges[ei];
  const inner = graph.edgeGeom[ei] || [];
  const pts = [[graph.px[e[0]], graph.py[e[0]]]];
  for (let i = 0; i + 1 < inner.length; i += 2) pts.push([inner[i], inner[i + 1]]);
  pts.push([graph.px[e[1]], graph.py[e[1]]]);
  return pts;
}

/** 点到线段的距离（SVG 像素）。 */
function pointSegDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy));
}

/**
 * 找到离 SVG 像素点最近的路段（用于"在地图上点一条路封掉"）。
 * @param {Uint8Array} [skipClosed] 已经封掉的路段不再返回
 */
function nearestEdge(x, y, skipClosed) {
  let best = -1, bd = Infinity;
  for (let ei = 0; ei < EDGE_COUNT; ei++) {
    if (skipClosed && skipClosed[ei]) continue;
    const pts = edgePoints(ei);
    for (let i = 0; i + 1 < pts.length; i++) {
      const d = pointSegDistance(x, y, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
      if (d < bd) { bd = d; best = ei; }
    }
  }
  return {
    index: best,
    distanceMeters: bd / S,
    roadType: best >= 0 ? graph.roadTypes[graph.edges[best][4]] : null,
    peak: best >= 0 ? graph.edges[best][3] : 0,
    length: best >= 0 ? graph.edges[best][2] : 0,
    id: best >= 0 ? graph.edgeIds[best] : null,
    midX: best >= 0 ? edgeMidpoint(best)[0] : 0,
    midY: best >= 0 ? edgeMidpoint(best)[1] : 0,
  };
}

/**
 * 找到离某个点一定半径内的所有路段（用于"上报路况"关联到一段路）。
 * @param {number} radiusMeters 半径（米）；0 或省略表示只要最近那一条
 */
function nearestEdges(x, y, radiusMeters, limit) {
  const all = [];
  for (let ei = 0; ei < EDGE_COUNT; ei++) {
    const pts = edgePoints(ei);
    let bd = Infinity;
    for (let i = 0; i + 1 < pts.length; i++) {
      const d = pointSegDistance(x, y, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
      if (d < bd) bd = d;
    }
    all.push({ ei, distanceMeters: bd / S });
  }
  all.sort((a, b) => a.distanceMeters - b.distanceMeters);
  const r = radiusMeters || 0;
  const hit = r > 0 ? all.filter(e => e.distanceMeters <= r) : all.slice(0, 1);
  return limit ? hit.slice(0, limit) : hit;
}

/** 一条边的中点，用于在图上标注。 */function edgeMidpoint(ei) {
  const pts = edgePoints(ei);
  // 按弧长取中点，长短边都落在中间
  let total = 0;
  const segs = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const d = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    segs.push(d); total += d;
  }
  let acc = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    if (acc + segs[i] >= total / 2) {
      const t = segs[i] > 0 ? (total / 2 - acc) / segs[i] : 0;
      return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t];
    }
    acc += segs[i];
  }
  return pts[0];
}

// ---------------------------------------------------------------- 最小堆
function Heap() {
  this.a = [];
}
Heap.prototype.push = function (item) {
  const a = this.a;
  a.push(item);
  let i = a.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (a[p][0] <= a[i][0]) break;
    const t = a[p]; a[p] = a[i]; a[i] = t;
    i = p;
  }
};
Heap.prototype.pop = function () {
  const a = this.a;
  if (a.length === 0) return null;
  const top = a[0];
  const last = a.pop();
  if (a.length) {
    a[0] = last;
    let i = 0;
    for (;;) {
      const l = i * 2 + 1, r = l + 1;
      let m = i;
      if (l < a.length && a[l][0] < a[m][0]) m = l;
      if (r < a.length && a[r][0] < a[m][0]) m = r;
      if (m === i) break;
      const t = a[m]; a[m] = a[i]; a[i] = t;
      i = m;
    }
  }
  return top;
};

/**
 * Dijkstra 最短路。
 * @param {object} network buildNetwork() 的结果
 * @param {number} start 起点节点下标
 * @param {number} dest  终点节点下标
 * @param {string} mode  'shortest' | 'fastest' | 'quiet'
 */
function planOn(network, start, dest, mode) {
  const n = graph.px.length;
  if (start < 0 || start >= n || dest < 0 || dest >= n) {
    return { ok: false, reason: '节点下标越界' };
  }
  if (start === dest) {
    return { ok: false, reason: '起点和终点是同一个位置，请重新选择' };
  }
  const m = isMode(mode) ? mode : 'quiet';
  const adj = network.adj;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  dist[start] = 0;
  const heap = new Heap();
  heap.push([0, start]);

  while (heap.a.length) {
    const top = heap.pop();
    const u = top[1];
    if (done[u]) continue;
    done[u] = 1;
    if (u === dest) break;
    const list = adj[u];
    for (let k = 0; k < list.length; k++) {
      const e = list[k];
      if (done[e.v]) continue;
      const nd = dist[u] + edgeCost(e, m, network);
      if (nd < dist[e.v]) {
        dist[e.v] = nd;
        prev[e.v] = u;
        heap.push([nd, e.v]);
      }
    }
  }

  if (!done[dest]) {
    const otherComp = graph.comp[start] !== graph.comp[dest];
    return {
      ok: false,
      reason: otherComp
        ? '起点与目的地在现有路网里不连通（缺少连接道路）'
        : '没有找到可行路径（可能被封闭的路段切断了）',
      unreachable: true,
    };
  }

  const path = [];
  let cur = dest;
  while (cur !== -1) { path.push(cur); cur = prev[cur]; }
  path.reverse();

  const result = {
    ok: true,
    path,
    mode: m,
    modeName: (MODES.find(x => x.key === m) || {}).name,
    projectedCost: dist[dest],
  };
  return Object.assign(result, metricsOfOn(network, path));
}

/** 便捷版：用基线路网规划。 */
function plan(start, dest, mode) {
  return planOn(baselineNetwork(), start, dest, mode);
}

/** 在给定路网上算三种模式。 */
function planAllOn(network, start, dest) {
  const out = {};
  for (const m of MODES) out[m.key] = planOn(network, start, dest, m.key);
  return out;
}

/** 便捷版：用基线路网算三种模式。 */
function planAll(start, dest) {
  return planAllOn(baselineNetwork(), start, dest);
}

/** 计算一条路径在给定路网上的距离、时间、人流与拥堵指标。 */
function metricsOfOn(network, path) {
  const adj = network.adj;
  let distance = 0;
  let time = 0;        // 实际耗时（含拥挤与天气），单位分钟
  let freeTime = 0;    // 同样天气下完全不拥挤的耗时
  let flowMeters = 0;  // Σ(长度 × 人次)，用于算加权平均同行人数
  let occMeters = 0;   // Σ(长度 × 占用率)，用于算加权平均拥堵程度
  let maxFlow = 0;
  let maxOcc = 0;
  let congestedSegments = 0;
  let policeSegments = 0;
  const usedEdges = [];

  for (let i = 0; i + 1 < path.length; i++) {
    const u = path[i], v = path[i + 1];
    let found = null;
    for (let k = 0; k < adj[u].length; k++) if (adj[u][k].v === v) { found = adj[u][k]; break; }
    if (!found) continue;   // 理论上不会发生
    distance += found.len;
    time += found.time;
    freeTime += found.freeTime;
    flowMeters += found.len * found.flow;
    occMeters += found.len * found.heat;
    if (found.flow > maxFlow) maxFlow = found.flow;
    if (found.heat > maxOcc) maxOcc = found.heat;
    if (found.heat >= 0.5) congestedSegments++;
    if (found.police) policeSegments++;
    usedEdges.push({
      u, v, ei: found.ei, len: found.len, flow: found.flow, heat: found.heat,
      roadType: found.roadType, time: found.time, freeTime: found.freeTime,
      speed: found.speed, police: !!found.police,
    });
  }

  const avgFlow = distance > 0 ? flowMeters / distance : 0;
  const avgOcc = distance > 0 ? occMeters / distance : 0;
  const byRoadType = {};
  for (const e of usedEdges) {
    byRoadType[e.roadType] = Math.round((byRoadType[e.roadType] || 0) + e.len);
  }

  return {
    distanceMeters: Math.round(distance),
    timeMinutes: Math.round(time * 10) / 10,
    freeFlowTimeMinutes: Math.round(freeTime * 10) / 10,
    crowdDelayMinutes: Math.round((time - freeTime) * 10) / 10,
    // 同行人数：按长度加权的平均人次（人/时段）
    avgHeatPersons: Math.round(avgFlow),
    maxHeatPersons: Math.round(maxFlow),
    // 拥堵程度：按长度加权的平均占用率，1.0 ≈ 基线最挤路段的水平
    avgCongestion: Math.round(avgOcc * 100) / 100,
    maxCongestion: Math.round(maxOcc * 100) / 100,
    congestedSegments,
    policeSegments,
    segmentCount: usedEdges.length,
    byRoadType,
    usedEdges,
  };
}

/** 便捷版：按基线路网算指标。 */
function metricsOf(path) {
  return metricsOfOn(baselineNetwork(), path);
}

/** 把节点下标路径转成 SVG 像素折线，供画布绘制。 */
function pathToPoints(path) {
  const pts = [];
  for (let i = 0; i < path.length; i++) pts.push([graph.px[path[i]], graph.py[path[i]]]);
  return pts;
}

/** 常用地点的展示名，例如「新校区 · 宿舍 · 升华学生公寓 7 栋」。 */
function placeLabel(p) {
  return p.c + ' · ' + p.k + ' · ' + p.n;
}

/** 把分钟数格式化成「1 小时 5 分钟」这种便于阅读的形式。 */
function formatDuration(minutes) {
  const total = Math.max(1, Math.round(minutes));
  if (total < 60) return total + ' 分钟';
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
}

module.exports = {
  graph,
  MODES,
  MODE_KEYS,
  QUIET_ALPHA,
  CROWD_SLOWDOWN,
  MAX_HEAT,
  POLICE_DELAY_MINUTES,
  ROAD_SPEED,
  DEFAULT_SPEED,
  MAX_PEAK,
  EDGE_COUNT,
  speedOf,
  project,
  metersBetween,
  baselinePeak,
  heatArray: peak => {
    // 兼容旧调用：纯流量归一化（不含速度反馈）
    const h = new Float64Array(peak.length);
    for (let i = 0; i < peak.length; i++) h[i] = peak[i] / MAX_PEAK;
    return h;
  },
  solveEdgeState,
  buildNetwork,
  withPolice,
  baselineNetwork,
  nearestNode,
  nearestNodeByLonLat,
  NEAR_PLACE_M,
  AROUND_PLACE_M,
  nearestPlace,
  describePoint,
  describeLonLat,
  nearestEdge,
  nearestEdges,
  edgePoints,
  edgeMidpoint,
  plan,
  planOn,
  planAll,
  planAllOn,
  metricsOf,
  metricsOfOn,
  pathToPoints,
  placeLabel,
  formatDuration,
};
