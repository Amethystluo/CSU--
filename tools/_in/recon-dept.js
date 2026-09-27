// 看看 137 个专业前缀能不能再粗分成「学院」一级
const P = require('../..' + '/miniprogram/miniprogram/data/people-index.js');
const g = new Map();
P.prefixes.forEach(p => {
  const k = p.name.slice(0, 2);
  if (!g.has(k)) g.set(k, []);
  g.get(k).push(p);
});
console.log('前两字分组数 =', g.size, '（专业前缀', P.prefixes.length, '个）');
const list = [...g.entries()].sort((a, b) => b[1].reduce((x, y) => x + y.students, 0) - a[1].reduce((x, y) => x + y.students, 0));
list.forEach(([k, ps]) => {
  const tot = ps.reduce((a, b) => a + b.students, 0);
  console.log(`${k}  ${String(tot).padStart(5)}人  ${ps.length}个: ${ps.map(p => p.name === k ? p.name : p.name + '(' + p.students + ')').join(' ')}`);
});
console.log('\n各年级 × 专业组合数 =', new Set(P.rows.map(r => r[0] + '|' + r[1])).size);
const byGrade = {};
P.rows.forEach(r => { byGrade[P.grades[r[1]].label] = (byGrade[P.grades[r[1]].label] || 0) + r[3]; });
console.log('各年级人数 =', JSON.stringify(byGrade));
// 找几个事件的典型规模
const pick = (names, grades) => {
  const pi = new Set(names.map(n => P.prefixes.findIndex(p => p.name === n)).filter(i => i >= 0));
  const gi = new Set(grades.map(gr => P.grades.findIndex(x => x.code === gr)).filter(i => i >= 0));
  let s = 0, cls = 0, dorms = new Set();
  P.rows.forEach(r => {
    if (pi.size && !pi.has(r[0])) return;
    if (gi.size && !gi.has(r[1])) return;
    s += r[3]; cls += r[4]; dorms.add(P.dormNodes[r[2]]);
  });
  return { students: s, classes: cls, dorms: dorms.size };
};
console.log('\n典型选择：');
console.log('  全校 =', JSON.stringify(pick([], [])));
console.log('  2026级 =', JSON.stringify(pick([], ['26'])));
console.log('  计算机 + 软件工程（全年级） =', JSON.stringify(pick(['计算机', '软件工程'], [])));
console.log('  计算机 2024+2025级 =', JSON.stringify(pick(['计算机'], ['24', '25'])));
