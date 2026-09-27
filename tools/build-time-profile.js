/**
 * 时段画像构建：用真实课表算出「每条路在每个换课时段有多少人」。
 *
 * 为什么需要：原始数据只给了两个时间量（学期总量、最高峰时段），
 * 中间过程没留下来，所以现在整张图只能显示最高峰、夜里也满格。
 * 有课表就能真正还原时段分布——形状来自课表，量级锚定原始数据。
 *
 * 用法：
 *   node tools/build-time-profile.js <课表.csv|json>   用真实课表构建
 *   node tools/build-time-profile.js --sample          用内置示例课表构建（自检/演示）
 *   node tools/build-time-profile.js --placeholder     只写一个"尚未提供课表"的占位文件
 *
 * 输出：miniprogram/miniprogram/data/time-profile.js
 *   无论哪种模式都会写文件——小程序里 require 一个不存在的模块会直接编译失败，
 *   所以必须始终存在，用 available 标记是否真的有数据。
 */
const fs = require('fs');
const path = require('path');

const { ROOT } = require('./paths.js');
const D = path.join(ROOT, 'data');
const read = f => JSON.parse(fs.readFileSync(path.join(D, f), 'utf8'));

const flow = read('traffic-flow.json');
const graph = require(path.join(ROOT, 'data', 'route-graph.js'));
const router = require(path.join(ROOT, 'utils', 'router.js'));

// ---------------------------------------------------------------- 节次时间表（学校通行）
/**
 * 两节连排为一个课段。
 * 重要：**真实课表里没有上下课时间**（已核对：19882 个格子中没有任何 hh:mm，
 * Sheet2/Sheet3 是空的），所以这张表是"节次号 -> 时间"的作息约定，属于常识性作息，
 * 不是本项目编的假设。11-12 节（21:00 起）标了 assumed，因为用到它的课很少（389 门）。
 */
const BLOCKS = [
  { key: 'p1', periods: [1, 2], start: '08:00', end: '09:40' },
  { key: 'p3', periods: [3, 4], start: '10:00', end: '11:40' },
  { key: 'p5', periods: [5, 6], start: '14:00', end: '15:40' },
  { key: 'p7', periods: [7, 8], start: '16:00', end: '17:40' },
  { key: 'p9', periods: [9, 10], start: '19:00', end: '20:40' },
  { key: 'p11', periods: [11, 12], start: '21:00', end: '22:40', assumed: true },
];
const blockOfPeriod = p => BLOCKS.find(b => p >= b.periods[0] && p <= b.periods[1]) || null;
const toMinutes = t => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

// ---------------------------------------------------------------- 解析课表
const WEEKDAY_CN = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };

/** 把各种写法的星期统一成 1~7。 */
function parseWeekday(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  const n = Number(s.replace(/[^0-9]/g, ''));
  if (n >= 1 && n <= 7 && /^\d+$/.test(s)) return n;
  if (/周|星期|礼拜/.test(s)) {
    const ch = s.replace(/周|星期|礼拜/g, '').trim();
    if (WEEKDAY_CN[ch]) return WEEKDAY_CN[ch];
    const d = Number(ch);
    if (d >= 1 && d <= 7) return d;
  }
  if (n >= 1 && n <= 7) return n;
  return null;
}

/** 把 "1-2" / "3,4" / "第5节" / "5" 统一成节次数组。 */
function parsePeriods(v) {
  const s = String(v == null ? '' : v).replace(/第|节|课/g, ' ').trim();
  const nums = (s.match(/\d+/g) || []).map(Number).filter(n => n >= 1 && n <= 12);
  if (!nums.length) return [];
  if (nums.length === 1) {
    // 单个节次：若它是奇数则视为"两节连排"的起点（1 -> 1-2），偶数则含前一节
    const n = nums[0];
    const start = n % 2 === 1 ? n : n - 1;
    return [start, start + 1];
  }
  return [Math.min.apply(null, nums), Math.max.apply(null, nums)];
}

/** 极简 CSV 解析：支持引号包裹与逗号。 */
function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  const split = line => {
    const out = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q;
      } else if (c === ',' && !q) { out.push(cur); cur = ''; } else cur += c;
    }
    out.push(cur);
    return out.map(s => s.trim());
  };
  const head = split(lines[0]);
  return lines.slice(1).map(l => {
    const cells = split(l);
    const o = {};
    head.forEach((h, i) => { o[h] = cells[i]; });
    return o;
  });
}

const ALIASES = {
  cls: ['班级', '班级名称', '教学班', '行政班', 'class', 'classname'],
  weekday: ['星期', '周几', 'weekday', 'day'],
  periods: ['节次', '节', '课节', 'period', 'periods'],
  room: ['教室', '地点', '上课地点', 'room', 'location'],
  start: ['上课时间', '开始时间', 'start'],
  end: ['下课时间', '结束时间', 'end'],
};

function pick(row, keys) {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== '') return row[k];
    const hit = Object.keys(row).find(x => x.trim() === k);
    if (hit && row[hit] !== '') return row[hit];
  }
  return '';
}

/**
 * 读课表 -> 统一记录。
 * @returns {{rows:Array, problems:Array}}
 */
function loadTimetable(file) {
  const ext = path.extname(file).toLowerCase();
  const text = fs.readFileSync(file, 'utf8');
  let raw;
  if (ext === '.json') {
    const j = JSON.parse(text);
    raw = Array.isArray(j) ? j : (j.rows || j.data || j.records || []);
  } else {
    raw = parseCsv(text);
  }

  const rows = [];
  const problems = [];
  raw.forEach((r, i) => {
    const cls = String(pick(r, ALIASES.cls) || '').trim();
    const wd = parseWeekday(pick(r, ALIASES.weekday));
    const periods = parsePeriods(pick(r, ALIASES.periods));
    const room = String(pick(r, ALIASES.room) || '').trim();
    const line = i + 2;
    if (!cls || !wd || !periods.length || !room) {
      problems.push({ line, reason: '缺少班级/星期/节次/教室', row: r });
      return;
    }
    const block = blockOfPeriod(periods[0]);
    if (!block) {
      problems.push({ line, reason: `节次 ${periods[0]} 不在 1~10 范围内`, row: r });
      return;
    }
    const startRaw = String(pick(r, ALIASES.start) || '').trim();
    const endRaw = String(pick(r, ALIASES.end) || '').trim();
    rows.push({
      cls,
      weekday: wd,
      start: periods[0],
      end: periods[1],
      block: block.key,
      startMin: toMinutes(startRaw) || toMinutes(block.start),
      endMin: toMinutes(endRaw) || toMinutes(block.end),
      room,
      customTime: !!(toMinutes(startRaw) || toMinutes(endRaw)),
    });
  });
  return { rows, problems };
}

// ---------------------------------------------------------------- 班级课表（合并单元格）解析
/**
 * `tools/import-timetable.ps1` 把学校的 .xls 导出成一行一个格子：
 *   class,classSize,weekday,period,cell
 * 一个格子里可能有 1~3 门课（同一时段的分组/单双周/不同教室），写法有两种：
 *   93人2-4,8-16周01-02节/B座105 （多媒体教室）      <- 周次 紧接 节次
 *   93人10-17单周/05-06节/B座214 （多媒体教室）        <- 单双周 后有一个斜杠
 *   8人8-14周/07节/101教室 （一般教室）                <- 单节，需补成两节连排
 * 一门课的三个关键字段就是：人数 / 周次(含单双周) / 教室。
 */
const RE_COURSE = /(\d+)\s*人\s*([0-9,\-\u2013\u2014]+)\s*(单周|双周)?\s*周?\s*\/?\s*(\d{1,2})\s*(?:-\s*(\d{1,2}))?\s*节\s*\/\s*([\s\S]*?)(?=\s*\d+\s*人\s*[0-9]|$)/g;

/** 一个格子的文字 -> 若干门课 {people, weeks, parity, p1, p2, room}。 */
function parseCellCourses(cell) {
  const s = String(cell == null ? '' : cell);
  const out = [];
  RE_COURSE.lastIndex = 0;
  let m;
  while ((m = RE_COURSE.exec(s))) {
    let p1 = Number(m[4]);
    let p2 = m[5] ? Number(m[5]) : (p1 % 2 ? p1 + 1 : p1 - 1);  // 单节 -> 所属两节连排
    if (p1 > p2) { const t = p1; p1 = p2; p2 = t; }
    out.push({
      people: Number(m[1]),
      weeks: m[2],
      parity: m[3] || '',
      p1,
      p2,
      room: String(m[6] || '').trim(),
    });
  }
  return out;
}

/** 去掉教室名里的括号说明与排课备注，得到可用于匹配建筑的名字。 */
function cleanRoom(raw) {
  return String(raw == null ? '' : raw)
    .replace(/\s*[（(][^）)]*[）)]\s*$/, ' ')                 // "B座106 （多媒体教室）"
    .replace(/\s*(?:分组|周[一二三四五六日天])\s*\d+\s*/g, ' ') // "外语网络楼104 分组02" / "L303 周二34"
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 读 `import-timetable.ps1` 产出的格子表。
 * @returns {{cells:Array, courses:Array, problems:Array}}
 */
function loadCellsCsv(file) {
  const raw = parseCsv(fs.readFileSync(file, 'utf8'));
  const cells = [];
  const courses = [];
  const problems = [];
  raw.forEach((r, i) => {
    const cls = String(r.class || r['班级'] || '').trim();
    const line = i + 2;
    if (!cls) { problems.push({ line, reason: '缺少班级' }); return; }
    const weekday = Number(String(r.weekday || r['星期'] || '').replace(/[^0-9]/g, ''));
    const per = String(r.period || r['节次'] || '');
    const pm = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(per);
    if (!(weekday >= 1 && weekday <= 7) || !pm) { problems.push({ line, reason: `星期/节次无法识别（${per}）` }); return; }
    const cell = String(r.cell || r['单元格'] || '');
    const classSize = Number(String(r.classSize || r['班级人数'] || '').replace(/[^0-9]/g, '')) || 0;
    const list = parseCellCourses(cell);
    if (!list.length) { problems.push({ line, reason: '格子文字里没有解析出任何课程', row: cell.slice(0, 60) }); return; }
    cells.push({ cls, classSize, weekday, period: per, rowP1: Number(pm[1]), rowP2: Number(pm[2]), cell });
    list.forEach(c => courses.push(Object.assign({ cls, classSize, weekday, rowPeriod: per }, c)));
  });
  return { cells, courses, problems };
}

/**
 * 课表里的"教学班"是**多个行政班共上一门课**，同一门课会原样出现在每个参与班级的课表里，
 * 所以不能直接把各班的格子相加（会重复计数）。这里的处理链：
 *   1) 按 (星期, 节次, 教室, 周次, 单双周) 认出一门"课"（session），参与班级 = 列出它的班级集合；
 *   2) 把这门课的**人数**按参与班级的班级人数比例分给各班——总量守恒，等于该时段真实上路的人数；
 *   3) 同一班级同一时段若还剩多门课（单周一门、双周另一门），只保留人数最大的那门，
 *      因为一个人同一时刻只能在一个地方（这是"最忙的一周"口径）。
 * @returns {{rows:Array, stats:Object, problems:Array, dropped:Array}}
 */
function buildRowsFromCells(courses) {
  const stats = {
    coursesParsed: courses.length,
    classesInTimetable: new Set(courses.map(c => c.cls)).size,
    sessions: 0,
    sharedSessions: 0,
    multiListingSessions: 0,
    sessionsWithDisagreeingHeadcount: 0,
    droppedByConflict: 0,
    peopleRaw: 0,
    peopleAfterDedup: 0,
  };
  const sessions = new Map();
  courses.forEach(c => {
    stats.peopleRaw += c.people;
    const key = [c.weekday, c.p1, c.p2, cleanRoom(c.room), c.weeks, c.parity].join('|');
    if (!sessions.has(key)) sessions.set(key, { key, people: c.people, listers: new Map() });
    const s = sessions.get(key);
    if (c.people !== s.people) stats.sessionsWithDisagreeingHeadcount++;
    s.people = Math.max(s.people, c.people);      // 同一门课的人数字面值应当一致，取大者更保守
    const prev = s.listers.get(c.cls);
    if (prev == null || c.people > prev.people) s.listers.set(c.cls, { cls: c.cls, classSize: c.classSize, room: c.room });
  });
  stats.sessions = sessions.size;

  // 2) 按班级人数比例分配这门课的人数
  const perSlot = new Map();                       // cls#weekday#p1#p2 -> 候选
  sessions.forEach(s => {
    const listers = [...s.listers.values()];
    if (listers.length > 1) stats.sharedSessions++;
    const sizeSum = listers.reduce((a, l) => a + (l.classSize > 0 ? l.classSize : 0), 0);
    const share = listers.length ? (sizeSum > 0 ? 'proportional' : 'equal') : null;
    stats.peopleAfterDedup += s.people;
    if (listers.length > 1) stats.multiListingSessions++;
    listers.forEach(l => {
      const weight = sizeSum > 0 && l.classSize > 0
        ? s.people * (l.classSize / sizeSum)
        : s.people / listers.length;
      const slot = [l.cls, s.key.split('|')[0], s.key.split('|')[1], s.key.split('|')[2]].join('#');
      const entry = {
        cls: l.cls, weekday: Number(s.key.split('|')[0]),
        p1: Number(s.key.split('|')[1]), p2: Number(s.key.split('|')[2]),
        room: l.room, people: weight, share, listers: listers.length,
      };
      if (!perSlot.has(slot)) perSlot.set(slot, []);
      perSlot.get(slot).push(entry);
    });
  });

  // 3) 同一班级同一时段只留一门
  const rows = [];
  const dropped = [];
  perSlot.forEach(list => {
    list.sort((a, b) => b.people - a.people);
    const keep = list[0];
    const block = blockOfPeriod(keep.p1);
    if (!block) { dropped.push({ reason: `节次 ${keep.p1} 不在作息表内`, cls: keep.cls }); return; }
    rows.push({
      cls: keep.cls,
      weekday: keep.weekday,
      start: keep.p1,
      end: keep.p2,
      block: block.key,
      startMin: toMinutes(block.start),
      endMin: toMinutes(block.end),
      room: keep.room,
      people: keep.people,
      shared: keep.listers > 1,
    });
    for (let i = 1; i < list.length; i++) {
      stats.droppedByConflict++;
      if (dropped.length < 20) {
        dropped.push({ reason: '同一时段还有别的课，按"最忙的一周"只保留人数多的那门', cls: keep.cls, kept: keep.room, lost: list[i].room });
      }
    }
  });
  rows.sort((a, b) => (a.weekday - b.weekday) || (a.start - b.start));
  return { rows, stats, problems: [], dropped };
}


// ---------------------------------------------------------------- 教室/班级 -> 节点
// 节点 id -> 下标（路网数据包里有 nodeIds，与 px/py 同序）
const NODE_INDEX = new Map((graph.nodeIds || []).map((id, i) => [id, i]));

/**
 * 教室名 -> 建筑 -> 路网节点（用现有的 location_rules 与 locations 映射）。
 *
 * 真实课表里的教室名比原数据的 key 多带装饰，所以要分几级匹配：
 *   1) 原样命中 location_rules；
 *   2) 去掉末尾括号说明（"B座106 （多媒体教室）" -> "B座106"）；
 *   3) 再去掉"分组02"、"周二34"这类排课备注（"外语网络楼104 分组02（实验室）" -> "外语网络楼104"）；
 *   4) 前缀命中："(暂无教室) 排球" -> "(暂无教室)"、"T106 临五2501-3" -> "T106"。
 * 第 4 级要求剩下的尾巴不是数字开头（避免 "T21" 误配 "T211"）。
 * 原数据里 status='excluded' 的教室（106教室、T211、新科教楼…）是原项目有意不纳入的，
 * 这里照样不纳入，只在统计里如实报出人数。
 */
function buildRoomResolver() {
  const rules = flow.location_rules || {};
  const locs = flow.locations || {};
  const keys = Object.keys(rules).filter(Boolean);
  const byPrefix = keys.slice().sort((a, b) => b.length - a.length);
  const cache = new Map();
  const stats = {
    matched: 0, excluded: 0, unknown: 0, unknownNames: [], excludedNames: [],
    byStrategy: { exact: 0, trailingParen: 0, inlineNote: 0, prefix: 0 },
  };

  const candidates = raw => {
    const out = [];
    const push = s => { const t = String(s || '').trim(); if (t && out.indexOf(t) < 0) out.push(t); };
    push(raw);
    const noParen = String(raw || '').replace(/\s*[（(][^）)]*[）)]\s*$/, '').trim();
    push(noParen);
    push(cleanRoom(raw));
    return out;
  };

  const strategies = ['exact', 'trailingParen', 'inlineNote'];

  /** 找到 rule 的 key（而不是直接给节点），便于统计命中方式。 */
  function findKey(raw) {
    const cands = candidates(raw);
    for (let i = 0; i < cands.length; i++) {
      if (rules[cands[i]]) return { key: cands[i], how: strategies[Math.min(i, strategies.length - 1)] };
    }
    const base = cleanRoom(raw);
    if (base) {
      for (const k of byPrefix) {
        if (!base.startsWith(k) || base.length === k.length) continue;
        const tail = base.slice(k.length);
        if (/^[0-9]/.test(tail)) continue;
        return { key: k, how: 'prefix' };
      }
    }
    return { key: null, how: null };
  }

  return {
    stats,
    findKey,
    /**
     * 教室 -> 节点下标，或 null。
     * 只按**教室名**统计一次（同名教室无论被查多少次都只算一次）；
     * "有多少人被纳入/排除"由 accumulate 按行统计，避免这里重复计数。
     */
    resolveInfo(room) {
      if (cache.has(room)) return cache.get(room);
      const found = findKey(room);
      const rule = found.key ? rules[found.key] : null;
      let node = null;
      let why = 'unknown';
      if (rule && rule.status === 'included' && rule.destination && locs[rule.destination]) {
        const id = locs[rule.destination].road_node;
        node = NODE_INDEX.has(id) ? NODE_INDEX.get(id) : null;
        if (node === null) {
          if (stats.unknownNames.length < 20) stats.unknownNames.push(`${room}（建筑 ${rule.destination} 的节点 ${id} 不在路网中）`);
        } else {
          why = 'matched';
          stats.byStrategy[found.how]++;
        }
      } else if (rule && rule.status === 'excluded') {
        why = 'excluded';
      }
      const info = { node, why, key: found.key || room };
      cache.set(room, info);
      if (node !== null) stats.matched++;
      else if (why === 'excluded') {
        stats.excluded++;
        if (stats.excludedNames.length < 12) stats.excludedNames.push(room);
      } else {
        stats.unknown++;
        if (stats.unknownNames.length < 20) stats.unknownNames.push(room);
      }
      return info;
    },
    resolve(room) {
      return this.resolveInfo(room).node;
    },
  };
}

/** 班级 -> 宿舍节点下标 + 人数。 */
function buildClassResolver() {
  const cache = new Map();
  const stats = { matched: 0, unknown: 0, unknownNames: [] };
  return {
    stats,
    resolve(cls) {
      if (cache.has(cls)) return cache.get(cls);
      const asg = flow.assignments[cls];
      let out = null;
      if (asg && NODE_INDEX.has(asg.dorm_node)) {
        out = { node: NODE_INDEX.get(asg.dorm_node), size: asg.class_size || 30 };
        stats.matched++;
      } else {
        stats.unknown++;
        if (stats.unknownNames.length < 20) stats.unknownNames.push(cls);
      }
      cache.set(cls, out);
      return out;
    },
  };
}

// ---------------------------------------------------------------- 逐时段累加流量
/**
 * 按原始仿真的移动规则还原：
 *   每节课开始前从"上一个地点"过来（相邻课节则直接去下一个教室，否则从宿舍出发），
 *   当天最后一节结束后回宿舍。
 * 每个"换课时刻"是一个时段：该时刻既有来上课的人，也有下课离开的人。
 */
function accumulate(rows, resolveRoom, resolveClass, resolveRoomInfo) {
  const incident = router.graph.edges;             // [u, v, len, peak, kind]
  const N = incident.length;
  const windows = new Map();                        // "weekday:minutes" -> {weekday, minutes, arrivals, departures}
  const keyOf = (weekday, min) => weekday + ':' + min;
  // 时段按 (星期, 时刻) 分开存：**每天的形状差别很大**（实测周三下午几乎没课、
  // 周四晚上没课），合成一张"整周平均"会把这种差别抹掉，
  // 那样"选某个日期"就只是个装饰。
  const add = (weekday, min, kind, ei, w) => {
    const k = keyOf(weekday, min);
    if (!windows.has(k)) {
      windows.set(k, { weekday, minutes: min, arrivals: new Float64Array(N), departures: new Float64Array(N) });
    }
    windows.get(k)[kind][ei] += w;
  };
  // 同一对起终点会被成百上千个班级重复走（宿舍->同一栋楼），缓存边序列，
  // 否则 ~2 万门课要跑 ~5 万次 Dijkstra。
  const routeCache = new Map();
  const edgesBetween = (from, to) => {
    const k = from + '|' + to;
    if (routeCache.has(k)) return routeCache.get(k);
    const r = router.plan(from, to, 'fastest');
    const list = r.ok ? r.usedEdges.map(e => e.ei) : null;
    routeCache.set(k, list);
    return list;
  };
  const route = (weekday, from, to, weight, kind, minutes) => {
    if (from == null || to == null) return -1;
    if (from === to) return 0;
    const list = edgesBetween(from, to);
    if (!list) return -1;
    for (const ei of list) add(weekday, minutes, kind, ei, weight);
    return 0;
  };

  // 按 (班级, 星期) 分组，按节次排序，才能判断"相邻课节"
  const groups = new Map();
  rows.forEach(r => {
    const k = r.cls + '#' + r.weekday;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  });

  const problems = [];
  let routedTrips = 0;
  // 按"行"统计人数去向：每一行只算一次，避免同一间教室被查多次而重复计数
  const peopleStats = { total: 0, matched: 0, excluded: 0, unknown: 0, topUnknown: {}, topExcluded: {}, noClass: 0 };
  const bump = (bag, k) => { bag[k] = (bag[k] || 0) + 1; };
  const resolveInfo = resolveRoomInfo || (room => ({ node: resolveRoom(room), why: 'unknown' }));
  groups.forEach(list => {
    list.sort((a, b) => a.start - b.start);
    for (let i = 0; i < list.length; i++) {
      const cur = list[i];
      const asg = resolveClass(cur.cls);
      if (!asg) { problems.push({ reason: `课表里的班级在原数据中找不到宿舍：${cur.cls}` }); continue; }
      // 人数：真实课表里每门课自己带人数，且一门课可能由多个班共上，
      // buildRowsFromCells 已经把人数按班级人数比例分到各班，所以优先用行上的 people。
      const size = cur.people != null ? cur.people : asg.size;
      const info = resolveInfo(cur.room);
      peopleStats.total += size;
      if (info.node !== null) peopleStats.matched += size;
      else if (info.why === 'excluded') { peopleStats.excluded += size; bump(peopleStats.topExcluded, info.key || cur.room); }
      else { peopleStats.unknown += size; bump(peopleStats.topUnknown, cur.room || '(空)'); }
      if (info.node === null) { problems.push({ reason: `教室无法定位：${cur.room}` }); continue; }
      const roomNode = info.node;
      const dorm = asg.node;
      const prev = list[i - 1];
      const next = list[i + 1];

      // 来上课：相邻课节从上一个教室直接过来，否则从宿舍出发
      const prevRoom = prev ? resolveInfo(prev.room).node : null;
      const from = (prev && prev.end + 1 === cur.start && prevRoom != null) ? prevRoom : dorm;
      const arriveMin = cur.startMin - 10;          // 上课前约 10 分钟出发，落在"课前"这个时段
      if (route(cur.weekday, from, roomNode, size, 'arrivals', arriveMin) < 0) {
        problems.push({ reason: `无法规划路径（去上课）：${cur.cls} -> ${cur.room}` });
      } else routedTrips++;

      // 下课离开：相邻课节直接去下一个教室，否则回宿舍
      const nextRoom = next ? resolveInfo(next.room).node : null;
      const to = (next && cur.end + 1 === next.start && nextRoom != null) ? nextRoom : dorm;
      if (route(cur.weekday, roomNode, to, size, 'departures', cur.endMin) < 0) {
        problems.push({ reason: `无法规划路径（下课离开）：${cur.cls} <- ${cur.room}` });
      } else routedTrips++;
    }
  });

  // 先按星期、再按时刻排序，保证每个星期的时段是连续的一段
  const list = [...windows.values()].sort((a, b) => (a.weekday - b.weekday) || (a.minutes - b.minutes));
  list.forEach(w => {
    const hh = String(Math.floor(w.minutes / 60)).padStart(2, '0');
    const mm = String(w.minutes % 60).padStart(2, '0');
    w.time = hh + ':' + mm;
  });
  return { windows: list, problems, routedTrips, peopleStats, routeCacheSize: routeCache.size };
}

// ---------------------------------------------------------------- 标定 + 输出
/**
 * 标定：每条路按 `peak_slot_person_trips / 本模型峰值时段` 缩放，
 * 使**最忙时段恰好等于原始数据**，各时段之间的比例保持课表算出来的形状。
 */
function calibrate(windows) {
  const N = graph.edges.length;
  const perEdge = [];
  const scaleInfo = { min: Infinity, max: 0, zeroFlowEdges: 0, edgesWithPeakButNoFlow: [], factors: [] };

  for (let ei = 0; ei < N; ei++) {
    const series = windows.map(w => w.arrivals[ei] + w.departures[ei]);
    const peak = graph.edges[ei][3];                  // 原始数据的最高峰时段人次
    const modelPeak = Math.max.apply(null, series.concat([0]));
    let scaled = series;
    if (modelPeak > 0 && peak > 0) {
      const k = peak / modelPeak;
      scaled = series.map(v => Math.round(v * k));
      scaleInfo.min = Math.min(scaleInfo.min, k);
      scaleInfo.max = Math.max(scaleInfo.max, k);
      scaleInfo.factors.push(k);
    } else {
      scaled = series.map(() => 0);
      scaleInfo.zeroFlowEdges++;
      if (peak > 0 && modelPeak === 0) scaleInfo.edgesWithPeakButNoFlow.push(ei);
    }
    perEdge.push(scaled);
  }
  return { perEdge, scaleInfo };
}

// ---------------------------------------------------------------- 标准输出
// 教室名 -> 节点，按"原样/去括号/去备注/前缀"四级匹配；命中方式写进统计里，便于核对。
function quantile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function emit(payload, outPath) {
  const out = outPath || path.join(D, 'time-profile.js');
  const body = '// 由 tools/build-time-profile.js 自动生成，请勿手工编辑。\n'
    + `// ${payload.available ? `数据来源：${payload.source}` : '尚未提供课表，时段功能未启用'}\n`
    + `module.exports = ${JSON.stringify(payload)};\n`;
  fs.writeFileSync(out, body, 'utf8');
  console.log(`已生成 ${path.relative(process.cwd(), out)}  ${(Buffer.byteLength(body) / 1024).toFixed(1)} KB`);
}

function placeholder(reason) {
  emit({
    available: false,
    reason: reason || '尚未提供含节次时间的课表',
    howTo: '见《时段数据说明.md》：提供 CSV（班级/星期/节次/教室）后运行 node tools/build-time-profile.js <文件>',
  });
}

/** 用内置示例课表构建：教室负载沿用原数据分布，仅用于自检与演示。 */
function buildSampleTimetable() {
  const rooms = Object.keys(flow.location_rules).filter(k => flow.location_rules[k].status === 'included');
  const classes = Object.keys(flow.assignments);
  const rows = [];
  let ci = 0;
  // 常见的时段偏好：上午/下午课多、晚上课少（仅示例分布）
  const periodBias = [1, 1, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5];
  rooms.forEach((room, i) => {
    const n = Math.min(flow.location_rules[room].event_count || 1, 30);
    for (let k = 0; k < n; k++) {
      const cls = classes[(ci++) % classes.length];
      const wd = 1 + ((i + k) % 5);
      const block = BLOCKS[periodBias[(i * 3 + k) % periodBias.length] - 1];
      rows.push({
        cls, weekday: wd, start: block.periods[0], end: block.periods[1],
        block: block.key, startMin: toMinutes(block.start), endMin: toMinutes(block.end),
        room, customTime: false,
      });
    }
  });
  return { rows, problems: [] };
}

// ---------------------------------------------------------------- 对外导出（供测试调用）
module.exports = {
  BLOCKS,
  parseWeekday,
  parsePeriods,
  parseCsv,
  loadTimetable,
  parseCellCourses,
  cleanRoom,
  loadCellsCsv,
  buildRowsFromCells,
  blockOfPeriod,
  toMinutes,
  buildSampleTimetable,
  buildRoomResolver,
  buildClassResolver,
  accumulate,
  calibrate,
};

/**
 * 这份课表里到底用了哪些信息、怎么用的。
 * 直接写进生成的文件里，界面/文档都能查到，不用去翻脚本。
 */
const USAGE = {
  source: '班级课表 (3).xls（中南大学教务导出的「班级课表」，1435 个班级块 × 10 行）',
  extraction: 'tools/import-timetable.ps1 用 ACE.OLEDB 读取 Sheet1，导出成 tools/_in/timetable-cells.csv（class,classSize,weekday,period,cell）',
  fields: [
    { field: '每个班级块的标题行「中南大学 <班级名> 班级课表」', used: '班级名，共 1435 个（去重 1419 个班名）' },
    { field: '第二行的「班级人数:NN」', used: '把一门共上课的人数按各班班级人数比例分到各班 —— 不做这步就会把同一门课重复计数' },
    { field: '第 3~8 行行首的节次标签（1－2 … 11－12）', used: '确定这节课在第几大节，再按作息表映射到具体时刻' },
    { field: '第 2 行的「星期一~星期五」表头', used: '确定这节课是每周的第几天（周末没有课，所以周末时段模型为空）' },
    { field: '格子文字里的「93人」', used: '这门课有多少人要走这段路 —— 真正的流量权重（不是用班级人数硬套）' },
    { field: '格子文字里的「2-4,8-16周」「单周/双周」', used: '识别同一时段的分周课程；同一班同一时段只保留人数最多的一门（"最忙的一周"口径）' },
    { field: '格子文字里的「/B座105 （多媒体教室）」', used: '教室 -> 建筑 -> 路网节点，作为行程的终点；隔壁节次连排时上一间教室就是起点' },
  ],
  notUsed: [
    '课程名称：班级课表的格子里没有课名，只有「人数/周次/节次/教室」四项',
    '备注行（第 10 行）：内容是全校性的通知，与出行无关',
    'Sheet2 / Sheet3：实测为空',
    '上下课时间：课表里一个 hh:mm 都没有（已全量核对），所以「节次 -> 时刻」用的仍是作息约定表 BLOCKS',
  ],
  movement: '每节课：课前 10 分钟从「上一节课的教室（相邻节次）或宿舍」走到本教室；下课后走去「下一节课的教室（相邻节次）或宿舍」。两个时刻各算一个换课时段。',
  calibration: '形状（各时段之间的比例）来自课表；量级按原始数据的 peak_slot_person_trips 逐边标定，使最忙时段恰好等于原始峰值。',
};

/** 按输入文件的表头判断走哪条解析路径。 */
function resolveInput(mode, argv) {
  if (mode === '--sample') {
    const s = buildSampleTimetable();
    return { kind: 'sample', rows: s.rows, problems: [], source: '内置示例课表（仅用于自检，非真实数据）', cellStats: null };
  }
  const file = path.resolve(mode);
  if (!fs.existsSync(file)) {
    console.error(`找不到课表文件：${mode}`);
    process.exit(1);
  }
  const head = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)[0] || '';
  const isCells = /classSize|单元格|,cell/i.test(head);
  if (isCells) {
    const parsed = loadCellsCsv(file);
    const built = buildRowsFromCells(parsed.courses);
    console.log(`格子表：${parsed.cells.length} 个非空格子 -> ${parsed.courses.length} 门课 -> ${built.stats.sessions} 门去重后的课`);
    console.log(`  共上课：${built.stats.sharedSessions} 门（同一门课出现在多个班的课表里）`);
    if (built.stats.sessionsWithDisagreeingHeadcount) {
      console.log(`  注意：${built.stats.sessionsWithDisagreeingHeadcount} 门课在不同班级表里人数写法不一致，已取大者`);
    }
    console.log(`  同一班同一时段有多门课的：${built.stats.droppedByConflict} 条，按"最忙的一周"只保留人数最多的一门`);
    if (parsed.problems.length) {
      console.log(`  无法解析的格子 ${parsed.problems.length} 个，示例：` + parsed.problems.slice(0, 3).map(p => `第 ${p.line} 行 ${p.reason}`).join('；'));
    }
    return {
      kind: 'cells',
      rows: built.rows,
      problems: parsed.problems.concat(built.problems || []),
      source: path.basename(mode),
      cellStats: built.stats,
      dropped: built.dropped,
    };
  }
  const t = loadTimetable(file);
  return { kind: 'timetable', rows: t.rows, problems: t.problems, source: path.basename(mode), cellStats: null };
}

// ---------------------------------------------------------------- 主流程
function main() {
const argv = process.argv.slice(2);
const mode = argv[0];

if (!mode || mode === '--placeholder') {
  placeholder();
  console.log('提示：未提供课表，仅写入占位文件（界面会如实显示为「最高峰时段」口径）。');
  process.exit(0);
}

const input = resolveInput(mode, argv);
const parsed = input;
if (!parsed.rows.length) {
  placeholder('课表里没有可用的排课记录');
  process.exit(1);
}
const source = parsed.source;

const resolver = buildRoomResolver();
const classResolver = buildClassResolver();
const acc = accumulate(parsed.rows, resolver.resolve, classResolver.resolve, resolver.resolveInfo);
console.log(`换课时段 ${acc.windows.length} 个：${acc.windows.map(w => w.time).join(', ')}`);
console.log(`教室名称：命中 ${resolver.stats.matched} / 不纳入 ${resolver.stats.excluded} / 无法识别 ${resolver.stats.unknown}`
  + (input.kind === 'cells' ? `（命中方式：原样 ${resolver.stats.byStrategy.exact}、去括号 ${resolver.stats.byStrategy.trailingParen}、去备注 ${resolver.stats.byStrategy.inlineNote}、前缀 ${resolver.stats.byStrategy.prefix}）` : ''));
{
  const ps = acc.peopleStats;
  const pct = n => (ps.total ? (100 * n / ps.total).toFixed(1) : '0.0') + '%';
  console.log(`人数去向（共 ${Math.round(ps.total).toLocaleString()} 人次）：`
    + `可定位到路网 ${Math.round(ps.matched).toLocaleString()}（${pct(ps.matched)}）`
    + ` / 原数据标为不纳入 ${Math.round(ps.excluded).toLocaleString()}（${pct(ps.excluded)}）`
    + ` / 教室无法识别 ${Math.round(ps.unknown).toLocaleString()}（${pct(ps.unknown)}）`);
  const top = Object.entries(ps.topExcluded).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (top.length) console.log('  人数最多的"不纳入"教室：' + top.map(([k, v]) => `${k}(${v}门课)`).join('、'));
}
console.log(`班级映射：命中 ${classResolver.stats.matched} / 无法识别 ${classResolver.stats.unknown}`
  + `（缓存了 ${acc.routeCacheSize} 对起终点）`);
console.log(`成功排出的行程：${acc.routedTrips.toLocaleString()} 次`);
if (resolver.stats.unknownNames.length) {
  console.log('  无法识别的教室示例：' + resolver.stats.unknownNames.slice(0, 8).join('、'));
}
if (acc.problems.length) {
  console.log(`  排课问题 ${acc.problems.length} 条，示例：` + acc.problems.slice(0, 3).map(p => p.reason).join('；'));
}

const cal = calibrate(acc.windows);
console.log(`标定系数范围：${cal.scaleInfo.min.toFixed(3)} ~ ${cal.scaleInfo.max.toFixed(3)}`);
{
  const f = cal.scaleInfo.factors.slice().sort((a, b) => a - b);
  if (f.length) {
    console.log(`  系数分布（${f.length} 条边）：中位 ${quantile(f, 0.5).toFixed(2)}，75% ${quantile(f, 0.75).toFixed(2)}，`
      + `90% ${quantile(f, 0.9).toFixed(2)}，最大 ${f[f.length - 1].toFixed(1)}；>10 的有 ${f.filter(x => x > 10).length} 条`);
  }
}
if (cal.scaleInfo.edgesWithPeakButNoFlow.length) {
  console.log(`  有 ${cal.scaleInfo.edgesWithPeakButNoFlow.length} 条路原始数据有峰值但课表未能覆盖（时段内按 0 处理）`);
}

// 一致性检查
const totalBySlot = acc.windows.map((w, i) => cal.perEdge.reduce((s, e) => s + e[i], 0));
const peakIdx = totalBySlot.indexOf(Math.max.apply(null, totalBySlot));
const keyOfWindow = w => 'd' + w.weekday + 'w' + String(w.minutes).padStart(4, '0');
console.log(`换课时段共 ${acc.windows.length} 个（${new Set(acc.windows.map(w => w.weekday)).size} 天 × 每天若干时刻）`);
console.log(`最忙时段：周${'一二三四五六日'[acc.windows[peakIdx].weekday - 1]} ${acc.windows[peakIdx].time}`
  + `（合计 ${totalBySlot[peakIdx].toLocaleString()} 人次）`);
if (acc.windows.length > 1) {
  const sorted = totalBySlot.slice().sort((a, b) => b - a);
  console.log(`  次忙 ${sorted[1].toLocaleString()}，最闲 ${sorted[sorted.length - 1].toLocaleString()}`
    + `（峰/谷 = ${(sorted[0] / Math.max(sorted[sorted.length - 1], 1)).toFixed(1)}×）`);
}
// 逐日的峰谷：这张表就是"选某一天"能看到的差别
{
  console.log('  各天的时段人次（周几: 最小 ~ 最大，峰谷比）：');
  for (const d of [...new Set(acc.windows.map(w => w.weekday))].sort((a, b) => a - b)) {
    const idx = acc.windows.map((w, i) => (w.weekday === d ? i : -1)).filter(i => i >= 0);
    const vals = idx.map(i => totalBySlot[i]);
    const mx = Math.max.apply(null, vals), mn = Math.min.apply(null, vals);
    console.log(`    周${'一二三四五六日'[d - 1]}  ${mn.toLocaleString().padStart(9)} ~ ${mx.toLocaleString().padStart(9)}`
      + `   峰/谷 ${(mx / Math.max(mn, 1)).toFixed(1)}×   时段数 ${idx.length}`);
  }
}

const payload = {
  available: true,
  source,
  generatedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
  method: input.kind === 'cells'
    ? '班级课表格子（人数/周次/节次/教室）-> 按共上课分配人数 -> 按原始移动规则逐时段累加 -> 按 peak_slot_person_trips 逐边标定'
    : '由课表按原始仿真的移动规则逐时段累加，再按 peak_slot_person_trips 标定',
  usage: input.kind === 'cells' ? USAGE : undefined,
  // 时段按 (星期, 时刻) 分开：key = d<星期>w<分钟>，例如 d1w0470 = 周一 07:50
  // 周末没有课，所以只有 1~5（见 days）。
  days: [...new Set(acc.windows.map(w => w.weekday))].sort((a, b) => a - b),
  windows: acc.windows.map((w, i) => ({
    key: keyOfWindow(w),
    weekday: w.weekday,
    time: w.time,
    minutes: w.minutes,
    total: totalBySlot[i],
  })),
  peakWindow: keyOfWindow(acc.windows[peakIdx]),
  // 每天各自的峰值时段：界面默认值用得上（选周三就默认看周三最忙那一刻）
  peakWindowByDay: (() => {
    const out = {};
    for (const d of [...new Set(acc.windows.map(w => w.weekday))]) {
      let bi = -1, bv = -1;
      acc.windows.forEach((w, i) => { if (w.weekday === d && totalBySlot[i] > bv) { bv = totalBySlot[i]; bi = i; } });
      if (bi >= 0) out[d] = keyOfWindow(acc.windows[bi]);
    }
    return out;
  })(),
  edgeIndex: graph.edges.map((e, i) => i).filter(i => cal.perEdge[i].some(v => v > 0)),
  flow: null,                       // 下面压缩填写
  stats: {
    inputKind: input.kind,
    timetableRows: parsed.rows.length,
    timetableProblems: parsed.problems.length + acc.problems.length,
    roomsMatched: resolver.stats.matched,
    roomsExcluded: resolver.stats.excluded,
    roomsUnknown: resolver.stats.unknown,
    unknownRoomSamples: resolver.stats.unknownNames,
    excludedRoomSamples: resolver.stats.excludedNames,
    scaleMin: Math.round(cal.scaleInfo.min * 1000) / 1000,
    scaleMax: Math.round(cal.scaleInfo.max * 1000) / 1000,
    scaleMedian: (() => {
      const f = cal.scaleInfo.factors.slice().sort((a, b) => a - b);
      return Math.round(quantile(f, 0.5) * 1000) / 1000;
    })(),
    scaleOver10: cal.scaleInfo.factors.filter(x => x > 10).length,
    edgesWithoutFlow: cal.scaleInfo.zeroFlowEdges,
    routedTrips: acc.routedTrips,
    peakToTrough: acc.windows.length > 1
      ? Math.round((Math.max.apply(null, totalBySlot) / Math.max(Math.min.apply(null, totalBySlot), 1)) * 10) / 10
      : 1,
  },
};
if (input.kind === 'cells') {
  payload.stats.classesInTimetable = input.cellStats.classesInTimetable;
  payload.stats.coursesRaw = input.cellStats.coursesParsed;
  payload.stats.sessions = input.cellStats.sessions;
  payload.stats.sharedSessions = input.cellStats.sharedSessions;
  payload.stats.peopleRawListed = Math.round(input.cellStats.peopleRaw);
  payload.stats.peopleAfterDedup = Math.round(input.cellStats.peopleAfterDedup);
  payload.stats.droppedByConflict = input.cellStats.droppedByConflict;
  payload.stats.peopleMatched = Math.round(acc.peopleStats.matched);
  payload.stats.peopleExcluded = Math.round(acc.peopleStats.excluded);
  payload.stats.peopleUnknown = Math.round(acc.peopleStats.unknown);
  payload.stats.peopleTotalAfterDedup = Math.round(acc.peopleStats.total);
  payload.stats.roomMatchByStrategy = resolver.stats.byStrategy;
  payload.stats.topExcludedRooms = Object.entries(acc.peopleStats.topExcluded)
    .sort((a, b) => b[1] - a[1]).slice(0, 10).map(([room, sessions]) => ({ room, sessions }));
  payload.stats.topUnknownRooms = Object.entries(acc.peopleStats.topUnknown)
    .sort((a, b) => b[1] - a[1]).slice(0, 10).map(([room, sessions]) => ({ room, sessions }));
}
// 只存有流量的路段，省体积
payload.flow = payload.edgeIndex.map(ei => cal.perEdge[ei]);

// 示例课表只写到 tools/ 下当测试夹具，绝不污染小程序真正加载的 data/
const isSample = mode === '--sample';
emit(payload, isSample ? path.join(__dirname, 'time-profile.sample.js') : undefined);
console.log(`时段画像：${payload.edgeIndex.length} 条有流量路段 × ${payload.windows.length} 个时段`);
console.log(isSample
  ? '示例画像写入 tools/time-profile.sample.js（仅供测试，小程序不加载它）'
  : '界面上的时段选择器会自动启用。');
}

if (require.main === module) main();
