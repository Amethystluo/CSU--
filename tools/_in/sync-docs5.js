/** 最后一批数字修正 */
const fs = require('fs');
const path = require('path');
const SRC = path.join('miniprogram', 'miniprogram');
const lines = p => fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(x => x.trim()).length;
const jsFiles = d => fs.readdirSync(d).filter(f => f.endsWith('.js')).map(f => path.join(d, f));
const utils = jsFiles(path.join(SRC, 'utils'));
const utilsLines = utils.reduce((a, f) => a + lines(f), 0);
const utilsKB = (utils.reduce((a, f) => a + fs.statSync(f).size, 0) / 1024).toFixed(1);
const pageJs = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (e.name.endsWith('.js')) pageJs.push(p);
  }
})(path.join(SRC, 'pages'));
const pageLines = pageJs.reduce((a, f) => a + lines(f), 0);
const routeLines = lines(path.join(SRC, 'pages', 'route', 'route.js'));

const jobs = [
  ['改动记录.md', [
    ['| `test-route-page.js` | 路线页逻辑测试（205 项，含选日期） |',
      '| `test-route-page.js` | 路线页逻辑测试（222 项，含选日期与事件） |'],
    ['画像从 10 个时段变成 **50 个**，文件 12.4 KB → 39.1 KB（打包 777 → 815 KB，主包上限 2048 KB）。',
      '画像从 10 个时段变成 **50 个**，文件 12.4 KB → 39.1 KB（主包上限 2048 KB）。'],
    ['node tools/test-route-page.js        # 205 项', 'node tools/test-route-page.js        # 222 项'],
    ['**合计 606 项断言**，10 个测试文件全部通过。', '**合计 781 项断言**，12 个测试文件全部通过。'],
    ['                        1744 行 / 10 个模块 / 70.3 KB',
      `                        ${utilsLines} 行 / ${utils.length} 个模块 / ${utilsKB} KB`],
    ['utils/render.js       293 行', 'utils/render.js       293 行'],
  ]],
  ['项目说明.md', [
    ['node tools/test-route-page.js        # 205 项 路线页逻辑（含选日期）',
      'node tools/test-route-page.js        # 222 项 路线页逻辑（含选日期与事件）'],
  ]],
  ['总结.md', [
    ['（其中路线页 1092 行）', `（其中路线页 ${routeLines} 行）`],
    ['| 页面 JS | **2158 行**（其中路线页 1092 行） |', `| 页面 JS | **${pageLines} 行**（其中路线页 ${routeLines} 行） |`],
  ]],
];
for (const [file, pairs] of jobs) {
  let s = fs.readFileSync(file, 'utf8');
  let n = 0;
  for (const [from, to] of pairs) {
    if (s.indexOf(from) < 0) { console.log('  未命中:', file, JSON.stringify(from.slice(0, 44))); continue; }
    s = s.split(from).join(to);
    n++;
  }
  fs.writeFileSync(file, s, 'utf8');
  console.log(file, '替换', n, '/', pairs.length);
}
