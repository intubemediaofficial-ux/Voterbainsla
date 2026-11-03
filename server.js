const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { db, saveExtraction, failPage, upsertPage } = require('./lib/db');
const { extractPage } = require('./lib/ocr');
const { anyKey, normText } = require('./lib/keys');

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
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: '5m' }));

app.get('/api/stats', (_req, res) => {
  const row = db.prepare(`SELECT COUNT(*) pages, COALESCE(SUM(record_count),0) voters,
    COALESCE(SUM(status='processing'),0) processing, COALESCE(SUM(status='error'),0) errors FROM pages`).get();
  const wards = db.prepare("SELECT DISTINCT ward_no FROM pages WHERE status='ready' AND ward_no<>'' ORDER BY CAST(ward_no AS INTEGER)").all().map(x => x.ward_no);
  res.json({ ...row, wards });
});

app.get('/api/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ query: q, results: [] });
  const n = normText(q);
  const k = anyKey(q).replace(/\s/g, '');
  const digits = q.replace(/\D/g, '');
  const rows = db.prepare(`SELECT v.*, p.total_pages, p.assembly_name, p.polling_station, p.stored_file,
    CASE
      WHEN v.name_norm = @n THEN 100
      WHEN replace(v.name_key,' ','') = @k AND @k <> '' THEN 96
      WHEN v.name_norm LIKE @np THEN 92
      WHEN replace(v.name_key,' ','') LIKE @kp AND length(@k)>=3 THEN 87
      WHEN v.relative_norm = @n THEN 82
      WHEN replace(v.relative_key,' ','') = @k AND @k <> '' THEN 80
      WHEN v.relative_norm LIKE @np THEN 76
      WHEN v.serial_no = @digits AND @digits <> '' THEN 72
      WHEN v.voter_id LIKE @qp THEN 70
      ELSE 0 END score
    FROM voters v JOIN pages p ON p.id=v.page_id
    WHERE v.name_norm LIKE @contains OR replace(v.name_key,' ','') LIKE @kcontains
       OR v.relative_norm LIKE @contains OR replace(v.relative_key,' ','') LIKE @kcontains
       OR (v.serial_no=@digits AND @digits<>'') OR v.voter_id LIKE @qp
    ORDER BY score DESC, CAST(v.ward_no AS INTEGER), CAST(v.page_no AS INTEGER), CAST(v.serial_no AS INTEGER)
    LIMIT 80`).all({ n, k, np: `${n}%`, kp: `${k}%`, contains: `%${n}%`, kcontains: `%${k}%`, digits, qp: `%${q.toUpperCase()}%` });
  res.json({ query: q, results: rows });
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
