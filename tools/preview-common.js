/**
 * 三张预览图共用的绘制片段，保证预览与真机观感一致。
 *
 * 颜色直接复用小程序里的 utils/render.js（同一个函数，不会跑偏）；
 * 线宽按"手机屏幕宽 375px"折算成 SVG 单位，所以预览图看起来就是真机上的粗细。
 */
const { ROOT } = require('./paths.js');
const path = require('path');
const render = require(path.join(ROOT, 'utils', 'render.js'));
const router = require(path.join(ROOT, 'utils', 'router.js'));

const VIEW_W = router.graph.meta.viewBox[0];
const ASSUMED_SCREEN_PX = 375;                 // 按这个屏宽折算，预览≈真机
const SVG_PER_PX = VIEW_W / ASSUMED_SCREEN_PX;

const px = v => v * SVG_PER_PX;

/** 与小程序同一个配色函数，保证预览图的颜色和真机一模一样。 */
const heatColor = render.heatColor;

/** 折线 -> SVG path 的 d 属性。 */
function d(pts) {
  return pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
}

/** 沿折线按屏幕间距画方向箭头（燕尾形），几何与小程序的 drawArrows 一致。 */
function arrowsSvg(pts, color) {
  const spacing = px(render.ARROW_SPACING_PX);
  const skip = px(render.ARROW_MIN_EDGE_PX);
  const len = px(render.ARROW_LEN_PX);
  const halfW = px(render.ARROW_HALF_W_PX);
  const back = len * 0.32;
  let out = '';
  let acc = 0;
  let next = skip;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (seg < 1e-6) continue;
    while (next <= acc + seg) {
      const t = (next - acc) / seg;
      const x = a[0] + (b[0] - a[0]) * t;
      const y = a[1] + (b[1] - a[1]) * t;
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const dx = Math.cos(ang), dy = Math.sin(ang);
      const nx = -dy, ny = dx;
      out += `<path d="M${(x + dx * len).toFixed(1)},${(y + dy * len).toFixed(1)}`
        + ` L${(x - dx * back + nx * halfW).toFixed(1)},${(y - dy * back + ny * halfW).toFixed(1)}`
        + ` L${(x - dx * back - nx * halfW).toFixed(1)},${(y - dy * back - ny * halfW).toFixed(1)} Z"`
        + ` fill="${color}"/>`;
      next += spacing;
    }
    acc += seg;
  }
  return out;
}

/** 一条路段：热度层的一条线（占用率决定颜色与粗细）。 */
function heatSegSvg(pts, occ) {
  return `<path d="${d(pts)}" fill="none" stroke="${heatColor(occ)}"`
    + ` stroke-width="${(4 + Math.min(occ, 1.4) * 9).toFixed(1)}"`
    + ` opacity="0.85" stroke-linecap="round"/>`;
}

/** 封闭路段：深灰虚线，宽度与小程序的 drawHeat 一致（屏幕 5px）。 */
function closedSegSvg(pts) {
  return `<path d="${d(pts)}" fill="none" stroke="#2b2b2b" stroke-width="${px(5).toFixed(1)}"`
    + ` stroke-dasharray="${px(10).toFixed(1)} ${px(7).toFixed(1)}" opacity="0.85"/>`;
}

/**
 * 规划路线：白描边 + 绿色主线 + 方向箭头。
 * @param {array} [usedEdges] plan.usedEdges；给了就按占用率给堵的段叠色（与小程序同色同宽）
 */
function routeSvg(pts, color, path_, usedEdges) {
  const p = d(pts);
  const halo = px(render.ROUTE_WIDTH_PX * render.ROUTE_HALO_SCALE);
  const main = px(render.ROUTE_WIDTH_PX);
  let segs = '';
  const heats = usedEdges ? render.segmentHeats(path_, usedEdges) : null;
  if (heats) {
    // 相邻同色合并成一条折线，与 render.drawCongestedSegments 的做法一致
    let i = 0;
    while (i < heats.length && i + 1 < pts.length) {
      const c = render.routeHeatColor(heats[i]);
      if (c === render.ROUTE_COLOR) { i++; continue; }
      let j = i;
      while (j + 1 < heats.length && j + 2 < pts.length && render.routeHeatColor(heats[j + 1]) === c) j++;
      segs += `<path d="${d(pts.slice(i, j + 2))}" fill="none" stroke="${c}"`
        + ` stroke-width="${main.toFixed(1)}" stroke-linecap="round" stroke-linejoin="round"/>`;
      i = j + 1;
    }
  }
  return `<path d="${p}" fill="none" stroke="#ffffff" stroke-width="${halo.toFixed(1)}"`
    + ` opacity="0.9" stroke-linecap="round" stroke-linejoin="round"/>`
    + `<path d="${p}" fill="none" stroke="${color}" stroke-width="${main.toFixed(1)}"`
    + ` stroke-linecap="round" stroke-linejoin="round"/>`
    + segs
    + arrowsSvg(pts, color);
}

/** 起终点圆点。 */
function endpointSvg(x, y, color) {
  const r = px(9);
  return `<circle cx="${x}" cy="${y}" r="${(r * 1.7).toFixed(1)}" fill="#fff" opacity="0.95"/>`
    + `<circle cx="${x}" cy="${y}" r="${r.toFixed(1)}" fill="${color}"/>`;
}

module.exports = {
  VIEW_W,
  SVG_PER_PX,
  px,
  heatColor,
  d,
  arrowsSvg,
  heatSegSvg,
  closedSegSvg,
  routeSvg,
  endpointSvg,
  render,
  router,
};
