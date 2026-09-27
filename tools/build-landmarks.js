/**
 * 生成「地标索引」data/landmarks.js —— 事件场馆、地点命名都用它。
 *
 * 背景：底图 assets/campus-map.svg 里有 122 个文字标注（体育场"鸟巢"、南校礼堂、
 * 计算机学院、各栋宿舍…），而且它们的 x/y 与路网是**同一套坐标**（都来自那次投影拟合）。
 * 所以每个标注都能直接吸附到最近的路网节点，变成一个可路由的目的地。
 *
 * 用途：
 *   1. 事件的"在哪"（校运会 -> 新校体育场"鸟巢"西门；双选会 -> 南校礼堂）
 *   2. 给任意坐标起名时多一层地标（见 utils/router.js 的 describeLonLat）
 *
 *   node tools/build-landmarks.js
 *   -> miniprogram/miniprogram/data/landmarks.js
 */
const fs = require('fs');
const path = require('path');

const { ROOT } = require('./paths.js');
const graphPath = path.join(ROOT, 'data', 'route-graph.js');
const svgPath = path.join(ROOT, 'assets', 'campus-map.svg');
const outPath = path.join(ROOT, 'data', 'landmarks.js');

const graph = require(graphPath);
const S = graph.proj[0];                     // 1 米 = S 像素

/** 名称 -> 类别。顺序重要：先匹配更具体的。 */
const KIND_RULES = [
  [/体育场|体育馆|球场|羽球|篮球馆|游泳/, '体育场馆'],
  [/礼堂|报告厅|音乐厅|活动中心/, '礼堂会场'],
  [/食堂|餐厅|超市|服务部/, '生活服务'],
  [/公寓|宿舍|舍|^\d+栋|栋$/, '宿舍'],
  [/学院|教学楼|实验楼|研究院|研究中心|图书馆|楼$/, '教学科研'],
  [/门$|大门|停靠站|车站/, '出入口'],
];

/** 底图里的"地图家具"（指北针、比例尺、片区名）不是地点，不要收进来。 */
const MAP_FURNITURE = [
  /^[↑↓←→\s]*[北南东西]$/,          // 指北针
  /^\d+\s*米$/,                       // 比例尺
  /^[^·]+ · [^·]+校区$/,              // 片区名（新校区 · 潇湘校区）
];

function kindOf(name) {
  for (const [re, k] of KIND_RULES) if (re.test(name)) return k;
  return '其他';
}

/** 去掉标注里用于定位的方位后缀，保留可读全名。 */
function cleanName(raw) {
  return String(raw)
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------- 1. 底图标注
const svg = fs.readFileSync(svgPath, 'utf8');
const items = [];
const seen = new Map();
const re = /<text[^>]*\bx="([-\d.]+)"[^>]*\by="([-\d.]+)"[^>]*>([^<]{1,60})<\/text>/g;
let m;
while ((m = re.exec(svg))) {
  const x = Number(m[1]);
  const y = Number(m[2]);
  const name = cleanName(m[3]);
  if (!name || seen.has(name)) continue;
  if (MAP_FURNITURE.some(re => re.test(name))) continue;
  seen.set(name, true);
  items.push({ n: name, x, y, src: 'svg' });
}
console.log(`底图标注：${items.length} 个`);

// ---------------------------------------------------------------- 2. 已有常用地点（更权威）
const placeNames = new Set();
for (const p of graph.places) {
  const name = cleanName(p.n);
  if (seen.has(name)) { placeNames.add(name); continue; }
  seen.set(name, true);
  items.push({ n: name, x: graph.px[p.i], y: graph.py[p.i], src: 'place' });
  placeNames.add(name);
}
console.log(`常用地点补充：${items.length - items.filter(i => i.src === 'svg').length} 个（含重名合并）`);

// ---------------------------------------------------------------- 3. 吸附到路网节点
function nearestNode(x, y) {
  const px = graph.px, py = graph.py;
  let best = 0, bd = Infinity;
  for (let i = 0; i < px.length; i++) {
    const dx = px[i] - x, dy = py[i] - y;
    const d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = i; }
  }
  return { index: best, meters: Math.round(Math.sqrt(bd) / S) };
}

const out = items.map(it => {
  const hit = nearestNode(it.x, it.y);
  return {
    n: it.n,
    k: kindOf(it.n),
    i: hit.index,
    s: hit.meters,                    // 标注位置到最近路口的距离
    x: Math.round(it.x * 10) / 10,
    y: Math.round(it.y * 10) / 10,
    src: it.src,
  };
}).sort((a, b) => a.n.localeCompare(b.n, 'zh'));

// 同名的只留一个；吸附距离过大的（>250 米，说明标注离路网很远）也标出来
const far = out.filter(o => o.s > 250);
const kinds = {};
out.forEach(o => { kinds[o.k] = (kinds[o.k] || 0) + 1; });

const payload = {
  generatedBy: 'tools/build-landmarks.js',
  source: 'assets/campus-map.svg 的文字标注 + data/route-graph.js 的 places',
  note: '事件场馆用这份索引选；x/y 与路网同坐标系，i 是吸附到的路网节点下标',
  count: out.length,
  kinds,
  items: out,
};

const body = '// 由 tools/build-landmarks.js 自动生成，请勿手工编辑。\n'
  + `// ${out.length} 个地标（底图标注 + 常用地点），已吸附到路网节点\n`
  + `module.exports = ${JSON.stringify(payload)};\n`;
fs.writeFileSync(outPath, body, 'utf8');

console.log(`\n已生成 ${path.relative(process.cwd(), outPath)}  ${(Buffer.byteLength(body) / 1024).toFixed(1)} KB`);
console.log('类别分布：', JSON.stringify(kinds, null, 0));
const venue = out.filter(o => o.k === '体育场馆' || o.k === '礼堂会场');
console.log('\n可用作活动场馆的：');
venue.forEach(o => console.log(`  ${o.n}  -> 节点 #${o.i}（离标注 ${o.s} 米）`));
if (far.length) {
  console.log(`\n吸附距离 >250 米的地标 ${far.length} 个（标注本身离路网较远）：`);
  far.slice(0, 8).forEach(o => console.log(`  ${o.n}  ${o.s} 米`));
}
