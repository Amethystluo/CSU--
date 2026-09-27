/**
 * 用户上报的实时路况：数据模型、审核规则、以及"上报 -> 生效路况"的聚合。
 *
 * 本文件不依赖任何 wx.* 接口，纯逻辑，可在 Node 里直接测试。
 * 存储与云同步在 utils/reportStore.js 里（那里才用 wx API）。
 *
 * 设计要点：**上报不等于生效**。
 *   用户提交 -> status = 'pending'（待核实）
 *   管理员核实 -> 'verified'（属实，进入路由计算）或 'rejected'（不属实，丢弃）
 * 只有 verified 的上报才会改变路网，这样"后台可以直接筛选信息是否属实"是硬约束，
 * 而不是一句口号。
 */

/** 上报类别。affects 决定它怎么影响规划。 */
const CATEGORIES = [
  {
    key: 'closure', name: '施工 / 封路', short: '封', color: '#2b2b2b',
    affects: 'capacity', radius: 0, hint: '这条路走不通了',
  },
  {
    key: 'obstacle', name: '事故 / 障碍', short: '障', color: '#8a2bbf',
    affects: 'capacity', radius: 0, hint: '有事故或障碍物挡路',
  },
  {
    key: 'congestion', name: '异常拥堵', short: '堵', color: '#e8720c',
    affects: 'flow', radius: 60, hint: '这里堵得反常',
  },
  {
    key: 'police', name: '有交警', short: '警', color: '#1f5fd0',
    affects: 'penalty', radius: 60, hint: '有交警查车，想绕开',
  },
];

const CATEGORY_MAP = {};
CATEGORIES.forEach(c => { CATEGORY_MAP[c.key] = c; });

const STATUS = {
  pending: { key: 'pending', name: '待核实' },
  verified: { key: 'verified', name: '属实' },
  rejected: { key: 'rejected', name: '不属实' },
};

/** 一条"异常拥堵"上报把该路段的流量放大多少倍。 */
const CONGESTION_BOOST = 2.5;
/** 上报有效期（毫秒）：超过就自动失效，避免陈旧信息一直影响规划。 */
const REPORT_TTL_MS = 6 * 60 * 60 * 1000;   // 6 小时

function isValidCategory(key) {
  return !!CATEGORY_MAP[key];
}

/** 生成一个足够唯一的 id（不依赖 crypto）。 */
function newId(now) {
  const t = now || Date.now();
  return 'r' + t.toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}

/**
 * 构造一条上报记录。
 * @param {object} input {category, edges, x, y, roadType, edgeId, note, reporter}
 */
function createReport(input, now) {
  const cat = CATEGORY_MAP[input.category];
  if (!cat) throw new Error('未知的上报类别: ' + input.category);
  if (!input.edges || !input.edges.length) throw new Error('上报必须关联至少一条路段');
  const ts = now || Date.now();
  return {
    id: input.id || newId(ts),
    category: cat.key,
    edges: input.edges.slice(0, 5),
    x: input.x,
    y: input.y,
    roadType: input.roadType || '',
    edgeId: input.edgeId || '',
    note: (input.note || '').slice(0, 60),
    createdAt: ts,
    updatedAt: ts,
    status: input.status || 'pending',
    reporter: input.reporter || '匿名',
    source: input.source || 'local',
  };
}

/**
 * 点选页回传的上报结果 -> 一条上报记录。
 *
 * 路线页与模块二级页**都会**收到这个结果（谁在前台谁先接住），所以转换只写一份，
 * 免得两边字段对不上（例如一边带 note、一边忘了带）。
 * @returns {object|null} 数据不完整时返回 null
 */
function createFromPick(picked, now) {
  if (!picked || picked.action !== 'report') return null;
  try {
    return createReport({
      category: picked.category,
      edges: picked.edges,
      x: picked.x,
      y: picked.y,
      roadType: picked.roadType,
      edgeId: picked.edgeId,
      note: picked.note,
    }, now);
  } catch (e) {
    return null;
  }
}

/** 一条上报是否还在有效期内。 */
function isFresh(report, now) {
  const t = now || Date.now();
  return t - (report.createdAt || 0) <= REPORT_TTL_MS;
}

/**
 * 聚合出"生效路况"。这是路由真正消费的东西。
 *
 * @param {Array} reports 全部上报
 * @param {object} opts
 * @param {boolean} [opts.includePending] 是否把"待核实"也计入（演示/应急可用，默认否）
 * @param {number}  [opts.now] 当前时间，用于过期判断
 * @returns {{closed:Set, congestion:Map, police:Set, counts:object, expired:number}}
 */
function aggregate(reports, opts) {
  const o = opts || {};
  const includePending = !!o.includePending;
  const now = o.now || Date.now();
  const closed = new Set();
  const congestion = new Map();   // ei -> 流量倍数
  const police = new Set();
  const counts = { closure: 0, obstacle: 0, congestion: 0, police: 0, pending: 0, verified: 0, rejected: 0 };
  let expired = 0;

  for (const r of reports) {
    if (r.status === 'rejected') { counts.rejected++; continue; }
    if (!isFresh(r, now)) { expired++; continue; }
    if (r.status === 'pending') {
      counts.pending++;
      if (!includePending) continue;
    } else {
      counts.verified++;
    }
    const cat = CATEGORY_MAP[r.category];
    if (!cat) continue;
    counts[cat.key] = (counts[cat.key] || 0) + 1;
    for (const ei of r.edges || []) {
      if (cat.affects === 'capacity') {
        closed.add(ei);
      } else if (cat.affects === 'flow') {
        congestion.set(ei, Math.max(congestion.get(ei) || 1, CONGESTION_BOOST));
      } else if (cat.affects === 'penalty') {
        police.add(ei);
      }
    }
  }

  return { closed, congestion, police, counts, expired };
}

/** 把 Set 转成 router 需要的 Uint8Array 掩码。 */
function toMask(set, edgeCount) {
  const m = new Uint8Array(edgeCount);
  if (set) set.forEach(ei => { if (ei >= 0 && ei < edgeCount) m[ei] = 1; });
  return m;
}

/** 审核状态流转是否合法（避免误操作把已核实的随手改掉）。 */
function canTransition(from, to) {
  if (!STATUS[to]) return false;
  if (from === to) return false;
  return true;
}

/** 生成一句便于展示的路况摘要，例如「1 处施工 · 2 处交警」。 */
function summarize(agg) {
  const parts = [];
  if (agg.counts.closure) parts.push(`${agg.counts.closure} 处施工`);
  if (agg.counts.obstacle) parts.push(`${agg.counts.obstacle} 处障碍`);
  if (agg.counts.congestion) parts.push(`${agg.counts.congestion} 处异常拥堵`);
  if (agg.counts.police) parts.push(`${agg.counts.police} 处交警`);
  if (!parts.length) return agg.counts.pending ? `暂无生效路况（${agg.counts.pending} 条待核实）` : '暂无用户上报';
  return parts.join(' · ');
}

module.exports = {
  CATEGORIES,
  CATEGORY_MAP,
  STATUS,
  CONGESTION_BOOST,
  REPORT_TTL_MS,
  isValidCategory,
  newId,
  createReport,
  createFromPick,
  isFresh,
  aggregate,
  toMask,
  canTransition,
  summarize,
};
