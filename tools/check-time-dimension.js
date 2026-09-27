// 一次性核算：数据里到底有几个"时间量"，以及我们显示的偏高多少
const { ROOT } = require('./paths.js');
const fs = require('fs');
const path = require('path');
const j = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'data', 'traffic-flow.json'), 'utf8',
));

let T = 0, P = 0;
j.edges.forEach(e => { T += e.semester_person_trips; P += e.peak_slot_person_trips; });

console.log('== 数据里与时间有关的字段 ==');
console.log('  顶级字段:', Object.keys(j).join(', '));
const one = j.edges[0];
console.log('  逐路段字段:', Object.keys(one).join(', '));
console.log('  -> 时间量只有两个：semester_person_trips（学期总量）、peak_slot_person_trips（最高峰时段）');
console.log('');
console.log('== 能推出什么 ==');
console.log('  学期总人次 ΣT =', T.toLocaleString());
console.log('  峰值时段之和 ΣP =', P.toLocaleString());
console.log('  ΣT / ΣP =', (T / P).toFixed(1), '（若各时段均匀，这就是时段总数）');
const rs = j.edges.map(e => e.semester_person_trips / e.peak_slot_person_trips).sort((a, b) => a - b);
console.log('  逐路段 T/P：min=' + rs[0].toFixed(0), '中位=' + rs[Math.floor(rs.length / 2)].toFixed(0),
  'max=' + rs[rs.length - 1].toFixed(0), '（越小说明这条路越"尖峰"）');
console.log('');
console.log('== 峰值是平时段的几倍 ==');
[450, 900, 1080, 1350].forEach(N => {
  console.log(`  若一学期有 ${String(N).padStart(4)} 个换课时段 -> 峰值 / 平时段 = ${(N / (T / P)).toFixed(1)} 倍`);
});
console.log('');
console.log('结论：一直显示"最高峰时段"，平均把拥挤度放大约 4~7 倍；');
console.log('      夜里没有课、实际接近 0，界面却仍显示满值。');
