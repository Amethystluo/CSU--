/** 总结.md 规模表按实测值更新 */
const fs = require('fs');
const path = require('path');
const SRC = path.join('miniprogram', 'miniprogram');
const lines = p => fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(x => x.trim()).length;
const files = d => fs.readdirSync(d).filter(f => f.endsWith('.js')).map(f => path.join(d, f));

const utils = files(path.join(SRC, 'utils'));
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
console.log(`实测：utils ${utils.length} 个 / ${utilsLines} 行 / ${utilsKB} KB；页面 JS ${pageLines} 行（路线页 ${routeLines} 行）`);

const f = '总结.md';
let s = fs.readFileSync(f, 'utf8');
const before = s;
const rep = (a, b) => {
  if (s.indexOf(a) < 0) { console.log('  miss', JSON.stringify(a.slice(0, 46))); return; }
  s = s.split(a).join(b);
};
rep('| 共享模块 `utils/` | **10 个 / 1744 行 / 70.3 KB** |',
  `| 共享模块 \`utils/\` | **${utils.length} 个 / ${utilsLines} 行 / ${utilsKB} KB** |`);
rep('| 页面 JS | **约 1560 行**（其中路线页 1050+ 行） |',
  `| 页面 JS | **${pageLines} 行**（其中路线页 ${routeLines} 行） |`);
rep('| 页面 JS | **1488 行**（其中路线页 981 行） |',
  `| 页面 JS | **${pageLines} 行**（其中路线页 ${routeLines} 行） |`);
rep('| 打包体积 | **40 个文件 / 815 KB**（主包上限 2048 KB，余量 1271 KB）|',
  '| 打包体积 | **40 个文件 / 815 KB**（主包上限 2048 KB，余量 1233 KB）|');
rep('**打包构成**：两张底图 SVG 542 KB（70%）+ 页面 96 KB + `utils` 70 KB + 运行时数据 57 KB + 根文件 11 KB。',
  `**打包构成**：两张底图 SVG 542 KB（67%）+ 运行时数据 84 KB + 页面约 100 KB + \`utils\` ${utilsKB} KB + 根文件 11 KB。`);
fs.writeFileSync(f, s, 'utf8');
console.log('changed =', before !== s);
