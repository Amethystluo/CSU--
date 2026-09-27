/**
 * 地图视口：把"容器尺寸 + 缩放 + 平移"这套几何算清楚，供路线页与点选页共用。
 *
 * 坐标系与变换约定（两个页面完全一致）：
 *   容器内未缩放坐标 u  ->  屏幕坐标 s：
 *       s = C + t + k * (u - C)          C = 容器中心，t = (tx,ty) 平移，k = 缩放
 *   再按 aspectFit 的留白把 u 换算成 SVG 坐标：
 *       svg = (u - off) / s
 *
 * 本文件不依赖 wx.*，纯几何 + 一个轻量的手势状态机，可直接单测。
 */
const DRAG_THRESHOLD = 6;      // 屏幕像素：超过才算拖动，否则仍视为点选
const TAP_SLOP = 12;           // 抬手时若位移超过这个值，就不当点选（防止漏掉的 move 事件）

/** 由容器尺寸算出 aspectFit 的缩放与留白。 */
function fit(viewW, viewH, W, H) {
  const s = Math.min(W / viewW, H / viewH);
  return { s, offX: (W - viewW * s) / 2, offY: (H - viewH * s) / 2 };
}

/** 创建一个视口状态。 */
function create(cfg) {
  const c = cfg || {};
  return {
    viewW: c.viewW,
    viewH: c.viewH,
    minScale: c.minScale === undefined ? 0.7 : c.minScale,
    maxScale: c.maxScale === undefined ? 4 : c.maxScale,
    scale: c.scale === undefined ? 1 : c.scale,
    tx: 0,
    ty: 0,
    W: 0, H: 0, s: 1, offX: 0, offY: 0,
    ready: false,
  };
}

/** 记录容器矩形；返回是否测量成功。 */
function measure(state, rect) {
  if (!rect || !rect.width || !rect.height) {
    state.ready = false;
    return false;
  }
  state.W = rect.width;
  state.H = rect.height;
  const f = fit(state.viewW, state.viewH, state.W, state.H);
  state.s = f.s;
  state.offX = f.offX;
  state.offY = f.offY;
  state.ready = true;
  return true;
}

/**
 * 屏幕触点 -> SVG 坐标。
 * @param {object} rect 当前容器矩形（每次触摸都要重新测，页面滚动过就不能用旧值）
 */
function toSvg(state, rect, clientX, clientY) {
  if (!state.ready) return null;
  const k = state.scale || 1;
  const px = clientX - rect.left;
  const py = clientY - rect.top;
  const ux = state.W / 2 + (px - state.W / 2 - state.tx) / k;
  const uy = state.H / 2 + (py - state.H / 2 - state.ty) / k;
  return [(ux - state.offX) / state.s, (uy - state.offY) / state.s];
}

/** 某个缩放下的平移上限：图比容器大才允许拖，否则为 0（保持居中）。 */
function panLimit(state, scale) {
  const k = scale === undefined ? state.scale : scale;
  return {
    maxTx: Math.max(0, (state.viewW * state.s * k - state.W) / 2),
    maxTy: Math.max(0, (state.viewH * state.s * k - state.H) / 2),
  };
}

/** 把平移夹在合法范围内——这样永远不会把地图拖丢。 */
function clamp(state, tx, ty, scale) {
  const lim = panLimit(state, scale);
  return {
    tx: Math.min(lim.maxTx, Math.max(-lim.maxTx, tx)),
    ty: Math.min(lim.maxTy, Math.max(-lim.maxTy, ty)),
  };
}

/** 当前缩放下是否拖得动。 */
function canPan(state, scale) {
  const lim = panLimit(state, scale);
  return lim.maxTx > 1 || lim.maxTy > 1;
}

/** 缩放夹紧并取一位小数。 */
function clampScale(state, v) {
  const lo = state.minScale, hi = state.maxScale;
  return Math.min(hi, Math.max(lo, Math.round(v * 10) / 10));
}

/**
 * 双指捏合：让"捏合开始时中点下方的那个地理位置"始终跟着当前中点走。
 * 由 s = C + t + k(u - C) 反解，得到 t' = m - C - k'(u0 - C)。
 * 这样缩放与双指平移（两指一起移动）会自动同时生效。
 */
function pinchTo(state, g, mid, dist) {
  const k = clampScale(state, g.scale * (dist / (g.dist || 1)));
  const ux = state.W / 2 + (g.midX - state.W / 2 - g.tx) / g.scale;
  const uy = state.H / 2 + (g.midY - state.H / 2 - g.ty) / g.scale;
  const tx = mid.x - state.W / 2 - k * (ux - state.W / 2);
  const ty = mid.y - state.H / 2 - k * (uy - state.H / 2);
  const c = clamp(state, tx, ty, k);
  return { scale: k, tx: c.tx, ty: c.ty };
}

// ---------------------------------------------------------------- 手势状态机
function createGesture() {
  return { kind: '', moved: false, start: null, multi: false };
}

const dist2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid2 = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * @param {array} pts 当前触摸点（已换算成容器内坐标 {x,y}）
 */
function gestureStart(state, gs, pts) {
  gs.moved = false;
  gs.start = pts;
  // 「这次触摸里同时按过 ≥2 根手指」要一直记到**所有手指抬起**为止：
  // 捏合结束后 WeChat 会先给一根手指 touchend、再给另一根，
  // 如果中间把标记清掉，第二次 touchend 就会被当成一次普通的点选（表现为"双指放大变成了点选"）。
  gs.multi = gs.multi || pts.length >= 2;
  if (pts.length >= 2) {
    gs.kind = 'pinch';
    gs.dist = dist2(pts[0], pts[1]);
    gs.mid = mid2(pts[0], pts[1]);
    gs.scale = state.scale;
    gs.tx = state.tx;
    gs.ty = state.ty;
  } else {
    gs.kind = 'drag';
    gs.p0 = pts[0];
    gs.scale = state.scale;
    gs.tx = state.tx;
    gs.ty = state.ty;
  }
  return gs;
}

/**
 * @returns {object|null} 需要写回视口的 {scale,tx,ty}；无变化返回 null
 */
function gestureMove(state, gs, pts) {
  if (!gs.kind || !pts.length) return null;

  if (gs.kind === 'pinch') {
    if (pts.length < 2) return null;          // 抬起一根手指后不跳变
    const next = pinchTo(state, {
      scale: gs.scale, tx: gs.tx, ty: gs.ty,
      midX: gs.mid.x, midY: gs.mid.y, dist: gs.dist,
    }, mid2(pts[0], pts[1]), dist2(pts[0], pts[1]));
    gs.moved = true;
    return next;
  }

  const dx = pts[0].x - gs.p0.x;
  const dy = pts[0].y - gs.p0.y;
  if (!gs.moved) {
    if (Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return null;
    if (!canPan(state, state.scale)) return null;   // 全览时拖不动，不必进入拖动状态
    gs.moved = true;
  }
  const c = clamp(state, gs.tx + dx, gs.ty + dy);
  return { scale: state.scale, tx: c.tx, ty: c.ty };
}

/**
 * 容器矩形变了（页面滚动/布局变化）：把**手势里已经记下的坐标**整体平移同样的量。
 *
 * 为什么需要它：为了不让快速轻扫被丢掉，起手必须**同步**做（不等异步测量），
 * 于是起手时用的可能是上一次的旧矩形；测量回来之后 `rect` 变了，
 * 后续触点按新矩形换算，而 `gs.p0/start/mid` 还停在旧坐标系里 ——
 * 位移会整体差一个容器偏移，抬手时还会被误判成"拖动过"（把轻点吞掉）。
 * 把旧坐标平移到新坐标系，两边就一致了。
 *
 * 注意 `gestureStart` 里 `gs.p0 === gs.start[0]` 是同一个对象，所以要去重，别平移两次。
 */
function shiftGesture(gs, dx, dy) {
  if (!gs || (!dx && !dy)) return gs;
  const seen = [];
  const move = p => {
    if (!p || seen.indexOf(p) >= 0) return;
    seen.push(p);
    p.x += dx;
    p.y += dy;
  };
  if (gs.start) gs.start.forEach(move);
  move(gs.p0);
  move(gs.mid);
  return gs;
}

/**
 * 结束手势。
 * @param {object} [end] 抬手位置（容器内坐标）。用于兜底：如果因为某些原因没收到
 *   touchmove（例如快速滑动被合并），仅凭 gs.moved 会把滑动误判成点选，
 *   所以这里再按起点到抬手的位移判一次。
 * @param {number} [remaining] 这次 touchend 之后还有几根手指留在屏幕上。
 *   >0 说明手势没结束（双指里抬起了一根），此时**绝不能**当成点选；
 *   而且要保留 `multi` 标记，等最后一根手指抬起时也不会被当成点选。
 * @returns {boolean} 这次触摸是否属于手势（拖动/捏合/多指）——是的话就不该当成点选
 */
function gestureEnd(gs, end, remaining) {
  const left = Number(remaining) || 0;
  let moved = gs.moved || gs.multi;
  if (!moved && end && gs.start && gs.start.length) {
    const s = gs.start[0];
    if (Math.abs(end.x - s.x) + Math.abs(end.y - s.y) > TAP_SLOP) moved = true;
  }
  if (left > 0) {
    // 还有手指没抬起来：手势仍在进行，标记留着，等最后一根手指
    gs.moved = true;
    return true;
  }
  gs.kind = '';
  gs.moved = false;
  gs.multi = false;
  gs.start = null;
  return moved;
}

/** 这次触摸是不是"多指"（捏合）——页面可以用它挡掉紧随其后的点选。 */
function isMulti(gs) {
  return !!(gs && gs.multi);
}

module.exports = {
  DRAG_THRESHOLD,
  TAP_SLOP,
  fit,
  create,
  measure,
  toSvg,
  panLimit,
  clamp,
  canPan,
  clampScale,
  pinchTo,
  createGesture,
  gestureStart,
  gestureMove,
  gestureEnd,
  isMulti,
  shiftGesture,
};
