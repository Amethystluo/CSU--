/**
 * 路线页 <-> 模块二级页 的通信。
 *
 * 两条通道：
 *   snapshot 往下传 —— 路线页把"要显示的数据"（口径、天气、封路、拥堵、结果…）放进来，
 *                      二级页读它渲染。重算逻辑只在路线页一处，二级页不重复实现。
 *   intent   往上传 —— 二级页自己做不了的事（重算、重新规划、联网取天气、开关定位）
 *                      记一条意图，路线页在 onShow 时统一执行。
 *
 * 为什么不用 eventChannel：项目里已有同样形态的 utils/pickBus.js，
 * 保持一种跨页通信写法，也便于用假的 wx 直接测。
 */
let snapshot = {};
let intents = [];

/** 路线页写：整体替换（每次刷新都是最新的一份）。 */
function putSnapshot(key, data) {
  snapshot[key] = data;
}

function getSnapshot(key) {
  return snapshot[key] || null;
}

/** 二级页写：记一条待执行意图。 */
function pushIntent(action, payload) {
  intents.push({ action, payload: payload || null });
}

/** 路线页读：取走全部意图（取走即清空，避免重复执行）。 */
function takeIntents() {
  const out = intents;
  intents = [];
  return out;
}

function peekIntents() {
  return intents.slice();
}

function clear() {
  snapshot = {};
  intents = [];
}

module.exports = {
  putSnapshot,
  getSnapshot,
  pushIntent,
  takeIntents,
  peekIntents,
  clear,
};
