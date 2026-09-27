/**
 * 事件模型：「谁、什么时候、去哪、有多少人」，以及它如何改变路网流量。
 *
 * 为什么单独成一个东西：以前特殊情况只有"下雨 / 封路"这类**环境**因素，
 * 而校运会、双选会、考试这类**活动**是另一类事实——它会凭空产生一批出行需求，
 * 而且需求的**来源**（哪些院系、哪些年级、住哪栋楼）是明确的。
 * 所以事件不是写在页面里的几个开关，而是有结构的数据：
 *
 *   { 名称, 类型, 日期, 起止时间, 场馆, 参加人群(年级 × 专业), 预计人数 }
 *     -> 解析成"从哪些宿舍出发、各多少人"
 *     -> 每栋宿舍到场馆各跑一次最短路（宿舍只有 35 个，手机上很快）
 *     -> 得到一条"事件流量曲线"，叠加到课表基线上
 *
 * 数据来源：
 *   data/people-index.js  班级名 -> 专业 / 年级 / 宿舍 + 人数（1090 班 -> 944 行）
 *   data/landmarks.js     124 个地标 -> 路网节点（校运会 -> 新校体育场"鸟巢"西门）
 *
 * 这个文件不依赖任何 wx.*，可以直接被 Node 测试。
 */
const peopleIndex = require('../data/people-index.js');
const landmarks = require('../data/landmarks.js');
const router = require('./router.js');

const EDGE_COUNT = router.EDGE_COUNT;
// 宿舍在索引里存的是**路网节点 id**（和 assignments.dorm_node 一致），
// 路由需要的是节点下标，所以先建一张 id -> 下标 的表。
const NODE_BY_ID = new Map((router.graph.nodeIds || []).map((id, i) => [id, i]));

/**
 * 活动类型：给出"到场提前量"和默认时长。
 * 这些是**可解释的经验值**（集中入场的活动提前量更大），不是实测数据，集中在这里便于校准。
 */
const EVENT_TYPES = [
  { key: 'sports', name: '校运会 / 体育比赛', leadMin: 40, start: '08:00', end: '17:00', hint: '集中入场，开场前约 40 分钟是入场高峰' },
  { key: 'jobfair', name: '双选会 / 招聘会', leadMin: 20, start: '09:00', end: '16:00', hint: '分批入场，高峰相对平缓' },
  { key: 'exam', name: '考试', leadMin: 20, start: '09:00', end: '11:00', hint: '开考前 20 分钟集中到场' },
  { key: 'lecture', name: '大型讲座 / 报告', leadMin: 30, start: '14:00', end: '16:00', hint: '开场前 30 分钟集中到场' },
  { key: 'show', name: '文艺演出 / 晚会', leadMin: 30, start: '19:00', end: '21:00', hint: '开场前 30 分钟集中到场，散场更集中' },
  { key: 'assembly', name: '集会 / 升旗', leadMin: 20, start: '07:00', end: '07:40', hint: '时间很短，来去都很集中' },
  { key: 'other', name: '其它活动', leadMin: 30, start: '09:00', end: '17:00', hint: '' },
];
const TYPE_MAP = {};
EVENT_TYPES.forEach(t => { TYPE_MAP[t.key] = t; });
function typeOf(key) { return TYPE_MAP[key] || TYPE_MAP.other; }

// 事件窗口与课表窗口相差在这个范围内，就认为"是同一波人"（避免两套时刻各画一遍）
const MERGE_MIN = 20;

// ---------------------------------------------------------------- 基础工具
const toMinutes = t => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const fmt = min => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

let idSeq = 0;
function newId() {
  idSeq++;
  return 'E' + Date.now().toString(36) + idSeq.toString(36);
}

// ---------------------------------------------------------------- 场馆
/** 地标名 -> {name, node, snapMeters}；找不到返回 null。 */
function landmarkByName(name) {
  if (!name) return null;
  const hit = landmarks.items.find(x => x.n === name);
  return hit ? { name: hit.n, node: hit.i, snapMeters: hit.s, kind: hit.k } : null;
}

/** 可选场馆：体育场馆 / 礼堂会场 排前面，其余按类别与名称。 */
function venueOptions() {
  const order = { 体育场馆: 0, 礼堂会场: 1, 教学科研: 2, 生活服务: 3, 宿舍: 4, 出入口: 5, 其他: 6 };
  return landmarks.items.slice().sort((a, b) => (order[a.k] - order[b.k]) || a.n.localeCompare(b.n, 'zh'))
    .map(x => ({ name: x.n, kind: x.k, node: x.i, snapMeters: x.s }));
}

/**
 * 事件的场馆解析成路网节点。
 * 支持两种写法：地标名（venue）或自定义点（venuePoint: {x, y}，来自地图点选）。
 */
function venueOf(event) {
  if (event && event.venue) {
    const hit = landmarkByName(event.venue);
    if (hit) return hit;
  }
  if (event && event.venuePoint && typeof event.venuePoint.x === 'number') {
    const near = router.nearestNode(event.venuePoint.x, event.venuePoint.y);
    return {
      name: event.venue || '自定义位置',
      node: near.index,
      snapMeters: Math.round(near.distanceMeters),
      kind: '自定义',
      custom: true,
    };
  }
  return null;
}

// ---------------------------------------------------------------- 参加人群
/** 空数组 = 不限制（全校所有年级 / 所有专业）。 */
function audienceOf(event) {
  const grades = (event && event.grades) || [];
  const prefixes = (event && event.departments) || [];
  const gSet = new Set(grades.map(g => peopleIndex.grades.findIndex(x => x.code === String(g))).filter(i => i >= 0));
  const pSet = new Set(prefixes.map(n => peopleIndex.prefixes.findIndex(x => x.name === n)).filter(i => i >= 0));

  let students = 0, classes = 0;
  const byDorm = new Map();
  const byGrade = new Map();
  for (const row of peopleIndex.rows) {
    const [p, g, d, size, cls] = row;
    if (gSet.size && !gSet.has(g)) continue;
    if (pSet.size && !pSet.has(p)) continue;
    students += size;
    classes += cls;
    const dn = peopleIndex.dormNodes[d];
    byDorm.set(dn, (byDorm.get(dn) || 0) + size);
    const gl = peopleIndex.grades[g].label;
    byGrade.set(gl, (byGrade.get(gl) || 0) + size);
  }
  return {
    students,
    classes,
    dorms: [...byDorm.entries()]
      .map(([id, n]) => {
        const di = peopleIndex.dormNodes.indexOf(id);
        return {
          id,
          name: (peopleIndex.dormNames && peopleIndex.dormNames[di]) || id,
          node: NODE_BY_ID.has(id) ? NODE_BY_ID.get(id) : null,
          students: n,
        };
      })
      .sort((a, b) => b.students - a.students),
    byGrade: [...byGrade.entries()].map(([name, n]) => ({ name, students: n })).sort((a, b) => a.name.localeCompare(b.name, 'zh')),
    unlimitedGrades: !gSet.size,
    unlimitedDepartments: !pSet.size,
    unknownGrades: grades.filter(g => peopleIndex.grades.findIndex(x => x.code === String(g)) < 0),
    unknownDepartments: prefixes.filter(n => peopleIndex.prefixes.findIndex(x => x.name === n) < 0),
  };
}

/** 事件规模：填了预计人数就按预计人数，否则按选中人群的实际人数。 */
function headcountOf(event, audience) {
  const a = audience || audienceOf(event);
  const want = Number(event && event.headcount) || 0;
  return {
    people: want > 0 ? want : a.students,
    declared: want,
    available: a.students,
    // 预计人数超过选中人群的名义人数：如实说出来（可能还会有校外人员/其他年级）
    overCapacity: want > 0 && a.students > 0 && want > a.students,
    source: want > 0 ? 'estimated' : 'audience',
  };
}

/** 「机械学院、2026级」这种可读描述。 */
function describeAudience(event) {
  const grades = (event && event.grades) || [];
  const prefixes = (event && event.departments) || [];
  const gl = grades.length
    ? grades.map(g => '20' + g + '级').join('、')
    : '全部年级';
  const pl = prefixes.length
    ? (prefixes.length <= 3 ? prefixes.join('、') : `${prefixes.slice(0, 3).join('、')} 等 ${prefixes.length} 个专业`)
    : '全部专业';
  return `${pl} · ${gl}`;
}

// ---------------------------------------------------------------- 事件窗口
/**
 * 活动的两个出行时刻：开场前 leadMin 分钟集中到场、结束后离场。
 */
function windowsOf(event) {
  const t = typeOf(event && event.type);
  const lead = Number(event && event.leadMin) >= 0 ? Number(event.leadMin) : t.leadMin;
  const s = toMinutes(event && event.start);
  const e = toMinutes(event && event.end);
  const out = [];
  if (s != null) out.push({ minutes: Math.max(0, s - lead), kind: 'arrival', label: `${event.start} 开场前 ${lead} 分钟（入场）` });
  if (e != null) out.push({ minutes: e, kind: 'departure', label: `${event.end} 结束（离场）` });
  return out;
}

// ---------------------------------------------------------------- 流量
let flowCache = new Map();      // 事件 -> {flow, windows, perWindow, stats}

function addInto(target, src, scale) {
  const k = scale == null ? 1 : scale;
  for (let i = 0; i < EDGE_COUNT; i++) if (src[i]) target[i] += src[i] * k;
}

/**
 * 事件产生的逐边流量（同时给出每个窗口各自的分量）。
 * 做法：把参加人群按宿舍聚合成若干"出发点"（最多 35 个），
 * 每个出发点跑一次宿舍->场馆、场馆->宿舍的最短路，按人数加权。
 * 结果按 (事件内容, 场馆节点, 人数) 缓存，改一次只算一次。
 *
 * @returns {{flow:Float64Array, windows:Array, perWindow:Array, stats:Object, audience:Object, venue:Object}}
 */
function flowFor(event) {
  const venue = venueOf(event);
  const audience = audienceOf(event);
  const head = headcountOf(event, audience);
  const key = JSON.stringify([
    event && event.id, event && event.type, event && event.start, event && event.end, event && event.leadMin,
    (event && event.grades) || [], (event && event.departments) || [],
    head.people, venue && venue.node,
  ]);
  const cached = flowCache.get(key);
  if (cached) return cached;

  const windows = windowsOf(event);
  // 每个窗口各存一份流量：叠加时按时刻挑窗口，避免为了"只要入场"再跑一遍最短路
  const perWindow = windows.map(w => ({
    minutes: w.minutes, time: fmt(w.minutes), kind: w.kind, label: w.label,
    flow: new Float64Array(EDGE_COUNT), people: 0, trips: 0, unassigned: 0,
  }));
  const total = new Float64Array(EDGE_COUNT);
  const stats = {
    people: Math.round(head.people),
    headSource: head.source,
    overCapacity: head.overCapacity,
    venue: venue ? { name: venue.name, node: venue.node, snapMeters: venue.snapMeters } : null,
    dorms: 0, pairs: 0, trips: 0, unassigned: 0,
  };
  const out = { flow: total, windows, perWindow, stats, audience, venue };
  if (!venue || !windows.length || !(head.people > 0)) {
    flowCache.set(key, out);
    return out;
  }

  // 每栋宿舍分到多少人（预计人数 ≠ 人群人数时按比例缩放，保证总量守恒）
  const scale = head.declared > 0 && audience.students > 0 ? head.declared / audience.students : 1;
  const origins = audience.dorms
    .map(d => ({ name: d.name, node: d.node, people: d.students * scale }))
    .filter(o => o.node != null);
  stats.dorms = origins.length;

  perWindow.forEach(w => {
    origins.forEach(o => {
      const from = w.kind === 'arrival' ? o.node : venue.node;
      const to = w.kind === 'arrival' ? venue.node : o.node;
      if (from === to) return;
      const r = router.plan(from, to, 'fastest');
      stats.pairs++;
      if (!r.ok) {
        stats.unassigned += o.people;
        w.unassigned += o.people;
        return;
      }
      for (const e of r.usedEdges) {
        w.flow[e.ei] += o.people;
        total[e.ei] += o.people;
      }
      w.people += o.people;
      w.trips++;
      stats.trips++;
    });
  });
  flowCache.set(key, out);
  return out;
}

/**
 * 某个时刻该叠加多少事件流量。
 * @param {Array} events
 * @param {number|null} minute 想看的那一分钟；传 null 表示"不看时刻，把所有窗口都算上"
 * @returns {{flow:Float64Array, used:Array}}
 */
function flowAt(events, minute) {
  const out = new Float64Array(EDGE_COUNT);
  const used = [];
  (events || []).forEach(ev => {
    const r = flowFor(ev);
    const targets = minute == null
      ? r.perWindow
      : r.perWindow.filter(w => Math.abs(w.minutes - minute) <= MERGE_MIN);
    if (!targets.length) return;
    targets.forEach(w => addInto(out, w.flow, 1));
    used.push({
      event: ev,
      title: ev.title || typeOf(ev.type).name,
      venue: r.venue ? r.venue.name : '',
      people: r.stats.people,
      windows: targets.map(w => ({ time: w.time, kind: w.kind, label: w.label })),
    });
  });
  return { flow: out, used };
}

function clearCache() {
  flowCache = new Map();
}

// ---------------------------------------------------------------- 校验 / 规范化
function validate(event) {
  const problems = [];
  if (!event) return ['事件为空'];
  if (!String(event.title || '').trim()) problems.push('缺少活动名称');
  if (!TYPE_MAP[event.type]) problems.push(`活动类型不认识：${event.type}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(event.date || ''))) problems.push('日期格式应为 YYYY-MM-DD');
  const s = toMinutes(event.start);
  const e = toMinutes(event.end);
  if (s == null) problems.push('缺少开始时间（HH:MM）');
  if (e == null) problems.push('缺少结束时间（HH:MM）');
  if (s != null && e != null && e <= s) problems.push('结束时间要晚于开始时间');
  if (!venueOf(event)) problems.push('场馆没选（或所选地标不在索引里）');
  const a = audienceOf(event);
  if (a.unknownGrades.length) problems.push(`年级不认识：${a.unknownGrades.join('、')}`);
  if (a.unknownDepartments.length) problems.push(`专业不认识：${a.unknownDepartments.join('、')}`);
  if (!(a.students > 0) && !(Number(event.headcount) > 0)) {
    problems.push('按当前人群选出来是 0 人，请检查年级/专业，或直接填预计人数');
  }
  const h = headcountOf(event, a);
  if (h.overCapacity) {
    problems.push(`预计人数（${h.declared}）超过所选人群的名义人数（${h.available}）——`
      + '如果包含校外人员或其他年级，忽略这条即可');
  }
  return problems;
}

/** 补齐默认值，得到一条完整、可直接参与计算的事件。 */
function normalize(input) {
  const t = typeOf(input && input.type);
  // 名称只写了空白字符时，用类型名兜底（否则会存下一条没有名字的事件）
  const rawTitle = String((input && input.title) || '').trim();
  return {
    id: (input && input.id) || newId(),
    title: rawTitle || t.name,
    type: TYPE_MAP[input && input.type] ? input.type : 'other',
    date: String((input && input.date) || ''),
    start: (input && input.start) || t.start,
    end: (input && input.end) || t.end,
    leadMin: (input && input.leadMin != null && input.leadMin !== '') ? Number(input.leadMin) : t.leadMin,
    venue: String((input && input.venue) || ''),
    venuePoint: (input && input.venuePoint) || null,
    grades: ((input && input.grades) || []).map(String),
    departments: ((input && input.departments) || []).map(String),
    headcount: Number((input && input.headcount) || 0),
    note: String((input && input.note) || ''),
  };
}

/** 某天有哪些事件。 */
function onDate(events, iso) {
  return (events || []).filter(e => e && e.date === iso);
}

/** 一句话描述，例如「校运会 · 新校体育场"鸟巢"西门 · 08:00-17:00 · 机械学院 2,138 人」。 */
function describe(event) {
  const t = typeOf(event.type);
  const v = venueOf(event);
  const a = audienceOf(event);
  const h = headcountOf(event, a);
  return `${event.title || t.name} · ${v ? v.name : '场馆未定'} · ${event.start}-${event.end}`
    + ` · ${describeAudience(event)} · ${Math.round(h.people).toLocaleString()} 人`
    + (h.source === 'estimated' ? '（预计）' : '（按选中人群）');
}

module.exports = {
  EVENT_TYPES,
  TYPE_MAP,
  MERGE_MIN,
  typeOf,
  toMinutes,
  fmt,
  newId,
  landmarkByName,
  venueOptions,
  venueOf,
  audienceOf,
  headcountOf,
  describeAudience,
  windowsOf,
  flowFor,
  flowAt,
  clearCache,
  validate,
  normalize,
  onDate,
  describe,
  peopleIndex,
  landmarks,
};
