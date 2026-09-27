/**
 * 作息时间表：把"换课时刻"翻译成人话。
 *
 * 时段画像里的 07:50 / 09:40 / 09:50 … 其实是**换课时刻**：
 *   第1-2节 08:00-09:40 → 课前 07:50（上课前 10 分钟出发）、课后 09:40
 *   第3-4节 10:00-11:40 → 课前 09:50、课后 11:40
 *   …
 * 直接给用户看"07:50 换课"很难懂，所以这里提供"第N-M节 课前/课后"的对应关系与整张课表。
 *
 * ⚠️ 这张表必须与 `tools/build-time-profile.js` 里的 BLOCKS 一致 ——
 *    时段画像就是按那张表算出来的。改了一处要同时改另一处（有测试守着两者一致）。
 *
 * 也提醒一句：课表里**没有上下课时间**，这份节次时间属于学校通行作息，不是从数据里算出来的
 * （第11-12节标了 assumed，因为用到它的课很少）。
 */
const LEAD_MIN = 10;                 // 上课前 10 分钟出发（与构建脚本一致）

const PERIODS = [
  { key: 'p1', name: '第1-2节', start: '08:00', end: '09:40' },
  { key: 'p3', name: '第3-4节', start: '10:00', end: '11:40' },
  { key: 'p5', name: '第5-6节', start: '14:00', end: '15:40' },
  { key: 'p7', name: '第7-8节', start: '16:00', end: '17:40' },
  { key: 'p9', name: '第9-10节', start: '19:00', end: '20:40' },
  { key: 'p11', name: '第11-12节', start: '21:00', end: '22:40', assumed: true },
];

function toMinutes(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

const fmt = min => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** 这一节的"课前出发时刻"与"下课时刻"（分钟）。 */
function marksOf(period) {
  const s = toMinutes(period.start);
  const e = toMinutes(period.end);
  return { before: s == null ? null : s - LEAD_MIN, after: e };
}

/** 某个换课时刻属于哪一节、是课前还是课后；认不出来返回 null。 */
function describe(minutes) {
  const min = Number(minutes);
  if (!isFinite(min)) return null;
  for (const p of PERIODS) {
    const m = marksOf(p);
    if (m.before === min) return { period: p, name: p.name, phase: '课前', text: `${p.name} 课前` };
    if (m.after === min) return { period: p, name: p.name, phase: '课后', text: `${p.name} 课后` };
  }
  return null;
}

/** 「第1-2节 课前」这种可读标签；认不出就退回时刻本身。 */
function labelOf(minutes) {
  const d = describe(minutes);
  return d ? d.text : `${fmt(minutes)} 换课`;
}

/**
 * 千分位（218212 -> 218,212）。
 * 不用 toLocaleString：小程序运行时不一定带完整 Intl，这里只要结果稳定。
 */
function groupNum(n) {
  const s = String(Math.round(Number(n) || 0));
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * 把某一天的换课时段整理成一张作息表：每一节一行，课前/课后两个可选项。
 * 那天没课的节次也会列出来（只是没有可选项），这样"周三下午没课"一眼能看见。
 *
 * @param {number} weekday 1~5
 * @param {Array} windows timeModel.windowsFor(weekday) 的结果
 */
function tableFor(weekday, windows) {
  const list = windows || [];
  return PERIODS.map(p => {
    const m = marksOf(p);
    const before = list.find(w => w.minutes === m.before) || null;
    const after = list.find(w => w.minutes === m.after) || null;
    const pick = w => (w ? {
      key: w.key, time: w.time, total: w.total, minutes: w.minutes,
      // WXML 里没法调 toLocaleString，所以这里先格式化好（218212 -> 218,212）
      totalText: groupNum(w.total),
    } : null);
    return {
      key: p.key,
      name: p.name,
      start: p.start,
      end: p.end,
      assumed: !!p.assumed,
      weekday,
      before: pick(before),
      after: pick(after),
      hasClass: !!(before || after),
    };
  });
}

/** 这张表里一共有几个可选的换课时段。 */
function countPicks(table) {
  return (table || []).reduce((a, row) => a + (row.before ? 1 : 0) + (row.after ? 1 : 0), 0);
}

module.exports = {
  LEAD_MIN,
  PERIODS,
  toMinutes,
  fmt,
  groupNum,
  marksOf,
  describe,
  labelOf,
  tableFor,
  countPicks,
};
