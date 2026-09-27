/**
 * Throwaway probe: how well does the real timetable line up with the routing data?
 * Not part of the build. Run: node tools/_in/probe-cells.js
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', 'miniprogram', 'miniprogram');
const flow = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'traffic-flow.json'), 'utf8'));

const text = fs.readFileSync(path.join(__dirname, 'timetable-cells.csv'), 'utf8').replace(/^\uFEFF/, '');
const lines = text.split(/\r?\n/).filter(l => l.trim());
const split = line => {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (c === ',' && !q) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur); return out;
};
const rows = lines.slice(1).map(l => { const c = split(l); return { cls: c[0], size: c[1], weekday: c[2], period: c[3], cell: c[4] }; });

// --- course parser under test -------------------------------------------------------
// Two observed layouts:
//   93人2-4,8-16周01-02节/B座105 （多媒体教室）
//   93人10-17单周/05-06节/B座214 （多媒体教室）
// so the "/" before the period is optional.
const RE_COURSE = /(\d+)\s*人\s*([0-9,\-\u2013\u2014]+)\s*(单周|双周)?\s*周?\s*\/?\s*(\d{1,2})\s*(?:-\s*(\d{1,2}))?\s*节\s*\/\s*([\s\S]*?)(?=\s*\d+\s*人\s*[0-9]|$)/g;
function parseCell(cell) {
  const out = [];
  RE_COURSE.lastIndex = 0;
  let m;
  while ((m = RE_COURSE.exec(cell))) {
    let p1 = +m[4];
    let p2 = m[5] ? +m[5] : (p1 % 2 ? p1 + 1 : p1 - 1);   // single period -> its 2-period block
    if (p1 > p2) { const t = p1; p1 = p2; p2 = t; }
    out.push({ people: +m[1], weeks: m[2], parity: m[3] || '', p1, p2, room: m[6].trim() });
  }
  return out;
}
const failed = [];
const courseCounts = [];
let total = 0, ok = 0;
const periodsInCells = new Map();
const rooms = new Map();
for (const r of rows) {
  total++;
  const cs = parseCell(r.cell);
  courseCounts.push(cs.length);
  const covered = cs.reduce((s, c) => s + c.people, 0);
  if (!cs.length) failed.push(r);
  else ok++;
  for (const c of cs) {
    const k = c.p1 + '-' + c.p2;
    periodsInCells.set(k, (periodsInCells.get(k) || 0) + 1);
    rooms.set(c.room, (rooms.get(c.room) || 0) + 1);
  }
}
console.log('cells               =', total);
console.log('cells parsed        =', ok);
console.log('cells with 0 course =', failed.length);
failed.slice(0, 8).forEach(f => console.log('   FAIL', f.cls, f.period, JSON.stringify(f.cell).slice(0, 110)));
console.log('courses per cell    = 1:', courseCounts.filter(n => n === 1).length, ' 2:', courseCounts.filter(n => n === 2).length,
  ' 3+:', courseCounts.filter(n => n >= 3).length);
console.log('periods inside cells:', [...periodsInCells.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  .map(([k, n]) => k + ':' + n).join('  '));

// --- overlap with routing data ------------------------------------------------------
const classes = new Set(rows.map(r => r.cls));
const assign = new Set(Object.keys(flow.assignments || {}));
const hit = [...classes].filter(c => assign.has(c));
console.log('\nclasses in timetable =', classes.size, ' in assignments =', assign.size, ' overlap =', hit.length);
console.log('assignment classes not in timetable =', [...assign].filter(c => !classes.has(c)).length);
console.log('sample timetable classes:', [...classes].slice(0, 6).join(' | '));
console.log('sample assignment keys  :', [...assign].slice(0, 6).join(' | '));

const rules = flow.location_rules || {};
const norm = s => String(s)
  .replace(/[（(][^）)]*[）)]/g, '')      // （多媒体教室）
  .replace(/\s*分组\s*\d+/g, '')          // 外语网络楼104 分组02
  .replace(/\s*周[一二三四五]\s*\d+/g, '') // L303 周二34
  .replace(/\s+/g, '')
  .trim();
const roomKeys = new Set(Object.keys(rules).map(norm));
const roomList = [...rooms.keys()];
const roomHit = roomList.filter(r => roomKeys.has(norm(r)));
console.log('\ndistinct rooms in cells =', roomList.length, ' matched by location_rules =', roomHit.length);
const miss = roomList.filter(r => !roomKeys.has(norm(r)));
console.log('unmatched rooms =', miss.length);
miss.slice(0, 20).forEach(r => console.log('   MISS', JSON.stringify(r), 'x' + rooms.get(r)));
console.log('\nsample location_rules keys:', Object.keys(rules).slice(0, 12).join(' | '));
const inc = Object.keys(rules).filter(k => rules[k].status === 'included');
console.log('location_rules included =', inc.length, 'excluded =', Object.keys(rules).length - inc.length);
// how many cells' people are covered by matched rooms
let peopleAll = 0, peopleMatched = 0;
for (const r of rows) for (const c of parseCell(r.cell)) {
  peopleAll += c.people;
  if (roomKeys.has(norm(c.room))) peopleMatched += c.people;
}
console.log('people in cells =', peopleAll, ' with a known room =', peopleMatched,
  '(' + (100 * peopleMatched / peopleAll).toFixed(1) + '%)');

// --- effective coverage: does the room map to a road node? ---------------------------
const graph = require(path.join(ROOT, 'data', 'route-graph.js'));
const nodeIds = new Set(graph.nodeIds || []);
const locs = flow.locations || {};
let pIncluded = 0, pExcluded = 0, pUnknown = 0, pNoNode = 0;
const excludedRooms = new Map(), unknownRooms = new Map();
for (const r of rows) for (const c of parseCell(r.cell)) {
  const rule = rules[norm(c.room)];
  if (!rule) { pUnknown += c.people; unknownRooms.set(norm(c.room), (unknownRooms.get(norm(c.room)) || 0) + c.people); continue; }
  if (rule.status === 'excluded') { pExcluded += c.people; excludedRooms.set(norm(c.room), (excludedRooms.get(norm(c.room)) || 0) + c.people); continue; }
  const id = locs[rule.destination] && locs[rule.destination].road_node;
  if (!id || !nodeIds.has(id)) { pNoNode += c.people; continue; }
  pIncluded += c.people;
}
const pc = n => (100 * n / peopleAll).toFixed(1) + '%';
console.log('\neffective coverage of people:');
console.log('  maps to a road node :', pIncluded, pc(pIncluded));
console.log('  room excluded       :', pExcluded, pc(pExcluded));
console.log('  room unknown        :', pUnknown, pc(pUnknown));
console.log('  node not in graph   :', pNoNode, pc(pNoNode));
console.log('excluded rooms by people:');
[...excludedRooms.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).forEach(([k, v]) => console.log('   EXC', JSON.stringify(k), v));
console.log('unknown rooms by people:');
[...unknownRooms.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).forEach(([k, v]) => console.log('   UNK', JSON.stringify(k), v));

// --- session sharing / parity --------------------------------------------------------
const sessKey = c => [c.p1, c.p2, norm(c.room), c.people, c.weeks, c.parity].join('|');
const sess = new Map();
let parityCourses = 0;
for (const r of rows) for (const c of parseCell(r.cell)) {
  if (c.parity) parityCourses++;
  const k = sessKey(c);
  if (!sess.has(k)) sess.set(k, { n: 0, classes: new Set(), people: c.people });
  const s = sess.get(k);
  s.n++; s.classes.add(r.cls);
}
console.log('\ndistinct sessions =', sess.size, ' courses with 单/双周 =', parityCourses);
const shared = [...sess.values()].filter(s => s.classes.size > 1);
console.log('sessions listed by >1 class =', shared.length,
  ' (max participants =', Math.max.apply(null, [...sess.values()].map(s => s.classes.size)), ')');
console.log('sum(people of all course listings) =', [...sess.values()].reduce((a, s) => a + s.people * s.n, 0));
console.log('sum(people once per session)       =', [...sess.values()].reduce((a, s) => a + s.people, 0));
// does a session's 人数 equal the sum of participating class sizes?
const sizeOf = new Map();
for (const r of rows) if (!sizeOf.has(r.cls)) sizeOf.set(r.cls, Number(r.size) || 0);
let exact = 0, near = 0, off = 0;
for (const s of shared) {
  const sum = [...s.classes].reduce((a, c) => a + (sizeOf.get(c) || 0), 0);
  const d = Math.abs(sum - s.people);
  if (d <= 1) exact++; else if (d <= s.people * 0.1) near++; else off++;
}
console.log('shared sessions where Σ班级人数 ≈ 人数 : exact', exact, ' within10%', near, ' off', off);
const multi = [...sess.values()].filter(s => s.classes.size > 1).slice(0, 3);
multi.forEach(s => console.log('   sample shared session:', s.people, '人', 'classes =', [...s.classes].join('/'),
  ' Σsize =', [...s.classes].reduce((a, c) => a + (sizeOf.get(c) || 0), 0)));
