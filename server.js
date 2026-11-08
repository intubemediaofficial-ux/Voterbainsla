const path0 = require('path');
// Secrets (e.g. GEMINI_API_KEYS) live outside the repo in data/.env.
try { process.loadEnvFile(process.env.ENV_FILE || path0.join(__dirname, 'data', '.env')); } catch {}
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const crypto = require('crypto');
const { db, listAreas, areaByKey, insertArea } = require('./lib/db');
const { addJob, retryJob, startQueue } = require('./lib/ingest');
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
  limits: { fileSize: 80 * 1024 * 1024, files: 100 },
  fileFilter: (_req, file, cb) => cb(null, /^(image\/(jpeg|png|webp)|application\/pdf)$/.test(file.mimetype))
});

// Only the admin (password in data/.env as ADMIN_PASSWORD) can upload rolls or see the upload queue and GP requests.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const adminToken = ADMIN_PASSWORD && crypto.createHmac('sha256', ADMIN_PASSWORD).update('voter-admin').digest('hex');
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const isAdmin = req => {
  if (!adminToken) return false;
  const c = /(?:^|;\s*)adm=([0-9a-f]+)/.exec(req.headers.cookie || '');
  return (c && same(c[1], adminToken)) || same(String(req.headers['x-admin-key'] || ''), ADMIN_PASSWORD);
};
const adminOnly = (req, res, next) => isAdmin(req) ? next() : res.status(401).json({ error: 'Admin login required.' });
db.exec(`CREATE TABLE IF NOT EXISTS gp_requests (id INTEGER PRIMARY KEY, gp TEXT NOT NULL, district TEXT, name TEXT, phone TEXT, done INTEGER DEFAULT 0, at TEXT DEFAULT CURRENT_TIMESTAMP)`);

app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
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

// Seed GPs (inserted once into the `areas` table; GPs found in uploaded PDFs are added there automatically).
// Order = order in the menu. `home: true` opens on the home page (defaults to the first entry).
const AREA_LIST = [
  { key: 'jhareesa', name: 'Jhareesa', district: 'Karauli', samiti: 'Todabhim', home: true, aliases: 'jhareesa jharisa jharesa jhareesha jharisha jhadisa झरीसा झारीसा झरिसा झरीशा झाड़ीसा झाडीसा' },
  { key: 'ladpura', name: 'Ladpura, Surgarh', district: 'Sawai Madhopur', samiti: 'Bamanwas', aliases: 'ladpura laadpura surgarh soorgarh लाडपुरा सूरगढ़ सुरगढ़' },
  { key: 'kheldi', name: 'Kheldi', district: 'Sawai Madhopur', samiti: 'Bamanwas', aliases: 'kheldi khedli khelri khedi खेलड़ी खेलडी खेडली खेड़ली' },
  { key: 'ghudla', name: 'Ghudla', district: 'Sawai Madhopur', samiti: 'Bamanwas', aliases: 'ghudla ghurla gudla घुड़ला घुडला' },
  { key: 'piplai', name: 'Piplai', district: 'Sawai Madhopur', samiti: 'Bamanwas', aliases: 'piplai pipalai peeplai pipli पिपलाई पीपलाई' }
];
AREA_LIST.forEach((a, i) => insertArea.run({ ...a, sort: i * 10 }));
for (const a of AREA_LIST) db.prepare("UPDATE areas SET district=CASE WHEN district='' THEN ? ELSE district END, samiti=CASE WHEN samiti='' THEN ? ELSE samiti END WHERE key=?").run(a.district, a.samiti, a.key);
if (!db.prepare('SELECT 1 FROM areas WHERE home=1').get()) db.prepare('UPDATE areas SET home=1 WHERE key=?').run((AREA_LIST.find(a => a.home) || AREA_LIST[0]).key);
const homeArea = () => (db.prepare('SELECT key FROM areas WHERE home=1').get() || listAreas()[0] || {}).key;
const areaOf = req => { const a = String((req.query && req.query.area) || (req.body && req.body.area) || ''); return areaByKey(a) ? a : homeArea(); };

app.get('/api/areas', (_req, res) => {
  const counts = Object.fromEntries(db.prepare('SELECT area, COALESCE(SUM(record_count),0) voters FROM pages GROUP BY area').all().map(r => [r.area, r.voters]));
  // GPs with no voter data yet stay out of the menu, and the home page falls back to the first GP that has data.
  const areas = listAreas().map(a => ({ key: a.key, name: a.name, district: a.district, samiti: a.samiti, aliases: a.aliases, home: !!a.home, voters: counts[a.key] || 0 })).filter(a => a.voters > 0);
  const home = (areas.find(a => a.key === homeArea()) || areas[0] || { key: homeArea() }).key;
  res.json({ home, areas });
});

app.get('/api/stats', (req, res) => {
  const area = areaOf(req);
  const row = db.prepare(`SELECT COUNT(*) pages, COALESCE(SUM(record_count),0) voters,
    COALESCE(SUM(status='processing'),0) processing, COALESCE(SUM(status='error'),0) errors FROM pages WHERE area=?`).get(area);
  const wards = db.prepare("SELECT DISTINCT ward_no FROM pages WHERE status='ready' AND ward_no<>'' AND area=? ORDER BY CAST(ward_no AS INTEGER)").all(area).map(x => x.ward_no);
  res.json({ ...row, area, areas: Object.fromEntries(listAreas().map(a => [a.key, a.name])), wards, slips: slipStats(area) });
});

const areaVoters = db.prepare(`SELECT v.*, p.total_pages, p.assembly_name, p.polling_station, p.stored_file, p.area
  FROM voters v JOIN pages p ON p.id=v.page_id WHERE p.area=?`);
const areaSig = db.prepare(`SELECT count(*) c, max(v.id) m, total(length(v.name)+length(coalesce(v.relative_name,''))+length(coalesce(v.village,''))+length(coalesce(v.name_alt,''))+length(coalesce(v.relative_alt,''))) l
  FROM voters v JOIN pages p ON p.id=v.page_id WHERE p.area=?`);

// Each field keeps its other OCR readings (name_alt, '|' separated) so a misread spelling still finds the voter.
const alts = (main, alt) => [main, ...String(alt || '').split('|')].map(s => match.words(s)).filter(w => w.length);
const best = (qw, list) => Math.max(0, ...list.map(fw => match.fieldScore(qw, fw)));
// Voters are cached per Gram Panchayat (most recently used first) so memory stays bounded as districts are added.
const CACHE_AREAS = 40;
const cache = new Map();
function areaRows(area) {
  const sig = JSON.stringify(areaSig.get(area));
  let c = cache.get(area);
  cache.delete(area);
  if (!c || c.sig !== sig) c = { sig, rows: areaVoters.all(area).map(v => ({ ...v, nw: alts(v.name, v.name_alt), rw: alts(v.relative_name, v.relative_alt) })) };
  cache.set(area, c);
  if (cache.size > CACHE_AREAS) cache.delete(cache.keys().next().value);
  return c.rows;
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
  for (const v of areaRows(area)) {
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
  const rows = areaRows(area).filter(v => v.ward_no === ward).map(v => ({ ...v, score: 0 })).sort(order);
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
  const voters = () => areaRows(area).filter(v => !ward || v.ward_no === ward);
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
  res.setHeader('Cache-Control', 'private, max-age=3600');
  if (fs.existsSync(file)) return res.sendFile(file);
  const m = /^([0-9a-f]{16})-p-(\d+)\.jpg$/.exec(path.basename(row.stored_file));
  const pdf = m && path.join(uploadDir, `${m[1]}.pdf`);
  if (!pdf || !fs.existsSync(pdf)) return res.sendStatus(404);
  const n = String(Number(m[2]));
  execFile('pdftoppm', ['-r', '150', '-jpeg', '-jpegopt', 'quality=70', '-f', n, '-l', n, '-singlefile', pdf],
    { encoding: 'buffer', maxBuffer: 32 << 20, timeout: 60000 },
    (e, out) => (e || !out.length ? res.sendStatus(500) : res.type('jpeg').send(out)));
});

app.get('/api/admin', (req, res) => res.json({ admin: isAdmin(req) }));
const logins = new Map();
app.post('/api/admin/login', (req, res) => {
  const t = (logins.get(req.ip) || []).filter(x => Date.now() - x < 15 * 60e3);
  if (t.length >= 10) return res.status(429).json({ error: 'Too many tries. Wait 15 minutes.' });
  if (!adminToken || !same(String((req.body && req.body.password) || ''), ADMIN_PASSWORD)) { logins.set(req.ip, [...t, Date.now()]); return res.status(401).json({ error: 'Wrong password.' }); }
  res.setHeader('Set-Cookie', `adm=${adminToken}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${180 * 86400}`);
  res.json({ admin: true });
});
app.post('/api/admin/logout', (_req, res) => { res.setHeader('Set-Cookie', 'adm=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'); res.json({ admin: false }); });

const asked = new Map();
app.post('/api/requests', (req, res) => {
  const f = k => String((req.body && req.body[k]) || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const gp = f('gp');
  if (gp.length < 2) return res.status(400).json({ error: 'Write the Gram Panchayat name.' });
  const t = (asked.get(req.ip) || []).filter(x => Date.now() - x < 3600e3);
  if (t.length >= 10) return res.status(429).json({ error: 'Too many requests. Try again later.' });
  asked.set(req.ip, [...t, Date.now()]);
  db.prepare('INSERT INTO gp_requests(gp, district, name, phone) VALUES(?,?,?,?)').run(gp, f('district'), f('name'), f('phone').replace(/[^\d+ ]/g, '').slice(0, 15));
  res.json({ ok: true });
});
app.get('/api/requests', adminOnly, (_req, res) => res.json({ requests: db.prepare('SELECT * FROM gp_requests ORDER BY done, id DESC LIMIT 100').all() }));
app.post('/api/requests/:id/done', adminOnly, (req, res) => res.json({ ok: db.prepare('UPDATE gp_requests SET done=1 WHERE id=?').run(Number(req.params.id)).changes > 0 }));

app.post('/api/upload', adminOnly, upload.array('photos', 100), (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'Select at least one PDF or JPG/PNG/WebP photo.' });
  const want = req.body.area === 'auto' ? 'auto' : areaOf(req);
  const name = f => Buffer.from(f.originalname, 'latin1').toString('utf8');
  const pdfs = files.filter(f => f.mimetype === 'application/pdf'), photos = files.filter(f => f.mimetype !== 'application/pdf');
  const ids = pdfs.map(f => addJob({ file_name: name(f), stored: f.filename, kind: 'pdf', want_area: want }));
  if (photos.length) ids.push(addJob({ file_name: photos.length > 1 ? `${photos.length} photos` : name(photos[0]), stored: JSON.stringify(photos.map(f => ({ stored: f.filename, name: name(f) }))), kind: 'photos', want_area: want }));
  res.status(202).json({ accepted: files.length, jobs: ids, message: 'Upload received. Pages are being read in the background.' });
});

app.get('/api/jobs', adminOnly, (_req, res) => {
  const jobs = db.prepare(`SELECT j.id,j.file_name,j.kind,j.area,a.name area_name,a.district,j.status,j.total,j.done,j.failed,j.voters,j.message,j.created_at
    FROM jobs j LEFT JOIN areas a ON a.key=j.area ORDER BY j.id DESC LIMIT 20`).all();
  res.json({ jobs });
});

app.post('/api/jobs/:id/retry', adminOnly, (req, res) => res.json({ ok: retryJob(Number(req.params.id)) }));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(400).json({ error: err.message || 'Request failed' });
});
startQueue();
app.listen(PORT, '127.0.0.1', () => console.log(`Voter Search listening on http://127.0.0.1:${PORT}`));
