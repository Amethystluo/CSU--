/**
 * 情景引擎：把"下雨"和"施工封路"折算成一张新的路段流量表，从而得到新的热度图。
 *
 * 【为什么需要它】
 * 基线热度是离线仿真一次算好、固化成文件的（仿真程序不在本仓库里），
 * 所以在小程序里换天气、加封路，不可能重跑原始仿真。这里采用两个透明、可解释的步骤：
 *
 *   1. 天气：对既有流量乘一个"需求系数"，对各道路类型的车速乘一个"路面系数"。
 *   2. 封路：把被封闭路段原有的流量，按"增量分配法"重新分配到替代路径上，
 *      替代路径会随着流量增加而变慢，于是自然出现新的拥堵点（级联效应）。
 *
 * 【必须说明的局限】
 * 这是"局部重分配"：只重分配被封路段原有的流量，其余路段保持基线。
 * 完整的做法需要 OD 矩阵（起讫点矩阵）来做全网络用户均衡，而 OD 矩阵不在数据里。
 * 因此本模块的结果是"情景推演"，不是实测预测；所有系数都集中在下方表格里，可随时校准。
 */
const router = require('./router.js');

const graph = router.graph;
const EDGE_COUNT = router.EDGE_COUNT;
const MAX_PEAK = router.MAX_PEAK;

// ---------------------------------------------------------------- 天气情景
/**
 * 三档天气情景的系数表。
 * demand：出行需求系数（下雨会有一部分人推迟/取消出行）——**假设值**。
 * speed ：按道路类型的车速系数。依据是"湿滑路面刹车距离变长、要减速慢行"，
 *         越窄越滑的路（人行道、小径）降得越多，有遮蔽的内部通道降得最少——**假设值**。
 */
const WEATHER_LEVELS = {
  none: {
    key: 'none', name: '晴/多云', demand: 1.0, speed: null,
  },
  light: {
    key: 'light', name: '小雨', demand: 0.98,
    speed: {
      primary: 0.85, secondary: 0.85, tertiary: 0.87,
      residential: 0.90, unclassified: 0.90, service: 0.92,
      track: 0.80, path: 0.80, footway: 0.75,
    },
  },
  heavy: {
    key: 'heavy', name: '中到大雨', demand: 0.94,
    speed: {
      primary: 0.72, secondary: 0.72, tertiary: 0.75,
      residential: 0.80, unclassified: 0.80, service: 0.85,
      track: 0.65, path: 0.65, footway: 0.55,
    },
  },
};

const WEATHER_ASSUMPTION = '雨天系数为可解释的假设值（路面湿滑减速 + 少量出行取消），非实测数据；'
  + '需求变化没有数据支撑，仅作情景推演。';

/**
 * WMO 天气编码 -> 情景档位。
 * 编码含义见 Open-Meteo 文档：0~3 晴到阴，45/48 雾，51~57 毛毛雨，
 * 61~67 雨（61 小 / 63 中 / 65 大 / 66~67 冻雨），71~77 雪，80~82 阵雨，95~99 雷雨。
 */
function levelFromWeatherCode(code, precipitation) {
  const c = Number(code);
  if (!isFinite(c)) {
    // 没有编码时退回用降水量判断（毫米）
    const p = Number(precipitation) || 0;
    if (p <= 0) return 'none';
    return p < 2.5 ? 'light' : 'heavy';
  }
  if (c <= 3) return 'none';
  if (c === 45 || c === 48) return 'light';                 // 雾
  if (c >= 51 && c <= 57) return 'light';                   // 毛毛雨/冻毛毛雨
  if (c === 61 || c === 80) return 'light';                 // 小雨/小阵雨
  if (c === 63 || c === 81) return 'heavy';                 // 中雨/中等阵雨
  if (c === 65 || c === 82) return 'heavy';                 // 大雨/强阵雨
  if (c === 66 || c === 67) return 'heavy';                 // 冻雨
  if (c >= 71 && c <= 77) return 'heavy';                   // 雪
  if (c >= 85 && c <= 86) return 'heavy';                   // 阵雪
  if (c >= 95) return 'heavy';                              // 雷雨
  return 'none';
}

/** 把天气编码翻译成人话，用于界面显示。 */
function weatherText(code) {
  const c = Number(code);
  if (!isFinite(c)) return '未知';
  if (c === 0) return '晴';
  if (c === 1) return '少云';
  if (c === 2) return '多云';
  if (c === 3) return '阴';
  if (c === 45 || c === 48) return '雾';
  if (c >= 51 && c <= 55) return '毛毛雨';
  if (c === 56 || c === 57) return '冻毛毛雨';
  if (c === 61) return '小雨';
  if (c === 63) return '中雨';
  if (c === 65) return '大雨';
  if (c === 66 || c === 67) return '冻雨';
  if (c >= 71 && c <= 75) return '雪';
  if (c === 77) return '米雪';
  if (c === 80) return '小阵雨';
  if (c === 81) return '阵雨';
  if (c === 82) return '强阵雨';
  if (c === 85 || c === 86) return '阵雪';
  if (c === 95) return '雷阵雨';
  if (c === 96 || c === 99) return '雷阵雨伴冰雹';
  return '未知';
}

// ---------------------------------------------------------------- 封路重分配
/**
 * 增量分配法（Incremental Assignment）：
 * 把每条封闭路段原有的流量切成若干份，逐份分配到"当前最快的替代路径"上，
 * 每分配一份就更新一次路网拥堵程度，于是后续份额会被挤到别的路上，
 * 从而避免"所有流量都堆到同一条替代路"这种不符合实际的结果。
 */
const ASSIGN_SLICES = 6;

/**
 * 应用情景，返回新的流量表与拥堵报告。
 * @param {object} opts
 * @param {string} [opts.level]        天气档位 none|light|heavy
 * @param {number[]} [opts.closedEdges] 要封闭的路段下标（手动封路 + 用户上报）
 * @param {Map|object} [opts.congestion] 异常拥堵上报：路段下标 -> 流量倍数
 * @param {number[]} [opts.policeEdges]  有交警的路段下标（只影响代价，不影响流量）
 * @param {boolean} [opts.avoidPolice]  本次规划是否启用交警规避
 * @param {Float64Array} [opts.basePeak] 该时段的基线流量；不传则用最高峰时段
 * @param {number} [opts.slices]       增量分配的份数
 */
function applyScenario(opts) {
  const o = opts || {};
  const level = WEATHER_LEVELS[o.level] ? o.level : 'none';
  const weather = WEATHER_LEVELS[level];
  // 注意 Number()：`closed` 是 Uint8Array，用**字符串**下标（例如 '397'）赋值会被静默忽略
  // （既不报错也不生效），于是"封了路但热度图没变"。宁可在入口把下标收成数字。
  // 空值要单独挡掉：Number(null) === 0、Number('') === 0，会把"没有下标"当成 0 号路段。
  const toIndex = ei => {
    if (ei === null || ei === undefined || ei === '' || typeof ei === 'boolean') return -1;
    const n = Number(ei);
    return isFinite(n) && n >= 0 && n < EDGE_COUNT ? Math.floor(n) : -1;
  };
  const closedEdges = (o.closedEdges || []).map(toIndex).filter(ei => ei >= 0);
  const policeEdges = (o.policeEdges || []).map(toIndex).filter(ei => ei >= 0);
  const slices = o.slices || ASSIGN_SLICES;
  // 时段基线：最高峰时段（原始数据）或课表推算出的某个换课时段
  const base = o.basePeak && o.basePeak.length === EDGE_COUNT ? o.basePeak : null;

  // 异常拥堵上报：把这些路的流量放大，占用率随之上升、车速下降
  const congestion = o.congestion || null;
  const boostOf = ei => {
    if (!congestion) return 1;
    const v = typeof congestion.get === 'function' ? congestion.get(ei) : congestion[ei];
    return v && v > 1 ? v : 1;
  };

  const basePeak = base || router.baselinePeak();
  // 1) 天气的需求系数先作用在基线上
  const peak = new Float64Array(EDGE_COUNT);
  for (let i = 0; i < EDGE_COUNT; i++) peak[i] = basePeak[i] * weather.demand;

  const closed = new Uint8Array(EDGE_COUNT);
  for (const ei of closedEdges) closed[ei] = 1;

  // 2) 被封闭路段：流量清零，并记下需要转移多少（含拥堵放大后的量）
  const pending = [];
  for (const ei of closedEdges) {
    const boosted = peak[ei] * boostOf(ei);
    if (boosted > 0) pending.push({ ei, from: graph.edges[ei][0], to: graph.edges[ei][1], flow: boosted });
    peak[ei] = 0;
  }

  // 3) 异常拥堵：未被封闭的路段按倍数放大流量
  for (let i = 0; i < EDGE_COUNT; i++) {
    if (closed[i]) continue;
    const b = boostOf(i);
    if (b > 1) peak[i] *= b;
  }

  const policeMask = new Uint8Array(EDGE_COUNT);
  for (const ei of policeEdges) policeMask[ei] = 1;

  // 4) 增量分配
  let unassigned = 0;
  let assignRounds = 0;
  for (const p of pending) {
    const per = p.flow / slices;
    for (let s = 0; s < slices; s++) {
      const net = router.buildNetwork({ peak, closed, speedScale: weather.speed, police: policeMask });
      const r = router.planOn(net, p.from, p.to, 'fastest');
      assignRounds++;
      if (!r.ok) { unassigned += per; continue; }
      for (const used of r.usedEdges) peak[used.ei] += per;
    }
  }

  const network = router.buildNetwork({
    peak, closed, speedScale: weather.speed,
    police: policeMask, policeActive: !!o.avoidPolice,
  });
  return {
    level,
    weather,
    closedEdges,
    closed,
    policeEdges,
    policeMask,
    avoidPolice: !!o.avoidPolice,
    peak,
    basePeak,
    network,
    unassignedFlow: Math.round(unassigned),
    assignRounds,
    ...congestionReport(basePeak, peak, network, closed, weather.demand),
  };
}

/**
 * 拥堵报告：对比基线与情景，找出新增堵点。
 *
 * 注意两个量不一样：
 *   流量 flow（人/时段）——有多少人经过，封路会改变它；
 *   占用率 occ（拥堵程度）——同一时刻路上有多挤，由 流量÷速度 决定，
 *   所以下雨即使人数不变，占用率也会上升。
 */
/**
 * 基线网络的占用率必须由**同一份流量**算出来。
 *
 * 踩过的坑：原来这里无条件用 `router.baselineNetwork()`（= 每条边各自最忙时段拼起来的
 * 包络，全天最挤的极限值）。当调用方传了某个换课时段的 basePeak 时，
 * 「拥堵指数 = 本时段占用率 / 包络占用率」就必然远小于 1，
 * 于是"下大雨"反而显示拥堵指数 0.22 —— 明明变堵了，指数却在下降。
 * 现在改成拿传进来的 basePeak（无天气、无封路）算基线：
 *   指数 = 本时段+情景的占用率 ÷ 本时段无情景的占用率，
 *   >1 就是真的更堵了。不传 basePeak 时 basePeak 就是基线峰值，
 *  结果与 `router.baselineNetwork()` 完全一致（向后兼容）。
 */
const baselineNetCache = new WeakMap();
function baselineNetworkFor(basePeak) {
  if (basePeak && typeof basePeak === 'object') {
    let hit = baselineNetCache.get(basePeak);
    if (!hit) {
      hit = router.buildNetwork({ peak: basePeak });
      baselineNetCache.set(basePeak, hit);
    }
    return hit;
  }
  return router.baselineNetwork();
}

function congestionReport(basePeak, peak, network, closed, demand) {
  const baseNet = baselineNetworkFor(basePeak);
  const changed = [];
  let baseFlowSum = 0, newFlowSum = 0;
  let baseOccLen = 0, newOccLen = 0;
  let increased = 0, decreased = 0, newHotspots = 0, aggravated = 0, eased = 0;

  for (let i = 0; i < EDGE_COUNT; i++) {
    const b = basePeak[i];
    const n = peak[i];
    const len = graph.edges[i][2];
    const occBase = baseNet.occ[i];
    const occNow = network.occ[i];

    baseFlowSum += b;
    newFlowSum += n;
    baseOccLen += occBase * len;
    newOccLen += occNow * len;

    const deltaFlow = n - b;
    const occDelta = occNow - occBase;
    if (deltaFlow > 1) increased++;
    else if (deltaFlow < -1) decreased++;
    // 明显变堵 / 明显变松：占用率变化超过 0.1
    if (occDelta > 0.1) aggravated++;
    if (occDelta < -0.1) eased++;
    // 新堵点：本来通畅（<0.3），现在接近基线最挤水平（>0.5）
    if (occBase < 0.3 && occNow > 0.5) newHotspots++;

    // "变化明显"的判定：流量变了，或者占用率明显变了（下雨会走这条分支）
    if (Math.abs(deltaFlow) > 1 || Math.abs(occDelta) > 0.03) {
      changed.push({
        ei: i,
        id: graph.edgeIds[i],
        roadType: graph.roadTypes[graph.edges[i][4]],
        length: Math.round(len),
        base: Math.round(b),
        now: Math.round(n),
        delta: Math.round(deltaFlow),
        occBase: Math.round(occBase * 100) / 100,
        occNow: Math.round(occNow * 100) / 100,
        occDelta: Math.round(occDelta * 100) / 100,
        heatBase: occBase,
        heatNow: occNow,
        closed: !!(closed && closed[i]),
      });
    }
  }

  // 最堵的：按占用率增量排序（这是"新增拥堵"最直接的指标）
  const byOcc = changed.slice().sort((a, b) => b.occDelta - a.occDelta);
  const worst = byOcc.slice(0, 5);
  const relief = byOcc.slice(-3).reverse().filter(c => c.occDelta < 0);

  return {
    changedCount: changed.length,
    increased,
    decreased,
    newHotspots,
    aggravated,
    eased,
    worst,
    relief,
    // 全网拥堵指数：按长度加权的平均占用率相对基线（同一时段的基线）
    // 基线本身没有车流时（周末/非换课时段），"相对指数"没有意义：
    // 此时 0 表示确实无拥堵，1 表示凭空出现了车流。
    congestionIndex: baseOccLen > 0
      ? Math.round((newOccLen / baseOccLen) * 100) / 100
      : (newOccLen > 0 ? 1 : 0),
    avgOccBase: Math.round((baseOccLen / totalLen()) * 100) / 100,
    avgOccNow: Math.round((newOccLen / totalLen()) * 100) / 100,
    totalFlowBase: Math.round(baseFlowSum),
    totalFlowNow: Math.round(newFlowSum),
    demandFactor: demand,
  };
}

let totalLenCache = null;
function totalLen() {
  if (totalLenCache === null) {
    let s = 0;
    for (let i = 0; i < EDGE_COUNT; i++) s += graph.edges[i][2];
    totalLenCache = s;
  }
  return totalLenCache;
}

/** 供界面展示的情景摘要文案。 */
function describeScenario(result) {
  const parts = [];
  if (result.level !== 'none') parts.push(result.weather.name);
  if (result.closedEdges.length) parts.push(`封闭 ${result.closedEdges.length} 条路段`);
  if (result.policeEdges && result.policeEdges.length) {
    parts.push(`${result.policeEdges.length} 处交警${result.avoidPolice ? '（已绕行）' : ''}`);
  }
  if (!parts.length) return '基线情景（无雨、无施工、无上报）';
  return parts.join(' · ');
}

module.exports = {
  WEATHER_LEVELS,
  WEATHER_ASSUMPTION,
  ASSIGN_SLICES,
  levelFromWeatherCode,
  weatherText,
  applyScenario,
  describeScenario,
};
