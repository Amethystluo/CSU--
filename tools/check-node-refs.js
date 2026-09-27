// 检查 assignments 的 dorm_node / locations 的 road_node 是否都能对上可路由节点
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./paths.js');
const D = path.join(ROOT, 'data');
const flow = JSON.parse(fs.readFileSync(path.join(D, 'traffic-flow.json'), 'utf8'));
const nodes = JSON.parse(fs.readFileSync(path.join(D, 'graph-nodes.json'), 'utf8'));

const kindOf = new Map(nodes.features.map(f => [f.properties.id, f.properties.kind]));
const coordOf = new Map(nodes.features.map(f => [f.properties.id, f.geometry.coordinates]));

const dormNodes = [...new Set(Object.values(flow.assignments).map(a => a.dorm_node))];
const locNodes = Object.values(flow.locations).map(l => l.road_node);
const all = [...new Set(dormNodes.concat(locNodes))];

const byKind = {};
all.forEach(id => { const k = kindOf.get(id) || '缺失'; byKind[k] = (byKind[k] || 0) + 1; });
console.log('用到的节点 id 共', all.length, '个，按类型:');
Object.entries(byKind).forEach(([k, v]) => console.log(`   ${k}: ${v}`));
console.log('');
const building = all.filter(id => kindOf.get(id) === 'building');
console.log('其中是"建筑节点"（不可路由）的:', building.length, building.slice(0, 10).join(', '));
const missing = all.filter(id => !kindOf.has(id));
console.log('图里找不到的:', missing.length, missing.slice(0, 10).join(', '));
