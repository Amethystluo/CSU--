/**
 * 事件 / 校历的存取。
 *
 * 两个来源：
 *   data/schedule.js —— 随包发布的预置内容（默认空，可放学校官方安排）
 *   本机存储         —— 使用者在小程序里自己加的（新增 / 修改 / 删除）
 * 合起来就是"当前生效的事件表与校历表"。
 *
 * 和 utils/reportStore.js 一样保持可插拔：现在只落本机，接云开发时把
 * `load/save` 换掉即可，上层不用改。
 */
const schedule = require('../data/schedule.js');

const STORAGE_KEY = 'schedule_v1';

function blank() {
  return { events: [], dayOverrides: [] };
}

function load() {
  try {
    const raw = wx.getStorageSync(STORAGE_KEY);
    if (!raw) return blank();
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return {
      events: Array.isArray(data.events) ? data.events : [],
      dayOverrides: Array.isArray(data.dayOverrides) ? data.dayOverrides : [],
    };
  } catch (e) {
    return blank();
  }
}

function save(data) {
  try {
    wx.setStorageSync(STORAGE_KEY, JSON.stringify(data));
    return true;
  } catch (e) {
    return false;
  }
}

/** 预置 + 本机，按 id 去重（本机的覆盖预置的）。 */
function all() {
  const local = load();
  const seen = {};
  const events = [];
  // 本机优先，保证"改过的"能看到改后的样子
  local.events.forEach(e => { if (e && e.id) { seen[e.id] = 1; events.push(e); } });
  (schedule.events || []).forEach(e => { if (e && e.id && !seen[e.id]) events.push(e); });
  const ovSeen = {};
  const dayOverrides = [];
  local.dayOverrides.forEach(o => { if (o && o.date) { ovSeen[o.date] = 1; dayOverrides.push(o); } });
  (schedule.dayOverrides || []).forEach(o => { if (o && o.date && !ovSeen[o.date]) dayOverrides.push(o); });
  return { events, dayOverrides };
}

function events() { return all().events; }
function dayOverrides() { return all().dayOverrides; }

/** 某一天的事件。 */
function eventsOn(iso) {
  return events().filter(e => e.date === iso);
}

/** 新增或更新一条事件（按 id）。 */
function putEvent(event) {
  const data = load();
  const i = data.events.findIndex(e => e.id === event.id);
  if (i >= 0) data.events[i] = event; else data.events.push(event);
  save(data);
  return event;
}

function removeEvent(id) {
  const data = load();
  data.events = data.events.filter(e => e.id !== id);
  save(data);
  return all();
}

/** 新增或更新一条校历覆盖（按日期，同一天只留一条）。 */
function putOverride(o) {
  const data = load();
  const i = data.dayOverrides.findIndex(x => x.date === o.date);
  if (i >= 0) data.dayOverrides[i] = o; else data.dayOverrides.push(o);
  save(data);
  return o;
}

function removeOverride(date) {
  const data = load();
  data.dayOverrides = data.dayOverrides.filter(o => o.date !== date);
  save(data);
  return all();
}

/**
 * 载入示例：把 data/schedule.js 里的 samples 填进本机存储。
 * 日期留空的示例会**顺延到最近几天**（今天 / 明天 / 后天），否则演示时看不到效果。
 */
function loadSamples(todayISO, addDays) {
  const samples = schedule.samples || blank();
  const shift = (base, n) => {
    if (!base) return '';
    const parts = String(base).split('-').map(Number);
    const d = new Date(parts[0], parts[1] - 1, parts[2]);
    d.setDate(d.getDate() + n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const base = todayISO || '';
  const data = load();
  (samples.events || []).forEach((e, i) => {
    const ev = Object.assign({}, e, { date: shift(base, i) });
    const at = data.events.findIndex(x => x.id === ev.id);
    if (at >= 0) data.events[at] = ev; else data.events.push(ev);
  });
  (samples.dayOverrides || []).forEach((o, i) => {
    const ov = Object.assign({}, o, { date: shift(base, 2 + i) });
    const at = data.dayOverrides.findIndex(x => x.date === ov.date);
    if (at >= 0) data.dayOverrides[at] = ov; else data.dayOverrides.push(ov);
  });
  save(data);
  void addDays;
  return all();
}

function clearLocal() {
  save(blank());
  return all();
}

module.exports = {
  STORAGE_KEY,
  load,
  save,
  all,
  events,
  dayOverrides,
  eventsOn,
  putEvent,
  removeEvent,
  putOverride,
  removeOverride,
  loadSamples,
  clearLocal,
};
