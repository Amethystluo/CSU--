/**
 * 时段模型：把"最高峰时段"这一张图，扩展成按**真实课表 + 具体日期**算出的逐时段流量。
 *
 * 背景：原始数据每条路只有两个时间量（学期总量、最高峰时段），没有中间过程，
 * 所以以前整张图只能显示最高峰、夜里也满格。`data/time-profile.js` 是用真实课表
 * 逐时段算出来的画像（见 tools/build-time-profile.js 与《时段数据说明.md》）：
 *   形状来自课表，量级按 peak_slot_person_trips 标定。
 *
 * **按天分开**：画像里的时段是 (星期, 时刻) 二维的，key 形如 `d1w0470` = 周一 07:50。
 * 这不是多余的精度——实测每天差别很大：
 *   周一 最闲/最忙 = 1.9 倍（一天都挺满），周四 = 98 倍（晚上几乎没人）。
 * 所以"选某一天"是真的会换一张热度图，而不是加个装饰。
 *
 * 没有课表时该文件是占位（available=false），这里所有查询都会安全返回"不可用"，
 * 界面于是如实显示为「最高峰时段」口径——绝不假装有时段数据。
 */
let profile = require('../data/time-profile.js');
const router = require('./router.js');

const EDGE_COUNT = router.EDGE_COUNT;
// 离最近的换课时段超过这么久，就认为"当前不是换课时间"
const NEAR_WINDOW_MIN = 60;
const WEEKEND = [0, 6];                  // 课表是周一到周五
const WEEKDAY_CN = ['日', '一', '二', '三', '四', '五', '六'];

function available() {
  return !!(profile && profile.available && profile.windows && profile.windows.length);
}

function reason() {
  return (profile && profile.reason) || '';
}

function source() {
  return (profile && profile.source) || '';
}

/** 画像覆盖了哪几天（1=周一 … 5=周五）。 */
function days() {
  if (!available()) return [];
  if (profile.days && profile.days.length) return profile.days.slice();
  const set = {};
  profile.windows.forEach(w => { set[w.weekday] = 1; });
  return Object.keys(set).map(Number).sort((a, b) => a - b);
}

function windows() {
  return available() ? profile.windows.slice() : [];
}

/** 某一天的换课时段（按时刻递增）。 */
function windowsFor(weekday) {
  if (!available()) return [];
  return profile.windows.filter(w => w.weekday === weekday);
}

/** 画像里是否包含这一天（周末会返回 false）。 */
function hasDay(weekday) {
  if (!available()) return false;
  if (profile.days && profile.days.length) return profile.days.indexOf(weekday) >= 0;
  return profile.windows.some(w => w.weekday === weekday);
}

/** 最忙时段：不传 weekday 就是全周最忙；传了就取那一天最忙的。 */
function peakKey(weekday) {
  if (!available()) return null;
  if (weekday != null && profile.peakWindowByDay && profile.peakWindowByDay[weekday]) {
    return profile.peakWindowByDay[weekday];
  }
  return profile.peakWindow || null;
}

/** 全网在此刻无通勤（周末 / 非换课时段）时用的全零流量。 */
function zeroFlow() {
  return new Float64Array(EDGE_COUNT);
}

let cache = {};
/** 某个时段的逐边流量（下标与 graph.edges 对齐，Float64Array）。 */
function flowAt(key) {
  if (!available() || !key) return null;
  if (cache[key]) return cache[key];
  let idx = -1;
  for (let i = 0; i < profile.windows.length; i++) if (profile.windows[i].key === key) { idx = i; break; }
  if (idx < 0) return null;
  const out = new Float64Array(EDGE_COUNT);
  for (let i = 0; i < profile.edgeIndex.length; i++) out[profile.edgeIndex[i]] = profile.flow[i][idx];
  cache[key] = out;
  return out;
}

const fmt = min => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** 把 Date 归一成"画像用的那一天"：{weekday, weekdayCN, isWeekend, iso, label}。 */
function dateInfo(date) {
  const d = date || new Date();
  const weekday = d.getDay();                        // 0=周日
  return {
    weekday,
    weekdayCN: WEEKDAY_CN[weekday],
    isWeekend: WEEKEND.indexOf(weekday) >= 0,
    iso: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    label: `${d.getMonth() + 1}月${d.getDate()}日 周${WEEKDAY_CN[weekday]}`,
  };
}

/**
 * 给定日期，该看哪个时段。
 * 周末、画像没覆盖的日子、或离最近换课时段超过 1 小时 -> idle（按课表模型没有通勤）。
 */
function currentSlot(date) {
  const d = date || new Date();
  const info = dateInfo(d);
  if (!available()) {
    return { key: null, idle: true, date: info, label: '未提供课表，只能显示最高峰时段' };
  }
  if (info.isWeekend) {
    return { key: null, idle: true, date: info, label: `${info.label}是周末，按课表模型没有通勤` };
  }
  const dayWindows = windowsFor(info.weekday);
  if (!dayWindows.length) {
    return { key: null, idle: true, date: info, label: `${info.label}课表里没有课，按课表模型没有通勤` };
  }
  const min = d.getHours() * 60 + d.getMinutes();
  let best = null;
  let bd = Infinity;
  dayWindows.forEach(w => {
    const dd = Math.abs(w.minutes - min);
    if (dd < bd) { bd = dd; best = w; }
  });
  if (best && bd <= NEAR_WINDOW_MIN) {
    return {
      key: best.key, time: best.time, minutes: best.minutes, weekday: info.weekday,
      near: true, idle: false, date: info,
      label: `${info.label} 最近换课时段 ${best.time}`,
    };
  }
  return { key: null, idle: true, date: info, label: `${info.label} ${fmt(min)} 不是换课时段，按课表模型没有通勤` };
}

/**
 * 给界面用的一张表：可选的"看哪个时段"。
 *
 * 固定项有两种"最忙"，它们**不是一回事**，必须分开给用户：
 *   peak  当天最忙时段 —— 那一天真实存在的一刻；
 *   worst 整周最高峰   —— 各路段各自最忙的时刻拼起来的**包络**，
 *                          它比任何真实时刻都更堵（不同时刻的峰值被叠在了一起）。
 * 传了 weekday 且那天有课时给 peak + worst；否则只给 worst。
 * 不传 weekday 时列全部时段（测试与老调用方用）。
 *
 * @param {number} [weekday] 只列这一天的时段
 * @returns {Array} [{key,label,hint}]
 */
function choices(weekday) {
  const dayWindows = weekday != null ? windowsFor(weekday) : [];
  const hasThatDay = weekday != null && dayWindows.length > 0;
  const list = [
    { key: 'auto', label: '按当前时间（自动）', hint: '打开时自动对到最近的那个换课时段；周末/深夜/没课的日子会显示为无通勤' },
  ];
  if (hasThatDay) {
    list.push({
      key: 'peak',
      label: '当天最忙时段',
      hint: '这一天真实存在的最忙一刻（按课表推算）',
    });
  }
  list.push({
    key: 'worst',
    label: hasThatDay ? '整周最高峰（最坏情况）' : '最高峰时段（最坏情况）',
    hint: '各路段各自最忙的时刻拼起来的包络，比任何真实时刻都更堵；只看最坏情况时用',
  });
  const ws = weekday != null ? dayWindows : windows();
  ws.forEach(w => {
    list.push({
      key: w.key,
      label: `${w.time} 换课`,
      hint: `该时段全网 ${Number(w.total || 0).toLocaleString()} 人次（课表推算）`,
      time: w.time,
      weekday: w.weekday,
    });
  });
  return list;
}

module.exports = {
  NEAR_WINDOW_MIN,
  WEEKDAY_CN,
  available,
  reason,
  source,
  days,
  hasDay,
  windows,
  windowsFor,
  peakKey,
  flowAt,
  zeroFlow,
  dateInfo,
  currentSlot,
  choices,
  // 仅供测试：临时注入一份画像，用完清掉。真机上永远走 data/time-profile.js
  __setProfileForTest(p) {
    profile = p;
    cache = {};
  },
  __clearProfileForTest() {
    profile = require('../data/time-profile.js');
    cache = {};
  },
};
