/**
 * 事件与校历页：把"事件"当成一等公民来管理，而不是写在页面里的开关。
 *
 * 两件事：
 *   1. 事件：活动名 / 类型 / 日期 / 起止时间 / 场馆 / **谁参加（年级 × 专业）** / 预计人数
 *      —— 保存后立刻能看到"选了谁、多少人、从几栋宿舍出发、入场离场在几点"。
 *   2. 校历：放假 / 调休（周六补周四的课），让时段模型知道"这天按哪天的课表算"。
 *
 * 数据落在 utils/eventStore.js（本机存储）；默认空空如也，点「载入示例」可以看效果。
 */
const eventsUtil = require('../../utils/events.js');
const calendar = require('../../utils/calendar.js');
const store = require('../../utils/eventStore.js');

const TYPE_NAMES = eventsUtil.EVENT_TYPES.map(t => t.name);
const VENUES = eventsUtil.venueOptions();
const VENUE_NAMES = VENUES.map(v => v.name);
const KIND_NAMES = calendar.OVERRIDE_KINDS.map(k => k.name);
const WEEK_NAMES = ['周一', '周二', '周三', '周四', '周五'];

function emptyForm(dateISO) {
  return eventsUtil.normalize({
    title: '', type: 'sports', date: dateISO,
    start: '08:00', end: '17:00',
    venue: VENUE_NAMES[0] || '', grades: [], departments: [], headcount: 0, note: '',
  });
}

/** 把 100 个"学院"粗分做成可勾选、可展开的列表。 */
function buildGroups(selected) {
  const sel = new Set(selected || []);
  return eventsUtil.peopleIndex.groups.map(g => {
    const prefixes = g.prefixes.map(name => {
      const p = eventsUtil.peopleIndex.prefixes.find(x => x.name === name);
      return { name, students: p ? p.students : 0, checked: sel.has(name) };
    });
    const on = prefixes.filter(p => p.checked).length;
    return {
      key: g.key, label: g.label, students: g.students, classes: g.classes,
      prefixes,
      checked: on === prefixes.length,
      partial: on > 0 && on < prefixes.length,
      expanded: false,
    };
  });
}

Page({
  data: {
    tab: 'events',
    todayISO: '',
    dateISO: '',
    dateLabel: '',
    dayInfo: null,

    // 列表
    list: [],
    listCount: 0,
    totalEvents: 0,
    overrideList: [],

    // 编辑表单
    editing: false,
    form: null,
    formProblems: [],
    typeNames: TYPE_NAMES,
    typeIndex: 0,
    venueNames: VENUE_NAMES,
    venueIndex: 0,
    venueHint: '',
    grades: [],
    groups: [],
    groupKeyword: '',
    audienceText: '',
    audienceStudents: 0,
    audienceClasses: 0,
    audienceDorms: 0,
    windowsText: '',
    headcountHint: '',

    // 校历
    kindNames: KIND_NAMES,
    weekNames: WEEK_NAMES,
    ovForm: null,
    ovProblems: [],

    toast: '',
  },

  onLoad() {
    const today = calendar.isoOf(new Date());
    this.setData({ todayISO: today, dateISO: today });
    this.refresh(today);
  },

  onShow() {
    this.refresh(this.data.dateISO || this.data.todayISO);
  },

  // ---------------------------------------------------------------- 列表
  refresh(dateISO) {
    const iso = dateISO || this.data.todayISO;
    const all = store.all();
    const dayInfo = calendar.resolveDay(iso, all.dayOverrides);
    const list = eventsUtil.onDate(all.events, iso).map(e => this.describeRow(e));
    const overrideList = all.dayOverrides.slice()
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .map(o => ({ date: o.date, kind: o.kind, label: calendar.describeOverride(o), note: o.note || '' }));
    this.setData({
      dateISO: iso,
      dateLabel: dayInfo ? dayInfo.label : iso,
      dayInfo,
      list,
      listCount: list.length,
      totalEvents: all.events.length,
      overrideList,
    });
  },

  describeRow(e) {
    const a = eventsUtil.audienceOf(e);
    const h = eventsUtil.headcountOf(e, a);
    const v = eventsUtil.venueOf(e);
    const ws = eventsUtil.windowsOf(e);
    const t = eventsUtil.typeOf(e.type);
    return {
      id: e.id,
      title: e.title,
      typeName: t.name,
      typeHint: t.hint,
      timeText: `${e.start} - ${e.end}`,
      venueText: v ? v.name : '场馆未定',
      venueSnap: v ? `${v.kind} · 离最近路口约 ${v.snapMeters} 米` : '',
      audienceText: eventsUtil.describeAudience(e),
      peopleText: `${Math.round(h.people).toLocaleString()} 人`,
      peopleSource: h.source === 'estimated' ? '预计人数' : '按选中人群',
      dormText: `涉及 ${a.dorms.length} 栋宿舍 / ${a.classes} 个班`,
      windowText: ws.map(w => `${eventsUtil.fmt(w.minutes)} ${w.kind === 'arrival' ? '入场' : '离场'}`).join(' · '),
      note: e.note || '',
      raw: e,
    };
  },

  onTab(e) {
    this.setData({ tab: e.currentTarget.dataset.tab });
  },

  onDateChange(e) {
    this.refresh(e.detail.value);
  },

  // ---------------------------------------------------------------- 表单
  startNew() {
    const form = emptyForm(this.data.dateISO);
    this.setForm(form);
  },

  editEvent(e) {
    const id = e.currentTarget.dataset.id;
    const ev = this.data.list.find(x => x.id === id);
    if (ev) this.setForm(JSON.parse(JSON.stringify(ev.raw)));
  },

  setForm(form) {
    const typeIndex = Math.max(0, eventsUtil.EVENT_TYPES.findIndex(t => t.key === form.type));
    const venueIndex = Math.max(0, VENUE_NAMES.indexOf(form.venue));
    const grades = eventsUtil.peopleIndex.grades.map(g => ({
      code: g.code,
      label: g.label,
      students: g.students,
      checked: form.grades.indexOf(g.code) >= 0,
    }));
    this.setData({
      editing: true,
      form,
      formProblems: [],
      typeIndex,
      venueIndex,
      grades,
      groups: buildGroups(form.departments),
      groupKeyword: '',
    }, () => this.recalc());
  },

  cancelEdit() {
    this.setData({ editing: false, form: null, formProblems: [] });
  },

  onTitleInput(e) { this.patch({ title: e.detail.value }); },
  onNoteInput(e) { this.patch({ note: e.detail.value }); },
  onHeadcountInput(e) { this.patch({ headcount: Number(e.detail.value) || 0 }); },

  onTypeChange(e) {
    const i = Number(e.detail.value);
    const t = eventsUtil.EVENT_TYPES[i];
    // 换类型时把默认时长/提前量也带过来，省得手填
    this.patch({ type: t.key, start: t.start, end: t.end, leadMin: t.leadMin });
  },
  onFormDateChange(e) { this.patch({ date: e.detail.value }); },
  onStartChange(e) { this.patch({ start: e.detail.value }); },
  onEndChange(e) { this.patch({ end: e.detail.value }); },
  onVenueChange(e) {
    const i = Number(e.detail.value);
    this.patch({ venue: VENUE_NAMES[i], venuePoint: null });
  },

  patch(obj) {
    const form = Object.assign({}, this.data.form, obj);
    // 人群一变就重建勾选列表，否则 chip 的选中态不会更新，
    // 连"再点一次取消"都会失效（它读的是 data.groups 里的 checked）。
    // 展开状态要保留，不然每次勾选都把用户展开的学院收起来。
    const expanded = {};
    (this.data.groups || []).forEach(g => { if (g.expanded) expanded[g.key] = true; });
    const groups = buildGroups(form.departments)
      .map(g => (expanded[g.key] ? Object.assign({}, g, { expanded: true }) : g));
    this.setData({ form, groups }, () => this.recalc());
  },

  // ---------------------------------------------------------------- 参加人群
  toggleGrade(e) {
    const code = e.currentTarget.dataset.code;
    const grades = this.data.form.grades.slice();
    const i = grades.indexOf(code);
    if (i >= 0) grades.splice(i, 1); else grades.push(code);
    this.patch({ grades });
  },

  toggleGroup(e) {
    const key = e.currentTarget.dataset.key;
    const g = this.data.groups.find(x => x.key === key);
    if (!g) return;
    let sel = this.data.form.departments.slice();
    const names = g.prefixes.map(p => p.name);
    if (g.checked) sel = sel.filter(n => names.indexOf(n) < 0);
    else names.forEach(n => { if (sel.indexOf(n) < 0) sel.push(n); });
    this.patch({ departments: sel });
  },

  togglePrefix(e) {
    const name = e.currentTarget.dataset.name;
    let sel = this.data.form.departments.slice();
    const i = sel.indexOf(name);
    if (i >= 0) sel.splice(i, 1); else sel.push(name);
    this.patch({ departments: sel });
  },

  toggleExpand(e) {
    const key = e.currentTarget.dataset.key;
    const groups = this.data.groups.map(g => (g.key === key ? Object.assign({}, g, { expanded: !g.expanded }) : g));
    this.setData({ groups });
  },

  onGroupSearch(e) {
    this.setData({ groupKeyword: e.detail.value });
  },

  clearAudience() {
    this.patch({ grades: [], departments: [] });
  },

  /** 重算"选了谁、多少人、几点入场" */
  recalc() {
    const form = this.data.form;
    if (!form) return;
    const a = eventsUtil.audienceOf(form);
    const h = eventsUtil.headcountOf(form, a);
    const ws = eventsUtil.windowsOf(form);
    const v = eventsUtil.venueOf(form);
    this.setData({
      audienceText: eventsUtil.describeAudience(form),
      audienceStudents: a.students,
      audienceClasses: a.classes,
      audienceDorms: a.dorms.length,
      windowsText: ws.map(w => `${eventsUtil.fmt(w.minutes)} ${w.kind === 'arrival' ? '入场' : '离场'}`).join(' · '),
      headcountHint: form.headcount > 0
        ? `按预计 ${Number(form.headcount).toLocaleString()} 人算（选中人群实际 ${a.students.toLocaleString()} 人）`
        : `留空 = 按选中人群的实际人数 ${a.students.toLocaleString()} 人`,
      venueHint: v ? `${v.kind} · 离最近路口约 ${v.snapMeters} 米 · 节点 #${v.node}` : '场馆没选',
    });
    void h;
  },

  saveEvent() {
    const form = this.data.form;
    const problems = eventsUtil.validate(form);
    if (problems.length) {
      this.setData({ formProblems: problems });
      return;
    }
    store.putEvent(eventsUtil.normalize(form));
    eventsUtil.clearCache();
    this.setData({ editing: false, form: null, formProblems: [], toast: '已保存' });
    this.refresh(form.date);
  },

  removeEvent(e) {
    const id = e.currentTarget.dataset.id;
    store.removeEvent(id);
    eventsUtil.clearCache();
    this.setData({ toast: '已删除' });
    this.refresh();
  },

  loadSamples() {
    store.loadSamples(this.data.todayISO);
    eventsUtil.clearCache();
    this.setData({ toast: '已载入示例（日期顺延到今天起）' });
    this.refresh();
  },

  clearAll() {
    store.clearLocal();
    eventsUtil.clearCache();
    this.setData({ toast: '已清空本机的事件与校历' });
    this.refresh();
  },

  // ---------------------------------------------------------------- 校历
  startOverride() {
    this.setData({ ovForm: { date: this.data.dateISO, kind: 'holiday', asWeekday: 1 }, ovProblems: [] });
  },

  onOvDate(e) { this.setData({ 'ovForm.date': e.detail.value }); },
  onOvKind(e) {
    const i = Number(e.detail.value);
    this.setData({ 'ovForm.kind': calendar.OVERRIDE_KINDS[i].key });
  },
  onOvWeek(e) {
    const i = Number(e.detail.value);
    this.setData({ 'ovForm.asWeekday': i + 1 });
  },
  onOvNote(e) { this.setData({ 'ovForm.note': e.detail.value }); },
  cancelOverride() { this.setData({ ovForm: null, ovProblems: [] }); },

  saveOverride() {
    const o = this.data.ovForm;
    const problems = calendar.validateOverride(o);
    if (problems.length) { this.setData({ ovProblems: problems }); return; }
    store.putOverride({ date: o.date, kind: o.kind, asWeekday: o.kind === 'makeup' ? Number(o.asWeekday) : undefined, note: o.note || '' });
    this.setData({ ovForm: null, ovProblems: [], toast: '校历已保存' });
    this.refresh(o.date);
  },

  removeOverride(e) {
    store.removeOverride(e.currentTarget.dataset.date);
    this.setData({ toast: '已删除' });
    this.refresh();
  },

  goRoute() {
    wx.navigateTo({ url: '/pages/route/route' });
  },

  back() {
    wx.navigateBack({ delta: 1 });
  },
});
