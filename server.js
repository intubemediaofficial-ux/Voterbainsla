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
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: '5m' }));

app.get('/api/stats', (_req, res) => {
  const row = db.prepare(`SELECT COUNT(*) pages, COALESCE(SUM(record_count),0) voters,
    COALESCE(SUM(status='processing'),0) processing, COALESCE(SUM(status='error'),0) errors FROM pages`).get();
  const wards = db.prepare("SELECT DISTINCT ward_no FROM pages WHERE status='ready' AND ward_no<>'' ORDER BY CAST(ward_no AS INTEGER)").all().map(x => x.ward_no);
  res.json({ ...row, wards });
});

const allVoters = db.prepare(`SELECT v.*, p.total_pages, p.assembly_name, p.polling_station, p.stored_file
  FROM voters v JOIN pages p ON p.id=v.page_id`);

let cache = { sig: '', rows: [] };
function voters() {
  const sig = JSON.stringify(db.prepare('SELECT count(*) c, max(id) m FROM voters').get());
  if (sig !== cache.sig) {
    cache = { sig, rows: allVoters.all().map(v => ({ ...v, nw: match.words(v.name), rw: match.words(v.relative_name) })) };
  }
  return cache.rows;
}
const order = (x, y) => y.score - x.score || Number(x.ward_no) - Number(y.ward_no) ||
  Number(x.page_no) - Number(y.page_no) || Number(x.serial_no) - Number(y.serial_no);
const clean = ({ nw, rw, ...v }) => v;

app.get('/api/search', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 120);
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
      const a = match.fieldScore(nq, v.nw);
      if (!a) continue;
      const b = match.fieldScore(rq, v.rw);
      const near = b ? 0 : Math.round(40 * Math.max(0, ...v.rw.map(w => Math.max(...rq.map(r => match.sim(r, w))))));
      rows.push({ ...v, score: a + (b ? b + 50 : near), rel_match: b > 0 });
    }
    rows.sort(order);
    return res.json({ query: q, mode: 'name+relative', exact: rows.some(r => r.rel_match), results: rows.slice(0, 120).map(clean) });
  }
  const qw = match.words(q);
  const rows = [];
  for (const v of voters()) {
    const a = match.fieldScore(qw, v.nw), b = match.fieldScore(qw, v.rw) * 0.9;
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
