/**
 * 侦察：能不能从现有数据里真的按「院系 / 年级」选出人？
 *   node tools/_in/recon-events.js
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', 'miniprogram', 'miniprogram');
const flow = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'traffic-flow.json'), 'utf8'));
const graph = require(path.join(ROOT, 'data', 'route-graph.js'));

const assign = flow.assignments || {};
const names = Object.keys(assign);
console.log('assignments 班级数 =', names.length);

// 班级名 -> 年级 + 专业前缀
// 例：智能2606 / 中国语言文学类2601 / 口腔医学（5+3）2402 / 自动化与电气类2618
const RE = /^(.*?)[（(]?[^0-9]*?(\d{2})(\d{2})$/;
function parseClass(n) {
  const m = /^(.*?)(\d{4})$/.exec(n);
  if (!m) return null;
  return { prefix: m[1].replace(/[（(].*$/, '').trim(), year: m[2].slice(0, 2), seq: m[2].slice(2) };
}
const parsed = names.map(n => ({ n, ...(parseClass(n) || { prefix: null, year: null, seq: null }) }));
const bad = parsed.filter(p => !p.prefix || !p.year);
console.log('解析失败的班级 =', bad.length, bad.slice(0, 8).map(b => b.n).join(' | '));

const years = {};
const prefixes = {};
parsed.forEach(p => {
  if (p.year) years[p.year] = (years[p.year] || 0) + 1;
  if (p.prefix) prefixes[p.prefix] = (prefixes[p.prefix] || 0) + 1;
});
console.log('\n年级分布（前两位数字）:');
Object.keys(years).sort().forEach(y => console.log(`  ${y} 级  ${String(years[y]).padStart(4)} 个班`));
console.log('\n专业前缀数 =', Object.keys(prefixes).length);
console.log('前缀示例:', Object.keys(prefixes).slice(0, 24).join(' | '));
const big = Object.entries(prefixes).sort((a, b) => b[1] - a[1]).slice(0, 14);
console.log('最大的前缀:'); big.forEach(([k, v]) => console.log(`  ${k}  ${v}`));

// 聚合到 (前缀, 年级, 宿舍节点) 之后的规模 —— 运行时只需要这么多行
const triple = {};
parsed.forEach(p => {
  if (!p.prefix || !p.year) return;
  const a = assign[p.n];
  if (!a || !a.dorm_node) return;
  const k = p.prefix + '|' + p.year + '|' + a.dorm_node;
  triple[k] = (triple[k] || 0) + (a.class_size || 30);
});
console.log('\n(专业前缀, 年级, 宿舍节点) 组合数 =', Object.keys(triple).length);
const dorms = new Set(Object.values(assign).map(a => a.dorm_node));
console.log('不同宿舍节点数 =', dorms.size);
const prefixYear = new Set(parsed.filter(p => p.prefix && p.year).map(p => p.prefix + '|' + p.year));
console.log('(专业前缀, 年级) 组合数 =', prefixYear.size);
const totalStudents = Object.values(assign).reduce((a, b) => a + (b.class_size || 30), 0);
console.log('学生总数（按班级人数求和）=', totalStudents);

// 估算每行的字节数
const sample = Object.entries(triple).slice(0, 3);
console.log('\n样例三元组:', JSON.stringify(sample));
const est = Object.entries(triple).reduce((a, [k, v]) => a + k.length + String(v).length + 8, 0);
console.log('紧凑数组估算体积 ≈', Math.round(est / 1024), 'KB');

// 场馆：现有地点里有没有体育场之类
console.log('\n=== 现有 58 个地点 ===');
const kinds = {};
graph.places.forEach(p => { kinds[p.k] = (kinds[p.k] || 0) + 1; });
console.log('类别:', JSON.stringify(kinds));
const teach = graph.places.filter(p => p.k !== '宿舍');
console.log('非宿舍地点:', teach.map(p => `${p.n}(${p.i})`).join(' | '));
console.log('\n=== flow.locations 14 个建筑 ===');
console.log(Object.keys(flow.locations).join(' | '));
console.log('\n=== traffic-flow 里有没有体育场/体育馆 ===');
const txt = fs.readFileSync(path.join(ROOT, 'data', 'traffic-flow.json'), 'utf8');
['体育场', '体育馆', '田径', '球场', '礼堂', '活动中心', '游泳'].forEach(k => {
  const c = txt.split(k).length - 1;
  console.log(`  ${k}: ${c} 次`);
});
