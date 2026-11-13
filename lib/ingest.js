// Background indexing of uploaded PDFs/photos. Each upload is a job; the Gram Panchayat is read from the
// page header (or taken from the GP the uploader chose) and created on the fly if it is new.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { db, saveExtraction, failPage, upsertPage, listAreas, areaByKey, insertArea, assignVillages } = require('./db');
const { extractPage } = require('./ocr');
const { anyKey } = require('./keys');

const uploadDir = path.join(__dirname, '..', 'uploads');
const MAX_PDF_PAGES = 300;
const LIMIT = Math.max(1, Number(process.env.OCR_CONCURRENCY || 2));
let active = 0;
const waiting = [];
async function slot(fn) {
  while (active >= LIMIT) await new Promise(r => waiting.push(r));
  active++;
  try { return await fn(); } finally { active--; const next = waiting.shift(); if (next) next(); }
}

const getJob = db.prepare('SELECT * FROM jobs WHERE id=?');
const setJob = (id, f) => db.prepare(`UPDATE jobs SET ${Object.keys(f).map(c => `${c}=@${c}`).join(',')},updated_at=CURRENT_TIMESTAMP WHERE id=@id`).run({ ...f, id });
const readyBySource = db.prepare("SELECT record_count FROM pages WHERE source_file=? AND status='ready'");
const readyByStored = db.prepare("SELECT area FROM pages WHERE stored_file=? AND status='ready' LIMIT 1");
const text = v => (v == null ? '' : String(v).trim());
const sha = file => crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
const run = (cmd, args) => new Promise((resolve, reject) =>
  execFile(cmd, args, { maxBuffer: 4 << 20, timeout: 600000 }, (e, out, err) => (e ? reject(new Error(String(err || e.message).slice(0, 300))) : resolve(String(out)))));

async function pdfImages(job) {
  const pdf = path.join(uploadDir, job.stored);
  const hash = sha(pdf);
  const pages = Number(/Pages:\s+(\d+)/.exec(await run('pdfinfo', [pdf]).catch(() => ''))?.[1] || 0);
  if (!pages) throw new Error('This PDF could not be opened.');
  if (pages > MAX_PDF_PAGES) throw new Error(`PDF has ${pages} pages; upload one ward at a time (max ${MAX_PDF_PAGES}).`);
  // A hash-named link to the PDF lets /api/source render a page on demand once its JPG is deleted after OCR.
  const keep = path.join(uploadDir, `${hash}.pdf`);
  if (!fs.existsSync(keep)) try { fs.linkSync(pdf, keep); } catch { fs.copyFileSync(pdf, keep); }
  const prefix = `${hash}-p-`;
  const have = () => fs.readdirSync(uploadDir).filter(f => f.startsWith(prefix) && f.endsWith('.jpg')).sort();
  if (have().length < pages) await run('pdftoppm', ['-r', '150', '-jpeg', '-jpegopt', 'quality=70', pdf, path.join(uploadDir, `${hash}-p`)]);
  const stem = path.parse(job.file_name).name.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'roll';
  return have().map((f, i) => ({ stored: f, name: `${stem}-${hash.slice(0, 6)}-p-${String(i + 1).padStart(3, '0')}.jpg` }));
}

// Page JPGs are only needed for OCR; the PDF they came from is ~20x smaller and is kept instead.
function dropPageImage(stored) {
  const m = /^([0-9a-f]{16})-p-\d+\.jpg$/.exec(stored);
  if (m && fs.existsSync(path.join(uploadDir, `${m[1]}.pdf`))) fs.rmSync(path.join(uploadDir, stored), { force: true });
}

const skel = s => anyKey(s).replace(/ /g, '');
const lev = (a, b) => {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
};
const titleCase = s => text(s).toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
// Matches the GP name printed on the page against known GPs by phonetic key (Hindi or English), within the same district.
function resolveArea(d) {
  const hi = text(d.gram_panchayat), en = text(d.gram_panchayat_en);
  if (!hi && !en) return null;
  const want = new Set([hi, en].filter(Boolean).map(skel).filter(k => k.length >= 2));
  const dist = skel(text(d.district_en) || text(d.district));
  // Same-named GPs exist in different samitis of one district (e.g. Talawara in Gangapur City and Khandar).
  const sam = titleCase(d.panchayat_samiti_en) || text(d.panchayat_samiti);
  const ascii = s => /^[\x20-\x7e]+$/.test(s);
  // OCR spells one samiti several ways (Laxmangarh / Lachhmangarh), so near-identical keys count as the same samiti.
  const near = (x, y) => x.includes(y) || y.includes(x) || (Math.min(x.length, y.length) >= 4 && lev(x, y) <= 2);
  const otherSamiti = a => a.samiti && sam && ascii(a.samiti) && ascii(sam) && !near(skel(a.samiti), skel(sam));
  for (const a of listAreas()) {
    if (a.district && dist && skel(a.district) !== dist) continue;
    if (otherSamiti(a)) continue;
    const names = [a.name, ...a.name.split(/[,\s]+/), ...a.aliases.split(/\s+/)].map(skel).filter(k => k.length >= 2);
    if (names.some(k => want.has(k))) {
      if (!a.samiti && sam) db.prepare('UPDATE areas SET samiti=? WHERE key=?').run(sam, a.key);
      return a.key;
    }
  }
  const name = titleCase(en) || hi;
  const base = (en || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || `gp-${Date.now().toString(36)}`;
  let key = base;
  for (let i = 2; areaByKey(key); i++) key = `${base}-${i}`;
  const sort = Math.max(0, ...listAreas().map(a => a.sort)) + 10;
  insertArea.run({ key, name, district: titleCase(d.district_en) || text(d.district), samiti: titleCase(d.panchayat_samiti_en) || text(d.panchayat_samiti), aliases: [en.toLowerCase(), hi].filter(Boolean).join(' '), sort });
  return key;
}

const running = new Set();
async function runJob(id) {
  if (running.has(id)) return;
  running.add(id);
  try {
    const job = getJob.get(id);
    setJob(id, { status: 'running', message: job.kind === 'pdf' ? 'Opening PDF' : 'Reading photos' });
    const imgs = job.kind === 'pdf' ? await pdfImages(job) : JSON.parse(job.stored);
    setJob(id, { total: imgs.length });
    let area = job.area || (job.want_area !== 'auto' && areaByKey(job.want_area) ? job.want_area : null);
    if (!area) area = (imgs.map(i => readyByStored.get(i.stored)).find(Boolean) || {}).area || null;
    const early = new Map();
    if (!area) {
      setJob(id, { message: 'Finding Gram Panchayat name' });
      for (const img of imgs.slice(0, 3)) {
        try {
          const d = await slot(() => extractPage(path.join(uploadDir, img.stored)));
          early.set(img.stored, d);
          if ((area = resolveArea(d))) break;
        } catch (err) {
          if (/quota|Gemini/i.test(err.message)) throw err;
        }
      }
      if (!area) throw new Error('Gram Panchayat name was not found on the first pages. Open that Gram Panchayat from the menu and upload again with it selected.');
    }
    setJob(id, { area, message: '' });
    let done = 0, failed = 0, voters = 0;
    const tick = () => setJob(id, { done, failed, voters });
    await Promise.all(imgs.map(async img => {
      const source = `${area}/${img.name}`;
      const ready = readyBySource.get(source);
      if (ready) { done++; voters += ready.record_count; return tick(); }
      try {
        const d = early.get(img.stored) || await slot(() => extractPage(path.join(uploadDir, img.stored)));
        voters += saveExtraction(source, img.stored, d, area).count;
        done++;
      } catch (err) {
        failPage.run(String(err.message).slice(0, 1000), Number(upsertPage.get({ source_file: source, stored_file: img.stored, area }).id));
        failed++;
      }
      tick();
    }));
    if (job.kind === 'pdf') for (const img of imgs) if (readyBySource.get(`${area}/${img.name}`)) dropPageImage(img.stored);
    assignVillages(area);
    setJob(id, { status: failed ? 'partial' : 'done', message: failed ? `${failed} page${failed > 1 ? 's' : ''} not read yet (Gemini limit) — retrying automatically` : '' });
  } catch (err) {
    const quota = /quota|Gemini/i.test(err.message);
    setJob(id, { status: quota ? 'partial' : 'error', message: quota ? 'Gemini limit reached — retrying automatically' : String(err.message).slice(0, 300) });
  } finally {
    running.delete(id);
  }
}

const createJob = db.prepare(`INSERT INTO jobs(file_name,stored,kind,want_area,status) VALUES(@file_name,@stored,@kind,@want_area,'queued') RETURNING id`);
function addJob(j) {
  const id = Number(createJob.get(j).id);
  runJob(id);
  return id;
}
function retryJob(id) {
  const job = getJob.get(id);
  if (!job || running.has(id) || !['partial', 'error'].includes(job.status)) return false;
  setJob(id, { status: 'queued', attempts: job.attempts + 1 });
  runJob(id);
  return true;
}
function startQueue() {
  for (const j of db.prepare("SELECT id FROM jobs WHERE status IN ('queued','running')").all()) runJob(j.id);
  setInterval(() => {
    for (const j of db.prepare("SELECT id FROM jobs WHERE status='partial' AND attempts<48").all()) retryJob(j.id);
  }, 30 * 60 * 1000).unref();
}
module.exports = { dropPageImage, addJob, retryJob, startQueue, resolveArea };
