/**
 * 生成「人群索引」data/people-index.js —— 事件要按"院系 / 年级"选人，靠它。
 *
 * 数据里**没有院系字段**，但班级名里带着信息：
 *   智能2606            -> 专业前缀「智能」  + 26 级 + 06 班
 *   中国语言文学类2601   -> 「中国语言文学类」 + 26 级
 *   口腔医学（5+3）2402  -> 「口腔医学」      + 24 级
 *   土木2505（天佑班）   -> 「土木」          + 25 级
 * 所以"按院系"实际是按**专业 / 大类**选（班级名只到这一级），这一点如实写在文件里。
 *
 * 关键优化：真正要算流量的是"从哪个宿舍出发、有多少人"，所以先聚合到
 * (专业, 年级, 宿舍节点) 再输出。1090 个班 -> 900 多行，宿舍节点只有 35 个，
 * 于是事件在手机上只需要跑 ≤35 次 Dijkstra。
 *
 *   node tools/build-people-index.js
 *   -> miniprogram/miniprogram/data/people-index.js
 */
const fs = require('fs');
const path = require('path');

const { ROOT } = require('./paths.js');
const outPath = path.join(ROOT, 'data', 'people-index.js');
const flow = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'traffic-flow.json'), 'utf8'));
const graph = require(path.join(ROOT, 'data', 'route-graph.js'));

const assign = flow.assignments || {};
const DEFAULT_SIZE = 30;

/**
 * 班级名 -> {prefix, grade}。
 * 先去掉末尾的括号说明与"班"字，再取末尾 4 位数字（前两位年级 + 后两位班号）。
 */
function parseClassName(name) {
  const s = String(name)
    .replace(/[（(][^）)]*[）)]\s*$/, '')   // 土木2505（天佑班）
    .replace(/班\s*$/, '')                 // 麻醉2601班
    .trim();
  const m = /^(.*?)(\d{4})$/.exec(s);
  if (!m) return null;
  const prefix = m[1].replace(/[（(][^）)]*[）)]/g, '').trim();   // 口腔医学（5+3）-> 口腔医学
  const grade = m[2].slice(0, 2);
  if (!prefix || !/^\d{2}$/.test(grade)) return null;
  return { prefix, grade, seq: m[2].slice(2) };
}

const rows = [];               // 临时：每个班一条
const problems = [];
Object.keys(assign).forEach(name => {
  const parsed = parseClassName(name);
  const a = assign[name];
  if (!parsed) { problems.push({ name, reason: '班级名里读不出专业/年级' }); return; }
  if (!a || !a.dorm_node) { problems.push({ name, reason: '原数据里没有宿舍节点' }); return; }
  rows.push({
    cls: name,
    prefix: parsed.prefix,
    grade: parsed.grade,
    dorm: a.dorm_node,          // 路网节点 id（路由要用）
    dormName: a.dorm || '',     // 宿舍名（显示要用）
    size: a.class_size || DEFAULT_SIZE,
  });
});
console.log(`班级 ${Object.keys(assign).length} 个 -> 可索引 ${rows.length} 个；无法解析 ${problems.length} 个`);
if (problems.length) console.log('  例如：' + problems.slice(0, 6).map(p => `${p.name}（${p.reason}）`).join('、'));

// ---- 索引表
const gradeList = [...new Set(rows.map(r => r.grade))].sort();
const prefixStat = new Map();
rows.forEach(r => {
  const s = prefixStat.get(r.prefix) || { name: r.prefix, classes: 0, students: 0 };
  s.classes++; s.students += r.size;
  prefixStat.set(r.prefix, s);
});
const prefixList = [...prefixStat.values()].sort((a, b) => b.students - a.students || a.name.localeCompare(b.name, 'zh'));
const dormList = [...new Set(rows.map(r => r.dorm))].sort();
// 一个路网节点常常被**好几栋宿舍**共用（实测 74 栋宿舍只落在 35 个节点上），
// 所以显示名取"人数最多的那一栋"，并在还有别的楼时标出"等 N 栋"。
const dormNameCount = new Map();   // node -> Map(name -> 班级数)
rows.forEach(r => {
  if (!dormNameCount.has(r.dorm)) dormNameCount.set(r.dorm, new Map());
  const m = dormNameCount.get(r.dorm);
  m.set(r.dormName, (m.get(r.dormName) || 0) + 1);
});
const dormNames = dormList.map(d => {
  const m = dormNameCount.get(d) || new Map();
  const sorted = [...m.entries()].sort((a, b) => b[1] - a[1]);
  if (!sorted.length) return '';
  const main = sorted[0][0];
  return sorted.length > 1 ? `${main} 等 ${m.size} 栋` : main;
});
const sharedNodes = dormList.filter(d => (dormNameCount.get(d) || new Map()).size > 1).length;
console.log(`宿舍节点 ${dormList.length} 个，其中 ${sharedNodes} 个被多栋宿舍共用（显示为"某某 等 N 栋"）`);

const pIdx = new Map(prefixList.map((p, i) => [p.name, i]));
const gIdx = new Map(gradeList.map((g, i) => [g, i]));
const dIdx = new Map(dormList.map((d, i) => [d, i]));

const agg = new Map();
rows.forEach(r => {
  const key = pIdx.get(r.prefix) + '|' + gIdx.get(r.grade) + '|' + dIdx.get(r.dorm);
  const cur = agg.get(key) || [pIdx.get(r.prefix), gIdx.get(r.grade), dIdx.get(r.dorm), 0, 0];
  cur[3] += r.size;
  cur[4] += 1;
  agg.set(key, cur);
});
// 按人数降序，压缩后也更整齐
const compact = [...agg.values()].sort((a, b) => b[3] - a[3]);

const students = rows.reduce((a, r) => a + r.size, 0);
const payload = {
  generatedBy: 'tools/build-people-index.js',
  source: 'traffic-flow.json 的 assignments（班级 -> 宿舍 + 班级人数）',
  note: '数据里没有院系字段：班级名只到「专业 / 大类」一级，所以"按院系"是按专业选。'
    + ' rows 每行是 [专业下标, 年级下标, 宿舍节点下标, 人数, 班级数]，已按人数降序。',
  classes: rows.length,
  students,
  grades: gradeList.map(g => ({
    code: g,
    label: '20' + g + '级',
    classes: rows.filter(r => r.grade === g).length,
    students: rows.filter(r => r.grade === g).reduce((a, r) => a + r.size, 0),
  })),
  prefixes: prefixList,
  // 「学院」只是**勾选时的便利分组**：按专业名前两字粗分（机械/机械类/机械D/机械T -> 机械）。
  // 规则是从数据里算出来的、写在文件里，不是官方院系表；事件里存的始终是精确的专业名。
  groups: (() => {
    const byKey = new Map();
    prefixList.forEach(p => {
      const k = p.name.slice(0, 2);
      if (!byKey.has(k)) byKey.set(k, { key: k, label: k, prefixes: [], students: 0, classes: 0 });
      const g = byKey.get(k);
      g.prefixes.push(p.name);
      g.students += p.students;
      g.classes += p.classes;
    });
    return [...byKey.values()].sort((a, b) => b.students - a.students || a.key.localeCompare(b.key, 'zh'));
  })(),
  dormNodes: dormList,
  // 与 dormNodes 一一对应的宿舍名（仅用于显示）
  dormNames,
  rows: compact,
};

const body = '// 由 tools/build-people-index.js 自动生成，请勿手工编辑。\n'
  + `// ${payload.classes} 个班级 / ${payload.students} 人 -> ${compact.length} 行（专业 × 年级 × 宿舍）\n`
  + `module.exports = ${JSON.stringify(payload)};\n`;
fs.writeFileSync(outPath, body, 'utf8');

console.log(`\n已生成 ${path.relative(process.cwd(), outPath)}  ${(Buffer.byteLength(body) / 1024).toFixed(1)} KB`);
console.log(`年级：${payload.grades.map(g => `${g.label}(${g.students}人/${g.classes}班)`).join(' ')}`);
console.log(`专业/大类 ${prefixList.length} 个，宿舍节点 ${dormList.length} 个，聚合后 ${compact.length} 行`
  + `，勾选用的"学院"粗分 ${payload.groups.length} 个`);
console.log('最大的几个专业：');
prefixList.slice(0, 8).forEach(p => console.log(`  ${p.name}  ${p.students} 人 / ${p.classes} 班`));
console.log('\n示例：机械 + 26 级 涉及哪些宿舍');
const pI = pIdx.get('机械'), gI = gIdx.get('26');
const sel = compact.filter(r => r[0] === pI && r[1] === gI);
console.log(sel.map(r => `${dormList[r[2]]}:${r[3]}人`).join('  '), ` 共 ${sel.reduce((a, r) => a + r[3], 0)} 人`);
