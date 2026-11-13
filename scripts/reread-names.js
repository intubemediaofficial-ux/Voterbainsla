// Re-reads names on already-indexed pages with the zoomed exact-spelling OCR and replaces misreads; old readings stay searchable in *_alt.
// Usage: node scripts/reread-names.js <area> [area...]   (CONC=3, FORCE=1 to redo pages already re-read, PAGES=id,id to limit)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { db } = require('../lib/db');
const { readNames } = require('../lib/ocr');
const { anyKey, normText } = require('../lib/keys');

const UP = path.join(__dirname, '..', 'uploads');
const OUT = path.join(__dirname, '..', 'data', 'reread');
fs.mkdirSync(OUT, { recursive: true });
const clean = s => String(s || '').normalize('NFC').replace(/[.,;:०()]+$/g, '').replace(/्$/, '').replace(/^्/, '').replace(/\s+/g, ' ').trim();
// ं and न्/म् before a consonant print differently but are the same name; keep the stored one then.
const same = (a, b) => { const f = s => s.replace(/[नम]्(?=[क-ह])/g, 'ं').replace(/ /g, ''); return f(a) === f(b); };
const vid = s => String(s || '').replace(/\s/g, '').toUpperCase();
function lev(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
// Guards against a reading that belongs to a different box: the new spelling must still sound like the old one.
const close = (a, b) => {
  const x = anyKey(a).replace(/ /g, ''), y = anyKey(b).replace(/ /g, '');
  return lev(x, y) <= Math.max(2, Math.ceil(Math.max(x.length, y.length) * 0.4));
};

function pageImage(p) {
  const f = path.join(UP, path.basename(p.stored_file));
  if (fs.existsSync(f)) return { file: f };
  const m = /^([0-9a-f]{16})-p-(\d+)\.jpg$/.exec(path.basename(p.stored_file));
  const pdf = m && path.join(UP, `${m[1]}.pdf`);
  if (!pdf || !fs.existsSync(pdf)) return null;
  const root = path.join(os.tmpdir(), `reread-${p.id}`), n = String(Number(m[2]));
  execFileSync('pdftoppm', ['-r', '150', '-jpeg', '-jpegopt', 'quality=70', '-f', n, '-l', n, '-singlefile', pdf, root]);
  return { file: root + '.jpg', tmp: true };
}

const rowsOf = db.prepare('SELECT * FROM voters WHERE page_id=?');
const log = fs.createWriteStream(path.join(OUT, 'changes.jsonl'), { flags: 'a' });
function apply(p, reading) {
  const bySerial = new Map();
  for (const r of reading) { const s = String(r.serial_no || '').trim(); if (s && !bySerial.has(s)) bySerial.set(s, r); }
  let changed = 0;
  db.transaction(() => {
    for (const v of rowsOf.all(p.id)) {
      const r = bySerial.get(String(v.serial_no).trim());
      if (!r || (vid(r.voter_id) && vid(v.voter_id) && vid(r.voter_id) !== vid(v.voter_id))) continue;
      for (const [k, altCol, normCol, keyCol] of [['name', 'name_alt', 'name_norm', 'name_key'], ['relative_name', 'relative_alt', 'relative_norm', 'relative_key']]) {
        const now = clean(r[k]);
        if (!now || now === v[k] || (v[k] && same(now, v[k])) || (v[k] && !close(now, v[k]))) continue;
        const alt = new Set(String(v[altCol] || '').split('|').filter(Boolean));
        if (v[k]) alt.add(v[k]);
        alt.delete(now);
        db.prepare(`UPDATE voters SET ${k}=?, ${altCol}=?, ${normCol}=?, ${keyCol}=? WHERE id=?`).run(now, [...alt].join('|'), normText(now), anyKey(now), v.id);
        log.write(JSON.stringify({ id: v.id, page: p.id, serial: v.serial_no, k, from: v[k], to: now }) + '\n');
        changed++;
      }
    }
  })();
  return changed;
}

(async () => {
  const areas = process.argv.slice(2);
  if (!areas.length) throw new Error('Give at least one area key');
  const pages = db.prepare(`SELECT id, area, stored_file, ward_no, page_no FROM pages WHERE status='ready' AND record_count>0 AND area IN (${areas.map(() => '?').join(',')})
    ORDER BY CAST(ward_no AS INT), CAST(page_no AS INT)`).all(...areas)
    .sort((a, b) => areas.indexOf(a.area) - areas.indexOf(b.area))
    .filter(p => !process.env.PAGES || process.env.PAGES.split(',').includes(String(p.id)))
    .filter(p => process.env.FORCE || !fs.existsSync(path.join(OUT, p.id + '.json')));
  console.log(`${pages.length} pages to re-read`);
  let i = 0, total = 0;
  const worker = async () => {
    while (i < pages.length) {
      const p = pages[i++];
      const img = pageImage(p);
      if (!img) { console.log(`skip page ${p.id}: no image or PDF`); continue; }
      try {
        for (;;) {
          try {
            const reading = await readNames(img.file);
            fs.writeFileSync(path.join(OUT, p.id + '.json'), JSON.stringify(reading));
            const n = apply(p, reading);
            total += n;
            console.log(`${p.area} W${p.ward_no} P${p.page_no}: ${n} fixed (total ${total})`);
            break;
          } catch (e) {
            if (!/quota|exhausted|Gemini|demand|fetch/i.test(e.message)) { console.log(`FAIL page ${p.id}: ${e.message}`); break; }
            await new Promise(r => setTimeout(r, 10 * 60e3));
          }
        }
      } finally { if (img.tmp) fs.rmSync(img.file, { force: true }); }
    }
  };
  await Promise.all(Array.from({ length: Number(process.env.CONC || 3) }, worker));
  console.log(`done, ${total} names fixed`);
})();
