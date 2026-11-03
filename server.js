const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { db, saveExtraction, failPage, upsertPage } = require('./lib/db');
const { extractPage } = require('./lib/ocr');
const match = require('./lib/match');

const app = express();
const PORT = Number(process.env.PORT || 3580);
const uploadDir = path.join(__dirname, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(5).toString('hex')}${path.extname(file.originalname).toLowerCase() || '.jpg'}`)
  }),
  limits: { fileSize: 16 * 1024 * 1024, files: 100 },
  fileFilter: (_req, file, cb) => cb(null, /^image\/(jpeg|png|webp)$/.test(file.mimetype))
});

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: 0 }));

app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

app.get('/api/stats', (_req, res) => {
  const row = db.prepare(`SELECT COUNT(*) pages, COALESCE(SUM(record_count),0) voters,
    COALESCE(SUM(status='processing'),0) processing, COALESCE(SUM(status='error'),0) errors FROM pages`).get();
  const wards = db.prepare("SELECT DISTINCT ward_no FROM pages WHERE status='ready' AND ward_no<>'' ORDER BY CAST(ward_no AS INTEGER)").all().map(x => x.ward_no);
  res.json({ ...row, wards });
});

const allVoters = db.prepare(`SELECT v.*, p.total_pages, p.assembly_name, p.polling_station, p.stored_file
  FROM voters v JOIN pages p ON p.id=v.page_id`);

// Each field keeps its other OCR readings (name_alt, '|' separated) so a misread spelling still finds the voter.
const alts = (main, alt) => [main, ...String(alt || '').split('|')].map(s => match.words(s)).filter(w => w.length);
const best = (qw, list) => Math.max(0, ...list.map(fw => match.fieldScore(qw, fw)));
let cache = { sig: '', rows: [] };
function allRows() {
  const sig = JSON.stringify(db.prepare("SELECT count(*) c, max(id) m, total(length(name)+length(coalesce(relative_name,''))+length(coalesce(name_alt,''))+length(coalesce(relative_alt,''))) l FROM voters").get());
  if (sig !== cache.sig) {
    cache = { sig, rows: allVoters.all().map(v => ({ ...v, nw: alts(v.name, v.name_alt), rw: alts(v.relative_name, v.relative_alt) })) };
  }
  return cache.rows;
}
const order = (x, y) => y.score - x.score || Number(x.ward_no) - Number(y.ward_no) ||
  (Number(x.page_no) || 999) - (Number(y.page_no) || 999) || Number(x.serial_no) - Number(y.serial_no);
const clean = ({ nw, rw, name_alt, relative_alt, name_norm, relative_norm, name_key, relative_key, ...v }) => v;

app.get('/api/ward/:ward', (req, res) => {
  const ward = String(req.params.ward).trim();
  const rows = allRows().filter(v => v.ward_no === ward).map(v => ({ ...v, score: 0 })).sort(order);
  res.json({ ward, count: rows.length, results: rows.map(clean) });
});

app.get('/api/search', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 120);
  const ward = String(req.query.ward || '').trim();
  const voters = () => ward ? allRows().filter(v => v.ward_no === ward) : allRows();
  if (q.length < 2) return res.json({ query: q, results: [] });
  if (/^\d+$/.test(q)) {
    const rows = voters().filter(v => v.serial_no === q || v.house_no === q).map(v => ({ ...v, score: v.serial_no === q ? 100 : 50 }));
    return res.json({ query: q, results: rows.sort(order).slice(0, 80).map(clean) });
  }
  if (/\d/.test(q) && /^[a-z0-9]+$/i.test(q)) {
    const id = q.toUpperCase();
    const rows = voters().filter(v => (v.voter_id || '').toUpperCase().includes(id)).map(v => ({ ...v, score: 100 }));
    return res.json({ query: q, results: rows.sort(order).slice(0, 80).map(clean) });
  }
  const parts = q.split(/\s*[-\u2013\u2014\/]+\s*/).filter(Boolean);
  if (parts.length >= 2) {
    const nq = match.words(parts[0]), rq = match.words(parts.slice(1).join(' '));
    const rows = [];
    for (const v of voters()) {
      const a = best(nq, v.nw);
      if (!a) continue;
      const b = best(rq, v.rw);
      const near = b ? 0 : Math.round(40 * Math.max(0, ...v.rw.flat().map(w => Math.max(...rq.map(r => match.sim(r, w))))));
      rows.push({ ...v, score: a + (b ? b + 50 : near), rel_match: b > 0 });
    }
    rows.sort(order);
    return res.json({ query: q, mode: 'name+relative', exact: rows.some(r => r.rel_match), results: rows.slice(0, 120).map(clean) });
  }
  const qw = match.words(q);
  const rows = [];
  for (const v of voters()) {
    const a = best(qw, v.nw), b = best(qw, v.rw) * 0.9;
    if (a || b) rows.push({ ...v, score: Math.max(a, b), matched: a >= b ? 'name' : 'relative' });
  }
  res.json({ query: q, results: rows.sort(order).slice(0, 120).map(clean) });
});

app.get('/api/source/:id', (req, res) => {
  const row = db.prepare('SELECT p.stored_file FROM voters v JOIN pages p ON p.id=v.page_id WHERE v.id=?').get(Number(req.params.id));
  if (!row) return res.sendStatus(404);
  const file = path.join(uploadDir, path.basename(row.stored_file));
  if (!fs.existsSync(file)) return res.sendStatus(404);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.sendFile(file);
});

app.post('/api/upload', upload.array('photos', 100), (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'Select at least one JPG, PNG or WebP photo.' });
  for (const file of files) {
    const pageId = Number(upsertPage.get({ source_file: file.originalname, stored_file: file.filename }).id);
    processPhoto(file, pageId);
  }
  res.status(202).json({ accepted: files.length, message: 'Photos are being indexed. You can keep using search.' });
});

async function processPhoto(file, pageId) {
  try {
    const data = await extractPage(file.path);
    saveExtraction(file.originalname, file.filename, data);
  } catch (err) {
    failPage.run(String(err.message).slice(0, 1000), pageId);
  }
}

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(400).json({ error: err.message || 'Request failed' });
});
app.listen(PORT, '127.0.0.1', () => console.log(`Voter Search listening on http://127.0.0.1:${PORT}`));
