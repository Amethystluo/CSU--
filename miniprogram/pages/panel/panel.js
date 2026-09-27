/**
 * 模块二级页：一个通用页 + key 区分。
 *
 * 9 个模块（时段 / 事件 / 天气 / 上报 / 交警 / 定位 / 封路 / 拥堵 / 结果）共用这一个页面，
 * 靠 query 的 key 决定显示哪一块。
 *
 * 分工（重要）：
 *   显示  <- 路线页算好放进 utils/panelBus.js 的 snapshot（路线页是唯一的计算者）
 *   改动  -> 写 utils/session.js，再推一条 intent；路线页 onShow 时统一读取并重算
 * 所以这里**不做任何业务计算**，只做"改参数 + 显示 + 跳到别的页"。
 */
const session = require('../../utils/session.js');
const panelBus = require('../../utils/panelBus.js');
const pickBus = require('../../utils/pickBus.js');
const router = require('../../utils/router.js');
const reports = require('../../utils/reports.js');
const reportStore = require('../../utils/reportStore.js');
const timeModel = require('../../utils/timeModel.js');
const periods = require('../../utils/periods.js');
const calendar = require('../../utils/calendar.js');
const eventStore = require('../../utils/eventStore.js');
const closedRoads = require('../../utils/closedRoads.js');

/** 版本标记：与 route.js 的 BUILD 一起用，确认跑的不是热重载留下的旧 JS。 */
const BUILD = 'panel-v1';

/** 与路线页保持完全一致的天气档位表 */
const WEATHER_CHOICES = [
  { key: 'auto', name: '自动（联网获取）' },
  { key: 'none', name: '晴天（不减速）' },
  { key: 'light', name: '小雨' },
  { key: 'heavy', name: '中到大雨' },
];

const TITLES = {
  time: '预测时段',
  event: '当天事件',
  weather: '天气',
  report: '实时路况上报',
  police: '交警规避',
  locate: '实时定位',
  close: '直接封路',
  congestion: '拥堵预测',
  result: '规划结果',
};

const SNAP_KEY = 'route';

Page({
  data: {
    key: 'time',
    title: '模块设置',
    // 页面上引用到的字段都在这里先声明一遍。
    // 好处：① 首次渲染不会出现 undefined 取值（例如 timeChoices[timeIndex].label）；
    //       ② tools/check-page-wiring.js 能逐字段核对，漏声明会被抓出来。
    weatherChoices: WEATHER_CHOICES,
    weatherAssumption: '',
    effective: null,
    policeDelayMinutes: router.POLICE_DELAY_MINUTES,
    noSnapshot: false,          // 没拿到路线页快照时，页面顶部给一条明确提示

    // 时段与日期
    timeAvailable: false,
    timeChoices: [],
    timeIndex: 0,
    timeChoice: 'auto',
    timeChoiceLabel: '按当前时间（自动）',
    timeText: '',
    timeHint: '',
    timeIdle: false,
    caliber: '最高峰时段',
    dateISO: '',
    dateLabel: '',
    dateHint: '',
    dateMin: '2024-01-01',
    dateMax: '2030-12-31',
    isWeekend: false,
    dayKind: 'normal',
    dayKindLabel: '',
    dayWindowCount: 0,

    // 作息时间表（「预测时段」这一页的主体）
    weekdayTabs: [],
    periodTable: [],
    tablePicks: 0,
    previewWeekday: null,
    previewName: '',
    offDay: false,
    offDayNote: '',
    tableHint: '',

    // 事件
    eventList: [],
    eventCount: 0,
    eventIncluded: 0,
    eventText: '',

    // 天气
    weatherChoice: 'auto',
    weatherIndex: 0,
    weatherLoading: false,
    weatherText: '',
    weatherDetail: '',
    weatherFetchedAt: '',
    weatherError: '',
    weatherSource: '',

    // 上报
    reportSummary: '',
    reportCounts: null,
    reportBackend: '',
    reportCloud: false,

    // 交警 / 定位 / 封路
    avoidPolice: false,
    policeCount: 0,
    tracking: false,
    trackingText: '',
    trackingError: '',
    closedList: [],

    // 情景与结果
    congestion: null,
    scenarioSummary: '',
    scenarioNote: '',
    atBaseline: true,
    result: null,
    comparison: [],
    insight: '',
    policeInsight: '',
    hint: '',
  },

  onLoad(query) {
    console.log('[panel] build =', BUILD, 'key =', (query && query.key) || 'time');
    const key = (query && query.key) || 'time';
    this.setData({
      key: TITLES[key] ? key : 'time',
      title: TITLES[key] || '模块设置',
    });
    wx.setNavigationBarTitle({ title: TITLES[key] || '模块设置' });
    this.pull();
    this.loadEffective();
  },

  /** 校历覆盖（放假 / 调休），与路线页同一份数据。 */
  dayOverrides() {
    try {
      return eventStore.dayOverrides();
    } catch (e) {
      return [];
    }
  },

  /** 从别的页回来（比如点选页、管理页）时，数据可能已经变了。 */
  onShow() {
    this.takePickResult();
    this.pull();
    this.loadEffective();
  },

  /**
   * 收下点选页回传的结果。
   *
   * 为什么**模块页也要收**：点选页是从这一页打开的，"返回"先回到这里。
   * 原来只有路线页在 onShow 里收，于是封完路回到本页时：
   *   - 本页的封路清单还是空的；
   *   - `session.closedList` 也没更新 —— **再进点选页时那条路还是"没封"的样子**
   *     （画着正常的热度色；占用率低的时候正好是黄色，看着就像"封路没生效、热度图没重算"）。
   *
   * 分工不变：本页只把用户输入写进 session，并推一条 intent，
   * 真正的重算仍然由路线页做（与改天气/时段完全一样）。
   */
  takePickResult() {
    let picked = null;
    try { picked = pickBus.take(); } catch (e) { picked = null; }
    if (!picked) return;

    if (picked.action === 'close') {
      const item = closedRoads.itemFromPick(picked);
      if (!item) return;
      const merged = closedRoads.add(session.get().closedList, item);
      if (!merged.added) {
        wx.showToast({ title: '这条路已经封了', icon: 'none' });
        return;
      }
      session.patch({ closedList: merged.list });
      panelBus.pushIntent('applyConfig');
      wx.showToast({ title: `已封闭 ${item.roadType}`, icon: 'none' });
      return;
    }

    if (picked.action === 'report') {
      const report = reports.createFromPick(picked);
      if (!report) {
        wx.showToast({ title: '上报内容不完整', icon: 'none' });
        return;
      }
      // 落到上报库里（路线页下次 onShow 会重新读库，所以这里存进去就够了）
      reportStore.add(report, ok => {
        if (!ok) wx.showToast({ title: '已存本机，云端同步失败', icon: 'none' });
      });
      panelBus.pushIntent('applyConfig');
      wx.showToast({
        title: reportStore.cloudAvailable() ? '已提交，等待核实' : '已提交（本机），待核实',
        icon: 'none',
      });
    }
  },

  // ---------------------------------------------------------------- 作息时间表
  /**
   * 日期相关的显示字段。
   *
   * **必须在本地算，不能等路线页回推** —— 否则用户在这个页面选了日期，
   * 徽标/说明/作息表全都还是旧的那一天，看起来就像"日期没改"。
   * （路线页仍然会在 onShow 时按 session 重算一遍，这里只是即时反馈。）
   */
  dayFields(dateISO) {
    const iso = dateISO || this.data.dateISO || calendar.isoOf(new Date());
    const day = calendar.resolveDay(iso, this.dayOverrides());
    const wd = (day && day.hasClass) ? day.effectiveWeekday : null;
    const ws = (wd != null && timeModel.available()) ? timeModel.windowsFor(wd) : [];
    const peak = ws.find(w => w.key === timeModel.peakKey(wd));
    return {
      dateISO: iso,
      dateLabel: day ? day.label : iso,
      isWeekend: !!(day && day.isWeekend),
      dayKind: day ? day.kind : 'normal',
      dayKindLabel: day ? day.kindLabel : '',
      dayWindowCount: ws.length,
      dateHint: calendar.describeDay(day, {
        windows: ws.length,
        peakTime: peak ? peak.time : '',
      }),
    };
  },

  /**
   * 「预测时段」这一页的核心：把换课时刻整理成一张**作息表**
   * （第1-2节 / 第3-4节 … 每节列出「课前」「课后」两个时刻，各带全网人次）。
   *
   * 为什么要有"看哪一天"：所选日期如果是周末或放假，那天本来就没有课，
   * 只列日期自己的时段会变成一片空白。所以这里退回到"看某一天的课表"，
   * 默认挑一个上课日，并且可以手动切换周一到周五。
   */
  buildTable() {
    const day = calendar.resolveDay(this.data.dateISO || calendar.isoOf(new Date()), this.dayOverrides());
    // 所选日期有课就用它；没有（周末/放假）就默认看最近的上课日
    let wd = this.previewWeekday;
    if (wd == null) wd = (day && day.hasClass) ? day.effectiveWeekday : 1;
    if (!timeModel.available()) wd = null;

    const weekdays = [1, 2, 3, 4, 5].map(w => ({
      w,
      name: '周' + timeModel.WEEKDAY_CN[w],
      active: w === wd,
      hasClass: timeModel.hasDay(w),
    }));
    const table = wd == null ? [] : periods.tableFor(wd, timeModel.windowsFor(wd));
    const picks = periods.countPicks(table);
    const selected = this.data.timeChoice;
    table.forEach(row => {
      [row.before, row.after].forEach(p => {
        if (p) p.selected = p.key === selected;
      });
    });

    // 第一句就是"这天怎么算"，与路线页/日期那一行同源（calendar.describeDay）
    const dayNote = day ? calendar.describeDay(day, {}).split('。')[0] + '。' : '';
    const offDay = !!(day && !day.hasClass);

    this.setData({
      weekdayTabs: weekdays,
      periodTable: table,
      tablePicks: picks,
      previewWeekday: wd,
      previewName: wd == null ? '' : '周' + timeModel.WEEKDAY_CN[wd],
      offDay,
      offDayNote: offDay
        ? `${dayNote}下面这张是「周${timeModel.WEEKDAY_CN[wd]}」的作息表 —— 点任意一节课的课前/课后，就能看那一刻的路况。`
        : dayNote,
      tableHint: timeModel.available()
        ? '课表里没有上下课时间，节次对应时刻用的是学校通行作息（第11-12节为假设值）。'
        : '当前没有课表画像，只能看最高峰时段。',
    });
  },

  /** 切"看周几的课表"。 */
  onWeekday(e) {
    const w = Number(e.currentTarget.dataset.w);
    if (!w || !timeModel.hasDay(w)) return;
    this.previewWeekday = w;
    this.buildTable();
  },

  /** 点某一节课的「课前」或「课后」-> 按那个时刻重算。 */
  onPickSlot(e) {
    const key = e.currentTarget.dataset.key;
    if (!key) return;
    session.patch({ timeChoice: key });
    panelBus.pushIntent('applyConfig');
    // 提示优先用"第1-2节 课前"这种人话；万一带不上分钟数，就退回 key，别显示 NaN:NaN
    const mins = Number(e.currentTarget.dataset.minutes);
    wx.showToast({ title: '已选 ' + (isFinite(mins) ? periods.labelOf(mins) : key), icon: 'none' });
    this.setData({ timeChoice: key }, () => this.buildTable());
  },

  /** 把路线页的快照 + session 里的配置拉进 data。 */
  pull() {
    const snap = panelBus.getSnapshot(SNAP_KEY);
    const s = session.get();
    const src = snap || {};
    const weatherChoice = src.weatherChoice || s.weatherChoice || 'auto';
    const wi = WEATHER_CHOICES.findIndex(w => w.key === weatherChoice);
    const timeChoices = src.timeChoices || [];
    const timeIndex = Math.min(Math.max(0, src.timeIndex || 0), Math.max(0, timeChoices.length - 1));
    const picked = timeChoices[timeIndex];
    // 日期以 session 为准（它是"用户改过的配置"的唯一出处），快照只是路线页上次推来的旧值；
    // 反过来的话，在别的页待一会儿再回来，日期就会被旧快照顶回去 —— 看起来就像"日期没改"。
    const dayFields = this.dayFields(s.dateISO || src.dateISO || '');
    this.setData(Object.assign({
      noSnapshot: !snap,
      // 时段（label 预先算好，避免在 WXML 里写 timeChoices[timeIndex].label 这种可能取到 undefined 的表达式）
      timeAvailable: !!src.timeAvailable,
      timeChoices,
      timeIndex,
      timeChoice: s.timeChoice || src.timeChoice || 'auto',
      timeChoiceLabel: picked ? picked.label : '按当前时间（自动）',
      timeText: src.timeText || '',
      timeHint: src.timeHint || '',
      timeIdle: !!src.timeIdle,
      caliber: src.caliber || '最高峰时段',
      dateMin: src.dateMin || '2024-01-01',
      dateMax: src.dateMax || '2030-12-31',
      // 事件
      eventList: src.eventList || [],
      eventCount: src.eventCount || 0,
      eventIncluded: src.eventIncluded || 0,
      eventText: src.eventText || '',
      // 天气
      weatherChoice,
      weatherIndex: wi >= 0 ? wi : 0,
      weatherLoading: !!src.weatherLoading,
      weatherText: src.weatherText || '',
      weatherDetail: src.weatherDetail || '',
      weatherFetchedAt: src.weatherFetchedAt || '',
      weatherError: src.weatherError || '',
      weatherSource: src.weatherSource || '',
      weatherAssumption: src.weatherAssumption || '',
      // 上报
      reportSummary: src.reportSummary || '',
      reportCounts: src.reportCounts || null,
      reportBackend: src.reportBackend || reportStore.backendName(),
      reportCloud: !!src.reportCloud,
      // 交警 / 定位 / 封路
      avoidPolice: typeof s.avoidPolice === 'boolean' ? s.avoidPolice : !!src.avoidPolice,
      policeCount: src.policeCount || 0,
      tracking: !!src.tracking,
      trackingText: src.trackingText || '',
      trackingError: src.trackingError || '',
      closedList: (s.closedList && s.closedList.length ? s.closedList : src.closedList) || [],
      // 情景 / 结果
      congestion: src.congestion || null,
      scenarioSummary: src.scenarioSummary || '',
      scenarioNote: src.scenarioNote || '',
      atBaseline: src.atBaseline !== false,
      result: src.result || null,
      comparison: src.comparison || [],
      insight: src.insight || '',
      policeInsight: src.policeInsight || '',
      hint: src.hint || '请先设置起点和终点',
    }, dayFields), () => {
      if (this.data.key === 'time') this.buildTable();
    });
  },

  /**
   * 生效路况的分项统计 + 上报计数（纯读，用现成的 reports 工具）。
   *
   * 计数也在这里现算，而不是用快照里的那份：快照是路线页上次推来的，
   * 而"刚刚在本页提交的那条上报"、"管理页刚核实/否决的"都可能比它新 ——
   * 用户提交完回到本页，最想看的就是"我的上报进去了没有"。
   */
  loadEffective() {
    try {
      reportStore.load(list => {
        const agg = reports.aggregate(list);
        this.setData({
          effective: {
            total: agg.closed.size + agg.congestion.size + agg.police.size,
            closed: agg.closed.size,
            congestion: agg.congestion.size,
            police: agg.police.size,
          },
          reportCounts: agg.counts,
          reportSummary: reports.summarize(agg),
          reportBackend: reportStore.backendName(),
        });
      });
    } catch (e) {
      this.setData({ effective: null });
    }
  },

  // ---------------------------------------------------------------- 时段
  onDateChange(e) {
    const dateISO = e.detail.value;
    session.patch({ dateISO });
    panelBus.pushIntent('applyConfig');
    // 日期一变，作息表要跟着换到那一天的星期（手动选过的页签先让位给新日期）
    this.previewWeekday = null;
    this.setData(this.dayFields(dateISO), () => {
      if (this.data.key === 'time') this.buildTable();
    });
    if (this.data.key !== 'time') {
      wx.showToast({ title: `已选 ${this.data.dateLabel}`, icon: 'none' });
    }
  },

  onTimeChoice(e) {
    const i = Number(e.detail.value);
    const c = (this.data.timeChoices || [])[i];
    if (!c) return;
    session.patch({ timeChoice: c.key, timeIndex: i });
    panelBus.pushIntent('applyConfig');
    this.setData({ timeIndex: i, timeChoice: c.key });
    wx.showToast({ title: `已切到 ${c.label}`, icon: 'none' });
  },

  // ---------------------------------------------------------------- 事件
  toggleEventInclude(e) {
    const id = e.currentTarget.dataset.id;
    const list = (this.data.eventList || []).map(x => (
      x.id === id ? Object.assign({}, x, { include: !x.include }) : x
    ));
    const include = {};
    list.forEach(x => { include[x.id] = x.include; });
    session.patch({ eventInclude: include });
    panelBus.pushIntent('applyConfig');
    this.setData({
      eventList: list,
      eventIncluded: list.filter(x => x.include).length,
    });
  },

  // ---------------------------------------------------------------- 天气
  onWeatherChoice(e) {
    const i = Number(e.detail.value);
    const c = WEATHER_CHOICES[i];
    if (!c) return;
    session.patch({ weatherChoice: c.key, weatherIndex: i, level: c.key === 'auto' ? session.get().level : c.key });
    panelBus.pushIntent(c.key === 'auto' ? 'refreshWeather' : 'applyConfig');
    this.setData({ weatherIndex: i, weatherChoice: c.key });
  },

  refreshWeather() {
    panelBus.pushIntent('refreshWeather');
    wx.showToast({ title: '已请求刷新，返回路线页生效', icon: 'none' });
  },

  // ---------------------------------------------------------------- 交警 / 定位 / 封路
  toggleAvoidPolice() {
    const next = !this.data.avoidPolice;
    session.patch({ avoidPolice: next });
    panelBus.pushIntent('applyConfig');
    this.setData({ avoidPolice: next });
  },

  toggleTracking() {
    const next = !this.data.tracking;
    session.patch({ wantTracking: next });
    panelBus.pushIntent('applyConfig');
    this.setData({ tracking: next });
  },

  removeClosed(e) {
    const ei = Number(e.currentTarget.dataset.ei);
    const list = (this.data.closedList || []).filter(c => c.ei !== ei);
    session.patch({ closedList: list });
    panelBus.pushIntent('applyConfig');
    this.setData({ closedList: list });
  },

  clearClosed() {
    if (!(this.data.closedList || []).length) return;
    session.patch({ closedList: [] });
    panelBus.pushIntent('applyConfig');
    this.setData({ closedList: [] });
  },

  // ---------------------------------------------------------------- 结果
  onSwitchMode(e) {
    const mode = e.currentTarget.dataset.mode;
    if (!mode || mode === (session.get().mode || 'quiet')) return;
    session.patch({ mode });
    panelBus.pushIntent('applyConfig');
    const comparison = (this.data.comparison || []).map(x => Object.assign({}, x, { active: x.key === mode }));
    this.setData({ comparison });
    wx.showToast({ title: '已切换走法', icon: 'none' });
  },

  // ---------------------------------------------------------------- 跳到别的页
  // from=panel：点选页靠它知道「取消」该回到这个模块页（而不是别的地图页）
  beginPickReport() { wx.navigateTo({ url: '/pages/pick/pick?mode=report&from=panel' }); },
  beginPickClose() { wx.navigateTo({ url: '/pages/pick/pick?mode=close&from=panel' }); },
  goAdmin() { wx.navigateTo({ url: '/pages/admin/admin' }); },
  goEventPage() { wx.navigateTo({ url: '/pages/event/event' }); },

  close() {
    wx.navigateBack({ delta: 1 });
  },
});
