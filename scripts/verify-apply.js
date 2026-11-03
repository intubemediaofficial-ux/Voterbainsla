// Applies judged readings: corrected text becomes the main value, every other reading is kept in *_alt for search.
const fs = require('fs');
const path = require('path');
const { db } = require('../lib/db');
const { anyKey, normText } = require('../lib/keys');
const D = path.join(__dirname, '..', 'data', 'verify');
const judge = JSON.parse(fs.readFileSync(path.join(D, 'judge.json'), 'utf8'));
const clean = s => String(s || '').normalize('NFC').replace(/[.,;:०()]+$/g, '').replace(/्$/, '').replace(/^्/, '').replace(/\s+/g, ' ').trim();
const vidOk = s => /^[A-Z]{3}\d{7}$/.test(s) || /^RJ\/\d+\/\d+\/\d+$/.test(s);
const get = db.prepare('SELECT * FROM voters WHERE id=?');
const changes = [];
db.transaction(() => {
  for (const items of Object.values(judge)) for (const t of items) {
    const v = get.get(t.id);
    if (!v) continue;
    if (t.k === 'voter_id') {
      const j = clean(t.judge).replace(/\s/g, '');
      if (vidOk(j) && j !== v.voter_id) { db.prepare('UPDATE voters SET voter_id=? WHERE id=?').run(j, v.id); changes.push({ id: v.id, k: t.k, from: v.voter_id, to: j }); }
      continue;
    }
    const j = clean(t.judge);
    const final = j || v[t.k];
    const altCol = t.k === 'name' ? 'name_alt' : 'relative_alt';
    const alt = new Set(String(v[altCol] || '').split('|').filter(Boolean));
    for (const s of [v[t.k], clean(t.a), clean(t.b)]) if (s && s !== final) alt.add(s);
    alt.delete(final);
    const normCol = t.k === 'name' ? 'name_norm' : 'relative_norm', keyCol = t.k === 'name' ? 'name_key' : 'relative_key';
    db.prepare(`UPDATE voters SET ${t.k}=?, ${altCol}=?, ${normCol}=?, ${keyCol}=? WHERE id=?`).run(final, [...alt].join('|'), normText(final), anyKey(final), v.id);
    if (final !== v[t.k]) changes.push({ id: v.id, k: t.k, from: v[t.k], to: final });
  }
})();
fs.writeFileSync(path.join(D, 'changes.json'), JSON.stringify(changes, null, 1));
console.log(changes.length, 'values corrected');
