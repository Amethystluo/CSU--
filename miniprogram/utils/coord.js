/**
 * 坐标系转换：WGS84 <-> GCJ-02（火星坐标）。
 *
 * 【为什么必须处理】
 *   本项目的整张地图来自 OpenStreetMap，是 **WGS84**（GPS 原始坐标）；
 *   而微信生态里的两种坐标是：
 *     - `wx.getLocation({type:'wgs84'})`  -> 返回 GPS 原始坐标（WGS84）
 *     - `wx.getLocation({type:'gcj02'})`  -> 返回国测局加密坐标（GCJ-02，可用于 wx.openLocation / 原生 map）
 *   两者在中南大学一带相差约 **660 米**（东偏 533 m、南偏 388 m）。
 *   一旦把 GCJ-02 当成 WGS84 去套我们的投影，用户的起点会被落到几百米外。
 *
 * 【本项目的约定】
 *   - 路线页拿定位时**必须**用 `type: 'wgs84'`，与 OSM 数据同系；
 *   - 若将来要接入微信原生 `map` 组件或 `wx.openLocation`，用 wgs84ToGcj02 转过去；
 *   - 反向用 gcj02ToWgs84（本项目目前不需要，留作通用工具）。
 *
 * 算法是公开的近似实现（俗称 eviltransform），与官方实现相差约 1~2 米，足够本项目使用。
 */

const PI = Math.PI;
const A = 6378245.0;                    // 克拉索夫斯基椭球长半轴
const EE = 0.00669342162296594323;      // 偏心率平方

/** 中国大陆范围之外不做偏移（港澳台及境外）。 */
function outOfChina(lon, lat) {
  return !(lon > 73.66 && lon < 135.05 && lat > 3.86 && lat < 53.55);
}

function transformLat(x, y) {
  let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2 / 3;
  r += (20 * Math.sin(y * PI) + 40 * Math.sin(y / 3 * PI)) * 2 / 3;
  r += (160 * Math.sin(y / 12 * PI) + 320 * Math.sin(y * PI / 30)) * 2 / 3;
  return r;
}

function transformLon(x, y) {
  let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2 / 3;
  r += (20 * Math.sin(x * PI) + 40 * Math.sin(x / 3 * PI)) * 2 / 3;
  r += (150 * Math.sin(x / 12 * PI) + 300 * Math.sin(x / 30 * PI)) * 2 / 3;
  return r;
}

function delta(lon, lat) {
  let dLat = transformLat(lon - 105, lat - 35);
  let dLon = transformLon(lon - 105, lat - 35);
  const radLat = lat / 180 * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180) / ((A * (1 - EE)) / (magic * sqrtMagic) * PI);
  dLon = (dLon * 180) / (A / sqrtMagic * Math.cos(radLat) * PI);
  return { dLon, dLat };
}

/** WGS84 -> GCJ-02。境外坐标原样返回。 */
function wgs84ToGcj02(lon, lat) {
  if (outOfChina(lon, lat)) return [lon, lat];
  const { dLon, dLat } = delta(lon, lat);
  return [lon + dLon, lat + dLat];
}

/**
 * GCJ-02 -> WGS84。
 * 用一次偏移迭代反解，误差在 1 米以内（本项目用不到，留作通用工具）。
 */
function gcj02ToWgs84(lon, lat) {
  if (outOfChina(lon, lat)) return [lon, lat];
  const g = wgs84ToGcj02(lon, lat);
  return [lon * 2 - g[0], lat * 2 - g[1]];
}

/**
 * 两个经纬度之间的实际距离（米），用等距圆柱近似，几十公里内足够准。
 * 用来判断定位点是否离谱（见 utils/router.js 的吸附告警）。
 */
function metersBetween(lon1, lat1, lon2, lat2) {
  const dx = (lon2 - lon1) * 111320 * Math.cos(lat1 / 180 * PI);
  const dy = (lat2 - lat1) * 110540;
  return Math.sqrt(dx * dx + dy * dy);
}

module.exports = { outOfChina, wgs84ToGcj02, gcj02ToWgs84, metersBetween };
