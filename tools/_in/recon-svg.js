// 侦察 SVG 标注的坐标格式
const fs = require('fs');
const s = fs.readFileSync(require('path').join(__dirname, '..', '..', 'miniprogram', 'miniprogram', 'assets', 'campus-map.svg'), 'utf8');
const vb = /viewBox="([^"]+)"/.exec(s);
console.log('viewBox =', vb && vb[1]);
console.log('文件大小 =', (s.length / 1024).toFixed(0), 'KB');
const re = /<text([^>]*)>([^<]{1,60})<\/text>/g;
let m, n = 0;
while ((m = re.exec(s)) && n < 8) {
  console.log('ATTR:', m[1].trim());
  console.log('TEXT:', m[2].trim());
  console.log('---');
  n++;
}
// 统计属性形态
const attrs = [...s.matchAll(/<text([^>]*)>/g)].map(x => x[1]);
const hasX = attrs.filter(a => /\bx=/.test(a)).length;
const hasT = attrs.filter(a => /transform/.test(a)).length;
const hasClass = attrs.filter(a => /class=/.test(a)).length;
console.log(`共 ${attrs.length} 个 text：带 x= ${hasX}，带 transform= ${hasT}，带 class= ${hasClass}`);
const samples = attrs.slice(0, 4);
samples.forEach(a => console.log('  ', a.trim()));
