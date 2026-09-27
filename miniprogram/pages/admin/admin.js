/**
 * 路况管理页：审核用户上报 + 查看生效的路况。
 *
 * 这就是需求里说的"后台可以直接修改道路信息来筛选某些信息是否属实"：
 *   - 逐条审核：属实（进入规划计算）/ 不属实（丢弃）/ 删除
 *   - 批量操作：一键全部属实（路演演示方便）
 *   - 直接看当前生效的路况：哪些路被封、哪些堵、哪些有交警
 *
 * 数据源与"少人路线"页共用 reportStore：开通云开发后，这里改的状态
 * 会同步给所有用户；未开通时只影响本机。
 */
const reportsUtil = require('../../utils/reports.js');
const reportStore = require('../../utils/reportStore.js');
const router = require('../../utils/router.js');

const ROAD_TYPE_CN = {
  primary: '城市主干道', secondary: '次干道', tertiary: '支路',
  residential: '生活区道路', unclassified: '一般道路', service: '内部通道',
  track: '小路', path: '小径', footway: '人行道',
};

const FILTERS = [
  { key: 'pending', name: '待核实' },
  { key: 'verified', name: '已属实' },
  { key: 'rejected', name: '已否决' },
  { key: 'all', name: '全部' },
];

function fmtTime(ts) {
  const d = new Date(ts || 0);
  const p = n => (n < 10 ? '0' + n : '' + n);
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

Page({
  data: {
    filters: FILTERS,
    filterIndex: 0,
    filter: 'pending',
    list: [],
    counts: null,
    summary: '',
    backend: '',
    isCloud: false,
    effective: null,
    loading: true,
  },

  onShow() {
    this.reload();
  },

  reload() {
    reportStore.load((list, meta) => {
      this.all = list;
      this.setData({
        backend: reportStore.backendName(),
        isCloud: !!(meta && meta.cloud),
        loading: false,
      });
      this.recompute();
    });
  },

  onFilter(e) {
    const i = Number(e.detail.value);
    this.setData({ filterIndex: i, filter: FILTERS[i].key }, () => this.recompute());
  },

  /** 按当前筛选条件整理列表，并算出"生效路况"。 */
  recompute() {
    const all = this.all || [];
    const agg = reportsUtil.aggregate(all);
    const f = this.data.filter;
    const list = all
      .filter(r => (f === 'all' ? true : r.status === f))
      .slice()
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .map(r => {
        const cat = reportsUtil.CATEGORY_MAP[r.category] || { name: r.category, color: '#888' };
        return {
          id: r.id,
          category: r.category,
          catName: cat.name,
          color: cat.color,
          status: r.status,
          statusName: (reportsUtil.STATUS[r.status] || {}).name || r.status,
          roadType: ROAD_TYPE_CN[r.roadType] || r.roadType || '—',
          edgeId: r.edgeId || '—',
          note: r.note || '',
          time: fmtTime(r.createdAt),
          edgeCount: (r.edges || []).length,
          fresh: reportsUtil.isFresh(r),
        };
      });

    // 当前生效的路况
    const eff = [];
    agg.closed.forEach(ei => eff.push({ kind: '封路', ei, name: router.graph.edgeIds[ei] }));
    agg.police.forEach(ei => eff.push({ kind: '交警', ei, name: router.graph.edgeIds[ei] }));
    agg.congestion.forEach((v, ei) => eff.push({ kind: `拥堵 ×${v}`, ei, name: router.graph.edgeIds[ei] }));

    this.setData({
      list,
      counts: agg.counts,
      summary: reportsUtil.summarize(agg),
      effective: {
        items: eff.slice(0, 12),
        total: eff.length,
        expired: agg.expired,
      },
    });
  },

  /** 审核：属实 / 不属实。 */
  setStatus(e) {
    const id = e.currentTarget.dataset.id;
    const status = e.currentTarget.dataset.status;
    const target = (this.all || []).find(r => r.id === id);
    if (!target || !reportsUtil.canTransition(target.status, status)) return;
    this.all = reportStore.update(id, { status }, () => this.reload());
    this.recompute();
    wx.showToast({ title: status === 'verified' ? '已标为属实，立即生效' : '已标为不属实', icon: 'none' });
  },

  removeOne(e) {
    const id = e.currentTarget.dataset.id;
    this.all = reportStore.remove(id, () => this.reload());
    this.recompute();
  },

  /** 路演用的批量操作：把当前待核实的全部标为属实。 */
  verifyAllPending() {
    const pending = (this.all || []).filter(r => r.status === 'pending' && reportsUtil.isFresh(r));
    if (!pending.length) {
      wx.showToast({ title: '没有待核实的上报', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '批量核实',
      content: `把 ${pending.length} 条待核实的上报全部标为属实？`,
      success: m => {
        if (!m.confirm) return;
        let list = this.all;
        pending.forEach(r => { list = reportStore.update(r.id, { status: 'verified' }); });
        this.all = list;
        this.recompute();
        wx.showToast({ title: `已核实 ${pending.length} 条`, icon: 'none' });
      },
    });
  },

  /** 清掉本机记录（不影响云端别人的数据）。 */
  clearLocal() {
    wx.showModal({
      title: '清空本机记录',
      content: '只清空这台设备上的上报，云端数据不受影响。',
      success: m => {
        if (!m.confirm) return;
        this.all = reportStore.clearLocal();
        this.recompute();
      },
    });
  },

  back() { wx.navigateBack(); },
});
