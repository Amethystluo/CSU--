/**
 * 坐标系与定位配置测试。
 *
 * 这一套是为了防止"真机上才暴露"的问题再次悄悄回来：
 *   1. wx.getLocation 必须请求 wgs84（地图是 WGS84，gcj02 会差 660 米）；
 *   2. app.json 必须声明 requiredPrivateInfos，否则新基础库直接拒绝定位；
 *   3. 转换函数自身正确。
 *
 *   node tools/test-coord.js
 */
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./paths.js');
const coord = require(path.join(ROOT, 'utils', 'coord.js'));
const router = require(path.join(ROOT, 'utils', 'router.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`); }
}

// 校内实测点（WGS84，来自 OSM 数据）
const CAMPUS = { lon: 112.93324839293244, lat: 28.1627837, name: '南校区6舍' };

console.log('=== 1. 偏移量到底有多大 ===');
{
  const [glon, glat] = coord.wgs84ToGcj02(CAMPUS.lon, CAMPUS.lat);
  const d = coord.metersBetween(CAMPUS.lon, CAMPUS.lat, glon, glat);
  console.log(`  同一点：WGS84 (${CAMPUS.lon.toFixed(5)}, ${CAMPUS.lat.toFixed(5)})`);
  console.log(`          GCJ-02 (${glon.toFixed(5)}, ${glat.toFixed(5)})`);
  console.log(`  两者相差 ${d.toFixed(0)} 米`);
  check('校内 WGS84 与 GCJ-02 相差数百米（不是小误差）', d > 300 && d < 1200, `${d.toFixed(0)} 米`);
  check('偏移方向符合长沙一带的规律（偏东偏南）', glon > CAMPUS.lon && glat < CAMPUS.lat,
    `东 ${((glon - CAMPUS.lon) * 111320 * Math.cos(CAMPUS.lat * Math.PI / 180)).toFixed(0)}m, `
    + `南 ${((CAMPUS.lat - glat) * 110540).toFixed(0)}m`);
}

console.log('\n=== 2. 转换函数正确性 ===');
{
  const [glon, glat] = coord.wgs84ToGcj02(CAMPUS.lon, CAMPUS.lat);
  const [blon, blat] = coord.gcj02ToWgs84(glon, glat);
  const err = coord.metersBetween(CAMPUS.lon, CAMPUS.lat, blon, blat);
  check('来回转换能回到原点（误差 < 2 米）', err < 2, `误差 ${err.toFixed(2)} 米`);

  check('境外坐标不做偏移（东京）',
    JSON.stringify(coord.wgs84ToGcj02(139.6917, 35.6895)) === JSON.stringify([139.6917, 35.6895]));
  check('境外坐标反向also不变',
    JSON.stringify(coord.gcj02ToWgs84(139.6917, 35.6895)) === JSON.stringify([139.6917, 35.6895]));
  check('边界判断：深圳在界内', coord.outOfChina(114.06, 22.55) === false);
  check('边界判断：香港在界内', coord.outOfChina(114.17, 22.32) === false);
  check('边界判断：新加坡在界外', coord.outOfChina(103.85, 1.29) === true);

  // 距离函数自检：纬度 1 度约 110.5 km
  const dLat = coord.metersBetween(112.9, 28.0, 112.9, 29.0);
  check('距离函数：1 度纬度约 110.5 km', Math.abs(dLat - 110540) < 200, `${dLat.toFixed(0)} 米`);
  const dLon = coord.metersBetween(112.0, 28.16, 113.0, 28.16);
  check('距离函数：该纬度 1 度经度约 98 km', dLon > 97000 && dLon < 99000, `${dLon.toFixed(0)} 米`);
}

console.log('\n=== 3. 把错坐标系喂进来会怎样（说明必须修）===');
{
  // 模拟真机：拿到的是 GCJ-02，如果当成 WGS84 直接投影
  const [glon, glat] = coord.wgs84ToGcj02(CAMPUS.lon, CAMPUS.lat);
  const wrong = router.nearestNodeByLonLat(glon, glat);      // 错误做法
  const right = router.nearestNodeByLonLat(CAMPUS.lon, CAMPUS.lat); // 正确做法
  const gap = Math.hypot(
    router.graph.px[wrong.index] - router.graph.px[right.index],
    router.graph.py[wrong.index] - router.graph.py[right.index],
  ) / router.graph.proj[0];
  console.log(`  正确坐标吸附到节点 #${right.index}，误用 GCJ-02 吸附到节点 #${wrong.index}`);
  console.log(`  两个节点实际相距 ${gap.toFixed(0)} 米`);
  check('用错坐标系会把起点吸到几百米外的另一个路口', gap > 200, `${gap.toFixed(0)} 米`);
}

console.log('\n=== 4. 路线页必须请求 wgs84（回归守卫）===');
{
  const src = fs.readFileSync(path.join(ROOT, 'pages', 'route', 'route.js'), 'utf8');
  const at = src.indexOf('wx.getLocation(');
  check('能找到 wx.getLocation 调用', at >= 0);
  // 调用体很长，直接在后面一段窗口里找参数，避免正则被嵌套括号绊倒
  const window = at >= 0 ? src.slice(at, at + 800) : '';
  const typeMatch = /type:\s*'([a-zA-Z0-9]+)'/.exec(window);
  check('请求的是 wgs84 而不是 gcj02',
    !!typeMatch && typeMatch[1] === 'wgs84', typeMatch ? `type=${typeMatch[1]}` : '未指定 type');
  check('代码里不再出现（去注释后的）gcj02 字面量',
    !/gcj02/.test(src.replace(/\/\/.*$/gm, '')));
}

console.log('\n=== 5. app.json 的隐私接口声明（回归守卫）===');
{
  const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
  const req = app.requiredPrivateInfos || [];
  check('声明了 requiredPrivateInfos', Array.isArray(app.requiredPrivateInfos), JSON.stringify(req));
  check('包含 getLocation（一次性定位）', req.indexOf('getLocation') >= 0);
  check('包含 startLocationUpdate / onLocationChange（持续定位）',
    req.indexOf('startLocationUpdate') >= 0 && req.indexOf('onLocationChange') >= 0);
  check('没有混入非地理位置的接口（微信明确要求只放地理位置类）',
    req.every(x => /Location/.test(x)), JSON.stringify(req));
  check('保留了 permission 授权说明', !!(app.permission && app.permission['scope.userLocation']));
  // 代码里用到的定位接口都必须已声明，否则真机直接报错
  const routeSrc = fs.readFileSync(path.join(ROOT, 'pages', 'route', 'route.js'), 'utf8');
  const used = ['getLocation', 'startLocationUpdate', 'onLocationChange', 'stopLocationUpdate']
    .filter(name => routeSrc.indexOf('wx.' + name) >= 0);
  const undeclared = used.filter(n => n !== 'stopLocationUpdate' && req.indexOf(n) < 0);
  check('代码里用到的定位接口都已在 app.json 声明', undeclared.length === 0,
    undeclared.length ? `缺声明：${undeclared.join(', ')}` : used.join(', '));
}

console.log('\n=== 6. 地图侧坐标约定 ===');
{
  // 我们自绘的 SVG 地图是 WGS84；这条断言锁住"投影输入是经纬度度数"
  const proj = router.graph.proj;
  check('投影参数规模符合"经纬度 -> 像素"的仿射变换',
    proj[0] > 0.1 && proj[0] < 10 && Math.abs(proj[1]) > 1e6,
    `S=${proj[0].toFixed(6)} X0=${proj[1].toFixed(0)}`);
  const px = router.project(CAMPUS.lon, CAMPUS.lat);
  const W = router.graph.meta.viewBox[0], H = router.graph.meta.viewBox[1];
  check('WGS84 坐标投影后落在地图范围内',
    px[0] >= 0 && px[0] <= W && px[1] >= 0 && px[1] <= H,
    `(${px[0].toFixed(0)}, ${px[1].toFixed(0)})`);
  check('若误用 GCJ-02 则明显偏离（作为对照）', (() => {
    const [glon, glat] = coord.wgs84ToGcj02(CAMPUS.lon, CAMPUS.lat);
    const gp = router.project(glon, glat);
    return Math.hypot(gp[0] - px[0], gp[1] - px[1]) > 200;
  })());
}

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exit(fail ? 1 : 0);
