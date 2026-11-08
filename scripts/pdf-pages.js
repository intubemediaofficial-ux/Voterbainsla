// One-off: for pages that came from uploaded PDFs and are already read, delete the page JPG and keep only the PDF.
// /api/source renders the page from the PDF on demand. Photo uploads are left untouched.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db } = require('../lib/db');
const { dropPageImage } = require('../lib/ingest');

const uploadDir = path.join(__dirname, '..', 'uploads');
let freed = 0, dropped = 0;
for (const j of db.prepare("SELECT stored FROM jobs WHERE kind='pdf'").all()) {
  const pdf = path.join(uploadDir, j.stored);
  if (!fs.existsSync(pdf)) continue;
  const hash = crypto.createHash('sha1').update(fs.readFileSync(pdf)).digest('hex').slice(0, 16);
  const keep = path.join(uploadDir, `${hash}.pdf`);
  if (!fs.existsSync(keep)) fs.linkSync(pdf, keep);
  for (const p of db.prepare("SELECT stored_file FROM pages WHERE status='ready' AND stored_file LIKE ?").all(`${hash}-p-%`)) {
    const f = path.join(uploadDir, p.stored_file);
    if (!fs.existsSync(f)) continue;
    freed += fs.statSync(f).size;
    dropPageImage(p.stored_file);
    dropped++;
  }
}
console.log(`dropped ${dropped} page images, freed ${(freed / 1e6).toFixed(0)} MB`);
