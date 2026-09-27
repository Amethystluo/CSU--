// 临时脚本：验证 router.describeLonLat / describePoint 的措辞（跑完可删）
const r = require('../../miniprogram/miniprogram/utils/router.js');
const g = r.graph;
const [S, X0, Y0] = [g.proj[0], g.proj[1], g.proj[2]];
const R = 6378137, RAD = Math.PI / 180;
const inv = (x, y) => {
  const mx = x / S + X0, my = Y0 - y / S;
  return [mx / (R * RAD), (2 * Math.atan(Math.exp(my / R)) - Math.PI / 2) / RAD];
};
const show = (tag, lon, lat) => {
  const d = r.describeLonLat(lon, lat);
  console.log(tag.padEnd(20), '| ' + String(d.label).padEnd(26), '|', d.detail);
};

const picks = g.places.slice(0, 2).concat(g.places.filter(x => x.k === '教学点').slice(0, 2));
for (const p of picks) {
  const [lon, lat] = inv(g.px[p.i], g.py[p.i]);
  show('就在 ' + p.n, lon, lat);
}
const p0 = g.places[0];
const [lon0, lat0] = inv(g.px[p0.i], g.py[p0.i]);
show('偏北 90 米', lon0, lat0 + 90 / 111320);
show('偏北 400 米', lon0, lat0 + 400 / 111320);
show('偏北 1500 米', lon0, lat0 + 1500 / 111320);
console.log('\n阈值:', 'NEAR_PLACE_M =', r.NEAR_PLACE_M, ' AROUND_PLACE_M =', r.AROUND_PLACE_M);
console.log('地点总数:', g.places.length, ' 类别:', JSON.stringify(g.places.reduce((a, x) => (a[x.k] = (a[x.k] || 0) + 1, a), {})));

// 真实校园边界内随机撒点，看命名是否都合理（不应出现空的/纯坐标）
let minD = Infinity, maxD = 0, noPlace = 0;
for (let i = 0; i < 400; i++) {
  const lon = 112.925 + Math.random() * 0.030;
  const lat = 28.145 + Math.random() * 0.026;
  const d = r.describeLonLat(lon, lat);
  if (!d.place) { noPlace++; continue; }
  minD = Math.min(minD, d.distanceMeters);
  maxD = Math.max(maxD, d.distanceMeters);
}
console.log('随机撒点 400 个：无法命名', noPlace, '；到最近地点距离 最小', minD.toFixed(0), '米 最大', maxD.toFixed(0), '米');
