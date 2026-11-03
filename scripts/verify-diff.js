// Compares stored OCR rows with the second-pass readings in data/verify and prints/saves the disagreements.
const fs = require('fs');
const path = require('path');
const { db } = require('../lib/db');
const D = path.join(__dirname, '..', 'data', 'verify');
const norm = s => String(s || '').normalize('NFC').replace(/\s+/g, ' ').trim();
const out = [];
for (const p of db.prepare("SELECT id, ward_no, page_no FROM pages WHERE status='ready' ORDER BY id").all()) {
  const f = path.join(D, p.id + '.json');
  if (!fs.existsSync(f)) continue;
  const v = JSON.parse(fs.readFileSync(f, 'utf8'));
  const bySerial = new Map();
  for (const r of v) if (!bySerial.has(norm(r.serial_no))) bySerial.set(norm(r.serial_no), r);
  for (const r of db.prepare('SELECT id, serial_no, voter_id, name, relative_name FROM voters WHERE page_id=?').all(p.id)) {
    const n = bySerial.get(norm(r.serial_no));
    if (!n) continue;
    const diff = {};
    for (const k of ['name', 'relative_name']) if (norm(n[k]) && norm(n[k]) !== norm(r[k])) diff[k] = [r[k], norm(n[k])];
    const vid = norm(n.voter_id).replace(/\s/g, '');
    if (vid && vid !== norm(r.voter_id).replace(/\s/g, '')) diff.voter_id = [r.voter_id, vid];
    if (Object.keys(diff).length) out.push({ id: r.id, page: p.id, ward: p.ward_no, pg: p.page_no, serial: r.serial_no, diff });
  }
}
fs.writeFileSync(path.join(D, 'diff.json'), JSON.stringify(out, null, 1));
console.log(out.length, 'rows differ');
if (process.argv[2]) for (const o of out.slice(0, +process.argv[2])) console.log(o.id, `W${o.ward} P${o.pg} S${o.serial}`, Object.entries(o.diff).map(([k, [a, b]]) => `${k}: ${a} -> ${b}`).join(' ; '));
