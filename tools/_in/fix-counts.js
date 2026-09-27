/** 批量更新文档里的测试计数（578 项 / router 67 / route-page 182） */
const fs = require('fs');
const jobs = [
  ['改动记录.md', [
    ['**559 项断言**，10 个测试文件 + 1 个接线检查', '**578 项断言**，10 个测试文件 + 1 个接线检查'],
    ['| `test-router.js` | 路由算法测试（54 项） |', '| `test-router.js` | 路由算法与地点命名测试（67 项） |'],
    ['| `test-route-page.js` | 路线页逻辑测试（176 项） |', '| `test-route-page.js` | 路线页逻辑测试（182 项） |'],
    ['node tools/test-router.js            # 54 项', 'node tools/test-router.js            # 67 项'],
    ['node tools/test-route-page.js        # 176 项', 'node tools/test-route-page.js        # 182 项'],
    ['**合计 559 项断言**，10 个测试文件全部通过。', '**合计 578 项断言**，10 个测试文件全部通过。'],
  ]],
  ['项目说明.md', [
    ['├─ test-router.js                  # 路由算法（54 项）', '├─ test-router.js                  # 路由算法与地点命名（67 项）'],
    ['├─ test-route-page.js              # 路线页逻辑（176 项）', '├─ test-route-page.js              # 路线页逻辑（182 项）'],
    ['**559 项零依赖测试**', '**578 项零依赖测试**'],
    ['验证手段是 559 项自动化测试 + 4 张 SVG 预览图。', '验证手段是 578 项自动化测试 + 4 张 SVG 预览图。'],
    ['node tools/test-router.js            # 54 项  路由算法', 'node tools/test-router.js            # 67 项  路由算法与地点命名'],
    ['node tools/test-route-page.js        # 176 项 路线页逻辑', 'node tools/test-route-page.js        # 182 项 路线页逻辑'],
    ['自动化测试合计 **559 项断言**。', '自动化测试合计 **578 项断言**。'],
  ]],
  ['miniprogram/miniprogram/README.md', [
    ['node tools/test-router.js            # 路由算法测试（54 项）', 'node tools/test-router.js            # 路由算法与地点命名测试（67 项）'],
  ]],
];
for (const [file, pairs] of jobs) {
  let s = fs.readFileSync(file, 'utf8');
  let n = 0;
  for (const [from, to] of pairs) {
    if (s.indexOf(from) < 0) { console.log('  未命中:', file, JSON.stringify(from.slice(0, 50))); continue; }
    s = s.split(from).join(to);
    n++;
  }
  fs.writeFileSync(file, s, 'utf8');
  console.log(file, '替换', n, '/', pairs.length);
}
