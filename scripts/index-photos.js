const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { extractPage } = require('../lib/ocr');
const { db, saveExtraction, failPage, upsertPage } = require('../lib/db');
const readyPage = db.prepare("SELECT 1 FROM pages WHERE source_file=? AND status='ready'");

const listFile = process.argv[2] || path.join(__dirname, '..', 'images.list');
const files = fs.readFileSync(listFile, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
const uploadDir = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
let next = 0, completed = 0;
const concurrency = Math.max(1, Number(process.env.OCR_CONCURRENCY || 3));
console.log(`Indexing ${files.length} photos with concurrency ${concurrency}`);

async function worker() {
  while (true) {
    const i = next++;
    if (i >= files.length) return;
    const source = files[i];
    if (!process.env.FORCE && readyPage.get(path.basename(source))) { completed++; continue; }
    const hash = crypto.createHash('sha1').update(fs.readFileSync(source)).digest('hex').slice(0, 12);
    const storedName = `${hash}${path.extname(source).toLowerCase() || '.jpg'}`;
    const dest = path.join(uploadDir, storedName);
    if (!fs.existsSync(dest)) fs.copyFileSync(source, dest);
    try {
      const data = await extractPage(dest);
      const saved = saveExtraction(path.basename(source), storedName, data);
      completed++;
      console.log(`[${completed}/${files.length}] ${path.basename(source)} -> ward ${saved.ward}, page ${saved.page}, ${saved.count} voters`);
    } catch (err) {
      const id = Number(upsertPage.get({ source_file: path.basename(source), stored_file: storedName }).id);
      failPage.run(String(err.message).slice(0, 1000), id);
      completed++;
      console.error(`[${completed}/${files.length}] FAILED ${path.basename(source)}: ${err.message}`);
    }
  }
}
Promise.all(Array.from({ length: concurrency }, worker)).then(() => {
  const stats = db.prepare("SELECT COUNT(*) pages, SUM(record_count) voters, SUM(status='error') errors FROM pages").get();
  console.log('Done:', stats);
});
