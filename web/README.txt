中南大学校园交通热度网页端

使用方式：
1. 保持文件夹结构不变，双击 traffic-flow.html 打开热度地图。
2. 页面右上角可以切换 2D / 3D。
3. 2D 页面支持鼠标滚轮缩放，双击地图恢复视图。
4. map-3d.html 也可以单独打开，使用鼠标旋转、平移和滚轮缩放。

网页文件：
- traffic-flow.html：预测通行热度页面，包含 2D/3D 切换。
- map-3d.html：三维校园路网页面。
- index.html：基础校园地图页面。
- traffic-heatmap.svg：已着色的黄→橙→红热度地图。

数据文件：
- traffic-flow.json / traffic-flow.js：课表模拟、道路流量和热度数据。
- graph-edges.geojson / graph-nodes.geojson：路网拓扑数据。
- roads.geojson、campus-map.geojson、campus-boundaries.geojson：底图和道路数据。
- buildings-3d.geojson：3D 建筑数据。
- metadata.json：数据来源和范围说明。

说明：
- 模拟范围为中南大学新校区与南校区。
- E001—E006、E004—E016 的现场连接已加入；E019 天桥不计入机动车路线。
- U001 为用户标注的替代走廊，按 50% 分流纳入热度。
- 数据为课表预测结果，不是实时人流。
- 需要联网的外部底图功能可能受浏览器跨域或网络策略影响；热度页面本身使用本地 SVG，可离线查看。

数据来源：OpenStreetMap，© OpenStreetMap contributors，ODbL 1.0。
https://www.openstreetmap.org/copyright
