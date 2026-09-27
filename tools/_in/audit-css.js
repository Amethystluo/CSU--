// 检查 WXML 里用到的 class 是否都在同名 wxss 里定义了
const fs = require('fs');
const path = require('path');
const BASE = path.join(__dirname, '..', '..', 'miniprogram', 'miniprogram', 'pages');

function audit(dir) {
  const wxml = fs.readFileSync(path.join(BASE, dir, dir + '.wxml'), 'utf8');
  const wxss = fs.readFileSync(path.join(BASE, dir, dir + '.wxss'), 'utf8');
  const used = new Set();
  for (const m of wxml.matchAll(/class="([^"]+)"/g)) {
    m[1].split(/\s+/).forEach(c => { if (c && !c.includes('{')) used.add(c); });
  }
  const defined = new Set();
  for (const m of wxss.matchAll(/\.([A-Za-z0-9_-]+)/g)) defined.add(m[1]);
  const missing = [...used].filter(c => !defined.has(c));
  console.log(`${dir}: 用到 ${used.size} 个类，wxss 定义 ${defined.size} 个；缺定义: ${missing.join(', ') || '（无）'}`);
  return missing;
}

let bad = 0;
for (const d of ['route', 'event', 'pick', 'admin', 'index', 'predict']) {
  if (!fs.existsSync(path.join(BASE, d, d + '.wxss'))) { console.log(`${d}: 无 wxss（跳过）`); continue; }
  bad += audit(d).length;
}
console.log(bad ? `\n共 ${bad} 个类没有样式` : '\n全部有样式');
