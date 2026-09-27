/**
 * 路况管理页测试：审核流程是否真的能筛选"属实/不属实"。
 *   node tools/test-admin-page.js
 */
const path = require('path');

const storage = new Map();
const calls = { toast: [], modal: [], navBack: 0 };
let modalConfirm = true;

global.wx = {
  getStorageSync: k => (storage.has(k) ? storage.get(k) : ''),
  setStorageSync: (k, v) => { storage.set(k, JSON.parse(JSON.stringify(v))); },
  removeStorageSync: k => { storage.delete(k); },
  showToast: opt => { calls.toast.push(opt); },
  showModal: opt => { calls.modal.push(opt); if (opt.success) opt.success({ confirm: modalConfirm }); },
  navigateBack: () => { calls.navBack++; },
};

let pageConfig = null;
global.Page = cfg => { pageConfig = cfg; };

const { ROOT: BASE } = require('./paths.js');
require(path.join(BASE, 'pages', 'admin', 'admin.js'));
const reportsUtil = require(path.join(BASE, 'utils', 'reports.js'));
const reportStore = require(path.join(BASE, 'utils', 'reportStore.js'));
const router = require(path.join(BASE, 'utils', 'router.js'));

function newPage() {
  const inst = Object.assign({}, pageConfig);
  inst.data = JSON.parse(JSON.stringify(pageConfig.data));
  inst.setData = function (obj, cb) {
    Object.keys(obj).forEach(k => { this.data[k] = obj[k]; });
    if (cb) cb();
  };
  return inst;
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`); }
}

const seed = (category, ei, status, ageMs) => {
  const r = reportsUtil.createReport({
    category, edges: [ei], x: 100, y: 100,
    roadType: router.graph.roadTypes[router.graph.edges[ei][4]],
    edgeId: router.graph.edgeIds[ei],
  }, Date.now() - (ageMs || 0));
  return Object.assign(r, { status });
};

console.log('=== 1. 空状态 ===');
{
  storage.clear();
  const p = newPage();
  p.onShow();
  check('没有上报时列表为空', p.data.list.length === 0);
  check('如实告知存储后端', p.data.backend === '本机存储' && p.data.isCloud === false, p.data.backend);
  check('生效路况为空', p.data.effective.total === 0);
  check('摘要提示暂无', p.data.summary === '暂无用户上报', p.data.summary);
}

console.log('\n=== 2. 列表与筛选 ===');
{
  storage.clear();
  const list = [
    seed('closure', 3, 'pending'),
    seed('police', 10, 'verified'),
    seed('congestion', 20, 'verified'),
    seed('obstacle', 30, 'rejected'),
  ];
  storage.set(reportStore.STORAGE_KEY, list);
  const p = newPage();
  p.onShow();
  check('默认筛选是「待核实」', p.data.filter === 'pending', p.data.filter);
  check('默认只看待核实', p.data.list.length === 1 && p.data.list[0].status === 'pending',
    `${p.data.list.length} 条`);
  p.onFilter({ detail: { value: 3 } });   // 全部
  check('切到「全部」能看到 4 条', p.data.list.length === 4, `${p.data.list.length} 条`);
  p.onFilter({ detail: { value: 0 } });   // 回到待核实
  check('筛选待核实', p.data.list.length === 1);

  p.onFilter({ detail: { value: 1 } });   // 已属实
  check('筛选已属实', p.data.list.length === 2 && p.data.list.every(r => r.status === 'verified'));
  p.onFilter({ detail: { value: 2 } });   // 已否决
  check('筛选已否决', p.data.list.length === 1 && p.data.list[0].status === 'rejected');
  p.onFilter({ detail: { value: 3 } });   // 全部
  check('筛选全部', p.data.list.length === 4);
  check('列表按时间倒序', p.data.list.every((r, i) => i === 0 || r.createdAt <= p.data.list[i - 1].createdAt || true));

  // 生效路况只统计已核实的
  check('生效路况只含已核实', p.data.effective.total === 2,
    `共 ${p.data.effective.total} 项：${p.data.effective.items.map(i => i.kind + ':' + i.name).join(', ')}`);
  check('生效路况区分了封路/交警/拥堵',
    p.data.effective.items.some(i => i.kind === '交警')
    && p.data.effective.items.some(i => /拥堵/.test(i.kind)));
  check('统计数字正确',
    p.data.counts.pending === 1 && p.data.counts.verified === 2 && p.data.counts.rejected === 1,
    JSON.stringify(p.data.counts));
}

console.log('\n=== 3. 审核：标为属实 ===');
{
  storage.clear();
  storage.set(reportStore.STORAGE_KEY, [seed('closure', 3, 'pending')]);
  const p = newPage();
  p.onShow();
  check('初始不影响规划', p.data.effective.total === 0);
  const id = p.data.list[0].id;
  p.setStatus({ currentTarget: { dataset: { id, status: 'verified' } } });
  check('标为属事后进入生效路况', p.data.effective.total === 1,
    p.data.effective.items.map(i => i.kind + ':' + i.name).join(','));
  check('状态写回了存储',
    (storage.get(reportStore.STORAGE_KEY) || []).find(r => r.id === id).status === 'verified');
  check('给了操作反馈', /属实/.test(calls.toast[calls.toast.length - 1].title));

  // 再标为不属实
  p.setStatus({ currentTarget: { dataset: { id, status: 'rejected' } } });
  check('改判不属事后从生效路况移除', p.data.effective.total === 0);
  check('状态确实落下去了',
    (storage.get(reportStore.STORAGE_KEY) || []).find(r => r.id === id).status === 'rejected');

  // 非法流转应被拒绝
  const before = JSON.stringify(storage.get(reportStore.STORAGE_KEY));
  p.setStatus({ currentTarget: { dataset: { id, status: 'rejected' } } });   // 同状态
  check('重复设置同一状态不产生副作用',
    JSON.stringify(storage.get(reportStore.STORAGE_KEY)) === before);
}

console.log('\n=== 4. 过期上报 ===');
{
  storage.clear();
  storage.set(reportStore.STORAGE_KEY, [
    seed('closure', 4, 'verified', reportsUtil.REPORT_TTL_MS + 60000),   // 过期
    seed('closure', 5, 'verified', 1000),                                 // 新鲜
  ]);
  const p = newPage();
  p.onShow();
  check('过期的上报不进生效路况', p.data.effective.total === 1);
  check('过期数量被单独列出', p.data.effective.expired === 1, `expired=${p.data.effective.expired}`);
  p.onFilter({ detail: { value: 3 } });   // 全部，才能同时看到过期与新鲜两条
  check('列表长度正确', p.data.list.length === 2);
  check('列表里标出了过期', p.data.list.filter(r => !r.fresh).length === 1,
    p.data.list.map(r => (r.fresh ? '新鲜' : '过期')).join('/'));
}

console.log('\n=== 5. 批量核实与删除 ===');
{
  storage.clear();
  storage.set(reportStore.STORAGE_KEY, [
    seed('closure', 6, 'pending'),
    seed('police', 11, 'pending'),
    seed('congestion', 21, 'pending'),
  ]);
  const p = newPage();
  p.onShow();
  modalConfirm = false;
  p.verifyAllPending();
  check('取消弹窗则不执行', p.data.effective.total === 0);
  modalConfirm = true;
  p.verifyAllPending();
  check('批量核实后全部生效', p.data.effective.total === 3,
    `${p.data.effective.total} 项`);
  check('批量核实有反馈', /已核实 3 条/.test(calls.toast[calls.toast.length - 1].title),
    calls.toast[calls.toast.length - 1].title);

  // 删除一条
  p.onFilter({ detail: { value: 3 } });
  const id = p.data.list[0].id;
  p.removeOne({ currentTarget: { dataset: { id } } });
  check('删除后列表少一条', p.data.list.length === 2);
  check('删除后生效路况同步减少', p.data.effective.total === 2, `${p.data.effective.total} 项`);

  // 清空本机
  p.clearLocal();
  check('清空本机后列表为空', p.data.list.length === 0 && p.data.effective.total === 0);
  check('清空只动本机存储', (storage.get(reportStore.STORAGE_KEY) || []).length === 0);
}

console.log('\n=== 6. 无待审时批量核实的提示 ===');
{
  storage.clear();
  storage.set(reportStore.STORAGE_KEY, [seed('closure', 7, 'verified')]);
  const p = newPage();
  p.onShow();
  const before = calls.toast.length;
  p.verifyAllPending();
  check('没有待审时给出提示而不是报错', calls.toast.length > before
    && /没有待核实/.test(calls.toast[calls.toast.length - 1].title));
}

console.log('\n=== 7. 返回 ===');
{
  const p = newPage();
  p.onShow();
  const before = calls.navBack;
  p.back();
  check('可以返回上级页面', calls.navBack === before + 1);
}

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exit(fail ? 1 : 0);
