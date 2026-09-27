/** 同步项目说明.md / README 里与"按天分开"相关的数字与描述 */
const fs = require('fs');
const jobs = [
  ['项目说明.md', [
    ['→ **10 个换课时段 × 166 条有流量路段**。',
      '→ **50 个换课时段（5 天 × 10 个时刻）× 166 条有流量路段**，界面可以选具体某一天。'],
    ['│     └─ time-profile.js              # 真实课表算出的时段画像（12.4 KB，构建产出）',
      '│     └─ time-profile.js              # 真实课表算出的时段画像（39.1 KB，5 天 × 10 时刻，构建产出）'],
    ['├─ test-time.js                    # ★ 课表解析 / 时段画像 / 口径守卫（48 项）',
      '├─ test-time.js                    # ★ 课表解析 / 时段画像 / 按天口径守卫（53 项）'],
    ['### 5.1 运行时数据 `data/route-graph.js`（44.8 KB）与 `data/time-profile.js`（12.4 KB）',
      '### 5.1 运行时数据 `data/route-graph.js`（44.8 KB）与 `data/time-profile.js`（39.1 KB）'],
    ['9. **时段画像已启用**：`data/time-profile.js` 现在是用真实 `班级课表 (3).xls` 算出来的\n   （10 个换课时段 × 166 条路段），界面时段选择器自动出现，非换课时刻热度为空。',
      '9. **时段画像已启用**：`data/time-profile.js` 现在是用真实 `班级课表 (3).xls` 算出来的\n   （**5 天 × 10 个时刻 = 50 个时段** × 166 条路段），界面可以**选具体某一天**，\n   非换课时刻与周末热度为空。'],
    ['node tools/test-time.js              # 48 项  课表解析/时段画像/口径守卫',
      'node tools/test-time.js              # 53 项  课表解析/时段画像/按天口径守卫'],
    ['node tools/check-time-shape.js       # 自检：算出来的时段之间有没有区分度',
      'node tools/check-time-shape.js       # 自检：时段之间、以及每天之间有没有区分度'],
  ]],
  ['miniprogram/miniprogram/README.md', [
    ['node tools/test-time.js              # 课表解析/时段画像/口径守卫（48 项）',
      'node tools/test-time.js              # 课表解析/时段画像/按天口径守卫（53 项）'],
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
