/** 把各文档里的测试计数与规模数字同步到 606 / 新规模 */
const fs = require('fs');
const jobs = [
  ['改动记录.md', [
    ['| 自动化测试 | 无 | **578 项断言**，10 个测试文件 + 1 个接线检查 |',
      '| 自动化测试 | 无 | **606 项断言**，10 个测试文件 + 1 个接线检查 |'],
    ['| `test-time.js` | 课表解析 / 时段画像 / 口径守卫测试（48 项） |',
      '| `test-time.js` | 课表解析 / 时段画像 / 按天口径守卫测试（53 项） |'],
    ['| `test-route-page.js` | 路线页逻辑测试（182 项） |',
      '| `test-route-page.js` | 路线页逻辑测试（205 项，含选日期） |'],
    ['node tools/test-time.js              # 48 项', 'node tools/test-time.js              # 53 项'],
    ['node tools/test-route-page.js        # 182 项', 'node tools/test-route-page.js        # 205 项'],
    ['**合计 578 项断言**，10 个测试文件全部通过。', '**合计 606 项断言**，10 个测试文件全部通过。'],
    ['| 共享模块 | 无 | `utils/` 下 **10 个模块** |', '| 共享模块 | 无 | `utils/` 下 **10 个模块** |'],
    ['断言总数 555 → **559**（后又补到 **578**，见四之六）。',
      '断言总数 555 → 559（四之五）→ 578（四之六）→ **606**（四之七）。'],
    ['| 小程序包体 | **2505 KB（超过 2 MB 上限）** | **777 KB** |',
      '| 小程序包体 | **2505 KB（超过 2 MB 上限）** | **815 KB** |'],
  ]],
  ['项目说明.md', [
    ['**578 项零依赖测试**', '**606 项零依赖测试**'],
    ['验证手段是 578 项自动化测试 + 4 张 SVG 预览图。', '验证手段是 606 项自动化测试 + 4 张 SVG 预览图。'],
    ['node tools/test-time.js              # 53 项  课表解析/时段画像/按天口径守卫',
      'node tools/test-time.js              # 53 项  课表解析/时段画像/按天口径守卫'],
    ['node tools/test-route-page.js        # 182 项 路线页逻辑',
      'node tools/test-route-page.js        # 205 项 路线页逻辑（含选日期）'],
    ['自动化测试合计 **578 项断言**。', '自动化测试合计 **606 项断言**。'],
    ['当前打包 **40 个文件 / 约 777 KB**。', '当前打包 **40 个文件 / 约 815 KB**。'],
  ]],
  ['总结.md', [
    ['测试 **578 项断言全通过**', '测试 **606 项断言全通过**'],
    ['**578 项断言 / 10 个测试文件 + 1 个接线检查**', '**606 项断言 / 10 个测试文件 + 1 个接线检查**'],
    ['验证手段是 578 项断言', '验证手段是 606 项断言'],
    ['# 测试（578 项）', '# 测试（606 项）'],
    ['**40 个文件 / 777 KB**', '**40 个文件 / 815 KB**'],
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
