// Backfill village/mohalla headings for pages indexed before sections were extracted, then assign each voter its village.
const path = require('path');
try { process.loadEnvFile(process.env.ENV_FILE || path.join(__dirname, '..', 'data', '.env')); } catch {}
const { db, assignVillages } = require('../lib/db');
const { extractSections } = require('../lib/ocr');

const uploads = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
const where = process.argv[2] ? 'AND area=?' : '';
const pages = db.prepare(`SELECT id, area, stored_file FROM pages WHERE status='ready' AND sections IS NULL ${where} ORDER BY area, id`).all(...process.argv.slice(2, 3));
const save = db.prepare('UPDATE pages SET sections=?, main_village=COALESCE(NULLIF(?,\'\'),main_village) WHERE id=?');
let next = 0, done = 0, failed = 0;
async function worker() {
  while (next < pages.length) {
    const p = pages[next++];
    try {
      const d = await extractSections(path.join(uploads, p.stored_file));
      save.run(JSON.stringify(d.sections || []), String(d.main_village || '').trim(), p.id);
      done++;
    } catch (err) {
      failed++;
      console.error(p.id, p.stored_file, String(err.message).slice(0, 160));
      if (/quota is used up/.test(err.message)) { next = pages.length; }
    }
    if ((done + failed) % 25 === 0) console.log(`${done + failed}/${pages.length} done=${done} failed=${failed}`);
  }
}
(async () => {
  await Promise.all(Array.from({ length: Number(process.env.OCR_CONCURRENCY || 3) }, worker));
  for (const a of db.prepare("SELECT DISTINCT area FROM pages WHERE status='ready'").all()) console.log(a.area, 'voters updated:', assignVillages(a.area));
  console.log({ pages: pages.length, done, failed });
})();
