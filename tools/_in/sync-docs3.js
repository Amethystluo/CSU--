/** 同步各文档的规模数字：781 项 / 923 KB / 新页面与命令 */
const fs = require('fs');
const jobs = [
  ['项目说明.md', [
    ['| 工程化 | Node 构建脚本 + **606 项零依赖测试** |', '| 工程化 | Node 构建脚本 + **781 项零依赖测试** |'],
    ['验证手段是 606 项自动化测试 + 4 张 SVG 预览图。', '验证手段是 781 项自动化测试 + 4 张 SVG 预览图。'],
    ['自动化测试合计 **606 项断言**。', '自动化测试合计 **781 项断言**（12 个测试文件）。'],
    ['当前打包 **40 个文件 / 约 815 KB**。', '当前打包 **50 个文件 / 约 923 KB**（主包上限 2048 KB）。'],
    ['- 主包超 2 MB → 剔除未使用素材，包体 815 KB', '- 主包超 2 MB → 剔除未使用素材，包体 923 KB'],
    ['| 页面 | **5 个**（+ 点选页、管理页） |', '| 页面 | **6 个**（+ 点选页、管理页、事件与校历页） |'],
    ['node tools/check-time-shape.js          # 自检：算出来的时段之间有没有区分度',
      'node tools/build-landmarks.js            # 底图标注 -> data/landmarks.js（124 个地标）\nnode tools/build-people-index.js         # 班级名 -> data/people-index.js（专业/年级/宿舍）\nnode tools/check-time-shape.js          # 自检：时段之间、每天之间有没有区分度'],
    ['node tools/test-time.js              # 53 项  课表解析/时段画像/按天口径守卫',
      'node tools/test-time.js              # 53 项  课表解析/时段画像/按天口径守卫\nnode tools/test-events.js            # 95 项  事件模型/人群索引/校历\nnode tools/test-event-page.js        # 63 项  事件与校历页'],
  ]],
  ['miniprogram/miniprogram/README.md', [
    ['node tools/test-route-page.js        # 路线页逻辑测试（205 项）',
      'node tools/build-landmarks.js        # 底图标注 -> data/landmarks.js\nnode tools/build-people-index.js     # 班级名 -> data/people-index.js\nnode tools/test-route-page.js        # 路线页逻辑测试（222 项，含选日期与事件）\nnode tools/test-events.js            # 事件模型/人群索引/校历（95 项）\nnode tools/test-event-page.js        # 事件与校历页（63 项）'],
  ]],
];
for (const [file, pairs] of jobs) {
  let s = fs.readFileSync(file, 'utf8');
  let n = 0;
  for (const [from, to] of pairs) {
    if (s.indexOf(from) < 0) { console.log('  未命中:', file, JSON.stringify(from.slice(0, 46))); continue; }
    s = s.split(from).join(to);
    n++;
  }
  fs.writeFileSync(file, s, 'utf8');
  console.log(file, '替换', n, '/', pairs.length);
}
