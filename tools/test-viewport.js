/**
 * 视口几何与手势测试（拖动 / 双指捏合）。
 * 这些数学错了在真机上才看得出来，所以在这里用纯函数逐条钉死。
 *
 *   node tools/test-viewport.js
 */
const { ROOT } = require('./paths.js');
const path = require('path');
const vp = require(path.join(ROOT, 'utils', 'viewport.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`); }
}
const near = (a, b, eps) => Math.abs(a - b) <= (eps === undefined ? 1e-6 : eps);

// 与点选页一致的容器：宽高错开，确保确实存在 letterbox
const RECT = { left: 16, top: 140, width: 375, height: 520 };
const VIEW_W = 1899.019537441565;
const VIEW_H = 2051.250000000162;

const makeView = (scale, opts) => vp.create(Object.assign({
  viewW: VIEW_W, viewH: VIEW_H, scale: scale === undefined ? 1.6 : scale,
  minScale: 0.7, maxScale: 4,
}, opts || {}));

console.log('=== 1. aspectFit 与测量 ===');
{
  const v = makeView();
  check('测量成功', vp.measure(v, RECT) === true);
  const s = Math.min(RECT.width / VIEW_W, RECT.height / VIEW_H);
  check('缩放比取两轴较小者（宽度受限）', near(v.s, s), `s=${v.s.toFixed(6)}`);
  check('留白只在纵向', near(v.offX, 0, 1e-9) && v.offY > 0, `offX=${v.offX.toFixed(1)} offY=${v.offY.toFixed(1)}`);
  check('矩形为 0 时测量失败', vp.measure(makeView(), { width: 0, height: 0 }) === false);
}

console.log('\n=== 2. 坐标换算（拖动前）===');
{
  const v = makeView(1);
  vp.measure(v, RECT);
  // 独立不变量：容器中心必然对应 SVG 中心，与留白无关
  const c = vp.toSvg(v, RECT, RECT.left + RECT.width / 2, RECT.top + RECT.height / 2);
  check('容器中心 <-> SVG 中心', near(c[0], VIEW_W / 2, 1e-6) && near(c[1], VIEW_H / 2, 1e-6),
    `(${c[0].toFixed(1)}, ${c[1].toFixed(1)})`);
  // 左上角应落在 SVG 的负留白区域（纵向）
  const tl = vp.toSvg(v, RECT, RECT.left, RECT.top);
  check('左上角映射到 SVG 左上（纵向带留白）', near(tl[0], 0, 1e-6) && tl[1] < 0,
    `(${tl[0].toFixed(1)}, ${tl[1].toFixed(1)})`);
}

console.log('\n=== 3. 拖动方向与夹紧 ===');
{
  const v = makeView(1.6);
  vp.measure(v, RECT);
  const gs = vp.createGesture();
  const cx = RECT.width / 2, cy = RECT.height / 2;
  vp.gestureStart(v, gs, [{ x: cx, y: cy }]);
  const next = vp.gestureMove(v, gs, [{ x: cx - 60, y: cy - 40 }]);
  check('拖动返回新的偏移', !!next, next && `tx=${next.tx} ty=${next.ty}`);
  check('手指左上移动 -> 内容跟着走（负偏移）', next.tx < 0 && next.ty < 0);
  check('拖动会被记为手势', vp.gestureEnd(gs) === true);

  // 夹紧
  const lim = vp.panLimit(v, 1.6);
  const far = vp.clamp(v, -99999, -99999, 1.6);
  check('横向被夹在上限', near(far.tx, -lim.maxTx, 1e-6), `tx=${far.tx.toFixed(1)} 上限=${lim.maxTx.toFixed(1)}`);
  check('纵向被夹在上限', near(far.ty, -lim.maxTy, 1e-6), `ty=${far.ty.toFixed(1)} 上限=${lim.maxTy.toFixed(1)}`);
}

console.log('\n=== 4. 全览时拖不动（但不算手势）===');
{
  const v = makeView(1);
  vp.measure(v, RECT);
  check('全览时 canPan=false', vp.canPan(v, 1) === false);
  const gs = vp.createGesture();
  const cx = RECT.width / 2, cy = RECT.height / 2;
  vp.gestureStart(v, gs, [{ x: cx, y: cy }]);
  const next = vp.gestureMove(v, gs, [{ x: cx - 200, y: cy - 200 }]);
  check('全览时拖动没有位移', next === null);
  check('且不会被当成手势（仍然可以点选）', vp.gestureEnd(gs) === false);
  check('小于阈值的移动不算拖动', (() => {
    const v2 = makeView(1.6);
    vp.measure(v2, RECT);
    const g2 = vp.createGesture();
    vp.gestureStart(v2, g2, [{ x: 100, y: 100 }]);
    const r = vp.gestureMove(v2, g2, [{ x: 102, y: 102 }]);
    return r === null && vp.gestureEnd(g2) === false;
  })());
  // 兜底：快速滑动可能一个 touchmove 都没有，只靠抬手位移也要判出手势
  check('没有 move 事件时，按抬手位移仍能判出滑动', (() => {
    const v3 = makeView(1.6);
    vp.measure(v3, RECT);
    const g3 = vp.createGesture();
    vp.gestureStart(v3, g3, [{ x: 100, y: 300 }]);
    return vp.gestureEnd(g3, { x: 160, y: 380 }) === true;
  })());
  check('轻微抖动的抬手仍算点选', (() => {
    const v4 = makeView(1.6);
    vp.measure(v4, RECT);
    const g4 = vp.createGesture();
    vp.gestureStart(v4, g4, [{ x: 100, y: 300 }]);
    return vp.gestureEnd(g4, { x: 103, y: 302 }) === false;
  })());
}

console.log('\n=== 5. 双指捏合：缩放 ===');
{
  const v = makeView(1);
  vp.measure(v, RECT);
  const cx = RECT.width / 2, cy = RECT.height / 2;
  const gs = vp.createGesture();
  // 两指水平相距 100 -> 200（放大一倍）
  vp.gestureStart(v, gs, [{ x: cx - 50, y: cy }, { x: cx + 50, y: cy }]);
  const next = vp.gestureMove(v, gs, [{ x: cx - 100, y: cy }, { x: cx + 100, y: cy }]);
  check('缩放翻倍', near(next.scale, 2, 1e-9), `scale=${next.scale}`);
  check('两指中点不动 -> 偏移基本不变', Math.abs(next.tx) < 1 && Math.abs(next.ty) < 1,
    `tx=${next.tx.toFixed(2)} ty=${next.ty.toFixed(2)}`);
  check('捏合也被记为手势', vp.gestureEnd(gs) === true);
}

console.log('\n=== 6. 双指捏合：中点必须"钉住"（关键）===');
{
  // 取一个偏离中心的捏合中点，验证它下面的那个地理位置在缩放前后位于同一点
  const v = makeView(1);
  vp.measure(v, RECT);
  const m0 = { x: 250, y: 180 };          // 容器内坐标
  const gs = vp.createGesture();
  vp.gestureStart(v, gs, [{ x: m0.x - 40, y: m0.y }, { x: m0.x + 40, y: m0.y }]);

  // 捏合前，中点对应的本地坐标
  const uxBefore = v.W / 2 + (m0.x - v.W / 2 - v.tx) / v.scale;
  const uyBefore = v.H / 2 + (m0.y - v.H / 2 - v.ty) / v.scale;

  const m1 = { x: m0.x + 30, y: m0.y - 25 };   // 捏合过程中两指整体移动
  const next = vp.gestureMove(v, gs, [{ x: m1.x - 80, y: m1.y }, { x: m1.x + 80, y: m1.y }]);
  check('捏合同时发生了缩放', next.scale > 1, `scale=${next.scale.toFixed(2)}`);

  // 用新的 scale/tx/ty 反算：原来那个本地坐标现在应该落在新的中点上
  const uxNow = next.tx + next.scale * (uxBefore - v.W / 2) + v.W / 2;
  const uyNow = next.ty + next.scale * (uyBefore - v.H / 2) + v.H / 2;
  check('缩放前中点下的位置，缩放后仍跟着中点', near(uxNow, m1.x, 0.5) && near(uyNow, m1.y, 0.5),
    `(${uxNow.toFixed(1)}, ${uyNow.toFixed(1)}) vs 中点 (${m1.x}, ${m1.y})`);
}

console.log('\n=== 7. 缩放范围与抬手指 ===');
{
  const v = makeView(1);
  vp.measure(v, RECT);
  const cx = RECT.width / 2, cy = RECT.height / 2;
  // 使劲捏大：不能超过上限
  let gs = vp.createGesture();
  vp.gestureStart(v, gs, [{ x: cx - 5, y: cy }, { x: cx + 5, y: cy }]);
  let next = vp.gestureMove(v, gs, [{ x: cx - 400, y: cy }, { x: cx + 400, y: cy }]);
  check('缩放不超过上限', next.scale <= 4 + 1e-9, `scale=${next.scale}`);
  // 使劲捏小：不能低于下限
  gs = vp.createGesture();
  vp.gestureStart(v, gs, [{ x: cx - 400, y: cy }, { x: cx + 400, y: cy }]);
  next = vp.gestureMove(v, gs, [{ x: cx - 5, y: cy }, { x: cx + 5, y: cy }]);
  check('缩放不低于下限', next.scale >= 0.7 - 1e-9, `scale=${next.scale}`);

  // 抬起一根手指后不应跳变
  gs = vp.createGesture();
  vp.gestureStart(v, gs, [{ x: cx - 50, y: cy }, { x: cx + 50, y: cy }]);
  check('双指剩一指时不产生位移', vp.gestureMove(v, gs, [{ x: cx - 50, y: cy }]) === null);
  check('clampScale 取一位小数且夹紧',
    vp.clampScale(makeView(), 2.34) === 2.3 && vp.clampScale(makeView(), 99) === 4
    && vp.clampScale(makeView(), 0.01) === 0.7);
}

console.log('\n=== 8. 拖动 + 缩放后坐标仍然自洽 ===');
{
  const v = makeView(1.6);
  vp.measure(v, RECT);
  // 手工设一个偏移与缩放，然后验证 屏幕->SVG 与 SVG->屏幕 互逆
  v.scale = 2.3;
  const c = vp.clamp(v, -80, 45, v.scale);
  v.tx = c.tx; v.ty = c.ty;
  const target = [900, 1100];   // 任意 SVG 点
  // 正向：SVG -> 屏幕
  const ux = target[0] * v.s + v.offX;
  const uy = target[1] * v.s + v.offY;
  const clientX = RECT.left + v.W / 2 + v.tx + v.scale * (ux - v.W / 2);
  const clientY = RECT.top + v.H / 2 + v.ty + v.scale * (uy - v.H / 2);
  const back = vp.toSvg(v, RECT, clientX, clientY);
  check('SVG -> 屏幕 -> SVG 往返一致',
    near(back[0], target[0], 1e-6) && near(back[1], target[1], 1e-6),
    `(${back[0].toFixed(1)}, ${back[1].toFixed(1)})`);
  check('该点在容器范围内（能真的点到）',
    clientX > RECT.left && clientX < RECT.left + RECT.width
    && clientY > RECT.top && clientY < RECT.top + RECT.height,
    `client=(${clientX.toFixed(0)}, ${clientY.toFixed(0)})`);
}

console.log('\n=== 9. 容器移动后把手势坐标平移过去（起手不等异步测量）===');
{
  // 起手必须同步做（否则快速轻扫会被整段丢掉），于是起手用的可能是旧矩形；
  // 测量回来之后 rect 变了，手势里记的坐标要整体平移，两边才在同一坐标系。
  const v = makeView(1.6);
  vp.measure(v, RECT);
  const gs = vp.createGesture();
  vp.gestureStart(v, gs, [{ x: 100, y: 200 }]);
  check('起手时 p0 与 start[0] 是同一个对象（所以平移时要去重）', gs.p0 === gs.start[0]);

  // 容器往下移了 60、往右移了 10
  vp.shiftGesture(gs, -10, -60);
  check('起点被平移了（只一次，没被平移两次）',
    gs.start[0].x === 90 && gs.start[0].y === 140, `(${gs.start[0].x}, ${gs.start[0].y})`);
  check('p0 与 start[0] 仍然一致', gs.p0.x === 90 && gs.p0.y === 140);

  // 平移之后：用新矩形换算的当前点算位移，结果应与"根本没动过容器"一致
  const dx = 40, dy = -25;
  const next = vp.gestureMove(v, gs, [{ x: 90 + dx, y: 140 + dy }]);
  check('平移后位移正确（差一个容器偏移的 bug 不会再出现）',
    next && near(next.tx, dx, 1e-6) && near(next.ty, dy, 1e-6),
    next ? `tx=${next.tx} ty=${next.ty}` : 'null');

  // 轻点不能被误判成拖动：平移后 start 与抬手点在同一坐标系
  const g2 = vp.createGesture();
  vp.gestureStart(v, g2, [{ x: 100, y: 200 }]);
  vp.shiftGesture(g2, -10, -60);
  check('平移后轻点仍判为点选（不会被容器偏移骗成"拖过"）',
    vp.gestureEnd(g2, { x: 90, y: 141 }) === false);

  check('平移量为 0 / 手势为空时不炸', (() => {
    const g3 = vp.createGesture();
    vp.shiftGesture(g3, 0, 0);
    vp.shiftGesture(null, 5, 5);
    vp.gestureStart(v, g3, [{ x: 7, y: 8 }]);
    vp.shiftGesture(g3, 0, 0);
    return g3.start[0].x === 7;
  })());

  // 捏合也要跟着平移（mid 一起挪）
  const g4 = vp.createGesture();
  vp.gestureStart(v, g4, [{ x: 100, y: 200 }, { x: 200, y: 200 }]);
  const midBefore = { x: g4.mid.x, y: g4.mid.y };
  vp.shiftGesture(g4, -10, -60);
  check('捏合的中点也跟着平移', g4.mid.x === midBefore.x - 10 && g4.mid.y === midBefore.y - 60,
    `(${g4.mid.x}, ${g4.mid.y})`);
}

console.log('\n=== 10. 双指触摸不能退化成点选（用户反馈"双指放大变成点击"）===');
{
  const v = makeView(1.6);
  vp.measure(v, RECT);

  // 两指落下 -> 抬起一根 -> 再抬起最后一根：两处 touchend 都不能算点选
  const g = vp.createGesture();
  const two = [{ x: 100, y: 200 }, { x: 300, y: 200 }];
  vp.gestureStart(v, g, two);
  check('两指落下就标记为多指手势', vp.isMulti(g) === true);
  check('抬起第一根手指（屏幕上还剩一根）不算点选',
    vp.gestureEnd(g, two[0], 1) === true);
  check('还剩手指时标记要留着', vp.isMulti(g) === true);
  check('抬起最后一根手指也不算点选（这一步原来会被当成点击）',
    vp.gestureEnd(g, two[1], 0) === true);
  check('手势结束后标记清掉（下一次单指轻点不受影响）', vp.isMulti(g) === false);

  // 双指原地按一下（完全没移动）也不能算点选
  const g2 = vp.createGesture();
  vp.gestureStart(v, g2, two);
  check('两指原地按一下也不算点选', vp.gestureEnd(g2, two[1], 0) === true);

  // 单指轻点仍然要算点选
  const g3 = vp.createGesture();
  vp.gestureStart(v, g3, [{ x: 100, y: 200 }]);
  check('单指原地轻点仍然是点选', vp.gestureEnd(g3, { x: 100, y: 201 }, 0) === false);
  check('单指轻点不会被 multi 干扰', vp.isMulti(g3) === false);

  // 单指按下、加一根手指、再全部抬起：整个过程都不该产生点选
  const g4 = vp.createGesture();
  vp.gestureStart(v, g4, [{ x: 100, y: 200 }]);
  vp.gestureStart(v, g4, [{ x: 100, y: 200 }, { x: 200, y: 200 }]);   // 第二根手指落下
  check('中途加第二根手指也会被记住', vp.isMulti(g4) === true);
  vp.gestureEnd(g4, { x: 200, y: 200 }, 1);
  check('这种"先拖后捏"的抬手同样不算点选', vp.gestureEnd(g4, { x: 100, y: 200 }, 0) === true);
}

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exit(fail ? 1 : 0);
