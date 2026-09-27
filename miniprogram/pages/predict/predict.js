// 预测结果在构建阶段写入页面，避免开发者工具加载大型本地数据文件时页面空白。
const topRoads=[
  {rank:1,name:'现场补充连接 E004—E016',trips:'4,372,292',peak:'19,220'},
  {rank:2,name:'道路 E004',trips:'4,372,292',peak:'19,220'},
  {rank:3,name:'道路 E016',trips:'4,372,292',peak:'19,220'},
  {rank:4,name:'道路 E350',trips:'4,356,288',peak:'19,164'},
  {rank:5,name:'道路 E351',trips:'4,356,288',peak:'19,164'}
];
Page({data:{mode:'2d',summary:{student_movements:'7,145,584',roads_with_flow:'219',modelled_classes:'1,090'},topRoads,peakTotal:'19,220'},set2d(){this.setData({mode:'2d'})},set3d(){this.setData({mode:'3d'})},back(){wx.navigateBack()}})
