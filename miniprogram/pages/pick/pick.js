/**
 * 点选页（二级页面）：全屏地图 + 确认栏。
 *
 * 为什么要单独开一页：
 *   1. 路线页很长，地图在最下面，点"地图点选"后按钮和地图不在同一屏，用户看不到提示；
 *   2. 关键的是**坐标换算**：wx 的 boundingClientRect 与触摸点的 clientX/clientY 都是
 *      相对于可视区域的，而这一页**全屏且不滚动**，滚动偏移恒为 0，
 *      所以测量出来的矩形始终有效，点哪儿就是哪儿，不会因为页面滚动而整体偏移。
 *      （每次触摸还会再测一次，双保险。）
 *
 * 支持四种模式（用 ?mode= 传入）：
 *   close  点选要封闭的道路
 *   report 点选要上报的道路（再选情况类型）
 *   start  点选起点（吸附到最近路口）
 *   dest   点选终点
 * 选完通过 utils/pickBus.js 把结果交回路线页。
 */
const router = require('../../utils/router.js');
const scenarioEngine = require('../../utils/scenario.js');
const reportsUtil = require('../../utils/reports.js');
const reportStore = require('../../utils/reportStore.js');
const render = require('../../utils/render.js');
const session = require('../../utils/session.js');
const pickBus = require('../../utils/pickBus.js');
const viewport = require('../../utils/viewport.js');

const graph = router.graph;
const VIEW_W = graph.meta.viewBox[0];
const VIEW_H = graph.meta.viewBox[1];

const ROAD_TYPE_CN = require('../../utils/closedRoads.js').ROAD_TYPE_CN;

const MODE_META = {
  close: {
    title: '点选封闭道路',
    hint: '点击地图上的道路来选中它，确认后该路段将被封闭',
    confirm: '确认封闭',
  },
  report: {
    title: '上报实时路况',
    hint: '点击要上报的那条道路，然后选择情况类型',
    confirm: '下一步',
  },
  start: {
    title: '点选起点',
    hint: '点击地图上的任意位置，会自动吸附到最近的路口',
    confirm: '设为起点',
  },
  dest: {
    title: '点选终点',
    hint: '点击地图上的任意位置，会自动吸附到最近的路口',
    confirm: '设为终点',
  },
};

// 距离道路多远就认为"没点在路上"（米）
const MAX_OFF_ROAD_METERS = 60;
// 初始缩放：整张图全览时无处可拖，所以默认放大一点，打开就能拖着找路
const DEFAULT_SCALE = 1.6;
const MIN_SCALE = 0.7;
const MAX_SCALE = 4;

Page({
  data: {
    mode: 'close',
    title: '',
    hint: '',
    confirmText: '',
    categories: reportsUtil.CATEGORIES,
    category: '',
    note: '',
    sheetVisible: false,
    selection: null,
    scale: DEFAULT_SCALE,
    scaleLabel: DEFAULT_SCALE.toFixed(1) + '×',
    tx: 0,               // 拖动偏移（容器像素）
    ty: 0,
    canPan: false,       // 当前缩放/尺寸下是否拖得动
  },

  viewport: null,
  network: null,
  reportList: [],

  onLoad(query) {
    const mode = MODE_META[query && query.mode] ? query.mode : 'close';
    const meta = MODE_META[mode];
    // 谁打开的这一页（模块二级页会带 from=report|close）：决定「取消」该回到哪一页
    this.from = (query && query.from) || '';
    // 视口与手势状态：几何全部交给 utils/viewport.js
    this.view = viewport.create({
      viewW: VIEW_W, viewH: VIEW_H,
      scale: DEFAULT_SCALE, minScale: MIN_SCALE, maxScale: MAX_SCALE,
    });
    this.gesture = viewport.createGesture();
    this.rect = null;
    this.setData({
      mode,
      title: meta.title,
      hint: meta.hint,
      confirmText: meta.confirm,
    });
  },

  onReady() {
    // 先把情景搭好再绘制，避免第一帧是空的
    this.network = this.buildNetwork();
    this.measureViewport(() => {
      // 量完才知道能不能拖，这里就得算一次，否则"可拖动"提示要等到第一次触摸才出现
      this.setData({ canPan: this.panAvailable() });
      this.draw();
    });
    this.loadReports();
  },

  /** 用路线页共享的情景参数（时段 / 天气 / 封路 / 交警）复算出同一个路网。 */
  buildNetwork() {
    const s = session.get();
    const agg = reportsUtil.aggregate(this.reportList || []);
    const closedEdges = (s.closedList || []).map(c => c.ei).concat(Array.from(agg.closed));
    const result = scenarioEngine.applyScenario({
      level: s.level,
      basePeak: s.basePeak || null,
      closedEdges,
      congestion: agg.congestion,
      policeEdges: Array.from(agg.police),
      avoidPolice: s.avoidPolice,
    });
    return result.network;
  },

  loadReports() {
    reportStore.load(list => {
      this.reportList = list || [];
      this.network = this.buildNetwork();
      this.draw();
    });
  },

  // ------------------------------------------------------------ 视口（几何算在 utils/viewport.js）
  measureViewport(cb) {
    wx.createSelectorQuery()
      .select('#pickMap')
      .boundingClientRect(rect => {
        const prev = this.rect;
        this.rect = rect;
        const ok = viewport.measure(this.view, rect);
        if (!ok) this.rect = null;
        // 容器位置变了：手势里已记下的坐标是按旧矩形算的，整体平移过去，
        // 否则位移会差一个偏移，轻点还会被误判成"拖过"（见 viewport.shiftGesture）
        if (prev && this.rect) {
          viewport.shiftGesture(this.gesture, prev.left - this.rect.left, prev.top - this.rect.top);
        }
        if (cb) cb();
      })
      .exec();
  },

  /** 屏幕触点 -> SVG 坐标。 */
  clientToSvg(clientX, clientY) {
    if (!this.rect) return null;
    return viewport.toSvg(this.view, this.rect, clientX, clientY);
  },

  /** 限制拖动范围（保留旧方法名，内部走 viewport）。 */
  clampOffset(tx, ty, scale) {
    return viewport.clamp(this.view, tx, ty, scale);
  },

  /** 当前缩放下是否拖得动。 */
  panAvailable(scale) {
    return viewport.canPan(this.view, scale);
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

  /**
   * 屏幕触点 -> SVG 坐标。
   * 图层变换是 translate(tx,ty) scale(k)（原点在容器中心），
   * 所以屏幕点 p 对应的未缩放坐标是 u = C + (p - C - t) / k，再按 aspectFit 留白换算到 SVG。
   */
  clientToSvg(clientX, clientY) {
    if (!this.rect) return null;
    return viewport.toSvg(this.view, this.rect, clientX, clientY);
  },

  /** 限制拖动范围：图比容器大时不允许拖出边缘，比容器小时保持居中。 */
  clampOffset(tx, ty, scale) {
    return viewport.clamp(this.view, tx, ty, scale);
  },

  /** 当前缩放下是否拖得动（决定要不要显示"可拖动"的提示）。 */
  panAvailable(scale) {
    return viewport.canPan(this.view, scale);
  },

  // ------------------------------------------------------------ 触摸：拖动 + 双指捏合 + 点选
  /** 把触摸点换算成容器内坐标（手势数学只需要相对容器的位置）。 */
  touchPoints(touches) {
    const r = this.rect;
    if (!r) return [];
    return (touches || []).map(t => ({ x: t.clientX - r.left, y: t.clientY - r.top }));
  },

  onTouchStart(e) {
    // **立刻**起手：矩形测量是异步的，若等它回来才 gestureStart，
    // 一次快速轻扫（touchstart → move → end 都在回调之前）会被整段丢掉 ——
    // 拖动失效，而且抬手时 gs.start 还是空的，会被误判成**点选**（在这个页面上就是误选一个点）。
    // 拖动只关心位移差，用已知的 rect 换算就够；新矩形随后异步测回来刷新（点选换算要用最新的）。
    viewport.gestureStart(this.view, this.gesture, this.touchPoints(e.touches));
    this.measureViewport(() => {
      this.setData({ canPan: this.panAvailable() });
    });
  },

  onTouchMove(e) {
    const pts = this.touchPoints(e.touches);
    if (!pts.length) return;
    const next = viewport.gestureMove(this.view, this.gesture, pts);
    if (!next) return;
    // 数值没变就不 setData，减少无谓的视图层通信
    if (Math.abs(next.tx - this.view.tx) < 0.5
      && Math.abs(next.ty - this.view.ty) < 0.5
      && Math.abs(next.scale - this.view.scale) < 1e-6) return;
    this.applyView(next);
  },

  onTouchEnd(e) {
    const t = (e.changedTouches && e.changedTouches[0]) || null;
    if (!t) return;
    // 拖过 / 捏合过 / 多指碰过 / 还有手指没抬起来 -> 都不算点选。
    // 抬手位置一并交给 gestureEnd 兜底判断（快速滑动可能一个 touchmove 都没有）。
    // 双指放大原来会被这里误判成点选，就是因为"抬起第一根手指"和"抬起最后一根手指"
    // 各来一次 touchend，中间那次丢了上下文。
    const endPt = this.rect ? { x: t.clientX - this.rect.left, y: t.clientY - this.rect.top } : null;
    const remaining = (e.touches || []).length;
    if (viewport.gestureEnd(this.gesture, endPt, remaining)) return;
    if (!this.rect) {
      this.measureViewport(() => this.handleTap(t.clientX, t.clientY));
      return;
    }
    this.handleTap(t.clientX, t.clientY);
  },

  handleTap(clientX, clientY) {
    const svg = this.clientToSvg(clientX, clientY);
    if (!svg) return;
    const inRange = svg[0] >= -50 && svg[0] <= VIEW_W + 50 && svg[1] >= -50 && svg[1] <= VIEW_H + 50;
    if (!inRange) return;

    if (this.data.mode === 'start' || this.data.mode === 'dest') {
      const hit = router.nearestNode(svg[0], svg[1]);
      const sel = {
        kind: 'node',
        index: hit.index,
        snapMeters: Math.round(hit.distanceMeters * 10) / 10,
        label: `已吸附到最近路口，偏移约 ${hit.distanceMeters.toFixed(0)} 米`,
      };
      this.setData({ selection: sel });
      this.draw();
      return;
    }

    // 封闭 / 上报：必须点在道路上
    const hit = router.nearestEdge(svg[0], svg[1]);
    if (hit.index < 0) {
      wx.showToast({ title: '附近没有道路', icon: 'none' });
      return;
    }
    if (hit.distanceMeters > MAX_OFF_ROAD_METERS) {
      wx.showToast({
        title: `离路太远（${hit.distanceMeters.toFixed(0)} 米），请点在道路上`,
        icon: 'none',
      });
      return;
    }
    // 已经封掉的路：在这里就告诉用户，别等他提交完才说"这条路已经封了"
    // （封路上画的是深灰虚线，所以这里也提示去哪儿解除）
    if (this.network && this.network.closed && this.network.closed[hit.index]) {
      wx.showToast({ title: '这条路已经封闭，可在「直接封路」里解除', icon: 'none' });
      return;
    }
    const typeCn = ROAD_TYPE_CN[hit.roadType] || hit.roadType;
    const sel = {
      kind: 'edge',
      index: hit.index,
      tapX: svg[0],
      tapY: svg[1],
      edgeId: hit.id,
      roadType: hit.roadType,
      roadTypeCn: typeCn,
      peak: Math.round(hit.peak),
      length: Math.round(hit.length),
      label: `${typeCn} · ${hit.id}`,
      detail: `峰值 ${Math.round(hit.peak)} 人/时段 · 长 ${Math.round(hit.length)} 米`,
    };
    this.setData({
      selection: sel,
      // 上报模式：选完路直接展开类型面板
      sheetVisible: this.data.mode === 'report',
      category: '',
    });
    this.draw();
  },

  // ------------------------------------------------------------ 上报面板
  chooseCategory(e) {
    const key = e.currentTarget.dataset.key;
    if (reportsUtil.isValidCategory(key)) this.setData({ category: key });
  },

  onNoteInput(e) {
    this.setData({ note: e.detail.value });
  },

  // ------------------------------------------------------------ 确认 / 取消
  /**
   * 关掉上报表单，**只关表单**。
   *
   * 以前表单里的「取消」和"点一下表单外面的遮罩"都直接 `cancel()`，
   * 也就是把整个点选页一起退掉 —— 用户只是想改个类型或重新点一条路，
   * 结果整张地图没了，手感很差。现在遮罩和表单里的按钮都只收起表单，
   * 已选中的路段留着，可以接着点、接着报。
   */
  closeSheet() {
    this.setData({ sheetVisible: false });
  },

  confirm() {
    const sel = this.data.selection;
    if (!sel) {
      wx.showToast({ title: '请先在地图上点选', icon: 'none' });
      return;
    }
    const mode = this.data.mode;

    if (mode === 'start' || mode === 'dest') {
      pickBus.put({
        action: mode,
        nodeIndex: sel.index,
        snapMeters: sel.snapMeters,
      });
      this.leave();
      return;
    }

    if (mode === 'close') {
      pickBus.put({
        action: 'close',
        edgeIndex: sel.index,
        edgeId: sel.edgeId,
        roadType: sel.roadType,
        peak: sel.peak,
        length: sel.length,
      });
      this.leave();
      return;
    }

    // report：类型没选就先把表单打开（而不是只弹一句提示，用户还得再找一次入口）
    if (!this.data.category) {
      if (!this.data.sheetVisible) {
        this.setData({ sheetVisible: true });
        return;
      }
      wx.showToast({ title: '请先选择情况类型', icon: 'none' });
      return;
    }
    const cat = reportsUtil.CATEGORY_MAP[this.data.category];
    // 封路类只影响点中的那一条；拥堵/交警类影响周边一段路
    const near = cat.radius > 0
      ? router.nearestEdges(sel.tapX, sel.tapY, cat.radius, 5)
      : [{ ei: sel.index }];
    pickBus.put({
      action: 'report',
      category: this.data.category,
      edges: near.map(n => n.ei),
      x: router.edgeMidpoint(sel.index)[0],
      y: router.edgeMidpoint(sel.index)[1],
      roadType: sel.roadType,
      edgeId: sel.edgeId,
      note: this.data.note,
    });
    this.leave();
  },

  /**
   * 上一页的页面路径（没有上一页就返回 ''）。
   * 用 `getCurrentPages()` 是因为"返回"到底回到哪儿，只有页面栈知道；
   * 测试环境里没有这个 API，所以做了兜底。
   */
  prevRoute() {
    try {
      if (typeof getCurrentPages !== 'function') return '';
      const pages = getCurrentPages() || [];
      const prev = pages.length >= 2 ? pages[pages.length - 2] : null;
      return (prev && (prev.route || prev.__route__)) || '';
    } catch (e) {
      return '';
    }
  },

  /** 明确回到模块二级页（页面栈里没有它的时候用）。 */
  redirectToPanel() {
    const url = '/pages/panel/panel?key=' + (this.data.mode === 'close' ? 'close' : 'report');
    if (typeof wx.redirectTo === 'function') wx.redirectTo({ url });
    else wx.navigateBack();          // 兜底：老基础库/测试桩没有 redirectTo
  },

  /** 离开点选页（左上「‹ 取消」、底部「取消」、提交成功之后都走这里）。 */
  leave() {
    // 模块二级页打开的（`?from=panel`）：必须回到那一页。
    // 上一页确实是它 -> 正常返回；否则明确跳过去，
    // 免得落到别的地图页上，用户还得自己再点一遍「实时路况上报」。
    if (this.from === 'panel') {
      if (this.prevRoute() === 'pages/panel/panel') {
        wx.navigateBack();
        return;
      }
      this.redirectToPanel();
      return;
    }
    if (this.prevRoute()) {
      wx.navigateBack();
      return;
    }
    // 页面栈里只有自己（例如扫码/分享直接打开）：明确回模块二级页
    this.redirectToPanel();
  },

  cancel() {
    pickBus.take();          // 丢弃可能残留的结果
    this.leave();
  },

  // ------------------------------------------------------------ 缩放与视野
  zoomIn() { this.setScale(this.data.scale + 0.3); },
  zoomOut() { this.setScale(this.data.scale - 0.3); },

  /** 回到全览：缩放归 1、偏移归零。 */
  resetZoom() { this.setScale(1, true); },

  /** 回到初始视野（1.6 倍 + 居中）。 */
  resetView() { this.setScale(DEFAULT_SCALE, true); },

  setScale(v, resetOffset) {
    const scale = viewport.clampScale(this.view, v);
    // 缩放后原来的偏移可能越界，重新夹一次；全览/复位则直接归零
    const off = resetOffset
      ? { tx: 0, ty: 0 }
      : viewport.clamp(this.view, this.view.tx, this.view.ty, scale);
    this.applyView({ scale, tx: off.tx, ty: off.ty }, () => this.draw());
  },

  // ------------------------------------------------------------ 绘制
  draw() {
    const vp = this.view;
    if (!vp || !vp.ready) return;
    const ctx = wx.createCanvasContext('pickCanvas', this);
    const view = render.beginFrame(ctx, {
      W: vp.W, H: vp.H, s: vp.s, offX: vp.offX, offY: vp.offY, scale: vp.scale,
    });
    render.drawHeat(ctx, this.network, view);
    render.drawReports(ctx, this.reportList, view);
    render.drawSelection(ctx, this.data.selection, view);
    // 路线页开着实时定位时，这里也能看到"我的位置"，方便就近选路
    render.drawMyLocation(ctx, session.get().myLocation, view);
    render.endFrame(ctx);
  },
});
