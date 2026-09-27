/**
 * 校历口径：模型默认"周一到周五按课表上课、周末没课"，
 * 但现实里还有**放假**和**调休**（周六补周四的课）。这里用一张覆盖表来表达，
 * 表本身由用户维护（`data/schedule.js` 与小程序里新增的规则），不写死在代码里。
 *
 * 为什么单独一个模块：日期 -> "这天按哪一天的课表算"这个转换，
 * 时段模型（utils/timeModel.js）与页面都要用，必须只有一处口径。
 */

const WEEKDAY_CN = ['日', '一', '二', '三', '四', '五', '六'];

/**
 * 覆盖条目的两种类型：
 *   holiday 放假   —— 这天不上课（即使本来是工作日）
 *   makeup  调休上课 —— 这天要按 asWeekday（1~5）那天的课表上课（通常是周末补课）
 */
const OVERRIDE_KINDS = [
  { key: 'holiday', name: '放假', hint: '这天不上课（周末本来就放假，不必重复录入）' },
  { key: 'makeup', name: '调休上课', hint: '按指定的星期几上课，例如周六补周四的课' },
];

function pad(n) { return String(n).padStart(2, '0'); }

/** 'YYYY-MM-DD' -> Date（本地时间中午，避免时区把日期挪一天）。 */
function parseISO(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
  return isNaN(d.getTime()) ? null : d;
}

function isoOf(date) {
  const d = date || new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function labelOf(date) {
  return `${date.getMonth() + 1}月${date.getDate()}日 周${WEEKDAY_CN[date.getDay()]}`;
}

function isWeekend(date) {
  const w = date.getDay();
  return w === 0 || w === 6;
}

/** 找出某天的覆盖条目（同一天有多条时取最后一条，便于"改主意"）。 */
function overrideFor(iso, overrides) {
  const list = overrides || [];
  let hit = null;
  for (const o of list) {
    if (o && o.date === iso) hit = o;
  }
  return hit;
}

/**
 * 把日期解析成"这天怎么算"。
 * @param {string|Date} when 'YYYY-MM-DD' 或 Date
 * @param {Array} overrides [{date, kind:'holiday'|'makeup', asWeekday?:1..5, note?}]
 * @returns {{iso, date, weekday, weekdayCN, isWeekend, kind, kindLabel, hasClass,
 *            effectiveWeekday, effectiveCN, note, override, label}}
 */
function resolveDay(when, overrides) {
  const date = typeof when === 'string' ? parseISO(when) : (when || new Date());
  if (!date) return null;
  const iso = isoOf(date);
  const weekday = date.getDay();
  const base = {
    iso,
    date,
    weekday,
    weekdayCN: WEEKDAY_CN[weekday],
    isWeekend: isWeekend(date),
    label: labelOf(date),
    override: null,
    note: '',
  };
  const ov = overrideFor(iso, overrides);

  if (ov && ov.kind === 'holiday') {
    return Object.assign(base, {
      override: ov,
      kind: 'holiday',
      kindLabel: '放假',
      hasClass: false,
      effectiveWeekday: null,
      effectiveCN: null,
      note: ov.note || '按校历放假，这天没有课',
    });
  }
  if (ov && ov.kind === 'makeup') {
    const w = Number(ov.asWeekday);
    const valid = w >= 1 && w <= 5;
    if (valid) {
      return Object.assign(base, {
        override: ov,
        kind: 'makeup',
        kindLabel: `调休上课（按周${WEEKDAY_CN[w]}）`,
        hasClass: true,
        effectiveWeekday: w,
        effectiveCN: WEEKDAY_CN[w],
        note: ov.note || `调休：这天按周${WEEKDAY_CN[w]}的课表上课`,
      });
    }
    // 没写清楚按周几，就按这天本身的星期算（如果是周末则没课）
  }

  if (base.isWeekend) {
    return Object.assign(base, {
      kind: 'weekend',
      kindLabel: '周末',
      hasClass: false,
      effectiveWeekday: null,
      effectiveCN: null,
      note: '周末按课表模型没有课',
    });
  }
  return Object.assign(base, {
    kind: 'normal',
    kindLabel: '正常上课日',
    hasClass: true,
    effectiveWeekday: weekday,
    effectiveCN: WEEKDAY_CN[weekday],
    note: '',
  });
}

/** 校验一条覆盖条目，返回问题清单（空数组=没问题）。 */
function validateOverride(o) {
  const problems = [];
  if (!o) return ['覆盖条目为空'];
  if (!parseISO(o.date)) problems.push('日期格式应为 YYYY-MM-DD');
  if (o.kind !== 'holiday' && o.kind !== 'makeup') problems.push('类型只能是 holiday（放假）或 makeup（调休上课）');
  if (o.kind === 'makeup') {
    const w = Number(o.asWeekday);
    if (!(w >= 1 && w <= 5)) problems.push('调休要指定按周几上课（1~5）');
  }
  return problems;
}

/**
 * 日期那一行的小字说明：这天按哪天的课表、有几个换课时段、模型的边界。
 *
 * 只接**普通数字**（几个换课时段 / 最忙时刻），不依赖 timeModel —— 这样路线页与
 * 模块二级页能用**同一份说法**。以前两页各写一份，改了一处另一处就对不上。
 *
 * @param {Object} day calendar.resolveDay 的结果
 * @param {{windows?:number, peakTime?:string}} [opts]
 */
function describeDay(day, opts) {
  if (!day) return '';
  const o = opts || {};
  const parts = [];
  if (day.kind === 'holiday') parts.push(`${day.label} 放假，按没有课算。`);
  else if (day.kind === 'makeup') parts.push(`${day.label} 调休：按周${day.effectiveCN}的课表上课。`);
  else if (day.isWeekend) parts.push(`${day.label} 是周末，课表模型没有课，这天没有通勤。`);
  else parts.push(`${day.label} 正常上课日。`);

  const n = Number(o.windows) || 0;
  if (n > 0) {
    parts.push(`课表共 ${n} 个换课时段${o.peakTime ? `，最忙是 ${o.peakTime}` : ''}。`);
  }
  parts.push('模型按「典型教学周」推算，不区分节假日与考试周，'
    + '放假/调休请到「事件与校历」页录入；天气仍按实时天气，不随这个日期变。');
  return parts.join('');
}

/** 覆盖条目的可读描述，例如「10月10日 周六 · 调休上课（按周四）」。 */
function describeOverride(o) {
  const d = parseISO(o && o.date);
  if (!d) return '(日期无效)';
  const kind = o.kind === 'holiday' ? '放假' : `调休上课（按周${WEEKDAY_CN[Number(o.asWeekday)] || '?'}）`;
  return `${labelOf(d)} · ${kind}${o.note ? ' · ' + o.note : ''}`;
}

module.exports = {
  WEEKDAY_CN,
  OVERRIDE_KINDS,
  pad,
  isoOf,
  parseISO,
  labelOf,
  resolveDay,
  describeDay,
  overrideFor,
  validateOverride,
  describeOverride,
};
