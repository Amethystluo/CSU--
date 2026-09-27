// 临时：看每个星期的课表分布差异（决定"选某一天"有没有意义）
const fs = require('fs');
const p = require('path');
const text = fs.readFileSync(p.join(__dirname, 'timetable-cells.csv'), 'utf8').replace(/^\uFEFF/, '');
const lines = text.split(/\r?\n/).filter(x => x.trim()).slice(1);
const split = l => {
  const o = []; let c = ''; let q = false;
  for (let i = 0; i < l.length; i++) {
    const ch = l[i];
    if (ch === '"') { if (q && l[i + 1] === '"') { c += '"'; i++; } else q = !q; }
    else if (ch === ',' && !q) { o.push(c); c = ''; } else c += ch;
  }
  o.push(c); return o;
};
const RE = /(\d+)\s*人\s*([0-9,\-\u2013\u2014]+)\s*(单周|双周)?\s*周?\s*\/?\s*(\d{1,2})\s*(?:-\s*(\d{1,2}))?\s*节/g;
const byDay = {}, byDayPeriod = {}, peopleDay = {};
for (const l of lines) {
  const c = split(l);
  const d = Number(c[2]); const per = c[3]; const cell = c[4];
  byDay[d] = (byDay[d] || 0) + 1;
  byDayPeriod[d + ':' + per] = (byDayPeriod[d + ':' + per] || 0) + 1;
  RE.lastIndex = 0; let m;
  while ((m = RE.exec(cell))) peopleDay[d] = (peopleDay[d] || 0) + Number(m[1]);
}
const CN = '一二三四五';
console.log('格子数 / 课次人数（含重复计数，只看相对多少）');
for (let d = 1; d <= 5; d++) {
  console.log('  周' + CN[d - 1], String(byDay[d]).padStart(5), String(peopleDay[d]).padStart(8));
}
console.log('\n各节次的格子数：');
console.log('        周一   周二   周三   周四   周五');
for (const per of ['1-2', '3-4', '5-6', '7-8', '9-10', '11-12']) {
  const row = [1, 2, 3, 4, 5].map(d => String(byDayPeriod[d + ':' + per] || 0).padStart(5));
  console.log('  ' + per.padEnd(6), row.join(' '));
}
