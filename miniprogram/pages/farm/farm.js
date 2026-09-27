// ============ 作物配置 ============
const CROPS = {
  '土豆': { emoji: '🥔', cost: 5, sellPrice: 9, duration: 2, needLevel: 1, exp: 2 },
  '番茄': { emoji: '🍅', cost: 10, sellPrice: 18, duration: 4, needLevel: 2, exp: 5 },
  '白菜': { emoji: '🥬', cost: 18, sellPrice: 32, duration: 6, needLevel: 3, exp: 8 },
  '南瓜': { emoji: '🎃', cost: 30, sellPrice: 55, duration: 10, needLevel: 4, exp: 14 },
  '玉米': { emoji: '🌽', cost: 50, sellPrice: 90, duration: 15, needLevel: 5, exp: 22 },
  '水稻': { emoji: '🌾', cost: 80, sellPrice: 150, duration: 20, needLevel: 7, exp: 35 },
  '辣椒': { emoji: '🌶️', cost: 120, sellPrice: 220, duration: 25, needLevel: 9, exp: 50 },
  '西瓜': { emoji: '🍉', cost: 180, sellPrice: 330, duration: 30, needLevel: 12, exp: 70 }
};

const STORAGE_KEY = 'csu_farm_v1';
const NUM_PLOTS = 9;
const EXP_PER_LEVEL = [0, 10, 25, 45, 70, 100, 140, 190, 250, 320, 400];
const LEVEL_NAMES = ['萌新菜农', '种田学徒', '耕田卫士', '农场达人', '中南农夫', '资深农民', '田园大师', '土豪地主', '农场传奇', '中南大总管', '地主之王'];

function makePlots() {
  const plots = [];
  for (let i = 0; i < NUM_PLOTS; i++) plots.push({ crop: '', plantedAt: 0, state: 'empty' });
  return plots;
}

function defaultState() {
  return { coins: 30, exp: 0, level: 1, inventory: {}, plots: makePlots(), lastVisit: Date.now() };
}

function loadState() {
  let s = null;
  try { s = wx.getStorageSync(STORAGE_KEY); } catch (e) {}
  if (!s || !s.plots) return defaultState();
  return s;
}

function saveState(s) { wx.setStorageSync(STORAGE_KEY, s); }

function cropEmoji(name, state) {
  if (state === 'withered') return '🥀';
  if (state === 'ripe') return (CROPS[name] || {}).emoji || '🌿';
  return '🌱';
}

function growPercent(cell) {
  const cfg = CROPS[cell.crop];
  const elapsedMin = (Date.now() - cell.plantedAt) / 1000 / 60;
  return Math.min(100, Math.round(elapsedMin / cfg.duration * 100));
}

Page({
  data: {
    tab: 'field',
    selected: null,
    level: 1,
    exp: 0,
    expNext: 10,
    expPercent: 0,
    coins: 30,
    inventory: {},
    plots: [],
    totalHarvest: 0,
    crops: Object.keys(CROPS).map(k => ({ name: k, ...CROPS[k] }))
  },

  onShow() {
    this.loadFarm();
    this.timer = setInterval(() => this.rollGrowth(), 60000);
  },
  onHide() { this.persist(); if (this.timer) clearInterval(this.timer); },
  onUnload() { this.persist(); if (this.timer) clearInterval(this.timer); },

  get levelName() {
    return LEVEL_NAMES[Math.min(this.data.level - 1, LEVEL_NAMES.length - 1)] || '';
  },

  cropEmoji(name, state) { return cropEmoji(name, state); },
  growPercent(cell) { return growPercent(cell); },
  sellPrice(name) { return (CROPS[name] || {}).sellPrice || 0; },

  loadFarm() {
    const s = loadState();
    this.applyIdleGrowth(s);
    this.setData({
      coins: s.coins,
      exp: s.exp,
      level: s.level,
      expNext: EXP_PER_LEVEL[Math.min(s.level, EXP_PER_LEVEL.length - 1)] || (s.level * 50),
      expPercent: 0,
      inventory: s.inventory || {},
      plots: s.plots
    });
    this.computeExpPercent();
    this.computeTotal();
    saveState(s);
  },

  applyIdleGrowth(s) {
    s.plots.forEach(cell => {
      if (cell.crop && cell.state === 'growing') {
        const cfg = CROPS[cell.crop];
        if ((Date.now() - cell.plantedAt) / 1000 / 60 >= cfg.duration) cell.state = 'ripe';
      }
    });
  },

  rollGrowth() {
    const s = loadState();
    let changed = false;
    s.plots.forEach(cell => {
      if (cell.crop && cell.state === 'growing') {
        const cfg = CROPS[cell.crop];
        if ((Date.now() - cell.plantedAt) / 1000 / 60 >= cfg.duration) { cell.state = 'ripe'; changed = true; }
      }
    });
    if (changed) { this.setData({ plots: s.plots }); saveState(s); }
  },

  persist() {
    const s = loadState();
    s.coins = this.data.coins;
    s.exp = this.data.exp;
    s.level = this.data.level;
    s.inventory = this.data.inventory;
    s.plots = this.data.plots;
    s.lastVisit = Date.now();
    saveState(s);
  },

  computeExpPercent() {
    const need = this.data.expNext;
    const has = this.data.exp;
    const pct = need <= 0 ? 100 : Math.min(100, Math.round(has / need * 100));
    this.setData({ expPercent: pct });
  },

  computeTotal() {
    const inv = this.data.inventory || {};
    const total = Object.keys(inv).reduce((sum, k) => sum + inv[k], 0);
    const list = Object.keys(inv).filter(k => inv[k] > 0).map(k => ({
      name: k,
      count: inv[k],
      emoji: (CROPS[k] || {}).emoji || '🌿',
      sell: (CROPS[k] || {}).sellPrice || 0
    }));
    this.setData({ totalHarvest: total, inventoryList: list });
  },

  setTab(e) { this.setData({ tab: e.currentTarget.dataset.tab }); },

  tapPlot(e) { this.setData({ selected: Number(e.currentTarget.dataset.index) }); },

  plantSelected() {
    const idx = this.data.selected;
    const cell = this.data.plots[idx];
    if (!cell || cell.crop) return;
    const avail = Object.keys(CROPS).filter(n => CROPS[n].needLevel <= this.data.level);
    if (avail.length === 0) { wx.showToast({ title: '等级太低，先去商店', icon: 'none' }); return; }
    const itemList = avail.map(n => `${CROPS[n].emoji} ${n}（${CROPS[n].cost}🪙）`);
    const availCrops = avail;
    wx.showActionSheet({
      itemList,
      success: res => this.doPlant(availCrops[res.tapIndex], idx)
    });
  },

  doPlant(cropName, idx) {
    const cfg = CROPS[cropName];
    if (this.data.coins < cfg.cost) { wx.showToast({ title: '学币不足', icon: 'none' }); return; }
    if (this.data.level < cfg.needLevel) { wx.showToast({ title: '等级不足', icon: 'none' }); return; }
    const plots = this.data.plots.slice();
    plots[idx] = { crop: cropName, plantedAt: Date.now(), state: 'growing' };
    this.setData({ coins: this.data.coins - cfg.cost, plots });
    this.persist();
    wx.showToast({ title: `已种下${cropName}`, icon: 'success' });
  },

  harvestSelected() {
    const idx = this.data.selected;
    const cell = this.data.plots[idx];
    if (!cell || cell.state !== 'ripe') return;
    const cfg = CROPS[cell.crop];
    const cropName = cell.crop;
    const inventory = Object.assign({}, this.data.inventory);
    inventory[cropName] = (inventory[cropName] || 0) + 1;
    const plots = this.data.plots.slice();
    plots[idx] = { crop: '', plantedAt: 0, state: 'empty' };
    this.setData({ inventory, plots });
    this.addExp(cfg.exp);
    this.computeTotal();
    this.persist();
    wx.showToast({ title: `收获${cropName}! 经验+${cfg.exp}`, icon: 'success' });
  },

  sellCrop(e) {
    const cropName = e.currentTarget.dataset.crop;
    const count = this.data.inventory[cropName];
    if (!count) return;
    const cfg = CROPS[cropName];
    const inventory = Object.assign({}, this.data.inventory);
    const coins = this.data.coins + cfg.sellPrice * count;
    delete inventory[cropName];
    this.setData({ inventory, coins });
    this.computeTotal();
    this.persist();
    wx.showToast({ title: `卖出${count}个，+${cfg.sellPrice * count}🪙`, icon: 'success' });
  },

  clearSelected() {
    const idx = this.data.selected;
    const plots = this.data.plots.slice();
    plots[idx] = { crop: '', plantedAt: 0, state: 'empty' };
    this.setData({ plots });
    this.persist();
    wx.showToast({ title: '已清理', icon: 'success' });
  },

  addExp(n) {
    let exp = this.data.exp + n;
    let level = this.data.level;
    let need = EXP_PER_LEVEL[Math.min(level, EXP_PER_LEVEL.length - 1)] || (level * 60);
    while (exp >= need && level < EXP_PER_LEVEL.length) {
      exp -= need;
      level += 1;
      need = EXP_PER_LEVEL[Math.min(level, EXP_PER_LEVEL.length - 1)] || (level * 60);
      wx.showToast({ title: `🎉 升到 Lv.${level}!`, icon: 'none' });
    }
    this.setData({ exp, level, expNext: need });
    this.computeExpPercent();
  },

  buy(e) {
    const cropName = e.currentTarget.dataset.crop;
    const cfg = CROPS[cropName];
    const emptyIdx = this.data.plots.findIndex(c => !c.crop);
    if (emptyIdx === -1) { wx.showToast({ title: '没有空地了，先收获', icon: 'none' }); return; }
    if (this.data.coins < cfg.cost) { wx.showToast({ title: '学币不足', icon: 'none' }); return; }
    if (this.data.level < cfg.needLevel) { wx.showToast({ title: '等级不足', icon: 'none' }); return; }
    const plots = this.data.plots.slice();
    plots[emptyIdx] = { crop: cropName, plantedAt: Date.now(), state: 'growing' };
    this.setData({ coins: this.data.coins - cfg.cost, plots });
    this.persist();
    wx.showToast({ title: `已种下${cropName}`, icon: 'success' });
  },

  lottery() {
    if (this.data.coins < 3) { wx.showToast({ title: '学币不足', icon: 'none' }); return; }
    const seeds = Object.keys(CROPS);
    const crop = seeds[Math.floor(Math.random() * seeds.length)];
    const emptyIdx = this.data.plots.findIndex(c => !c.crop);
    let coins = this.data.coins - 3;
    let msg;
    if (Math.random() < 0.7 && emptyIdx !== -1) {
      const plots = this.data.plots.slice();
      plots[emptyIdx] = { crop, plantedAt: Date.now(), state: 'growing' };
      this.setData({ plots, coins });
      msg = `🎉 摸到${CROPS[crop].emoji}${crop}种子，已种下!`;
    } else {
      const reward = Math.floor(Math.random() * 5) + 2;
      coins += reward;
      this.setData({ coins });
      msg = `奖励 ${reward}🪙`;
    }
    this.persist();
    wx.showToast({ title: msg, icon: 'none', duration: 2000 });
  },

  help() {
    wx.showModal({
      title: '中南农场玩法',
      content: '🌱 在商店买种子种进农田\n⏱ 等待一段时间作物成熟\n🧺 成熟后收获可卖掉换学币\n⭐ 收获获得经验升级解锁高级作物\n🎲 花3学币可以摸奖',
      showCancel: false
    });
  },

  back() { wx.navigateBack(); }
});
