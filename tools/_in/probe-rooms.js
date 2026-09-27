/** Follow-up probe: what are the empty / odd room strings? Run: node tools/_in/probe-rooms.js */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', 'miniprogram', 'miniprogram');
const flow = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'traffic-flow.json'), 'utf8'));
const rules = flow.location_rules || {};

const text = fs.readFileSync(path.join(__dirname, 'timetable-cells.csv'), 'utf8').replace(/^\uFEFF/, '');
const split = line => {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (c === ',' && !q) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur); return out;
};
const rows = text.split(/\r?\n/).filter(l => l.trim()).slice(1)
  .map(l => { const c = split(l); return { cls: c[0], size: c[1], weekday: c[2], period: c[3], cell: c[4] }; });

const RE = /(\d+)\s*人\s*([0-9,\-\u2013\u2014]+)\s*(单周|双周)?\s*周?\s*\/?\s*(\d{1,2})\s*(?:-\s*(\d{1,2}))?\s*节\s*(\/\s*([\s\S]*?))?(?=\s*\d+\s*人\s*[0-9]|$)/g;
const norm = s => String(s)
  .replace(/[（(][^）)]*[）)]/g, '')
  .replace(/\s*分组\s*\d+/g, '')
  .replace(/\s*周[一二三四五]\s*\d+/g, '')
  .replace(/\s+/g, '').trim();

const empty = [], groupy = [];
let nEmpty = 0, nGroup = 0;
for (const r of rows) {
  RE.lastIndex = 0; let m;
  while ((m = RE.exec(r.cell))) {
    const raw = m[7] === undefined ? null : m[7].trim();
    const n = +m[1];
    if (raw === null || raw === '') { nEmpty++; if (empty.length < 12) empty.push([r.cls, r.period, r.cell.slice(0, 90)]); continue; }
    const k = norm(raw);
    if (k === '' || k === '分组') { nGroup++; if (groupy.length < 12) groupy.push([raw, r.cls, r.period]); }
  }
}
console.log('courses with NO room part =', nEmpty);
empty.forEach(e => console.log('   ', e[0], e[1], JSON.stringify(e[2])));
console.log('\ncourses whose room normalises to empty/分组 =', nGroup);
groupy.forEach(e => console.log('   ', JSON.stringify(e[0]), e[1], e[2]));

// raw room strings that normalise to a key NOT present in location_rules, by people
const people = new Map();
for (const r of rows) {
  RE.lastIndex = 0; let m;
  while ((m = RE.exec(r.cell))) {
    const raw = (m[7] || '').trim();
    const k = norm(raw);
    if (k && !rules[k]) people.set(raw, (people.get(raw) || 0) + (+m[1]));
  }
}
console.log('\ntop unmatched raw room strings (of', people.size, '):');
[...people.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).forEach(([k, v]) => console.log('   ', v, JSON.stringify(k)));

// which of those could be matched by prefix (building name) instead of exact?
let recov = 0;
for (const [raw, v] of people) {
  const k = norm(raw);
  const hit = Object.keys(rules).find(x => x && (k.startsWith(norm(x)) || norm(x).startsWith(k)));
  if (hit) recov += v;
}
console.log('people recoverable by prefix match =', recov);
