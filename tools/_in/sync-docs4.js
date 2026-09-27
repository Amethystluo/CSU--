/** 收尾：同步 改动记录.md / 总结.md 的规模数字到实测值 */
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
const toolsJs = fs.readdirSync('tools').filter(f => f.endsWith('.js')).length;
const toolsTest = fs.readdirSync('tools').filter(f => /^test-.*\.js$/.test(f)).length;

console.log(`实测：utils ${utils.length} 个 / ${utilsLines} 行 / ${utilsKB} KB；页面 JS ${pageLines} 行；tools ${toolsJs} 个 .js（${toolsTest} 个测试）`);

const jobs = [
  ['改动记录.md', [
    ['| 小程序页面 | 3 个（首页 / 预测热度 / 少人路线） | **5 个**（+ 地图点选页、路况管理页） |',
      '| 小程序页面 | 3 个（首页 / 预测热度 / 少人路线） | **6 个**（+ 地图点选页、路况管理页、事件与校历页） |'],
    [`| 小程序端 JS | 4 个文件，合计 **15 个非空行**（高度压缩的单行写法） | \`utils/\` 10 个模块 **1744 行** + 页面 JS **1488 行** |`,
      `| 小程序端 JS | 4 个文件，合计 **15 个非空行**（高度压缩的单行写法） | \`utils/\` ${utils.length} 个模块 **${utilsLines} 行** + 页面 JS **${pageLines} 行** |`],
    ['| 共享模块 | 无 | `utils/` 下 **10 个模块** |',
      `| 共享模块 | 无 | \`utils/\` 下 **${utils.length} 个模块** |`],
    ['| 运行时数据 | 无（页面数字全是硬编码） | `data/route-graph.js`（44.8 KB）+ `data/time-profile.js`（39.1 KB，50 个时段），构建产出 |',
      '| 运行时数据 | 无（页面数字全是硬编码） | `data/route-graph.js`（44.8 KB）+ `time-profile.js`（39.1 KB）+ `landmarks.js`（11.0 KB）+ `people-index.js`（30.6 KB），构建产出 |'],
    ['| 自动化测试 | 无 | **606 项断言**，10 个测试文件 + 1 个接线检查 |',
      '| 自动化测试 | 无 | **781 项断言**，12 个测试文件 + 1 个接线检查 |'],
    ['| 构建脚本 | 无 | `tools/` 下 **23 个 .js（含 10 个测试）+ 2 个 .ps1** + 4 张预览图 |',
      `| 构建脚本 | 无 | \`tools/\` 下 **${toolsJs} 个 .js（含 ${toolsTest} 个测试）+ 2 个 .ps1** + 4 张预览图 |`],
    ['| 小程序包体 | **2505 KB（超过 2 MB 上限）** | **815 KB** |',
      '| 小程序包体 | **2505 KB（超过 2 MB 上限）** | **923 KB** |'],
  ]],
  ['总结.md', [
    ['### 第 6 轮 · `35a4222` 可以选具体某一天', '### 第 6 轮 · `35a4222` 可以选具体某一天'],
    ['## 二、六轮改动（对应 6 个提交）', '## 二、七轮改动（对应 7 个提交）'],
    ['| 共享模块 `utils/` | **10 个 / 2065 行 / 76.2 KB** |',
      `| 共享模块 \`utils/\` | **${utils.length} 个 / ${utilsLines} 行 / ${utilsKB} KB** |`],
    ['| 页面 JS | **1623 行**（其中路线页 1092 行） |',
      `| 页面 JS | **${pageLines} 行**（其中路线页 1092 行） |`],
    ['| 自动化测试 | **606 项断言 / 10 个测试文件 + 1 个接线检查**，全通过 |',
      '| 自动化测试 | **781 项断言 / 12 个测试文件 + 1 个接线检查**，全通过 |'],
    ['| 构建与检查脚本 | `tools/` 23 个 `.js`（含 10 测试 / 4 检查 / 4 预览 / 2 构建）+ 2 个 `.ps1` |',
      `| 构建与检查脚本 | \`tools/\` ${toolsJs} 个 \`.js\`（含 ${toolsTest} 测试 / 4 检查 / 4 预览 / 4 构建）+ 2 个 \`.ps1\` |`],
    ['| 页面 | **5 个**（+ 点选页、管理页） |', '| 页面 | **6 个**（+ 点选页、管理页、事件与校历页） |'],
    ['| 打包体积 | **40 个文件 / 815 KB**（主包上限 2048 KB，余量 1233 KB）|',
      '| 打包体积 | **50 个文件 / 923 KB**（主包上限 2048 KB，余量 1125 KB）|'],
    ['测试 **606 项断言全通过**', '测试 **781 项断言全通过**'],
    ['验证手段是 606 项断言', '验证手段是 781 项断言'],
    ['# 测试（606 项）', '# 测试（781 项）'],
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
