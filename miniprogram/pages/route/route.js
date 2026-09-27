/**
 * 少人路线页（含特殊情况情景）
 *
 * 起点支持三种来源：自动定位 / 从常用地点列表选 / 直接在地图上点选；终点两种：列表 / 地图点选。
 * 点选后会吸附到最近的路网节点，再按所选走法（少人优先 / 时间最短 / 距离最短）跑 Dijkstra。
 *
 * 特殊情况：
 *   天气 —— 自动联网获取（Open-Meteo），也可手动指定；
 *   施工封路 —— 在地图上点一条路即可封掉，可撤销。
 *   两者都会交给 utils/scenario.js 重算全网流量与占用率，于是得到**新的热度图**，
 *   路线也会随之重新规划。
 *
 * 热度层的画法：底图用不带热度的 campus-map.svg，热度由画布按当前情景的
 * 占用率动态绘制（颜色 + 线宽），所以任何情景都能立刻看到新的热度分布。
 */
const router = require('../../utils/router.js');
const scenarioEngine = require('../../utils/scenario.js');
const reports = require('../../utils/reports.js');
const reportStore = require('../../utils/reportStore.js');
const render = require('../../utils/render.js');
const session = require('../../utils/session.js');
const pickBus = require('../../utils/pickBus.js');
const viewport = require('../../utils/viewport.js');
const timeModel = require('../../utils/timeModel.js');
const eventsUtil = require('../../utils/events.js');
const calendar = require('../../utils/calendar.js');
const eventStore = require('../../utils/eventStore.js');
const panelBus = require('../../utils/panelBus.js');
const periods = require('../../utils/periods.js');
const closedRoads = require('../../utils/closedRoads.js');

/**
 * 版本标记（改了这一页的代码就把版本号 +1）。
 * 为什么需要：开发者工具开着「代码热重载」时，**WXML 会立刻更新，但应用逻辑层的 JS 仍跑旧的那份**，
 * 于是会出现"新 WXML 绑了旧 JS 里不存在的方法"这类报错（例如 does not have a method "pickStartSheet"），
 * 或者 wx:for 的数据没人写入导致按钮整片不渲染。
 * 判断方法：重新编译后看控制台有没有打印下面这行；没有就是还在跑旧 JS，
 * 执行「工具 → 清除缓存 → 全部清除」后再编译一次（或直接关掉热重载）。
 */
const BUILD = 'route-panel-v1';

const graph = router.graph;
const VIEW_W = graph.meta.viewBox[0];
const VIEW_H = graph.meta.viewBox[1];

// 定位失败时的兜底点：路网几何中心（会再吸附到最近节点）
const fallbackPoint = (() => {
  let sx = 0, sy = 0;
  for (let i = 0; i < graph.px.length; i++) { sx += graph.px[i]; sy += graph.py[i]; }
  return [sx / graph.px.length, sy / graph.py.length];
})();

// 道路类型显示名与"封路结果怎么变成清单里的一项"都由 utils/closedRoads.js 提供，
// 模块二级页也要处理同一个点选结果，两边共用一份，行为不会分叉。
const ROAD_TYPE_CN = closedRoads.ROAD_TYPE_CN;

const MODE_LABEL = {};
router.MODES.forEach(m => { MODE_LABEL[m.key] = m.name; });

// 上报类别（供界面提示使用）
const REPORT_CATEGORIES = reports.CATEGORIES;

// 可搜索的地点清单（在 58 个常用地点上加一个稳定下标，供搜索结果索引）
const PLACE_LIST = graph.places.map((p, idx) => Object.assign({ idx }, p));

/**
 * 按关键词与类别过滤地点。
 * 关键词同时匹配名称、校区、类别，方便用"升华 37"或"新校区 宿舍"这种写法。
 */
function searchPlaces(keyword, kind) {
  const kw = String(keyword || '').trim().toLowerCase();
  return PLACE_LIST.filter(p => {
    if (kind && kind !== 'all' && p.k !== kind) return false;
    if (!kw) return true;
    return (p.n + ' ' + p.c + ' ' + p.k).toLowerCase().indexOf(kw) >= 0;
  });
}

// 拥堵节点的参数
const CONGESTION_NODE_HEAT = render.HEAT_WARN;  // 占用率达到多少才放节点（与"较堵"的口径同一个定义）
const CONGESTION_NODE_GAP_M = 90;   // 节点之间的最小间距（米）
const CONGESTION_NODE_MAX = 8;      // 最多放几个，避免地图上太乱
const CONGESTION_NODE_HIT_M = 50;   // 点击命中半径（米）

// 持续定位：位移超过这个距离才用新位置重新规划，避免每秒都重算
const TRACK_FOLLOW_M = 40;

/**
 * 初始缩放。
 *
 * 为什么不是 1.0（全览）：aspectFit 下 1.0× 时整张图正好塞进容器，
 * `viewport.panLimit` 的上限是 0，于是**一点都拖不动**（能拖也只是把地图拖偏、露出背景）。
 * 一屏布局之后地图区域变矮，1.0× 还会在左右留下几十像素空白。
 * 所以默认给一点放大：地图比容器大 → 开局就拖得动，内容也更清楚。
 * 与点选页的做法一致（那边 DEFAULT_SCALE = 1.6）；点「全览」仍然回到 1.0×。
 */
const DEFAULT_SCALE = 1.3;

// 吸附偏移大到这个程度，就不再是"轻微修正"，而是"人根本不在路网附近"，要如实说
const SNAP_FAR_M = 200;

/**
 * 吸附提示文案。
 * 偏移小的时候"已吸附到最近路口（偏移约 8 米）"就够了；
 * 但人在校区外时偏移可能是几百米甚至几公里，此时再写"偏移约 520 米"
 * 会和"距某地点约 528 米"看起来像同一个数，反而让人看不懂，所以换一种说法讲清楚。
 */
function snapHint(meters) {
  const m = Math.round(meters);
  if (m <= SNAP_FAR_M) return `已吸附到最近路口（偏移约 ${m} 米）`;
  return `定位点离路网约 ${m} 米（可能在校区外），已就近接入路口`;
}

/**
 * 拥堵节点的趣味提示（彩蛋，纯娱乐，不影响任何计算）。
 * 文案按顺序轮换，同一段路多点几次会看到不同内容。
 */
const CONGESTION_JOKES = [
  {
    key: 'stuck',
    title: '前后都堵',
    desc: '这一段有 {people} 人同行，占用率 {occ}（1.0 ≈ 基线最挤路段）。',
    options: ['弃车快跑', '原地参悟人生'],
  },
  {
    key: 'late',
    title: '迟到警报',
    desc: '这一段比空载慢了 {slow}%，照这个速度下去要迟到了。',
    options: ['申请飞过去', '召唤主盾'],
  },
  {
    key: 'fun',
    title: '堵车娱乐局',
    desc: '反正也动不了，不如干点别的。当前平均车速 {speed} km/h。',
    options: ['玩一局侠盗猎车手', '给前车起个名字'],
  },
  {
    key: 'nitro',
    title: '氮气加速检测',
    desc: '检测到本路段被 {people} 人占据，通行效率 {speed} km/h。',
    options: ['开启氮气', '开启佛系模式'],
  },
];

/** 组装一条趣味提示（把真实数据填进文案，看起来更有说服力）。 */
function pickCongestionJoke(node, seq) {
  const tpl = CONGESTION_JOKES[seq % CONGESTION_JOKES.length];
  const kmh = Math.round((node.speed || 0) * 60 / 1000);
  const slow = node.time > 0 && node.freeTime > 0
    ? Math.round((1 - node.freeTime / node.time) * 100)
    : 0;
  const desc = tpl.desc
    .replace('{people}', node.people)
    .replace('{occ}', (node.heat || 0).toFixed(2))
    .replace('{speed}', kmh)
    .replace('{slow}', slow);
  return {
    title: tpl.title,
    desc,
    road: `${ROAD_TYPE_CN[node.roadType] || node.roadType} · ${node.people} 人/时段`,
    options: tpl.options.map((label, i) => ({ id: tpl.key + '-' + i, label })),
    note: '拥堵节点是娱乐彩蛋，不影响路线计算',
  };
}

// 查天气用的坐标（校区中心）与数据源
const CAMPUS = { lat: 28.1567, lon: 112.9357 };
const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast'
  + '?latitude=' + CAMPUS.lat + '&longitude=' + CAMPUS.lon
  + '&current=temperature_2m,precipitation,rain,weather_code&timezone=Asia%2FShanghai';
const WEATHER_SOURCE = 'Weather data by Open-Meteo.com';

// 天气档位的手动可选项（自动获取失败或想演示时用）
const WEATHER_CHOICES = [
  { key: 'auto', name: '自动获取' },
  { key: 'none', name: '晴/多云' },
  { key: 'light', name: '小雨' },
  { key: 'heavy', name: '中到大雨' },
];

/** 生成一句"为什么推荐这条"的结论。 */
function buildInsight(modeKey, all) {
  const cur = all[modeKey];
  const fast = all.fastest;
  if (!cur || !cur.ok || !fast.ok) return '';
  if (modeKey === 'fastest') {
    const s = all.shortest;
    if (s.ok && s.timeMinutes - cur.timeMinutes >= 0.5) {
      return `距离最短的那条实际更慢：要穿过更堵的路段，比这条多花约 ${(s.timeMinutes - cur.timeMinutes).toFixed(1)} 分钟。`;
    }
    return '这条已经是三种走法里最快的。';
  }
  if (modeKey === 'shortest') {
    if (cur.timeMinutes - fast.timeMinutes >= 0.5) {
      return `虽然路程最短，但路上更堵，实际比最快的走法多花约 ${(cur.timeMinutes - fast.timeMinutes).toFixed(1)} 分钟。`;
    }
    return '这条路既是最短也是最快的。';
  }
  const extra = cur.timeMinutes - fast.timeMinutes;
  const cut = fast.avgHeatPersons > 0
    ? Math.round((1 - cur.avgHeatPersons / fast.avgHeatPersons) * 100) : 0;
  if (extra >= 0.5) return `比最快路线多花约 ${extra.toFixed(1)} 分钟，换来路上平均少 ${cut}% 的人。`;
  return `既避开了人流，用时也和最快路线相当（平均少 ${cut}% 的人）。`;
}


Page({
  data: {
    modes: router.MODES,

    // 起点
    startLabel: '尚未设置', startSource: '', startSnapText: '', startReady: false,
    // 终点
    destLabel: '尚未设置', destSource: '', destSnapText: '', destReady: false,

    // 交互
    mode: 'quiet',
    hint: '请先设置起点和终点',
    planError: '',
    planned: false,
    result: null,
    comparison: [],
    insight: '',
    policeInsight: '',
    scale: DEFAULT_SCALE,
    scaleLabel: DEFAULT_SCALE.toFixed(1) + '×',
    tx: 0,
    ty: 0,
    canPan: true,          // 初始就放大了一点，所以开局就能拖（见 DEFAULT_SCALE 的说明）
    locating: false,

    // 天气
    weatherChoices: WEATHER_CHOICES,
    weatherIndex: 0,
    weatherChoice: 'auto',
    weatherLoading: false,
    weatherText: '',
    weatherDetail: '',
    weatherLevel: 'none',
    weatherFetchedAt: '',
    weatherError: '',
    weatherSource: WEATHER_SOURCE,

    // 施工封路（管理员/调度直接改道路信息）
    closedList: [],
    // 用户上报的实时路况
    reportCategories: REPORT_CATEGORIES,
    reportList: [],
    reportSummary: '',
    reportBackend: '本机存储',
    reportCloud: false,
    reportCounts: null,
    avoidPolice: false,         // 是否绕开交警
    // 目的地搜索
    placeSearch: null,          // {visible, target:'start'|'dest', keyword, kind}
    placeResults: [],
    placeKinds: [
      { key: 'all', name: '全部' },
      { key: '宿舍', name: '宿舍' },
      { key: '教学点', name: '教学点' },
    ],
    // 拥堵节点趣味提示（彩蛋）
    nodeSheet: null,
    // 持续定位
    tracking: false,
    trackingText: '',
    trackingError: '',
    // 情景与拥堵预测
    scenarioSummary: '',
    atBaseline: true,
    congestion: null,
    scenarioNote: '',
    // 时段（有课表画像时才有选择器）
    timeAvailable: false,
    timeChoices: [],
    timeIndex: 0,
    timeChoice: 'auto',
    timeText: '',
    timeHint: '',
    timeIdle: false,
    caliber: '最高峰时段',
    // 日期：课表模型按「星期几」给出当天形状，所以可以选任意一天看
    dateISO: '',
    dateLabel: '',
    dateHint: '',
    dateMin: '2024-01-01',
    dateMax: '2030-12-31',
    isWeekend: false,
    dayKind: 'normal',
    dayKindLabel: '',
    // 当天的事件（活动）：谁参加、多少人、几点入场离场，并可以逐个选择是否计入
    eventList: [],
    eventCount: 0,
    eventIncluded: 0,
    eventText: '',
    // 一屏布局用：状态条上的天气摘要 + 9 个模块按钮（图标/名称/角标都是算出来的）
    weatherChip: '天气未知',
    panelButtons: [],
  },

  startNode: -1,
  destNode: -1,
  autoLocated: false,
  readyOnce: false,       // onShow 是否已经跑过一次（用来判断"从别的页返回"）
  eventInclude: {},       // 事件 id -> 是否计入（默认计入）
  network: null,          // 当前情景的路网（默认基线）
  scenario: null,         // applyScenario 的结果
  lastPath: null,         // 最近一次规划出的路径：拖动/缩放后重绘要用
  nodes: [],              // 拥堵节点（路线上的互动点）

  onLoad() {
    // 看到这行说明跑的是最新 JS；看不到就是热重载留下的旧代码（清缓存后重新编译）
    console.log('[route] build =', BUILD);
    // 地图视口与手势：几何全部交给 utils/viewport.js，与点选页同一套
    this.view = viewport.create({
      viewW: VIEW_W, viewH: VIEW_H,
      scale: DEFAULT_SCALE, minScale: 0.7, maxScale: 4,
    });
    this.gesture = viewport.createGesture();
    this.rect = null;
  },

  // ------------------------------------------------------------ 生命周期
  onReady() {
    this.measureViewport(() => {
      this.setData({ canPan: viewport.canPan(this.view, this.view.scale) });
      this.draw();
    });
    this.refreshEvents();
    this.initTimeChoice();
    this.refreshWeather();
    this.loadReports();
    this.refreshScenario();
  },

  onShow() {
    // **顺序要紧**：① 先并二级页改的配置（它读 session）
    //               ② 再收点选页回传的结果
    //               ③ 最后重读上报库（二级页新报的、管理页核实/否决的都在库里）
    // 这三步的末尾都会 refreshScenario()，而它会**把当前 data 写回 session**
    // （为了给二级页显示）—— 顺序反过来就会把前面刚写进 session 的配置覆盖掉，
    // 表现就是"在二级页封的路，回到地图上没了"。
    const changed = this.applyPanelConfig();
    const picked = pickBus.take();
    if (picked) this.handlePickResult(picked);
    this.loadReports();
    // 从「事件与校历」页回来：事件或校历可能变了，重算一遍
    if (this.readyOnce && !changed && !picked) {
      this.refreshEvents();
      this.initTimeChoice();
      this.refreshScenario();
    }
    this.readyOnce = true;
    // 回到前台时，如果用户之前开着实时定位，就把监听恢复上
    if (session.get().wantTracking && !this.data.tracking) this.startTracking();
    else if (this.wantTracking && !this.data.tracking) this.startTracking();
    if (!this.autoLocated) {
      this.autoLocated = true;
      this.useMyLocation();
    }
  },

  /**
   * 把模块二级页改过的配置（都写在 utils/session.js 里）并回本页，并执行它留下的意图。
   *
   * 二级页不做任何业务计算 —— 它只改参数、记一条 intent；真正的重算、重新规划、
   * 联网取天气、开关定位都在这里发生，保证"只有一处口径"。
   * @returns {boolean} 是否真的应用了改动（用于决定要不要重算）
   */
  applyPanelConfig() {
    const intents = panelBus.takeIntents();
    const s = session.get();
    const patch = {};

    if (s.dateISO && s.dateISO !== this.data.dateISO) patch.dateISO = s.dateISO;
    if (s.timeChoice && s.timeChoice !== this.data.timeChoice) {
      patch.timeChoice = s.timeChoice;
      patch.timeIndex = Number(s.timeIndex) || 0;
    }
    if (s.weatherChoice && s.weatherChoice !== this.data.weatherChoice) {
      patch.weatherChoice = s.weatherChoice;
      patch.weatherIndex = Number(s.weatherIndex) || 0;
      // 手动档位就按档位显示；'auto' 交回联网刷新
      if (s.weatherChoice !== 'auto') {
        const c = WEATHER_CHOICES.find(w => w.key === s.weatherChoice);
        patch.weatherLevel = s.weatherChoice;
        patch.weatherText = c ? c.name : '';
        patch.weatherDetail = '手动指定';
        patch.weatherError = '';
      }
    }
    if (typeof s.avoidPolice === 'boolean' && s.avoidPolice !== this.data.avoidPolice) patch.avoidPolice = s.avoidPolice;
    if (Array.isArray(s.closedList) && s.closedList !== this.data.closedList) patch.closedList = s.closedList;
    if (s.mode && s.mode !== this.data.mode) patch.mode = s.mode;
    if (s.eventInclude && s.eventInclude !== this.eventInclude) this.eventInclude = s.eventInclude;

    if (Object.keys(patch).length) this.setData(patch);

    // 定位开关：真正的监听在本页，二级页只表达意愿
    if (s.wantTracking && !this.data.tracking) this.startTracking();
    if (!s.wantTracking && this.data.tracking) this.stopTracking(true);

    const hasIntent = intents.length > 0;
    intents.forEach(it => {
      if (it.action === 'refreshWeather') this.refreshWeather();
    });

    if (!Object.keys(patch).length && !hasIntent) return false;

    // 配置变了 -> 重算热度与拥堵；起终点齐了就顺带重新规划
    if (this.readyOnce) {
      this.refreshEvents();
      this.initTimeChoice({ reset: false });
      this.refreshScenario();
    }
    return true;
  },

  /** 离开页面就停掉实时定位，别在后台耗电。 */
  onHide() {
    if (this.data.tracking) this.stopTracking(false);
  },

  onUnload() {
    if (this.data.tracking || this.wantTracking) this.stopTracking(true);
  },

  /** 处理点选页交回来的结果。 */
  handlePickResult(r) {
    if (r.action === 'start' || r.action === 'dest') {
      const isStart = r.action === 'start';
      if (isStart) this.startNode = r.nodeIndex;
      else this.destNode = r.nodeIndex;
      const patch = isStart
        ? {
          startLabel: `地图选点 节点#${r.nodeIndex}`,
          startSource: 'map',
          startSnapText: `已吸附到最近路口，偏移约 ${r.snapMeters} 米`,
          startReady: true,
        }
        : {
          destLabel: `地图选点 节点#${r.nodeIndex}`,
          destSource: 'map',
          destSnapText: `已吸附到最近路口，偏移约 ${r.snapMeters} 米`,
          destReady: true,
        };
      this.setData(Object.assign(patch, { planError: '' }));
      this.afterSelection();
      return;
    }

    if (r.action === 'close') {
      const item = closedRoads.itemFromPick(r);
      if (!item) {
        wx.showToast({ title: '封路信息不完整，请重新点选', icon: 'none' });
        return;
      }
      if (closedRoads.has(this.data.closedList, item.ei)) {
        wx.showToast({ title: '这条路已经封了', icon: 'none' });
        return;
      }
      this.setData({ closedList: closedRoads.add(this.data.closedList, item).list });
      this.refreshScenario();
      wx.showToast({ title: `已封闭 ${item.roadType}`, icon: 'none' });
      return;
    }

    if (r.action === 'report') {
      const report = reports.createFromPick(r);
      if (!report) {
        wx.showToast({ title: '上报内容不完整', icon: 'none' });
        return;
      }
      reportStore.add(report, ok => {
        if (!ok) wx.showToast({ title: '已存本机，云端同步失败', icon: 'none' });
      });
      this.setData({ reportList: [report].concat(this.data.reportList) });
      this.refreshScenario();
      wx.showToast({
        title: this.data.reportCloud ? '已提交，等待核实' : '已提交（本机），待核实',
        icon: 'none',
      });
    }
  },

  /** 打开全屏点选页（二级页面）。from=route 让点选页知道「取消」该回到本页。 */
  openPicker(mode) {
    wx.navigateTo({ url: '/pages/pick/pick?mode=' + mode + '&from=route' });
  },

  // ------------------------------------------------------------ 持续定位
  /** 开关实时定位。开启后地图上会有"我的位置"小蓝点跟随移动。 */
  toggleTracking() {
    if (this.data.tracking) this.stopTracking(true);
    else this.startTracking();
  },

  startTracking() {
    if (this.data.tracking) return;
    this.wantTracking = true;
    if (typeof wx.startLocationUpdate !== 'function' || typeof wx.onLocationChange !== 'function') {
      this.wantTracking = false;
      this.setData({ trackingError: '当前基础库不支持实时定位，请更新微信版本' });
      return;
    }
    wx.startLocationUpdate({
      success: () => {
        // 保存 handler 引用：关闭时要能摘掉，否则回调会越挂越多
        if (!this.locationHandler) this.locationHandler = res => this.onLocationChange(res);
        wx.onLocationChange(this.locationHandler);
        this.setData({ tracking: true, trackingError: '' });
        wx.showToast({ title: '实时定位已开启', icon: 'none' });
      },
      fail: err => {
        const msg = (err && err.errMsg) || '';
        this.wantTracking = false;
        this.setData({
          tracking: false,
          trackingError: /auth|deny|permission/i.test(msg)
            ? '未授权实时定位：请在设置里允许位置信息，或改用「用当前位置」'
            : `开启实时定位失败：${msg || '未知原因'}`,
        });
      },
    });
  },

  stopTracking(userAction) {
    if (userAction) this.wantTracking = false;
    if (this.locationHandler && typeof wx.offLocationChange === 'function') {
      wx.offLocationChange(this.locationHandler);
    }
    if (typeof wx.stopLocationUpdate === 'function') wx.stopLocationUpdate({});
    this.setData({ tracking: false, trackingText: '' });
  },

  /**
   * 位置变化回调：画"我的位置"，并且**只有当起点本身就是定位结果时**才跟着走
   * （用户手动设过起点就不覆盖他的选择）。
   */
  onLocationChange(res) {
    if (!res || typeof res.longitude !== 'number') return;
    // 显示用原始位置（不吸附，避免小蓝点在路口之间跳）
    const svg = router.project(res.longitude, res.latitude);
    const hit = router.nearestNode(svg[0], svg[1]);
    // 位置也用最近的常用地点来称呼，而不是只丢经纬度
    const named = router.describePoint(svg[0], svg[1], res.longitude, res.latitude);
    this.myLocation = { x: svg[0], y: svg[1] };
    session.patch({ myLocation: this.myLocation });

    const acc = res.accuracy ? ` · 精度 ${Math.round(res.accuracy)} 米` : '';
    this.setData({
      trackingText: `实时位置 · ${named.label} · ${named.coord}${acc}`,
    }, () => this.draw(this.lastPath));

    // 跟随：起点是定位来的，且位移超过阈值，才重新规划
    if (this.data.startSource !== 'gps' || !this.data.startReady) return;
    if (this.startNode >= 0) {
      const dx = svg[0] - graph.px[this.startNode];
      const dy = svg[1] - graph.py[this.startNode];
      if (Math.hypot(dx, dy) / graph.proj[0] < TRACK_FOLLOW_M) return;
    }
    this.startNode = hit.index;
    this.setData({
      startLabel: named.label,
      startSnapText: `${named.detail} · ${snapHint(hit.distanceMeters)}`,
      startReady: true,
    });
    this.afterSelection();
  },

  // ------------------------------------------------------------ 视口与手势（几何算在 utils/viewport.js）
  measureViewport(cb) {
    wx.createSelectorQuery()
      .select('#routeMap')
      .boundingClientRect(rect => {
        const prev = this.rect;
        this.rect = rect;
        if (!viewport.measure(this.view, rect)) this.rect = null;
        // 容器位置变了：手势里已记下的坐标是按旧矩形算的，整体平移过去，
        // 否则位移会差一个偏移，轻点还会被误判成"拖过"（见 viewport.shiftGesture）
        if (prev && this.rect) {
          viewport.shiftGesture(this.gesture, prev.left - this.rect.left, prev.top - this.rect.top);
        }
        if (cb) cb();
      })
      .exec();
  },

  /** 把视口写回页面数据。 */
  applyView(next, cb) {
    this.view.scale = next.scale;
    this.view.tx = next.tx;
    this.view.ty = next.ty;
    this.setData({
      scale: next.scale,
      scaleLabel: next.scale.toFixed(1) + '×',
      tx: Math.round(next.tx),
      ty: Math.round(next.ty),
      canPan: viewport.canPan(this.view, next.scale),
    }, cb);
  },

  /** 把触摸点换算成容器内坐标。 */
  touchPoints(touches) {
    const r = this.rect;
    if (!r) return [];
    return (touches || []).map(t => ({ x: t.clientX - r.left, y: t.clientY - r.top }));
  },

  onMapTouchStart(e) {
    // 新的触摸开始：清掉"上一次是多指"的标记（见 onMapTouchEnd）
    this.blockTap = false;
    // **立刻**起手，不能等异步测量回来再起：
    // 页面布局/滚动过之后 rect 会变，所以每次触摸都重新测一遍；
    // 但 measureViewport 是异步的 —— 如果等它的回调才 gestureStart，
    // 一次快速轻扫（touchstart → move → end 都发生在回调之前）会被整段丢掉，
    // 现象就是"地图拖不动"。拖动只关心位移差，用**已知的** rect 换算就够了，
    // 新的 rect 测回来之后再更新（点选换算成 SVG 时才需要它是最新的）。
    viewport.gestureStart(this.view, this.gesture, this.touchPoints(e.touches));
    this.measureViewport(() => {
      this.setData({ canPan: viewport.canPan(this.view, this.view.scale) });
    });
  },

  onMapTouchMove(e) {
    const pts = this.touchPoints(e.touches);
    if (!pts.length) return;
    const next = viewport.gestureMove(this.view, this.gesture, pts);
    if (!next) return;
    if (Math.abs(next.tx - this.view.tx) < 0.5
      && Math.abs(next.ty - this.view.ty) < 0.5
      && Math.abs(next.scale - this.view.scale) < 1e-6) return;
    this.applyView(next);
  },

  onMapTouchEnd(e) {
    const t = (e.changedTouches && e.changedTouches[0]) || null;
    const endPt = (t && this.rect) ? { x: t.clientX - this.rect.left, y: t.clientY - this.rect.top } : null;
    // 双指（或更多）碰过 -> 记一笔：紧随其后的 tap 不能当成点选，
    // 否则"双指放大"会顺手弹出堵点彩蛋。标记在下一次 touchstart 时清掉。
    if (viewport.isMulti(this.gesture) || (e.touches || []).length > 0) this.blockTap = true;
    viewport.gestureEnd(this.gesture, endPt, (e.touches || []).length);
  },

  /** 屏幕触点 -> SVG 坐标（拥堵节点点击判定要用）。 */
  clientToSvg(clientX, clientY) {
    if (!this.rect) return null;
    return viewport.toSvg(this.view, this.rect, clientX, clientY);
  },

  // ------------------------------------------------------------ 拥堵节点（趣味互动）
  /**
   * 沿规划路线挑出可交互的拥堵节点：只放在确实堵的路段上，
   * 并且彼此间隔至少 90 米，避免节点出现在无关位置或挤成一团。
   */
  buildCongestionNodes(primary) {
    if (!primary || !primary.ok) return [];
    const pxPerMeter = graph.proj[0];        // 投影是等比的：1 米 = S 像素
    const out = [];
    let last = null;
    for (const e of primary.usedEdges) {
      if (e.heat < CONGESTION_NODE_HEAT) continue;   // 只放堵的
      const mid = router.edgeMidpoint(e.ei);
      if (last) {
        const gap = Math.hypot(mid[0] - last[0], mid[1] - last[1]) / pxPerMeter;
        if (gap < CONGESTION_NODE_GAP_M) continue;
      }
      last = mid;
      out.push({
        x: mid[0], y: mid[1], ei: e.ei, heat: e.heat, roadType: e.roadType,
        people: Math.round(e.flow || 0),
      });
    }
    return out.slice(0, CONGESTION_NODE_MAX);
  },

  /** 点击地图：命中拥堵节点就弹趣味提示。 */
  onCongestionTap(e) {
    // 上一次触摸是双指捏合（或还没抬完手指）：这一次 tap 不算点选
    if (this.blockTap) {
      this.blockTap = false;
      return;
    }
    if (!this.nodes || !this.nodes.length) return;
    const t = (e.changedTouches && e.changedTouches[0])
      || (e.touches && e.touches[0]) || null;
    if (!t) return;
    const svg = this.clientToSvg(t.clientX, t.clientY);
    if (!svg) return;
    // 判定阈值按米算，缩放后手感一致
    const hitR = CONGESTION_NODE_HIT_M * graph.proj[0];
    let best = null;
    let bd = Infinity;
    for (const n of this.nodes) {
      const d = Math.hypot(n.x - svg[0], n.y - svg[1]);
      if (d < bd) { bd = d; best = n; }
    }
    if (best && bd <= hitR) this.openCongestionSheet(best);
  },

  openCongestionSheet(node) {
    const joke = pickCongestionJoke(node, this.jokeIndex || 0);
    this.jokeIndex = (this.jokeIndex || 0) + 1;
    wx.vibrateShort && wx.vibrateShort({ type: 'light' });
    this.setData({ nodeSheet: joke });
  },

  closeCongestionSheet() {
    this.setData({ nodeSheet: null });
  },

  /** 点了段子里的某个选项：只给个反馈，不做任何实际改动。 */
  onJokeOption(e) {
    const label = e.currentTarget.dataset.label || '';
    this.setData({ nodeSheet: null });
    wx.showToast({ title: `${label}（彩蛋，不影响路线）`, icon: 'none', duration: 1500 });
  },

  // ------------------------------------------------------------ 目的地搜索
  openPlaceSearch(e) {
    const target = (e && e.currentTarget && e.currentTarget.dataset.target) || 'dest';
    this.setData({
      placeSearch: { visible: true, target, keyword: '', kind: 'all' },
      placeResults: PLACE_LIST,
    });
  },

  closePlaceSearch() {
    this.setData({ placeSearch: null });
  },

  onPlaceKeyword(e) {
    this.setData({ 'placeSearch.keyword': e.detail.value }, () => this.refreshPlaceResults());
  },

  onPlaceKind(e) {
    const kind = e.currentTarget.dataset.kind;
    this.setData({ 'placeSearch.kind': kind }, () => this.refreshPlaceResults());
  },

  refreshPlaceResults() {
    const s = this.data.placeSearch;
    if (!s) return;
    this.setData({ placeResults: searchPlaces(s.keyword, s.kind) });
  },

  /** 从搜索结果里选一个地点作为起点或终点。 */
  onPickPlaceResult(e) {
    const i = Number(e.currentTarget.dataset.index);
    const p = this.data.placeResults[i];
    if (!p) return;
    const isStart = this.data.placeSearch.target === 'start';
    if (isStart) this.startNode = p.i;
    else this.destNode = p.i;
    const patch = {
      placeSearch: null,
      planError: '',
    };
    patch[isStart ? 'startLabel' : 'destLabel'] = p.n;
    patch[isStart ? 'startSource' : 'destSource'] = 'place';
    patch[isStart ? 'startSnapText' : 'destSnapText'] = `${p.c} · ${p.k} · 距最近路口约 ${p.s} 米`;
    patch[isStart ? 'startReady' : 'destReady'] = true;
    this.setData(patch);
    this.afterSelection();
  },

  zoomIn() { this.setRouteScale(this.view.scale + 0.3); },
  zoomOut() { this.setRouteScale(this.view.scale - 0.3); },
  resetZoom() { this.setRouteScale(1, true); },

  setRouteScale(v, resetOffset) {
    const scale = viewport.clampScale(this.view, v);
    const off = resetOffset
      ? { tx: 0, ty: 0 }
      : viewport.clamp(this.view, this.view.tx, this.view.ty, scale);
    this.applyView({ scale, tx: off.tx, ty: off.ty }, () => this.draw());
  },


  // ------------------------------------------------------------ 天气
  /** 联网获取实时天气；失败就退回手动档位，且不影响其他功能。 */
  refreshWeather() {
    if (this.data.weatherChoice !== 'auto') return;
    this.setData({ weatherLoading: true, weatherError: '' });
    wx.request({
      url: WEATHER_URL,
      method: 'GET',
      timeout: 8000,
      success: res => {
        const cur = res && res.data && res.data.current;
        if (!cur) {
          this.setData({ weatherLoading: false, weatherError: '天气数据格式异常，请手动选择天气' });
          return;
        }
        const code = cur.weather_code;
        const level = scenarioEngine.levelFromWeatherCode(code, cur.precipitation);
        const precip = Number(cur.precipitation) || 0;
        this.setData({
          weatherLoading: false,
          weatherError: '',
          weatherText: scenarioEngine.weatherText(code),
          weatherDetail: `${cur.temperature_2m}°C · 降水 ${precip} mm`,
          weatherLevel: level,
          weatherFetchedAt: cur.time,
        });
        this.refreshScenario();
      },
      fail: () => {
        this.setData({
          weatherLoading: false,
          weatherError: '未能联网获取天气（需在开发者工具勾选“不校验合法域名”），可手动选择',
          weatherLevel: 'none',
          weatherText: '',
          weatherDetail: '',
        });
        this.refreshScenario();
      },
    });
  },

  onWeatherChoice(e) {
    const i = Number(e.detail.value);
    const choice = WEATHER_CHOICES[i];
    if (!choice) return;
    this.setData({ weatherIndex: i, weatherChoice: choice.key });
    if (choice.key === 'auto') {
      this.refreshWeather();
    } else {
      this.setData({
        weatherLevel: choice.key,
        weatherError: '',
        weatherText: choice.name,
        weatherDetail: '手动指定',
      });
      this.refreshScenario();
    }
  },

  /** 当前实际生效的天气档位。 */
  currentLevel() {
    const c = this.data.weatherChoice;
    if (c === 'auto') return this.data.weatherLevel || 'none';
    return c;
  },

  // ------------------------------------------------------------ 用户上报的路况
  /** 读取上报（本地 / 云端），然后重算情景。 */
  loadReports() {
    reportStore.load((list, meta) => {
      this.setData({
        reportList: list,
        reportBackend: reportStore.backendName(),
        reportCloud: !!(meta && meta.cloud),
      });
      this.refreshScenario();
    });
  },

  /** 目前生效的路况（只含已核实且在有效期内的上报）。 */
  effectiveReports() {
    return reports.aggregate(this.data.reportList);
  },

  // ------------------------------------------------------------ 打开点选页
  /** 点选一律交给全屏的点选页，避免长页面里按钮和地图不在同一屏、坐标还受滚动影响。 */
  beginPickStart() { this.openPicker('start'); },
  beginPickDest() { this.openPicker('dest'); },
  beginPickClose() { this.openPicker('close'); },
  beginPickReport() { this.openPicker('report'); },

  /** 一键核实/否决仅用于演示：真实场景由管理页或后台逐条审核。 */
  toggleAvoidPolice() {
    this.setData({ avoidPolice: !this.data.avoidPolice }, () => this.refreshScenario());
  },

  goAdmin() {
    wx.navigateTo({ url: '/pages/admin/admin' });
  },

  removeClosed(e) {
    const ei = Number(e.currentTarget.dataset.ei);
    this.setData({ closedList: this.data.closedList.filter(c => c.ei !== ei) });
    this.refreshScenario();
  },

  clearClosed() {
    if (!this.data.closedList.length) return;
    this.setData({ closedList: [] });
    this.refreshScenario();
  },

  // ------------------------------------------------------------ 时段与日期
  /**
   * 初始化时段选择器。
   * 只有在给出了含节次时间的课表、并跑过 tools/build-time-profile.js 之后才有得选；
   * 否则如实说明"现在只有最高峰时段这一个口径"。
   */
  initTimeChoice(opts) {
    const reset = !!(opts && opts.reset);
    const overrides = this.dayOverrides();
    const day = calendar.resolveDay(this.data.dateISO || calendar.isoOf(new Date()), overrides);
    const choices = this.buildTimeChoices(day);
    // 默认保住用户当前选的时刻（勾/取消一个活动不该把视角弹回"自动"）；
    // 换了日期则退回「按当前时间」。
    const prev = reset ? 'auto' : this.data.timeChoice;
    let idx = 0;
    if (prev && prev !== 'auto') {
      let at = choices.findIndex(c => c.key === prev);
      if (at < 0) {
        // 用户可能在二级页的作息表里挑了**别的星期**的时段（窗口 key 自带星期：d3w0470 = 周三 07:50）。
        // 那种 key 不在"所选日期"的列表里，但它依然是合法时段，不能在这里被丢掉。
        const extra = this.describeChoiceKey(prev);
        if (extra) { choices.push(extra); at = choices.length - 1; }
      }
      if (at >= 0) idx = at;
    }
    this.setData({
      dateISO: day.iso,
      dateLabel: day.label,
      isWeekend: day.isWeekend,
      dayKind: day.kind,
      dayKindLabel: day.kindLabel,
      dateMin: this.data.dateMin || '2024-01-01',
      dateMax: this.data.dateMax || '2030-12-31',
      dateHint: this.dateHintFor(day),
      timeAvailable: timeModel.available(),
      timeChoices: choices,
      timeIndex: idx,
      timeChoice: choices[idx] ? choices[idx].key : 'auto',
      timeHint: timeModel.available()
        ? `时段画像来自课表：${timeModel.source()}（覆盖周${timeModel.days().map(d => timeModel.WEEKDAY_CN[d]).join('、')}）`
          + '；放假 / 调休按「事件与校历」页的录入来算。'
        : `${timeModel.reason()}。数据里只有"最高峰时段"一个时间量，`
          + '所以下面所有拥堵都是最高峰口径，不代表此刻路况；'
          + '要按时段预测需要一份含节次时间的课表，格式见《时段数据说明.md》。',
    });
  },

  /** 校历覆盖（放假 / 调休）。 */
  dayOverrides() {
    try {
      return eventStore.dayOverrides();
    } catch (e) {
      return [];
    }
  },

  /** 所选日期这一天的口径。 */
  dayInfo() {
    return calendar.resolveDay(this.data.dateISO || calendar.isoOf(new Date()), this.dayOverrides());
  },

  /** 当天的事件（含"是否参与计算"的开关状态）。 */
  refreshEvents() {
    let all = [];
    try {
      all = eventStore.eventsOn(this.data.dateISO);
    } catch (e) {
      all = [];
    }
    const includeMap = this.eventInclude || {};
    const list = all.map(e => {
      const a = eventsUtil.audienceOf(e);
      const h = eventsUtil.headcountOf(e, a);
      const v = eventsUtil.venueOf(e);
      return {
        id: e.id,
        title: e.title,
        typeName: eventsUtil.typeOf(e.type).name,
        timeText: `${e.start}-${e.end}`,
        venueText: v ? v.name : '场馆未定',
        audienceText: eventsUtil.describeAudience(e),
        peopleText: `${Math.round(h.people).toLocaleString()} 人`,
        include: includeMap[e.id] !== false,
        raw: e,
        a,
      };
    });
    this.eventList = list;
    this.setData({
      eventList: list,
      eventCount: list.length,
      eventIncluded: list.filter(x => x.include).length,
      eventText: list.length
        ? `当天 ${list.length} 个活动，已计入 ${list.filter(x => x.include).length} 个`
        : '当天没有活动',
    });
  },

  /** 参与计算的事件。 */
  activeEvents() {
    return (this.eventList || []).filter(x => x.include).map(x => x.raw);
  },

  toggleEventInclude(e) {
    const id = e.currentTarget.dataset.id;
    const cur = (this.eventList || []).find(x => x.id === id);
    if (!cur) return;
    this.eventInclude = this.eventInclude || {};
    this.eventInclude[id] = !cur.include;
    this.refreshEvents();
    // 可选的时刻会随活动增减，重列一次（但保住当前视角），然后必须重算流量
    this.initTimeChoice();
    this.refreshScenario();
  },

  goEventPage() {
    wx.navigateTo({ url: '/pages/event/event' });
  },

  /**
   * 可选时刻 = 当天的课表换课时段 + 当天活动的入场/离场时刻。
   * 活动时刻必须一起列出来，否则"校运会 07:20 入场"这种时刻根本选不到。
   */
  buildTimeChoices(day) {
    const d = day || this.dayInfo();
    const list = [
      { key: 'auto', label: '按当前时间（自动）', hint: '自动对到最近的换课/活动时刻；没有课也没有活动时显示为无通勤' },
    ];
    const candidates = this.dayCandidates(d);
    if (candidates.length) {
      list.push({ key: 'peak', label: '当天最忙时段', hint: '这一天（含活动）真实存在的最忙一刻' });
      list.push({ key: 'worst', label: '整周最高峰（最坏情况）', hint: '各路段各自最忙的时刻拼起来的包络，比任何真实时刻都更堵' });
    } else {
      list.push({ key: 'worst', label: '最高峰时段（最坏情况）', hint: '各路段各自最忙的时刻拼起来的包络' });
    }
    candidates.forEach(c => list.push(c));
    return list;
  },

  /** 把任一时段 key（课表窗口 / 活动时刻）还原成一个可显示的选项；不合法返回 null。 */
  describeChoiceKey(key) {
    const k = String(key || '');
    if (k.indexOf('ev:') === 0) {
      const parts = k.split(':');
      const minute = Number(parts[1]);
      if (!isFinite(minute)) return null;
      return {
        key: k, minutes: minute, kind: 'event',
        label: `${eventsUtil.fmt(minute)} ${parts[2] === 'arrival' ? '活动入场' : '活动离场'}`,
        hint: '活动时刻',
      };
    }
    const w = timeModel.windows().find(x => x.key === k);
    if (!w) return null;
    const wdCN = timeModel.WEEKDAY_CN[w.weekday];
    return {
      key: k, minutes: w.minutes, kind: 'class', weekday: w.weekday,
      label: `周${wdCN} ${this.windowLabel(w)}`,
      hint: `周${wdCN} 该时段全网 ${Number(w.total || 0).toLocaleString()} 人次（课表推算）`,
    };
  },

  /** 当天所有"有意义的时刻"：课表换课 + 活动入场/离场。 */
  dayCandidates(day) {
    const d = day || this.dayInfo();
    const out = [];
    const seen = {};
    if (d && d.hasClass && timeModel.available()) {
      timeModel.windowsFor(d.effectiveWeekday).forEach(w => {
        if (seen[w.minutes]) return;
        seen[w.minutes] = 1;
        out.push({
          key: w.key, minutes: w.minutes, kind: 'class', weekday: w.weekday,
          // 用「第1-2节 课前」这种作息表说法，比"07:50 换课"好懂
          label: this.windowLabel(w),
          hint: `该时段全网 ${Number(w.total || 0).toLocaleString()} 人次（课表推算）`,
        });
      });
    }
    this.activeEvents().forEach(ev => {
      eventsUtil.windowsOf(ev).forEach(w => {
        if (seen[w.minutes]) return;
        seen[w.minutes] = 1;
        out.push({
          key: `ev:${w.minutes}:${w.kind}`, minutes: w.minutes, kind: 'event', eventId: ev.id,
          label: `${eventsUtil.fmt(w.minutes)} ${w.kind === 'arrival' ? '活动入场' : '活动离场'}`,
          hint: `${ev.title} · ${w.label}`,
        });
      });
    });
    return out.sort((a, b) => a.minutes - b.minutes);
  },

  /** 所选日期对应的 Date（年/月/日用选中的，时/分用此刻的）。 */
  selectedDate() {
    const iso = this.data.dateISO || calendar.isoOf(new Date());
    const parts = String(iso).split('-').map(Number);
    const now = new Date();
    if (parts.length !== 3 || !parts[0]) {
      return now;
    }
    return new Date(parts[0], parts[1] - 1, parts[2], now.getHours(), now.getMinutes());
  },

  /** 日期那一行的小字说明：这天按哪天的课表、有没有活动、模型的边界。 */
  dateHintFor(day) {
    const d = day || this.dayInfo();
    if (!d) return '';
    // 基础说明（这天怎么算 + 有几个换课时段 + 模型边界）由 calendar.describeDay 统一给，
    // 保证与「预测时段」二级页说的是同一句话；这里只多补一句当天的活动。
    const hasClass = !!(timeModel.available() && d.hasClass && timeModel.hasDay(d.effectiveWeekday));
    const ws = hasClass ? timeModel.windowsFor(d.effectiveWeekday) : [];
    const pw = ws.find(w => w.key === timeModel.peakKey(d.effectiveWeekday));
    const base = calendar.describeDay(d, { windows: ws.length, peakTime: pw ? pw.time : '' });

    const events = (this.eventList || []).filter(x => x.include);
    if (!events.length) return base;
    const evText = `当天有 ${events.length} 个活动已计入：`
      + events.map(e => `${e.title}（${e.peopleText}）`).join('、') + '。';
    // 插在「这天正常上课日。」这类第一句之后，活动紧跟日期，读起来更顺
    const cut = base.indexOf('。');
    return cut < 0 ? base + evText : base.slice(0, cut + 1) + evText + base.slice(cut + 1);
  },

  onDateChange(e) {
    const iso = e.detail.value;
    this.setData({ dateISO: iso, timeIdle: false }, () => {
      // 换了一天：事件、可选的时刻、这天的口径都得重算，视角退回「按当前时间」
      this.eventInclude = {};
      this.refreshEvents();
      this.initTimeChoice({ reset: true });
      session.patch({ dateISO: iso });
      this.refreshScenario();
    });
  },

  onTimeChoice(e) {
    const i = Number(e.detail.value);
    const c = this.data.timeChoices[i];
    if (!c) return;
    this.setData({ timeIndex: i, timeChoice: c.key }, () => this.refreshScenario());
  },

  /**
   * 某个时刻的基线流量 = 课表部分 + 活动部分。
   *
   * @param {number} minute 时刻（分钟）
   * @param {number} [weekday] 用**哪一天**的课表算。不传就用所选日期的星期。
   *   为什么要有这个参数：用户可以在二级页里按作息表挑"周三 07:50"，
   *   而所选日期可能是周日 —— 这时必须按周三算，否则会算成 0（周日没课）。
   *   窗口 key 本身就带着星期（d3w0470 = 周三 07:50），所以调用方能把它传进来。
   * @returns {{flow:Float64Array, classWindow:Object|null, events:Array, day:Object}}
   */
  baseFlowAt(minute, weekday) {
    const day = this.dayInfo();
    const flow = timeModel.zeroFlow();          // 全零（不改动 timeModel 的缓存数组）
    let classWindow = null;
    const wd = weekday != null ? weekday : (day ? day.effectiveWeekday : null);
    const dayHasClass = weekday != null ? timeModel.hasDay(weekday) : !!(day && day.hasClass);
    if (minute != null && dayHasClass && timeModel.available()) {
      const ws = timeModel.windowsFor(wd);
      let best = null, bd = Infinity;
      ws.forEach(w => {
        const d = Math.abs(w.minutes - minute);
        if (d < bd) { bd = d; best = w; }
      });
      if (best && bd <= timeModel.NEAR_WINDOW_MIN) {
        const tf = timeModel.flowAt(best.key);
        if (tf) { for (let i = 0; i < flow.length; i++) flow[i] += tf[i]; }
        classWindow = best;
      }
    }
    const ev = eventsUtil.flowAt(this.activeEvents(), minute);
    for (let i = 0; i < flow.length; i++) flow[i] += ev.flow[i];
    return { flow, classWindow, events: ev.used, day };
  },

  /**
   * 一个换课时段的人话说法，例如「第1-2节 课前 07:50」。
   * 认得出节次就用作息表说法，认不出（非标准作息的画像）就退回「07:50 换课」。
   * 三处文案（口径 / 选择器 / 当天最忙）都走这里，免得同一件事在不同地方说法不一样。
   */
  windowLabel(w) {
    if (!w) return '';
    const d = periods.describe(w.minutes);
    return d ? `${d.text} ${w.time}` : `${w.time} 换课`;
  },

  /** 把"有哪些来源"写成口径文案。 */
  caliberParts(base, minute) {
    const parts = [];
    if (base.classWindow) parts.push(this.windowLabel(base.classWindow));
    base.events.forEach(u => {
      u.windows.forEach(w => parts.push(`${u.title} ${w.kind === 'arrival' ? '入场' : '离场'}`));
    });
    void minute;
    return parts;
  },

  /**
   * 算出本次要用的时段基线。
   * @returns {{basePeak:Float64Array|null, caliber:string, text:string, idle:boolean}}
   *   basePeak = null 表示用原始的最高峰数据
   */
  resolveTimeBase() {
    if (!timeModel.available() && !(this.activeEvents() || []).length) {
      return {
        basePeak: null,
        caliber: '最高峰时段',
        text: '原始仿真数据的最高峰时段',
        idle: false,
      };
    }
    const date = this.selectedDate();
    const day = this.dayInfo();
    const key = this.data.timeChoice;
    const evCount = (this.activeEvents() || []).length;
    const evSuffix = evCount ? `＋${evCount} 个活动` : '';

    if (key === 'worst') {
      // 整周最高峰：各路段各自最忙的时刻拼起来的包络（原数据的 baselinePeak）。
      // 活动仍按它的窗口叠加进来 —— 否则"最坏情况"反而看不到当天的活动。
      const ev = eventsUtil.flowAt(this.activeEvents(), null);
      const flow = timeModel.zeroFlow();
      for (let i = 0; i < flow.length; i++) flow[i] += ev.flow[i];
      const hasEv = ev.used.length > 0;
      return {
        basePeak: hasEv ? this.addBaseline(flow) : null,
        caliber: hasEv ? `整周最高峰＋${ev.used.length} 个活动` : '整周最高峰（包络）',
        text: '原始仿真数据的最高峰时段（各路段各自最忙的时刻拼起来的包络，不是某一个真实时刻）'
          + (hasEv ? '，再叠加当天的活动窗口' : ''),
        idle: false,
      };
    }

    if (key === 'peak') {
      // 「当天最忙」= 当天所有真实时刻（课表换课 + 活动入场/离场）里最忙的那个
      const cands = this.dayCandidates(day);
      if (!cands.length) {
        return { basePeak: null, caliber: '整周最高峰（包络）', text: '这天没有课也没有活动，改看整周最高峰（包络）', idle: false };
      }
      let best = null, bestSum = -1, bestBase = null;
      cands.forEach(c => {
        const b = this.baseFlowAt(c.minutes);
        let sum = 0;
        for (let i = 0; i < b.flow.length; i++) sum += b.flow[i];
        if (sum > bestSum) { bestSum = sum; best = c; bestBase = b; }
      });
      const parts = this.caliberParts(bestBase, best.minutes);
      return {
        basePeak: bestBase.flow,
        caliber: `当天最忙 ${best.label}`,
        text: `${day.label} 最忙的一刻：${parts.join(' + ')}，合计 ${Math.round(bestSum).toLocaleString()} 人次`,
        idle: false,
      };
    }

    if (key === 'auto') {
      const d = this.selectedDate();
      const minute = d.getHours() * 60 + d.getMinutes();
      const b = this.baseFlowAt(minute);
      const parts = this.caliberParts(b, minute);
      if (parts.length) {
        return {
          basePeak: b.flow,
          caliber: `周${day.effectiveCN || day.weekdayCN} ${parts.join('＋')}`,
          text: `${day.label} ${eventsUtil.fmt(minute)}：${parts.join(' + ')}`,
          idle: false,
        };
      }
      // 没有课也没有活动 -> 无通勤
      const idleLabel = day.hasClass
        ? `${day.label} ${eventsUtil.fmt(minute)} 不是换课时段，也没有活动`
        : `${day.label} ${day.kind === 'holiday' ? '放假' : '没有课'}，也没有活动`;
      return { basePeak: timeModel.zeroFlow(), caliber: '无通勤', text: idleLabel, idle: true };
    }

    // 具体时刻：可能是课表时段（dXwXXXX）或活动时刻（ev:分钟:类型）
    if (String(key).indexOf('ev:') === 0) {
      const minute = Number(String(key).split(':')[1]);
      const b = this.baseFlowAt(minute);
      const parts = this.caliberParts(b, minute);
      return {
        basePeak: b.flow,
        caliber: `${eventsUtil.fmt(minute)} ${parts.join('＋') || '活动'}`,
        text: `${day.label} ${eventsUtil.fmt(minute)}：${parts.join(' + ') || '活动时刻'}`,
        idle: false,
      };
    }
    const w = timeModel.windows().find(x => x.key === key);
    if (!w) return { basePeak: timeModel.zeroFlow(), caliber: '无通勤', text: '该时段不在画像里', idle: true };
    // 关键：按**这个时段自己所属的星期**算，而不是按所选日期。
    // 用户完全可以在周日的界面上挑"周三 07:50"看那节课前后的路况。
    const b = this.baseFlowAt(w.minutes, w.weekday);
    const parts = this.caliberParts(b, w.minutes);
    const wdCN = timeModel.WEEKDAY_CN[w.weekday];
    const onOtherDay = !day || !day.hasClass || day.effectiveWeekday !== w.weekday;
    return {
      basePeak: b.flow,
      caliber: `周${wdCN} ${this.windowLabel(w)}${evSuffix}`,
      text: `周${wdCN} ${this.windowLabel(w)}，全网 ${Number(w.total).toLocaleString()} 人次（按课表推算）`
        + (onOtherDay ? ` —— 所选日期${day ? day.label : ''}没有课，这一张按周${wdCN}的课表算` : '')
        + (evCount ? `，并叠加 ${evCount} 个活动` : ''),
      idle: false,
    };
  },

  /** 把活动流量并到原始包络上（只看最坏情况时用）。 */
  addBaseline(evFlow) {
    const base = router.baselinePeak();
    const out = new Float64Array(base.length);
    for (let i = 0; i < base.length; i++) out[i] = base[i] + evFlow[i];
    return out;
  },

  // ------------------------------------------------------------ 情景重算
  closeEdgeIndices() {
    return this.data.closedList.map(c => c.ei);
  },

  /** 重算全网流量与占用率 -> 新热度图 -> 重新规划路线。 */
  refreshScenario() {
    const level = this.currentLevel();
    const agg = this.effectiveReports();
    const time = this.resolveTimeBase();
    // 管理员直接封的路 + 用户上报并核实过的封路，合并生效
    const closedEdges = this.closeEdgeIndices().concat(Array.from(agg.closed));
    const s = scenarioEngine.applyScenario({
      level,
      basePeak: time.basePeak,
      closedEdges,
      congestion: agg.congestion,
      policeEdges: Array.from(agg.police),
      avoidPolice: this.data.avoidPolice,
    });
    this.network = s.network;
    this.scenario = s;
    this.reportAgg = agg;
    // 把当前情景共享给点选页，保证两页画的是同一张热度图；
    // 同时把"配置类"字段也写进去，模块二级页读它来显示与改参数。
    session.patch({
      level,
      closedList: this.data.closedList,
      avoidPolice: this.data.avoidPolice,
      basePeak: time.basePeak,
      dateISO: this.data.dateISO,
      timeChoice: this.data.timeChoice,
      timeIndex: this.data.timeIndex,
      weatherChoice: this.data.weatherChoice,
      weatherIndex: this.data.weatherIndex,
      mode: this.data.mode,
      eventInclude: this.eventInclude || {},
      wantTracking: !!this.wantTracking,
    });

    const worst = (s.worst || []).slice(0, 3).map(w => ({
      roadType: ROAD_TYPE_CN[w.roadType] || w.roadType,
      occBase: w.occBase,
      occNow: w.occNow,
      now: w.now,
      text: `${ROAD_TYPE_CN[w.roadType] || w.roadType} · 占用 ${w.occBase} → ${w.occNow}`,
    }));

    const counts = agg.counts;
    const hasInput = level !== 'none' || closedEdges.length > 0
      || agg.congestion.size > 0 || agg.police.size > 0;

    this.setData({
      reportSummary: reports.summarize(agg),
      reportCounts: counts,
      caliber: time.caliber,
      timeText: time.text,
      timeIdle: time.idle,
      scenarioSummary: scenarioEngine.describeScenario(s),
      atBaseline: !hasInput,
      scenarioNote: s.unassignedFlow > 0
        ? `有 ${s.unassignedFlow} 人次因路网被切断而无法绕行。`
        : (level !== 'none' ? scenarioEngine.WEATHER_ASSUMPTION : ''),
      congestion: {
        index: s.congestionIndex,
        avgOccBase: s.avgOccBase,
        avgOccNow: s.avgOccNow,
        aggravated: s.aggravated,
        eased: s.eased,
        newHotspots: s.newHotspots,
        increased: s.increased,
        unassignedFlow: s.unassignedFlow,
        worst,
      },
    });

    if (this.data.startReady && this.data.destReady) this.plan();
    else { this.draw(); this.publishPanel(); }
  },

  // ------------------------------------------------------------ 模块按钮与二级页
  /**
   * 把"一屏布局需要的东西"算出来，并把模块二级页要显示的数据放进 panelBus。
   *
   * 放在这里（而不是二级页里）的原因：口径、拥堵、结果这些值只有本页算得出来，
   * 二级页只是显示 + 改参数。这样重算逻辑永远只有一份。
   */
  publishPanel() {
    const d = this.data;
    const weatherChip = d.weatherLoading ? '天气…'
      : (d.weatherText || (d.weatherChoice === 'auto' ? '天气未知' : '未指定'));
    const pending = (d.reportCounts && d.reportCounts.pending) || 0;
    const effectiveCount = this.reportAgg
      ? this.reportAgg.closed.size + this.reportAgg.congestion.size + this.reportAgg.police.size
      : 0;

    const buttons = [
      { key: 'time', icon: '🕐', name: '预测时段', badge: d.dateLabel || '' },
      { key: 'event', icon: '📅', name: '当天事件', badge: d.eventCount ? `${d.eventIncluded}/${d.eventCount}` : '' },
      { key: 'weather', icon: '🌦', name: '天气', badge: d.weatherText || '' },
      { key: 'report', icon: '📣', name: '路况上报', badge: pending ? `待核 ${pending}` : (effectiveCount ? `生效 ${effectiveCount}` : '') },
      { key: 'police', icon: '🚓', name: '交警规避', badge: d.avoidPolice ? '已开启' : '' },
      { key: 'locate', icon: '📍', name: '实时定位', badge: d.tracking ? '跟随中' : '' },
      { key: 'close', icon: '🚧', name: '直接封路', badge: d.closedList.length ? `${d.closedList.length} 条` : '' },
      { key: 'congestion', icon: '📊', name: '拥堵预测', badge: d.congestion ? `指数 ${d.congestion.index}` : '' },
      { key: 'result', icon: '🧭', name: '规划结果', badge: d.result ? d.result.timeText : '' },
    ];
    this.setData({ panelButtons: buttons, weatherChip });

    // 给模块二级页的快照（每次都刷新，保证二级页看到的是最新的）
    panelBus.putSnapshot('route', {
      timeAvailable: d.timeAvailable,
      timeChoices: d.timeChoices,
      timeIndex: d.timeIndex,
      timeChoice: d.timeChoice,
      timeText: d.timeText,
      timeHint: d.timeHint,
      timeIdle: d.timeIdle,
      caliber: d.caliber,
      dateISO: d.dateISO,
      dateLabel: d.dateLabel,
      dateHint: d.dateHint,
      dateMin: d.dateMin,
      dateMax: d.dateMax,
      isWeekend: d.isWeekend,
      dayKind: d.dayKind,
      dayWindowCount: (d.timeChoices || []).length,
      eventList: d.eventList,
      eventCount: d.eventCount,
      eventIncluded: d.eventIncluded,
      eventText: d.eventText,
      weatherChoice: d.weatherChoice,
      weatherIndex: d.weatherIndex,
      weatherLoading: d.weatherLoading,
      weatherText: d.weatherText,
      weatherDetail: d.weatherDetail,
      weatherFetchedAt: d.weatherFetchedAt,
      weatherError: d.weatherError,
      weatherSource: d.weatherSource,
      weatherAssumption: scenarioEngine.WEATHER_ASSUMPTION,
      reportSummary: d.reportSummary,
      reportCounts: d.reportCounts,
      reportBackend: d.reportBackend,
      reportCloud: d.reportCloud,
      avoidPolice: d.avoidPolice,
      policeCount: (this.reportAgg && this.reportAgg.police.size) || 0,
      tracking: d.tracking,
      trackingText: d.trackingText,
      trackingError: d.trackingError,
      closedList: d.closedList,
      congestion: d.congestion,
      scenarioSummary: d.scenarioSummary,
      scenarioNote: d.scenarioNote,
      atBaseline: d.atBaseline,
      result: d.result,
      comparison: d.comparison,
      insight: d.insight,
      policeInsight: d.policeInsight,
      hint: d.hint,
      planError: d.planError,
      mode: d.mode,
    });
  },

  /** 点模块按钮 -> 进对应二级页。 */
  goPanel(e) {
    const key = (e && e.currentTarget && e.currentTarget.dataset.key) || 'time';
    // 先进之前把最新数据推过去，二级页一打开就有内容。
    // 包一层 try：刷新快照是"锦上添花"，绝不能因为它出错就导致按钮点不动。
    try {
      this.publishPanel();
    } catch (err) {
      console.warn('[goPanel] 刷新面板快照失败，仍然继续跳转：', err);
    }
    wx.navigateTo({
      url: '/pages/panel/panel?key=' + key,
      fail: res => {
        // 跳转失败时给出可见反馈，而不是"点了没反应"
        console.error('[goPanel] navigateTo 失败：', res);
        wx.showToast({ title: '打不开模块页：' + ((res && res.errMsg) || '未知原因'), icon: 'none' });
      },
    });
  },

  /** 起点：三种来源收进一个原生选择菜单，省掉一整张卡片。 */
  pickStartSheet() {
    wx.showActionSheet({
      itemList: ['用当前位置', '搜索选择', '地图点选'],
      success: r => {
        if (r.tapIndex === 0) this.useMyLocation();
        else if (r.tapIndex === 1) this.openPlaceSearch({ currentTarget: { dataset: { target: 'start' } } });
        else this.beginPickStart();
      },
      fail: () => {},
    });
  },

  /** 终点：两种来源。 */
  pickDestSheet() {
    wx.showActionSheet({
      itemList: ['搜索选择', '地图点选'],
      success: r => {
        if (r.tapIndex === 0) this.openPlaceSearch({ currentTarget: { dataset: { target: 'dest' } } });
        else this.beginPickDest();
      },
      fail: () => {},
    });
  },

  // ------------------------------------------------------------ 起点 / 终点
  useMyLocation() {
    if (this.data.locating) return;
    this.setData({ locating: true, planError: '' });
    const applyCoords = (lon, lat) => {
      const hit = router.nearestNodeByLonLat(lon, lat);
      // 不直接把经纬度丢给用户：用最近的常用地点命名（utils/router.js 的 describeLonLat）
      const named = router.describeLonLat(lon, lat);
      this.startNode = hit.index;
      this.setData({
        startLabel: named.label,
        startSource: 'gps',
        startSnapText: `${named.detail} · ${snapHint(hit.snapMeters)} · ${named.coord}`,
        startReady: true, locating: false, planError: '',
      });
      this.afterSelection();
    };
    const applyFallback = () => {
      const hit = router.nearestNode(fallbackPoint[0], fallbackPoint[1]);
      this.startNode = hit.index;
      this.setData({
        startLabel: '校园中心（示意起点）', startSource: 'gps',
        startSnapText: '未获得定位权限，已改用校园中心，可手动改起点',
        startReady: true, locating: false,
      });
      this.afterSelection();
    };

    wx.getLocation({
      // 必须用 wgs84：整张地图（OSM + 我们拟合的投影）是 WGS84，
      // 而 gcj02 在中南大学一带与之相差约 660 米，会把起点放到几百米外。
      type: 'wgs84',
      success: r => applyCoords(r.longitude, r.latitude),
      fail: () => {
        wx.getSetting({
          success: s => {
            if (s.authSetting['scope.userLocation'] === false) {
              wx.showModal({
                title: '需要定位权限',
                content: '请在设置里允许获取位置，或直接手动选择起点。',
                confirmText: '去设置',
                success: m => { if (m.confirm) wx.openSetting({}); },
              });
              this.setData({ locating: false });
              return;
            }
            wx.authorize({
              scope: 'scope.userLocation',
              success: () => this.setData({ locating: false }, () => this.useMyLocation()),
              fail: applyFallback,
            });
          },
          fail: applyFallback,
        });
      },
    });
  },

  // ------------------------------------------------------------ 规划
  afterSelection() {
    if (this.data.startReady && this.data.destReady) {
      this.plan();
    } else {
      this.setData({
        planned: false, result: null, comparison: [], insight: '',
        hint: this.data.startReady ? '已设置起点，再选一个目的地' : '请先设置起点和终点',
      });
      this.draw();
    }
  },

  setQuiet() { this.setMode('quiet'); },
  setFastest() { this.setMode('fastest'); },
  setShortest() { this.setMode('shortest'); },

  onSwitchMode(e) {
    const mode = e.currentTarget.dataset.mode;
    if (mode) this.setMode(mode);
  },

  setMode(mode) {
    if (this.data.mode === mode) return;
    this.setData({ mode }, () => {
      if (this.data.startReady && this.data.destReady) this.plan();
    });
  },

  plan() {
    if (!this.data.startReady || !this.data.destReady) {
      this.setData({ hint: '请先设置起点和终点' });
      return;
    }
    const network = this.network || router.baselineNetwork();
    const all = router.planAllOn(network, this.startNode, this.destNode);
    const primary = all[this.data.mode];

    const comparison = router.MODES.map(m => {
      const r = all[m.key];
      return {
        key: m.key, name: m.name, active: m.key === this.data.mode, ok: r.ok,
        timeText: r.ok ? router.formatDuration(r.timeMinutes) : '不可达',
        distance: r.ok ? r.distanceMeters : 0,
        avgHeat: r.ok ? r.avgHeatPersons : 0,
      };
    });

    if (!primary.ok) {
      this.lastPath = null;
      this.usedEdges = null;
      this.nodes = [];
      this.setData({
        planned: false, result: null, comparison: [], insight: '',
        planError: primary.reason, hint: '换个起点、终点，或取消部分封路',
      });
      this.draw();
      this.publishPanel();
      return;
    }

    // 缓存路径：拖动/缩放后重绘时还要用
    this.lastPath = primary.path;
    // 路线要按"这一段有多堵"叠色，所以把每一段的占用率也留着（path 本身不含流量）
    this.usedEdges = primary.usedEdges;
    this.nodes = this.buildCongestionNodes(primary);

    this.setData({
      planned: true, planError: '', hint: '',
      result: {
        modeName: MODE_LABEL[this.data.mode],
        distanceMeters: primary.distanceMeters,
        timeMinutes: primary.timeMinutes,
        timeText: router.formatDuration(primary.timeMinutes),
        crowdDelayMinutes: primary.crowdDelayMinutes,
        avgHeatPersons: primary.avgHeatPersons,
        maxHeatPersons: primary.maxHeatPersons,
        avgCongestion: primary.avgCongestion,
        maxCongestion: primary.maxCongestion,
        congestedSegments: primary.congestedSegments,
        // 其中"爆堵"（占用率 ≥ 1.0）的段数：地图上这些段是红的，详见 render.HEAT_BAD
        badSegments: primary.usedEdges.filter(e => e.heat >= render.HEAT_BAD).length,
        policeSegments: primary.policeSegments,
        segmentCount: primary.segmentCount,
        roadMix: Object.entries(primary.byRoadType)
          .sort((a, b) => b[1] - a[1])
          .map(([t, v]) => `${ROAD_TYPE_CN[t] || t} ${v}m`)
          .join(' · '),
      },
      comparison,
      insight: buildInsight(this.data.mode, all),
      policeInsight: this.buildPoliceInsight(all),
    });
    this.draw(primary.path);
    this.publishPanel();
  },
  /**
   * 交警规避的取舍说明：把"绕开"和"不绕开"两条算出来对比，
   * 让用户看到绕开到底多花多少、以及还能不能绕得掉。
   */
  buildPoliceInsight(all) {
    const policeCount = (this.reportAgg && this.reportAgg.police.size) || 0;
    if (!policeCount) return '';
    const withPolice = router.withPolice(this.network, true);
    const avoided = all[this.data.mode];
    const direct = router.planOn(withPolice, this.startNode, this.destNode, this.data.mode);
    if (!direct.ok || !avoided.ok) return '';
    const extra = avoided.timeMinutes - direct.timeMinutes;
    const left = avoided.policeSegments;
    if (left > 0) {
      return `已标记 ${policeCount} 处交警，但其中 ${left} 处在必经之路上，绕不开。`;
    }
    return `已避开全部 ${policeCount} 处交警，代价是多花约 ${Math.max(0, extra).toFixed(1)} 分钟。`;
  },

  back() { wx.navigateBack(); },

  // ------------------------------------------------------------ 绘制
  /**
   * 画三层：当前情景的热度层 -> 封闭路段 -> 规划路线与起终点。
   * 全部在 SVG 坐标系里画，线宽除以缩放比以保证屏幕上的粗细稳定。
   */
  draw(path) {
    const vp = this.view;
    if (!vp || !vp.ready) return;
    const ctx = wx.createCanvasContext('routeCanvas', this);
    const view = render.beginFrame(ctx, {
      W: vp.W, H: vp.H, s: vp.s, offX: vp.offX, offY: vp.offY, scale: vp.scale,
    });
    render.drawHeat(ctx, this.network || router.baselineNetwork(), view);
    render.drawReports(ctx, this.data.reportList, view);
    render.drawRoute(ctx, this.lastPath || path, view, { usedEdges: this.usedEdges });
    render.drawCongestionNodes(ctx, this.nodes, view);
    render.drawEndpoints(ctx, this.startNode, this.destNode, view);
    render.drawMyLocation(ctx, this.myLocation, view);
    render.endFrame(ctx);
  },
});
