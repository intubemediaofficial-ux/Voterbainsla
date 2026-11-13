// Feeds downloaded SEC Rajasthan ward PDFs into the upload queue one at a time, so free Gemini quota is spent steadily over days.
// Usage: node scripts/sec-feed.js <dir with <dist>/<ps>/<gp>.json manifests and ward PDFs>
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
try { process.loadEnvFile(process.env.ENV_FILE || path.join(__dirname, '..', 'data', '.env')); } catch {}
const auth = { 'x-admin-key': process.env.ADMIN_PASSWORD || '' };
const { db } = require('../lib/db');
const { resolveArea } = require('../lib/ingest');

const ROOT = process.argv[2] || '/var/www/voter-search-data/sec';
const PORT = process.env.PORT || 3580;
const ORDER = ['Karauli', 'Sawai Madhopur'];
// SEC GP codes (comma separated) to read before everything else.
const PRIORITY = String(process.env.SEC_PRIORITY || '').split(',').map(s => s.trim()).filter(Boolean);
// SEC_ONLY=1 feeds just the SEC_PRIORITY GPs and nothing else.
const ONLY = process.env.SEC_ONLY === '1';
db.exec('CREATE TABLE IF NOT EXISTS sec_feed (file TEXT PRIMARY KEY, area TEXT, job_id INTEGER, at TEXT DEFAULT CURRENT_TIMESTAMP)');
const fed = db.prepare('SELECT 1 FROM sec_feed WHERE file=?');
const markFed = db.prepare('INSERT OR IGNORE INTO sec_feed(file, area, job_id) VALUES(?,?,?)');
// GPs that already had data before the feeder started (uploaded by hand) are left untouched.
const hasOwnData = db.prepare("SELECT 1 FROM pages WHERE area=? AND NOT EXISTS (SELECT 1 FROM sec_feed WHERE area=? AND job_id IS NOT NULL) LIMIT 1");
const titleCase = s => String(s || '').toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase()).trim();

function manifests() {
  const out = [];
  for (const d of fs.existsSync(ROOT) ? fs.readdirSync(ROOT) : [])
    for (const p of fs.readdirSync(path.join(ROOT, d)))
      for (const f of fs.readdirSync(path.join(ROOT, d, p)).filter(f => f.endsWith('.json')))
        out.push(JSON.parse(fs.readFileSync(path.join(ROOT, d, p, f), 'utf8')));
  if (ONLY) return out.filter(m => PRIORITY.includes(m.gp)).sort((a, b) => PRIORITY.indexOf(a.gp) - PRIORITY.indexOf(b.gp));
  const rank = m => [PRIORITY.includes(m.gp) ? PRIORITY.indexOf(m.gp) : PRIORITY.length, ORDER.indexOf(m.district), /TODABHIM|BAMANWAS/.test(m.samiti) ? 0 : 1, m.samiti, m.name];
  return out.sort((a, b) => { const x = rank(a), y = rank(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; return 0; });
}

const MIN_FREE_GB = Number(process.env.SEC_MIN_FREE_GB || 15);
const MAX_DATA_GB = Number(process.env.SEC_MAX_DATA_GB || 5);
const DATA = path.dirname(ROOT);
function busy() {
  // Stop feeding before the shared server's disk fills up, or once the voter data folder reaches its size budget.
  const st = fs.statfsSync(ROOT);
  if (st.bavail * st.bsize < MIN_FREE_GB * 1e9) { console.error(new Date().toISOString(), `paused: under ${MIN_FREE_GB} GB free`); return true; }
  const used = Number(execFileSync('du', ['-sb', DATA]).toString().split('\t')[0]);
  if (used > MAX_DATA_GB * 1e9) { console.error(new Date().toISOString(), `paused: ${DATA} is over ${MAX_DATA_GB} GB`); return true; }
  if (db.prepare("SELECT 1 FROM jobs WHERE status IN ('queued','running') LIMIT 1").get()) return true;
  // Pages waiting on Gemini quota go first; the server retries them every 30 min, nudge ones past its retry cap.
  const stuck = db.prepare("SELECT id, attempts FROM jobs WHERE status='partial' AND id IN (SELECT job_id FROM sec_feed)").all();
  for (const j of stuck.filter(j => j.attempts >= 48)) fetch(`http://127.0.0.1:${PORT}/api/jobs/${j.id}/retry`, { method: 'POST', headers: auth }).catch(() => {});
  return stuck.length > 0;
}

// Once a ward's job is done, the downloaded PDF becomes a hardlink to the uploaded copy, so it takes disk space only once.
const doneFed = db.prepare("SELECT s.file, j.stored FROM sec_feed s JOIN jobs j ON j.id=s.job_id WHERE j.status='done'");
function dedupe() {
  const up = path.join(__dirname, '..', 'uploads');
  for (const { file, stored } of doneFed.all()) {
    const src = path.join(up, stored);
    try {
      if (!fs.existsSync(file) || !fs.existsSync(src) || fs.statSync(file).ino === fs.statSync(src).ino) continue;
      fs.linkSync(src, file + '.lnk');
      fs.renameSync(file + '.lnk', file);
    } catch (e) { console.error(new Date().toISOString(), 'dedupe', file, e.message); }
  }
}

async function feedOne() {
  dedupe();
  if (busy()) return false;
  for (const m of manifests()) {
    const samiti = titleCase(m.samiti.replace(/\s*PANCHAYAT SAMITI\s*$/i, ''));
    for (const w of m.wards) {
      const file = path.join(ROOT, m.dist, m.ps, path.basename(w.file));
      if (fed.get(file) || !fs.existsSync(file)) continue;
      const area = resolveArea({ gram_panchayat: m.hi, gram_panchayat_en: m.name, district_en: m.district, panchayat_samiti_en: samiti });
      if (hasOwnData.get(area, area)) { markFed.run(file, area, null); continue; }
      const form = new FormData();
      form.append('area', area);
      form.append('photos', new Blob([fs.readFileSync(file)], { type: 'application/pdf' }), `${titleCase(m.name)}-Ward-${w.ward}.pdf`);
      const r = await fetch(`http://127.0.0.1:${PORT}/api/upload`, { method: 'POST', body: form, headers: auth });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.status);
      markFed.run(file, area, j.jobs[0]);
      console.log(new Date().toISOString(), 'fed', m.district, samiti, m.name, 'ward', w.ward, 'job', j.jobs[0]);
      return true;
    }
  }
  return false;
}

(async function loop() {
  try { await feedOne(); } catch (e) { console.error(new Date().toISOString(), e.message); }
  setTimeout(loop, 60 * 1000);
})();
