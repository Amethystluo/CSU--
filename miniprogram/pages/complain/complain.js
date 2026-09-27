// 吐槽数据存储键
const STORAGE_KEY = 'csu_complaints';

// 获取所有吐槽（本地存储 + 内置示例）
function getComplaints() {
  try {
    const stored = wx.getStorageSync(STORAGE_KEY);
    if (Array.isArray(stored) && stored.length > 0) return stored;
  } catch (e) { /* 忽略 */ }
  // 首次使用时写入示例数据
  const samples = [
    { id: Date.now() + 1, content: '新校区到南校区这段路早晚高峰真的堵哭了，能不能多开几个门啊 😭', time: '2025-09-20 08:15', likes: 12, liked: false },
    { id: Date.now() + 2, content: '潇湘校区A座门口的共享单车堆成山了，走路都要绕道🤯', time: '2025-09-21 12:30', likes: 8, liked: false },
    { id: Date.now() + 3, content: '建议学校在上下课高峰期开通校内摆渡车，腿都要走断了🥲', time: '2025-09-22 18:20', likes: 15, liked: false }
  ];
  wx.setStorageSync(STORAGE_KEY, samples);
  return samples;
}

function saveComplaints(list) {
  wx.setStorageSync(STORAGE_KEY, list);
}

Page({
  data: {
    complaints: [],
    inputText: '',
    submitting: false,
    sortMode: 'newest' // newest / hottest
  },

  onShow() {
    this.loadData();
  },

  loadData() {
    const list = getComplaints();
    this.setData({ complaints: this.sortList(list, this.data.sortMode) });
  },

  sortList(list, mode) {
    const copy = [...list];
    if (mode === 'hottest') {
      copy.sort((a, b) => b.likes - a.likes);
    } else {
      copy.sort((a, b) => b.id - a.id);
    }
    return copy;
  },

  onInput(event) {
    this.setData({ inputText: event.detail.value });
  },

  submit() {
    const content = (this.data.inputText || '').trim();
    if (!content) {
      wx.showToast({ title: '写点内容再发吧', icon: 'none' });
      return;
    }
    if (content.length > 200) {
      wx.showToast({ title: '吐槽不能超过200字', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const time = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const newItem = {
      id: Date.now(),
      content,
      time,
      likes: 0,
      liked: false
    };
    const list = getComplaints();
    list.unshift(newItem);
    saveComplaints(list);
    this.setData({
      complaints: this.sortList(list, this.data.sortMode),
      inputText: '',
      submitting: false
    });
    wx.showToast({ title: '吐槽已发送', icon: 'success' });
  },

  toggleLike(event) {
    const id = event.currentTarget.dataset.id;
    const list = getComplaints();
    const item = list.find(i => i.id === id);
    if (!item) return;
    if (item.liked) {
      item.likes = Math.max(0, item.likes - 1);
    } else {
      item.likes += 1;
    }
    item.liked = !item.liked;
    saveComplaints(list);
    this.setData({ complaints: this.sortList(list, this.data.sortMode) });
  },

  switchSort() {
    const mode = this.data.sortMode === 'newest' ? 'hottest' : 'newest';
    this.setData({
      sortMode: mode,
      complaints: this.sortList(this.data.complaints, mode)
    });
  },

  deleteComplaint(event) {
    const id = event.currentTarget.dataset.id;
    wx.showModal({
      title: '确认删除',
      content: '确定要删除这条吐槽吗？',
      success: res => {
        if (res.confirm) {
          const list = getComplaints().filter(i => i.id !== id);
          saveComplaints(list);
          this.setData({ complaints: this.sortList(list, this.data.sortMode) });
          wx.showToast({ title: '已删除', icon: 'success' });
        }
      }
    });
  },

  copyContent(event) {
    const content = event.currentTarget.dataset.content;
    wx.setClipboardData({ data: content });
  },

  back() { wx.navigateBack(); }
});
