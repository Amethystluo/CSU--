/**
 * 封路结果在两页之间共用。
 *
 * 为什么单独一个模块：点选页回传的封路结果**路线页和模块二级页都要处理** ——
 * 谁在前台谁先接住。原来只有路线页在 `onShow` 里收，
 * 于是「路线页 → 模块页 → 点选页」这条路径上封完路回到模块页时：
 *   - 模块页的封路清单还是空的；
 *   - `session.closedList` 没更新，**再进点选页时那条路还是"没封"的样子**
 *     （画着正常的热度色，占用率低的时候正好是黄色）—— 看起来就像"封路没生效、热度图没重算"。
 *
 * 所以把"一条点选结果 -> closedList 里的一项"这段纯逻辑抽到这里，
 * 两个页面用同一份，避免各写一遍之后行为分叉。
 */

/** 道路类型的显示名（点选结果里带的是英文 key）。两份页面原来各写一份，现在共用这一份。 */
const ROAD_TYPE_CN = {
  primary: '城市主干道', secondary: '次干道', tertiary: '支路',
  residential: '生活区道路', unclassified: '一般道路', service: '内部通道',
  track: '小路', path: '小径', footway: '人行道',
};

/** 一个边下标是否合法（点选页回传、上报聚合都可能给出各种类型）。 */
function isValidIndex(ei) {
  // 空值要单独挡掉：Number(null) 与 Number('') 都是 0，会把"没有下标"当成 0 号路段
  if (ei === null || ei === undefined || ei === '' || typeof ei === 'boolean') return false;
  const n = Number(ei);
  return isFinite(n) && n >= 0 && Math.floor(n) === n;
}

/**
 * 点选页回传的封路结果 -> `closedList` 里的一项。
 * @returns {object|null} 数据不完整时返回 null（调用方据此提示，而不是塞一条坏数据进去）
 */
function itemFromPick(r) {
  if (!r || r.action !== 'close') return null;
  if (!isValidIndex(r.edgeIndex)) return null;
  const typeCn = ROAD_TYPE_CN[r.roadType] || r.roadType || '道路';
  const peak = Math.round(Number(r.peak) || 0);
  const length = Math.round(Number(r.length) || 0);
  return {
    ei: Number(r.edgeIndex),
    id: r.edgeId || '',
    roadType: typeCn,
    peak,
    length,
    label: `${typeCn} · 峰值 ${peak} 人/时段 · ${length}m`,
  };
}

/** 这条路是不是已经在封路清单里了。 */
function has(list, ei) {
  const n = Number(ei);
  return (list || []).some(c => Number(c.ei) === n);
}

/**
 * 追加一条封路。
 * @returns {{list:Array, added:boolean}} added=false 表示这条路已经封过了（清单原样返回）
 */
function add(list, item) {
  const cur = list || [];
  if (!item || !isValidIndex(item.ei)) return { list: cur, added: false };
  if (has(cur, item.ei)) return { list: cur, added: false };
  return { list: cur.concat([item]), added: true };
}

/** 解开一条封路。 */
function remove(list, ei) {
  const n = Number(ei);
  return (list || []).filter(c => Number(c.ei) !== n);
}

module.exports = {
  ROAD_TYPE_CN,
  isValidIndex,
  itemFromPick,
  has,
  add,
  remove,
};
