/**
 * 日程数据：**事件**与**校历覆盖（放假 / 调休）**。
 *
 * 默认是空的 —— 不编造学校里没发生过的活动。
 * 小程序里可以自己新增（存在本机，见 utils/eventStore.js）；
 * `samples` 里放了两条示例，点一下「载入示例」就能看到效果。
 *
 * 事件字段（详见 utils/events.js）：
 *   title        活动名，如「2026 秋季校运会」
 *   type         sports / jobfair / exam / lecture / show / assembly / other
 *   date         'YYYY-MM-DD'
 *   start, end   'HH:MM'
 *   leadMin      到场提前量（默认按活动类型）
 *   venue        场馆，取自 data/landmarks.js 的地标名
 *   venuePoint   {x, y} 自定义点（地图点选），与 venue 二选一
 *   grades       ['26','25']  参加年级（空 = 全部）
 *   departments  ['机械','机械类']  参加专业（空 = 全部）—— 数据里没有院系字段，
 *                班级名只到"专业 / 大类"一级，界面按"学院（前两字粗分）"帮你勾
 *   headcount    预计人数（0 = 按选中人群的实际人数）
 *   note         备注
 *
 * 校历覆盖字段：
 *   { date: '2026-10-01', kind: 'holiday' }                  放假
 *   { date: '2026-10-10', kind: 'makeup', asWeekday: 4 }     调休：周六补周四的课
 */
module.exports = {
  note: '默认空：事件由使用者自己录入（小程序内的「事件与校历」页），或把学校官方安排填在这里',
  events: [],
  dayOverrides: [],

  /** 示例：只为演示效果，不是学校里真实发生过的活动。 */
  samples: {
    note: '示例数据，仅用于演示；点「载入示例」后可以随时删除',
    events: [
      {
        id: 'sample-sports',
        title: '示例 · 校运会',
        type: 'sports',
        date: '',
        start: '08:00',
        end: '17:00',
        venue: '新校体育场“鸟巢”西门',
        grades: [],
        departments: [],
        headcount: 3000,
        note: '全校参加，集中入场',
      },
      {
        id: 'sample-jobfair',
        title: '示例 · 机械学院双选会',
        type: 'jobfair',
        date: '',
        start: '09:00',
        end: '16:00',
        venue: '南校礼堂',
        grades: ['26'],
        departments: ['机械', '机械类', '机械D', '机械T'],
        headcount: 0,
        note: '按学院 + 年级选人，人数留空=按实际在校人数',
      },
      {
        id: 'sample-exam',
        title: '示例 · 全校大学英语考试',
        type: 'exam',
        date: '',
        start: '09:00',
        end: '11:00',
        venue: '第二教学楼',
        grades: ['25'],
        departments: [],
        headcount: 0,
        note: '只按年级选人',
      },
    ],
    dayOverrides: [
      { date: '', kind: 'holiday', note: '示例：放假一天' },
      { date: '', kind: 'makeup', asWeekday: 4, note: '示例：周六补周四的课' },
    ],
  },
};
