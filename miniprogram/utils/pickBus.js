/**
 * 点选页 -> 路线页的结果传递。
 *
 * 用模块级暂存而不是 EventChannel：点选页返回后路线页在 onShow 里取走即可，
 * 不依赖 wx.navigateTo 的 events 参数，页面被直接打开（如开发者工具单独编译）时也不会丢逻辑。
 * 取走即清空，保证一次点选只被消费一次。
 */
let pending = null;

function put(value) {
  pending = value;
  return value;
}

function take() {
  const v = pending;
  pending = null;
  return v;
}

function peek() {
  return pending;
}

module.exports = { put, take, peek };
