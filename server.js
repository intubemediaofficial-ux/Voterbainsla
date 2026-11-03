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

function editSim(a, b) {
  if (!a || !b) return 0;
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return 1 - d[b.length] / Math.max(a.length, b.length);
}

function partScore(norm, key, n, k) {
  key = (key || '').replace(/\s/g, '');
  if (!n && !k) return 0;
  if (n && norm === n) return 100;
  if (k && key === k) return 96;
  if (n && norm.startsWith(n)) return 90;
  if (k.length >= 2 && key.startsWith(k)) return 85;
  if (n.length >= 2 && norm.includes(n)) return 72;
  if (k.length >= 3 && key.includes(k)) return 68;
  const sim = k.length >= 3 ? Math.max(editSim(key, k), editSim(key.slice(0, k.length), k)) : 0;
  return sim >= 0.7 ? Math.round(60 * sim) : 0;
}

function comboSearch(namePart, relPart) {
  const [n1, k1] = [normText(namePart), anyKey(namePart).replace(/\s/g, '')];
  const [n2, k2] = [normText(relPart), anyKey(relPart).replace(/\s/g, '')];
  const scored = [];
  for (const v of allVoters.all()) {
    const a = partScore(v.name_norm || '', v.name_key, n1, k1);
    if (!a) continue;
    const b = partScore(v.relative_norm || '', v.relative_key, n2, k2);
    scored.push({ ...v, score: a + b, rel_match: b > 0 });
  }
  const both = scored.filter(v => v.rel_match);
  return (both.length ? both : scored).sort((x, y) => y.score - x.score ||
    Number(x.ward_no) - Number(y.ward_no) || Number(x.page_no) - Number(y.page_no) ||
    Number(x.serial_no) - Number(y.serial_no)).slice(0, 80);
}

app.get('/api/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ query: q, results: [] });
  const parts = q.split(/\s*[-\u2013\u2014\/]+\s*/).filter(Boolean);
  if (parts.length >= 2) {
    const results = comboSearch(parts[0], parts.slice(1).join(' '));
    return res.json({ query: q, mode: 'name+relative', exact: results.some(r => r.rel_match), results });
  }
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
    LIMIT 80`).all({ n, k, np: `${n}%`, kp: k ? `${k}%` : '\u0000', contains: n ? `%${n}%` : '\u0000', kcontains: k.length >= 2 ? `%${k}%` : '\u0000', digits, qp: `%${q.toUpperCase()}%` });
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
