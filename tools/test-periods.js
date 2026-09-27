/**
 * 作息时间表（utils/periods.js）测试。
 *   node tools/test-periods.js
 *
 * 这张表的作用是"把换课时刻翻译成人话"（07:50 → 第1-2节 课前），
 * 所以最要紧的一条是：**它必须和 tools/build-time-profile.js 里的 BLOCKS 一致**。
 * 一旦有人只改了一边，用户就会看到"第5-6节 课前 13:50"这种对不上的说法，
 * 或者更糟——作息表上有个按钮，点了却没数据。这个测试就是防这个的。
 */
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./paths.js');

const periods = require(path.join(ROOT, 'utils', 'periods.js'));
const timeModel = require(path.join(ROOT, 'utils', 'timeModel.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`); }
}

// ---------------------------------------------------------------- 1. 工具函数
console.log('\n=== 1. 时刻解析与格式化 ===');
{
  check('toMinutes 正常解析', periods.toMinutes('08:00') === 480 && periods.toMinutes('21:05') === 1265);
  check('toMinutes 认不出来就返回 null', periods.toMinutes('八点') === null && periods.toMinutes('') === null);
  check('fmt 补齐两位', periods.fmt(470) === '07:50' && periods.fmt(1240) === '20:40');
  check('fmt 跨天取模不越界', periods.fmt(24 * 60 + 5) === '00:05');
  check('课前提前量是 10 分钟', periods.LEAD_MIN === 10, `LEAD_MIN=${periods.LEAD_MIN}`);
  check('千分位（WXML 里没法调 toLocaleString）',
    periods.groupNum(218212) === '218,212' && periods.groupNum(0) === '0' && periods.groupNum(999) === '999',
    `${periods.groupNum(218212)} / ${periods.groupNum(999)}`);
}

// ------------------------------------------------- 2. PERIODS <-> BLOCKS 一致性
console.log('\n=== 2. 与构建脚本 BLOCKS 一致（改一边必须改另一边）===');
{
  const src = fs.readFileSync(path.join(ROOT, '..', 'tools', 'build-time-profile.js'), 'utf8');
  const m = /const BLOCKS = (\[[\s\S]*?\n\]);/.exec(src);
  check('能读到构建脚本里的 BLOCKS', !!m);
  if (!m) {
    console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
    process.exit(1);
  }
  const BLOCKS = new Function(`return ${m[1]}`)();

  check('节次数一样', BLOCKS.length === periods.PERIODS.length,
    `BLOCKS ${BLOCKS.length} vs PERIODS ${periods.PERIODS.length}`);

  const norm = b => [b.key, b.start, b.end, !!b.assumed].join('|');
  const a = BLOCKS.map(norm).join(',');
  const b = periods.PERIODS.map(norm).join(',');
  check('每段的 key / 上下课时刻 / assumed 完全一致', a === b, a === b ? '' : `\n      BLOCKS : ${a}\n      PERIODS: ${b}`);

  const lead = /const arriveMin = cur\.startMin - (\d+)/.exec(src);
  check('课前提前量与构建脚本里的 10 分钟一致',
    !!lead && Number(lead[1]) === periods.LEAD_MIN,
    lead ? `脚本 ${lead[1]} / periods ${periods.LEAD_MIN}` : '脚本里没找到 arriveMin');

  const cn = periods.PERIODS.map(p => p.name).join(' ');
  check('节次名字是「第N-M节」这种说法', /第1-2节/.test(cn) && /第11-12节/.test(cn), cn);
}

// ------------------------------------------------- 3. 换课时刻 -> 人话
console.log('\n=== 3. 换课时刻翻译成人话 ===');
{
  const d = periods.describe(470);
  check('07:50 认得出是第1-2节 课前', !!d && d.phase === '课前' && d.name === '第1-2节', d && d.text);
  const d2 = periods.describe(580);
  check('09:40 认得出是第1-2节 课后', !!d2 && d2.phase === '课后' && d2.name === '第1-2节', d2 && d2.text);
  check('labelOf 出人话标签', periods.labelOf(470) === '第1-2节 课前', periods.labelOf(470));
  check('labelOf 课后也对', periods.labelOf(1240) === '第9-10节 课后', periods.labelOf(1240));
  check('认不出的时刻不瞎编，退回时刻本身',
    periods.labelOf(1234) === '20:34 换课', periods.labelOf(1234));
  check('非法输入不崩', periods.describe('abc') === null && periods.labelOf(NaN) === 'NaN:NaN 换课');
}

// ------------------------------------------------- 4. 与真实画像对齐
console.log('\n=== 4. 画像里每个换课时刻都翻译得出来 ===');
{
  check('时段画像可用（否则这个测试没意义）', timeModel.available(), timeModel.source());
  const win = timeModel.windows();
  check('画像里有换课时段', win.length > 0, `${win.length} 个`);

  const unknown = win.filter(w => !periods.describe(w.minutes));
  check('每个窗口时刻都能对上某一节（没有孤儿窗口）', unknown.length === 0,
    unknown.slice(0, 4).map(w => `${w.key}=${w.time}`).join(' '));

  const marks = periods.PERIODS.reduce((acc, p) => {
    const mm = periods.marksOf(p);
    if (mm.before != null) acc[mm.before] = 1;
    if (mm.after != null) acc[mm.after] = 1;
    return acc;
  }, {});
  const outside = win.filter(w => !marks[w.minutes]);
  check('每个窗口时刻都落在某节课的课前/课后点上', outside.length === 0,
    outside.slice(0, 4).map(w => w.time).join(' '));
}

// ------------------------------------------------- 5. 作息表 tableFor
console.log('\n=== 5. 一天一张作息表 ===');
{
  const wd1 = timeModel.windowsFor(1);
  const t = periods.tableFor(1, wd1);
  check('一行一节，节数与 PERIODS 相同', t.length === periods.PERIODS.length, `${t.length} 行`);
  check('每行都带星期和上下课时刻',
    t.every(r => r.weekday === 1 && /^\d{2}:\d{2}$/.test(r.start) && /^\d{2}:\d{2}$/.test(r.end)));
  check('第1-2节：课前 07:50 / 课后 09:40 都选得到',
    !!t[0].before && t[0].before.time === '07:50' && !!t[0].after && t[0].after.time === '09:40',
    `${t[0].before && t[0].before.time} / ${t[0].after && t[0].after.time}`);
  check('可选按钮带得上窗口 key（点了才有数据）',
    t[0].before.key === 'd1w0470' && t[0].after.key === 'd1w0580',
    `${t[0].before.key} ${t[0].after.key}`);
  check('按钮带得上该时段人次', t[0].before.total > 0, String(t[0].before.total));
  check('人次已经格式化好，能直接显示', /^[\d,]+$/.test(t[0].before.totalText)
    && t[0].before.totalText === periods.groupNum(t[0].before.total),
    `${t[0].before.totalText} 人次`);

  const last = t[t.length - 1];
  check('第11-12节如实标记为 assumed', last.assumed === true && last.key === 'p11');
  check('画像里没有 21:00 的窗口，所以第11-12节没有可选项（不编数据）',
    last.before === null && last.after === null && last.hasClass === false,
    `${last.before} / ${last.after}`);

  check('有课的节次 hasClass 为真', t[0].hasClass === true);

  const picks = periods.countPicks(t);
  check('可选项个数 = 该天窗口个数（不重不漏）', picks === wd1.length, `picks ${picks} / windows ${wd1.length}`);
}

// ------------------------------------------------- 6. 没课的一天
console.log('\n=== 6. 没课的日子（周末 / 放假）===');
{
  const empty = periods.tableFor(6, []);
  check('还是列出整张作息表（让人看见"这天没课"）', empty.length === periods.PERIODS.length);
  check('但每一节都没有可选项', empty.every(r => r.hasClass === false && r.before === null && r.after === null));
  check('可选项个数是 0', periods.countPicks(empty) === 0);
  check('传空数组 / undefined 都不崩',
    periods.countPicks([]) === 0 && periods.countPicks(null) === 0 && periods.tableFor(3, null).length === periods.PERIODS.length);

  const wd2 = timeModel.windowsFor(2);
  const t2 = periods.tableFor(2, wd2);
  check('周二这张表也自洽', periods.countPicks(t2) === wd2.length, `${periods.countPicks(t2)} / ${wd2.length}`);
}

// ------------------------------------------------- 7. 每个上课日都不缺胳膊少腿
console.log('\n=== 7. 周一到周五都能翻译 ===');
{
  const days = timeModel.days();
  check('画像覆盖了工作日', days.length >= 5, `周${days.map(d => timeModel.WEEKDAY_CN[d]).join('、')}`);
  let bad = [];
  days.forEach(d => {
    const rows = periods.tableFor(d, timeModel.windowsFor(d));
    if (periods.countPicks(rows) !== timeModel.windowsFor(d).length) bad.push(`周${timeModel.WEEKDAY_CN[d]}`);
    rows.forEach(r => {
      [r.before, r.after].forEach(x => {
        if (x && !periods.describe(x.minutes)) bad.push(`${r.name} ${x.time}`);
      });
    });
  });
  check('每天都自洽、每个可选项都翻译得出来', bad.length === 0, bad.join(' '));
}

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exit(fail ? 1 : 0);
