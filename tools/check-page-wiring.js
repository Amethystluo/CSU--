/**
 * 页面接线检查：WXML 里绑定的事件处理函数、引用的数据字段，
 * 在 JS 里是否真的存在。这类错误在开发者工具里表现为点击无反应或页面报错，
 * 放在这里静态查出来更省事。
 *
 *   node tools/check-page-wiring.js
 */
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./paths.js');

let problems = 0;
const note = msg => { problems++; console.log('  ✗ ' + msg); };
const ok = msg => console.log('  ✓ ' + msg);

// 用假的 Page 拿到页面配置
function loadPageConfig(jsPath) {
  let cfg = null;
  const prevPage = global.Page;
  global.Page = o => { cfg = o; };
  global.wx = global.wx || {};
  global.getApp = () => ({ globalData: {} });
  delete require.cache[require.resolve(jsPath)];
  require(jsPath);
  global.Page = prevPage;
  return cfg;
}

// WXML 里可以在 {{}} 中使用的内置关键字
const KEYWORDS = new Set([
  'true', 'false', 'null', 'undefined', 'item', 'index', 'wx', 'Math', 'JSON',
  // wx:for-item 自定义的循环变量名（WXML 里局部绑定，不是页面 data 字段）
  'p', 'g', 'v', 'row',
]);

/**
 * WXML 结构体检（这类问题不会在 JS 侧暴露）：
 *   a) 内联 style 里不能有空值（开发工具拖拽常留下 `display: ;` 这种残样式）或负的宽高；
 *   b) wx:for 应该带 wx:key（否则列表更新会错乱）。
 *
 * **这里不检查 wx:if / wx:elif 的配对**：实测（拿开发者工具自带的 wcc 编译）证明
 * 中间夹注释并不影响配对，而真正的"wx:elif 没有配对"由 tools/check-wxml-compile.ps1
 * 用官方编译器报错（`Bad attr wx:elif ... wx:if not found`），比这里的启发式判断准得多。
 * 曾经加过这条规则，结果误报了一次、带着人去查错方向，所以撤掉。
 */
function lintWxml(wxml) {
  const problems = [];
  const lines = wxml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    for (const m of lines[i].matchAll(/style="([^"]*)"/g)) {
      const css = m[1];
      if (/[a-zA-Z-]+\s*:\s*(;|$)/.test(css)) problems.push(`第 ${i + 1} 行内联 style 有空值: ${css.slice(0, 40)}`);
      if (/(width|height|top|left|right|bottom)\s*:\s*-/.test(css)) {
        problems.push(`第 ${i + 1} 行内联 style 用了负值: ${css.slice(0, 40)}`);
      }
    }
    if (/wx:for=/.test(t) && !/wx:key/.test(t)) {
      const next = (lines[i + 1] || '') + (lines[i + 2] || '');
      if (!/wx:key/.test(next)) problems.push(`第 ${i + 1} 行 wx:for 没有 wx:key`);
    }
  }
  return problems;
}

for (const page of ['index', 'predict', 'route', 'pick', 'admin', 'event', 'panel']) {
  const dir = path.join(ROOT, 'pages', page);
  const wxml = fs.readFileSync(path.join(dir, page + '.wxml'), 'utf8');
  const jsPath = path.join(dir, page + '.js');
  const cfg = loadPageConfig(jsPath);
  console.log(`\n=== ${page} ===`);
  if (!cfg) { note('页面 JS 没有调用 Page()'); continue; }

  // 1. 事件处理函数
  const handlers = new Set();
  for (const m of wxml.matchAll(/\b(?:bind|catch)[a-zA-Z]*\s*=\s*"([^"{}]+)"/g)) {
    handlers.add(m[1].trim());
  }
  const missing = [...handlers].filter(h => typeof cfg[h] !== 'function');
  if (missing.length) note(`WXML 绑定了 JS 里不存在的方法: ${missing.join(', ')}`);
  else ok(`事件绑定全部存在 (${[...handlers].join(', ')})`);

  // 1.5 WXML 结构体检
  const structural = lintWxml(wxml);
  if (structural.length) structural.forEach(p => note(`WXML 结构: ${p}`));
  else ok('WXML 结构没问题（wx:if/elif 配对、内联样式、wx:key）');

  // 2. 数据字段
  const dataKeys = new Set(Object.keys(cfg.data || {}));
  const used = new Set();
  for (const m of wxml.matchAll(/\{\{([^}]*)\}\}/g)) {
    let expr = m[1];
    expr = expr.replace(/'[^']*'/g, ' ').replace(/"[^"]*"/g, ' ');   // 去掉字符串字面量
    for (const id of expr.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
      const name = id[0];
      // 跳过属性访问的点号后半部分与关键字
      const at = id.index;
      if (at > 0 && expr[at - 1] === '.') continue;
      if (KEYWORDS.has(name)) continue;
      used.add(name);
    }
  }
  const unknown = [...used].filter(k => !dataKeys.has(k) && typeof cfg[k] === 'undefined');
  if (unknown.length) note(`WXML 引用了未定义的数据字段: ${unknown.join(', ')}`);
  else ok(`数据字段引用全部有定义 (用到 ${used.size} 个)`);

  // 3. 页面 JSON 里注册的组件/标题
  const jsonPath = path.join(dir, page + '.json');
  if (fs.existsSync(jsonPath)) {
    const j = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    if (!j.navigationBarTitleText) note(`${page}.json 缺少 navigationBarTitleText`);
    else ok(`标题: ${j.navigationBarTitleText}`);
  }
}

// 4. app.json 注册的页面都存在
console.log('\n=== app.json ===');
const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
for (const p of appJson.pages) {
  const missing = ['.js', '.wxml', '.json'].filter(ext => !fs.existsSync(path.join(ROOT, p + ext)));
  if (missing.length) note(`${p} 缺少文件: ${missing.join(', ')}`);
  else ok(`${p} 文件齐全`);
}

// 5. require 的相对路径都能解析
console.log('\n=== require 路径 ===');
function walk(dirv) {
  for (const f of fs.readdirSync(dirv, { withFileTypes: true })) {
    const full = path.join(dirv, f.name);
    if (f.isDirectory()) { walk(full); continue; }
    if (!f.name.endsWith('.js')) continue;
    const src = fs.readFileSync(full, 'utf8');
    for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const target = path.resolve(path.dirname(full), m[1]);
      const candidates = [target, target + '.js', path.join(target, 'index.js')];
      if (!candidates.some(c => fs.existsSync(c))) {
        note(`${path.relative(ROOT, full)} 引用了不存在的模块: ${m[1]}`);
      }
    }
  }
}
const before = problems;
walk(ROOT);
if (problems === before) ok('所有 require 路径都能解析');

console.log(`\n========== ${problems === 0 ? '全部通过' : problems + ' 个问题'} ==========`);
process.exit(problems ? 1 : 0);
