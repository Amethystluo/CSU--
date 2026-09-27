Page({
  data: {
    // 功能宫格配置：图标 / 标题 / 副标题 / 跳转方法 / 配色
    navs: [
      { icon: '🗺️', title: '预测热度', sub: '通行热度与Top5', key: 'predict', color: '#167052' },
      { icon: '🧭', title: '少人路线', sub: '三种走法避堵', key: 'route', color: '#1f8a6f' },
      { icon: '🌱', title: '中南农场', sub: '种菜收菜小游戏', key: 'farm', color: '#6a9e3b' },
      { icon: '💬', title: '校园吐槽', sub: '通勤槽点留言板', key: 'complain', color: '#e07a1f' },
      { icon: '📅', title: '事件与校历', sub: '活动·放假·调休', key: 'event', color: '#d25b5b' },
      { icon: '🛠', title: '路况管理', sub: '审核上报路况', key: 'admin', color: '#5b7fd2' }
    ]
  },
  go(e) {
    const key = e.currentTarget.dataset.key;
    const map = {
      predict: '/pages/predict/predict',
      route: '/pages/route/route',
      farm: '/pages/farm/farm',
      complain: '/pages/complain/complain',
      event: '/pages/event/event',
      admin: '/pages/admin/admin'
    };
    wx.navigateTo({ url: map[key] });
  }
})
