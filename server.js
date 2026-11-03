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

const AREAS = { ladpura: 'Ladpura, Surgarh', kheldi: 'Kheldi', ghudla: 'Ghudla' };
const areaOf = req => { const a = String((req.query && req.query.area) || (req.body && req.body.area) || ''); return AREAS[a] ? a : 'ladpura'; };

app.get('/api/stats', (req, res) => {
  const area = areaOf(req);
  const row = db.prepare(`SELECT COUNT(*) pages, COALESCE(SUM(record_count),0) voters,
    COALESCE(SUM(status='processing'),0) processing, COALESCE(SUM(status='error'),0) errors FROM pages WHERE area=?`).get(area);
  const wards = db.prepare("SELECT DISTINCT ward_no FROM pages WHERE status='ready' AND ward_no<>'' AND area=? ORDER BY CAST(ward_no AS INTEGER)").all(area).map(x => x.ward_no);
  res.json({ ...row, area, areas: AREAS, wards, slips: slipStats(area) });
});

const allVoters = db.prepare(`SELECT v.*, p.total_pages, p.assembly_name, p.polling_station, p.stored_file, p.area
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

// Slip status is keyed by Voter ID (falls back to page+serial) so it survives re-OCR of a page and covers duplicate rows.
const slipKey = v => String(v.voter_id || '').replace(/\s/g, '').toUpperCase() || `P${v.page_id}-S${v.serial_no}`;
const slipMap = () => new Map(db.prepare('SELECT * FROM slips').all().map(s => [s.vkey, s]));
const withSlip = () => { const m = slipMap(); return v => { const s = m.get(slipKey(v)); return { ...clean(v), slip: s ? { at: s.given_at, by: s.given_by } : null }; }; };
function slipStats(area) {
  const m = slipMap(), seen = new Set(), wards = {};
  let given = 0;
  for (const v of allRows()) {
    if (v.area !== area) continue;
    const k = slipKey(v);
    const w = wards[v.ward_no] || (wards[v.ward_no] = { total: 0, given: 0, seen: new Set() });
    if (!w.seen.has(k)) { w.seen.add(k); w.total++; if (m.has(k)) w.given++; }
    if (seen.has(k)) continue;
    seen.add(k);
    if (m.has(k)) given++;
  }
  for (const w of Object.values(wards)) delete w.seen;
  return { total: seen.size, given, wards };
}

app.post('/api/slip', (req, res) => {
  const v = db.prepare('SELECT v.page_id, v.serial_no, v.voter_id, p.area FROM voters v JOIN pages p ON p.id=v.page_id WHERE v.id=?').get(Number(req.body && req.body.id));
  if (!v) return res.status(404).json({ error: 'Voter not found' });
  const k = slipKey(v), given = !!req.body.given, by = String(req.body.by || '').trim().slice(0, 40) || null;
  if (given) db.prepare('INSERT INTO slips(vkey, given_by) VALUES(?, ?) ON CONFLICT(vkey) DO NOTHING').run(k, by);
  else db.prepare('DELETE FROM slips WHERE vkey=?').run(k);
  db.prepare('INSERT INTO slip_log(vkey, given, by_name) VALUES(?, ?, ?)').run(k, given ? 1 : 0, by);
  const s = db.prepare('SELECT * FROM slips WHERE vkey=?').get(k);
  res.json({ slip: s ? { at: s.given_at, by: s.given_by } : null, stats: slipStats(v.area) });
});

app.get('/api/ward/:ward', (req, res) => {
  const ward = String(req.params.ward).trim(), area = areaOf(req);
  const rows = allRows().filter(v => v.area === area && v.ward_no === ward).map(v => ({ ...v, score: 0 })).sort(order);
  res.json({ ward, count: rows.length, results: rows.map(withSlip()) });
});

// Strict hits first; when they are few, append loose "similar" hits (spelling/OCR variants) below them.
const SIMILAR_MAX = 40;
function withSimilar(strict, voters, looseFn) {
  if (strict.length >= 15) return strict;
  const have = new Set(strict.map(v => v.id)), sim = [];
  for (const v of voters) {
    if (have.has(v.id)) continue;
    const s = looseFn(v);
    if (s >= 45) sim.push({ ...v, score: s, similar: true });
  }
  return strict.concat(sim.sort(order).slice(0, SIMILAR_MAX));
}
const loose = (qw, list) => Math.max(0, ...list.map(fw => match.looseScore(qw, fw)));

function nameRelative(voters, nq, rq) {
  const rows = [];
  for (const v of voters) {
    const a = best(nq, v.nw);
    if (!a) continue;
    const b = best(rq, v.rw);
    const near = b ? 0 : Math.round(40 * Math.max(0, ...v.rw.flat().map(w => Math.max(...rq.map(r => match.sim(r, w))))));
    rows.push({ ...v, score: a + (b ? b + 50 : near), rel_match: b > 0 });
  }
  rows.sort(order);
  const exact = rows.filter(r => r.rel_match);
  // Voter name misread but relative matches: listed as similar.
  const out = withSimilar(rows, voters, v => { const b = best(rq, v.rw); return b ? Math.round((b + loose(nq, v.nw)) / 2) : 0; });
  return { exact: exact.length > 0, results: out };
}

app.get('/api/search', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 120);
  const rel = String(req.query.rel || '').trim().slice(0, 120);
  const ward = String(req.query.ward || '').trim(), area = areaOf(req);
  const voters = () => allRows().filter(v => v.area === area && (!ward || v.ward_no === ward));
  const send = (extra, rows) => res.json({ query: q, rel, ...extra, results: rows.slice(0, 160).map(withSlip()) });
  if (rel.length >= 2) {
    const rq = match.words(rel);
    if (q.length < 2) {
      const vs = voters();
      const strict = vs.map(v => ({ ...v, score: best(rq, v.rw) })).filter(v => v.score).sort(order);
      return send({ mode: 'relative' }, withSimilar(strict, vs, v => loose(rq, v.rw)));
    }
    const r = nameRelative(voters(), match.words(q), rq);
    return send({ mode: 'name+relative', exact: r.exact }, r.results);
  }
  if (q.length < 2) return res.json({ query: q, results: [] });
  if (/^\d+$/.test(q)) {
    const rows = voters().filter(v => v.serial_no === q || v.house_no === q).map(v => ({ ...v, score: v.serial_no === q ? 100 : 50 }));
    return send({}, rows.sort(order).slice(0, 80));
  }
  if (/\d/.test(q) && /^[a-z0-9]+$/i.test(q)) {
    const id = q.toUpperCase();
    const rows = voters().filter(v => (v.voter_id || '').toUpperCase().includes(id)).map(v => ({ ...v, score: 100 }));
    return send({}, rows.sort(order).slice(0, 80));
  }
  const parts = q.split(/\s*[-\u2013\u2014\/]+\s*/).filter(Boolean);
  if (parts.length >= 2) {
    const r = nameRelative(voters(), match.words(parts[0]), match.words(parts.slice(1).join(' ')));
    return send({ mode: 'name+relative', exact: r.exact }, r.results);
  }
  const qw = match.words(q), vs = voters();
  const rows = [];
  for (const v of vs) {
    const a = best(qw, v.nw), b = best(qw, v.rw) * 0.9;
    if (a || b) rows.push({ ...v, score: Math.max(a, b), matched: a >= b ? 'name' : 'relative' });
  }
  send({}, withSimilar(rows.sort(order).slice(0, 120), vs, v => Math.max(loose(qw, v.nw), loose(qw, v.rw) * 0.9)));
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
  const area = areaOf(req), src = f => (area === 'ladpura' ? f.originalname : `${area}/${f.originalname}`);
  for (const file of files) {
    const pageId = Number(upsertPage.get({ source_file: src(file), stored_file: file.filename, area }).id);
    processPhoto(file, pageId, src(file));
  }
  res.status(202).json({ accepted: files.length, message: 'Photos are being indexed. You can keep using search.' });
});

async function processPhoto(file, pageId, sourceFile) {
  try {
    const data = await extractPage(file.path);
    saveExtraction(sourceFile, file.filename, data);
  } catch (err) {
    failPage.run(String(err.message).slice(0, 1000), pageId);
  }
}

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(400).json({ error: err.message || 'Request failed' });
});
app.listen(PORT, '127.0.0.1', () => console.log(`Voter Search listening on http://127.0.0.1:${PORT}`));
