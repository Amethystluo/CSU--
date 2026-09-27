/**
 * 自动定位小程序根目录（含 app.json 与 pages/ 的那一层）。
 *
 * 为什么需要：tools/ 里的脚本原来都把路径写死成 `<仓库>/miniprogram/miniprogram`，
 * 项目一旦被复制成不同的层级（例如 `<仓库>/miniprogram`），27 个脚本会全部失效。
 * 这里按"哪个目录里有 app.json 和 pages/"来判断，跟项目怎么摆放无关。
 */
const fs = require('fs');
const path = require('path');

function findRoot() {
  const candidates = [
    path.join(__dirname, '..', 'miniprogram', 'miniprogram'),  // 仓库/miniprogram/miniprogram
    path.join(__dirname, '..', 'miniprogram'),                 // 仓库/miniprogram
    path.join(__dirname, '..'),                                // 仓库本身就是小程序目录
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'app.json')) && fs.existsSync(path.join(c, 'pages'))) return c;
  }
  throw new Error('找不到小程序根目录（应包含 app.json 与 pages/）');
}

module.exports = { ROOT: findRoot(), TOOLS: __dirname };
