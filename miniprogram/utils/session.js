/**
 * 跨页面共享的规划输入。
 *
 * 路线页把当前情景写进来，点选页读出来 —— 这样点选页画出来的热度层、
 * 封闭路段与路线页完全一致，用户不会在两个页面看到两张不同的图。
 *
 * 模块二级页（pages/panel）也走这里：面板里改的每一项配置都先写进 session，
 * 再由路线页在 onShow 时统一读取并重算 —— **重算逻辑只有路线页一份**，
 * 二级页只负责改参数和显示，不复制任何业务计算。
 */
const state = {
  // ↓ 点选页也要读的（保证两页画同一张图）
  level: 'none',          // 天气档位
  closedList: [],         // 直接封路：[{ei, roadType, label}]
  avoidPolice: false,     // 是否绕开交警

  // ↓ 只有模块二级页会改的
  dateISO: '',            // 看哪一天（'' = 今天）
  timeChoice: 'auto',     // 看哪个时段（'auto' / 'peak' / 'worst' / 时段 key）
  timeIndex: 0,           // 时段选择器下标
  weatherChoice: 'auto',  // 天气选择（'auto' = 联网，否则是档位 key）
  weatherIndex: 0,
  eventInclude: {},       // 事件 id -> 是否计入（false 才排除）
  mode: 'quiet',          // 三种走法
  wantTracking: false,    // 是否开启实时定位
};

function get() {
  return state;
}

function patch(p) {
  Object.keys(p).forEach(k => { state[k] = p[k]; });
  return state;
}

/** 只取"配置类"字段，用于路线页判断是否有变化。 */
function config() {
  return {
    dateISO: state.dateISO,
    timeChoice: state.timeChoice,
    timeIndex: state.timeIndex,
    weatherChoice: state.weatherChoice,
    weatherIndex: state.weatherIndex,
    level: state.level,
    closedList: state.closedList,
    avoidPolice: state.avoidPolice,
    eventInclude: state.eventInclude,
    mode: state.mode,
    wantTracking: state.wantTracking,
  };
}

module.exports = { get, patch, config };
