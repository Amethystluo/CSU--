/**
 * 上报记录的存储与同步。
 *
 * 这是本项目唯一需要"后端"的地方，因此做成**可插拔适配器**：
 *
 *   local（默认，开箱可用）
 *     写在本机 wx.storage 里。单机演示、离线演示都能用，
 *     但**只有这台设备自己看得见**，不构成"同步给其他用户"。
 *
 *   cloud（需要你开通微信云开发）
 *     用 wx.cloud 的数据库集合 reports，所有用户共享同一份数据，
 *     这才真正实现"其他用户也能看到"。开通步骤见 项目说明.md 第 7.7 节。
 *     未开通时 cloudAvailable() 返回 false，会自动退回 local，功能不受影响。
 *
 * 对外接口对两种适配器完全一致，页面不需要知道用的是哪个。
 */
const reports = require('./reports.js');

const STORAGE_KEY = 'traffic_reports_v1';
const COLLECTION = 'reports';
const CLOUD_ENV = '';          // 开通云开发后把环境 ID 填在这里，例如 'csu-traffic-1a2b3c'
const FETCH_LIMIT = 200;

/** 云开发是否可用（未配置环境 ID 时一律当作不可用）。 */
function cloudAvailable() {
  return !!CLOUD_ENV
    && typeof wx !== 'undefined'
    && wx.cloud
    && typeof wx.cloud.database === 'function';
}

let cloudInited = false;
function db() {
  if (!cloudAvailable()) return null;
  if (!cloudInited) {
    wx.cloud.init({ env: CLOUD_ENV, traceUser: true });
    cloudInited = true;
  }
  return wx.cloud.database();
}

// ---------------------------------------------------------------- 本地存储
function readLocal() {
  try {
    const v = wx.getStorageSync(STORAGE_KEY);
    return Array.isArray(v) ? v : [];
  } catch (e) {
    return [];
  }
}

function writeLocal(list) {
  try {
    wx.setStorageSync(STORAGE_KEY, list);
  } catch (e) {
    // 存储满了就算了，不影响本次会话内的使用
  }
}

/** 按 id 合并两份列表；同 id 取 updatedAt 较新的那条。 */
function mergeById(a, b) {
  const map = new Map();
  for (const r of a.concat(b)) {
    if (!r || !r.id) continue;
    const prev = map.get(r.id);
    if (!prev || (r.updatedAt || 0) >= (prev.updatedAt || 0)) map.set(r.id, r);
  }
  return Array.from(map.values()).sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0));
}

// ---------------------------------------------------------------- 对外接口
/**
 * 读取全部上报（本地 + 云端合并）。
 * @param {function} cb cb(list, meta)  meta = {cloud:boolean, error:string}
 */
function load(cb) {
  const local = readLocal();
  if (!cloudAvailable()) {
    cb(local, { cloud: false, error: '' });
    return;
  }
  db().collection(COLLECTION)
    .orderBy('createdAt', 'desc')
    .limit(FETCH_LIMIT)
    .get()
    .then(res => {
      const remote = (res.data || []).map(r => Object.assign({}, r, { source: 'cloud' }));
      const merged = mergeById(local, remote);
      writeLocal(merged);
      cb(merged, { cloud: true, error: '' });
    })
    .catch(err => {
      // 云端读失败不能影响功能，退回本地
      cb(local, { cloud: false, error: (err && err.errMsg) || '云端读取失败' });
    });
}

/** 新增一条上报。 */
function add(report, cb) {
  const list = mergeById(readLocal(), [report]);
  writeLocal(list);
  if (cloudAvailable()) {
    const data = Object.assign({}, report);
    delete data._id;
    db().collection(COLLECTION).add({ data })
      .then(res => { if (cb) cb(true, res); })
      .catch(err => { if (cb) cb(false, err); });
  } else if (cb) {
    cb(true, null);
  }
  return list;
}

/** 更新一条上报（主要用于审核改状态）。 */
function update(id, patch, cb) {
  const list = readLocal().map(r => (r.id === id
    ? Object.assign({}, r, patch, { updatedAt: Date.now() })
    : r));
  writeLocal(list);
  if (cloudAvailable()) {
    db().collection(COLLECTION).where({ id }).update({ data: Object.assign({}, patch, { updatedAt: Date.now() }) })
      .then(res => { if (cb) cb(true, res); })
      .catch(err => { if (cb) cb(false, err); });
  } else if (cb) {
    cb(true, null);
  }
  return list;
}

/** 删除一条上报。 */
function remove(id, cb) {
  const list = readLocal().filter(r => r.id !== id);
  writeLocal(list);
  if (cloudAvailable()) {
    db().collection(COLLECTION).where({ id }).remove()
      .then(res => { if (cb) cb(true, res); })
      .catch(err => { if (cb) cb(false, err); });
  } else if (cb) {
    cb(true, null);
  }
  return list;
}

/** 清空本机记录（云端不动，避免误删别人的上报）。 */
function clearLocal() {
  writeLocal([]);
  return [];
}

/** 当前存储后端，用于在界面上如实告知用户。 */
function backendName() {
  return cloudAvailable() ? '云端同步' : '本机存储';
}

module.exports = {
  STORAGE_KEY,
  COLLECTION,
  CLOUD_ENV,
  cloudAvailable,
  backendName,
  load,
  add,
  update,
  remove,
  clearLocal,
  mergeById,
  createReport: reports.createReport,
};
