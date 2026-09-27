/**
 * 事件与校历页测试：新增/编辑/删除、谁参加（年级 × 专业）、场馆、预计人数、放假/调休。
 *   node tools/test-event-page.js
 */
const path = require('path');

const storage = new Map();
const calls = { toast: [], navTo: [], navBack: 0 };

global.wx = {
  getStorageSync: k => (storage.has(k) ? storage.get(k) : ''),
  setStorageSync: (k, v) => { storage.set(k, JSON.parse(JSON.stringify(v))); },
  removeStorageSync: k => { storage.delete(k); },
  showToast: opt => { calls.toast.push(opt); },
  navigateTo: opt => { calls.navTo.push(opt.url); },
  navigateBack: () => { calls.navBack++; },
};

let pageConfig = null;
global.Page = cfg => { pageConfig = cfg; };

const { ROOT: BASE } = require('./paths.js');
require(path.join(BASE, 'pages', 'event', 'event.js'));
const eventsUtil = require(path.join(BASE, 'utils', 'events.js'));
const calendar = require(path.join(BASE, 'utils', 'calendar.js'));
const store = require(path.join(BASE, 'utils', 'eventStore.js'));

function newPage() {
  const inst = Object.assign({}, pageConfig);
  inst.data = JSON.parse(JSON.stringify(pageConfig.data));
  inst.setData = function (obj, cb) {
    Object.keys(obj).forEach(k => {
      if (k.indexOf('.') >= 0) {
        const parts = k.split('.');
        let cur = this.data;
        for (let i = 0; i < parts.length - 1; i++) {
          if (cur[parts[i]] === undefined) cur[parts[i]] = {};
          cur = cur[parts[i]];
        }
        cur[parts[parts.length - 1]] = obj[k];
      } else this.data[k] = obj[k];
    });
    if (cb) cb();
  };
  return inst;
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`); }
}

const ev = (over) => ({ currentTarget: { dataset: over } });
const inp = (value) => ({ detail: { value } });

console.log('\n=== 1. 打开：默认空，不编造活动 ===');
{
  storage.clear();
  const p = newPage();
  p.onLoad();
  check('默认落在「事件」页签', p.data.tab === 'events');
  check('默认看今天', p.data.dateISO === calendar.isoOf(new Date()), p.data.dateLabel);
  check('默认没有事件（不编造学校活动）', p.data.list.length === 0 && p.data.totalEvents === 0);
  check('默认没有校历条目', p.data.overrideList.length === 0);
  check('日期口径说明了这天的性质', !!p.data.dayInfo && !!p.data.dayInfo.kindLabel,
    `${p.data.dateLabel} · ${p.data.dayInfo.kindLabel}`);
  check('日期口径带上了模型的边界说明',
    p.data.dayInfo.hasClass ? /正常上课日|调休/.test(p.data.dayInfo.kindLabel) : true,
    p.data.dayInfo.note || p.data.dayInfo.kindLabel);
}

console.log('\n=== 2. 新增事件：谁参加 / 在哪 / 多少人 ===');
{
  const p = newPage();
  p.onLoad();
  p.startNew();
  check('进入编辑态并给了默认表单', p.data.editing === true && !!p.data.form);
  check('默认类型是校运会', p.data.form.type === 'sports' && p.data.typeIndex === 0);
  check('默认场馆是体育场馆类（排在最前）', !!p.data.form.venue && p.data.venueIndex === 0,
    p.data.form.venue);
  check('年级复选框有 4 个', p.data.grades.length === 4, p.data.grades.map(g => g.label).join(' '));
  check('学院粗分有 100 个左右', p.data.groups.length > 50, `${p.data.groups.length} 个`);
  check('初始试算 = 全校人数', p.data.audienceStudents === eventsUtil.peopleIndex.students,
    `${p.data.audienceStudents} 人`);

  p.onTitleInput(inp('测试校运会'));
  check('填名称', p.data.form.title === '测试校运会');

  p.onHeadcountInput(inp('3000'));
  check('填预计人数', p.data.form.headcount === 3000);
  check('提示说明了"按预计人数算"', /按预计 3,000 人算/.test(p.data.headcountHint), p.data.headcountHint);

  // 只选一个年级
  p.toggleGrade(ev({ code: '26' }));
  check('勾选年级后人群变小',
    p.data.form.grades.join() === '26'
    && p.data.audienceStudents < eventsUtil.peopleIndex.students,
    `2026级 ${p.data.audienceStudents} 人`);
  p.toggleGrade(ev({ code: '26' }));
  check('再点一次取消', p.data.form.grades.length === 0);

  // 勾"学院"= 勾中它下面所有专业
  const mech = p.data.groups.find(g => g.key === '机械');
  p.toggleGroup(ev({ key: '机械' }));
  check('勾一个学院 = 选中它下面所有专业',
    p.data.form.departments.length === mech.prefixes.length
    && p.data.groups.find(g => g.key === '机械').checked === true,
    `${p.data.form.departments.length} 个专业`);
  check('人群变成该学院人数', p.data.audienceStudents === mech.students,
    `${p.data.audienceStudents} 人`);

  // 展开后单独勾一个专业 -> 变成部分选中
  p.toggleExpand(ev({ key: '机械' }));
  check('可以展开看具体专业', p.data.groups.find(g => g.key === '机械').expanded === true);
  const one = mech.prefixes[0].name;
  p.togglePrefix(ev({ name: one }));
  const g2 = p.data.groups.find(g => g.key === '机械');
  check('取消一个专业后学院变成"部分选中"', g2.partial === true && g2.checked === false,
    `已选 ${p.data.form.departments.length} 个`);

  // 年级 + 专业 = 交集
  p.toggleGrade(ev({ code: '26' }));
  const bothOk = p.data.form.grades.length === 1 && p.data.form.departments.length === mech.prefixes.length - 1;
  check('年级与专业可以同时用（两个都要）', bothOk,
    `${p.data.audienceStudents} 人 / ${p.data.audienceClasses} 班 / ${p.data.audienceDorms} 栋宿舍`);

  p.clearAudience();
  check('可以一键清空人群（= 全校）', p.data.form.grades.length === 0
    && p.data.form.departments.length === 0
    && p.data.audienceStudents === eventsUtil.peopleIndex.students);

  p.onGroupSearch(inp('机械'));
  check('可以搜索学院/专业', p.data.groupKeyword === '机械');

  p.onVenueChange(inp(0));
  check('换场馆', !!p.data.form.venue && p.data.venueIndex === 0);
  check('场馆提示带上了吸附距离', /离最近路口约 \d+ 米/.test(p.data.venueHint), p.data.venueHint);

  p.onTypeChange(inp(1));
  check('换类型会带上默认时长与提前量',
    p.data.form.type === 'jobfair' && p.data.form.start === '09:00' && p.data.form.leadMin === 20,
    `${p.data.form.start}-${p.data.form.end} 提前 ${p.data.form.leadMin} 分`);
  check('出行时刻跟着变', /入场/.test(p.data.windowsText) && /离场/.test(p.data.windowsText),
    p.data.windowsText);

  p.onTypeChange(inp(0));
  p.saveEvent();
  check('保存成功并退出编辑', p.data.editing === false && p.data.formProblems.length === 0);
  check('列表里出现了这条事件', p.data.list.length === 1 && p.data.list[0].title === '测试校运会',
    p.data.list[0] && p.data.list[0].timeText);
  check('落盘了', store.events().length === 1);
  check('列表条目带上了人数与来源', /3,?000 人/.test(p.data.list[0].peopleText),
    `${p.data.list[0].peopleText}（${p.data.list[0].peopleSource}）`);
  check('列表条目写出了出行时刻', /入场/.test(p.data.list[0].windowText), p.data.list[0].windowText);
}

console.log('\n=== 3. 校验：不合法的不能存 ===');
{
  const p = newPage();
  p.onLoad();
  p.startNew();
  p.patch({ title: '', venue: '', start: '18:00', end: '09:00', headcount: 0, grades: [], departments: [] });
  p.saveEvent();
  check('校验不过时不落盘、留在编辑态', p.data.editing === true && p.data.formProblems.length > 0,
    `${p.data.formProblems.length} 条问题`);
  check('问题里有名称/场馆/时间',
    p.data.formProblems.some(x => /名称/.test(x))
    && p.data.formProblems.some(x => /场馆/.test(x))
    && p.data.formProblems.some(x => /晚于/.test(x)),
    p.data.formProblems.join('；'));
  check('没有偷偷存进去', store.events().length === 1, `${store.events().length} 条`);
  p.cancelEdit();
  check('可以取消编辑', p.data.editing === false && p.data.form === null);
}

console.log('\n=== 4. 编辑与删除 ===');
{
  const p = newPage();
  p.onLoad();
  const id = p.data.list[0].id;
  p.editEvent(ev({ id }));
  check('打开编辑时带上了原值',
    p.data.editing === true && p.data.form.title === '测试校运会' && p.data.form.headcount === 3000,
    p.data.form.title);
  p.onTitleInput(inp('改过的校运会'));
  p.saveEvent();
  check('保存后是更新而不是新增',
    p.data.list.length === 1 && p.data.list[0].title === '改过的校运会' && store.events().length === 1);

  p.removeEvent(ev({ id }));
  check('删除后列表为空', p.data.list.length === 0 && store.events().length === 0);
}

console.log('\n=== 5. 载入示例 / 清空 ===');
{
  const p = newPage();
  p.onLoad();
  p.loadSamples();
  check('载入示例后有三条事件', p.data.totalEvents === 3, p.data.totalEvents + ' 条');
  check('示例覆盖三种典型选人方式', (() => {
    const es = store.events();
    const kinds = es.map(e => `${e.grades.length}|${e.departments.length}`);
    return kinds.indexOf('0|0') >= 0 && kinds.indexOf('1|4') >= 0 && kinds.indexOf('1|0') >= 0;
  })(), store.events().map(e => `${e.title}: 年级${e.grades.length}/专业${e.departments.length}`).join('；'));
  check('示例日期顺延到今天起（否则看不到效果）', p.data.todayISO === store.events()[0].date,
    store.events().map(e => e.date).join(' '));
  check('示例同时给了校历条目', p.data.overrideList.length === 2, p.data.overrideList.length + ' 条');
  check('校历条目有放假也有调休',
    p.data.overrideList.some(o => o.kind === 'holiday') && p.data.overrideList.some(o => o.kind === 'makeup'));

  const dayWithEvent = store.events()[0].date;
  p.onDateChange(inp(dayWithEvent));
  check('按日期筛选能筛出当天事件', p.data.list.length === 1 && p.data.list[0].title.indexOf('校运会') >= 0,
    p.data.list[0] && p.data.list[0].title);

  p.clearAll();
  check('清空本机', store.events().length === 0 && store.dayOverrides().length === 0
    && p.data.totalEvents === 0);
}

console.log('\n=== 6. 校历：放假 / 调休 ===');
{
  const p = newPage();
  p.onLoad();
  p.onTab(ev({ tab: 'calendar' }));
  check('切到校历页签', p.data.tab === 'calendar');
  p.startOverride();
  check('打开新增校历表单', !!p.data.ovForm && p.data.ovForm.kind === 'holiday');
  check('默认按当前所选日期', p.data.ovForm.date === p.data.dateISO);

  p.onOvDate(inp('2026-10-01'));
  p.onOvKind(inp(1));                       // 调休
  check('切成调休', p.data.ovForm.kind === 'makeup');
  check('调休会给出周几的默认值', p.data.ovForm.asWeekday >= 1 && p.data.ovForm.asWeekday <= 5,
    '按周' + p.data.ovForm.asWeekday);
  // 周几被清成非法值时应当拦住
  p.setData({ 'ovForm.asWeekday': 0 });
  p.saveOverride();
  check('调休没写周几时被拦住', p.data.ovProblems.length > 0, p.data.ovProblems.join('；'));
  check('被拦住时不落盘', store.dayOverrides().length === 0);

  p.onOvWeek(inp(3));                       // 周四
  check('选了周几', p.data.ovForm.asWeekday === 4);
  p.onOvNote(inp('国庆调休'));
  p.saveOverride();
  check('保存成功', p.data.ovForm === null && store.dayOverrides().length === 1);
  check('列表里是可读描述', /调休上课（按周四）/.test(p.data.overrideList[0].label),
    p.data.overrideList[0].label);

  // 放假
  p.startOverride();
  p.onOvDate(inp('2026-10-02'));
  p.onOvKind(inp(0));
  p.saveOverride();
  check('放假条目也能存', store.dayOverrides().length === 2);
  check('两条都能在列表看到', p.data.overrideList.length === 2);

  p.removeOverride(ev({ date: '2026-10-02' }));
  check('可以删除校历条目', store.dayOverrides().length === 1);

  // 校历会影响那天的口径
  p.onDateChange(inp('2026-10-01'));
  check('调休那天被标为调休', p.data.dayInfo.kind === 'makeup' && p.data.dayInfo.effectiveWeekday === 4,
    p.data.dayInfo.kindLabel);
  store.clearLocal();
}

console.log('\n=== 7. 页内跳转 ===');
{
  const p = newPage();
  p.onLoad();
  p.goRoute();
  check('能跳去路线页', calls.navTo.indexOf('/pages/route/route') >= 0, calls.navTo.join(' '));
  p.back();
  check('能返回', calls.navBack > 0);
}

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exit(fail ? 1 : 0);
