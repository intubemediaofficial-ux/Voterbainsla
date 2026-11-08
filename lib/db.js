const Database = require('better-sqlite3');
const path = require('path');
const { anyKey, normText } = require('./keys');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'voters.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_file TEXT NOT NULL UNIQUE,
  stored_file TEXT NOT NULL,
  ward_no TEXT,
  page_no TEXT,
  total_pages TEXT,
  assembly_name TEXT,
  polling_station TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  record_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at TEXT
);
CREATE TABLE IF NOT EXISTS voters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  serial_no TEXT,
  voter_id TEXT,
  name TEXT NOT NULL,
  relative_name TEXT,
  relation_type TEXT,
  house_no TEXT,
  age TEXT,
  gender TEXT,
  ward_no TEXT,
  page_no TEXT,
  name_norm TEXT,
  relative_norm TEXT,
  name_key TEXT,
  relative_key TEXT
);
CREATE INDEX IF NOT EXISTS idx_voters_name_norm ON voters(name_norm);
CREATE INDEX IF NOT EXISTS idx_voters_relative_norm ON voters(relative_norm);
CREATE INDEX IF NOT EXISTS idx_voters_name_key ON voters(name_key);
CREATE INDEX IF NOT EXISTS idx_voters_relative_key ON voters(relative_key);
CREATE INDEX IF NOT EXISTS idx_voters_serial ON voters(serial_no);
`);

for (const c of ['name_alt', 'relative_alt']) {
  if (!db.prepare('PRAGMA table_info(voters)').all().some(x => x.name === c)) db.exec(`ALTER TABLE voters ADD COLUMN ${c} TEXT`);
}

for (const [t, c] of [['pages', 'sections'], ['pages', 'main_village'], ['voters', 'village']]) {
  if (!db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} TEXT`);
}

// Each gram panchayat is a separate voter list; existing pages belong to Ladpura, Surgarh.
if (!db.prepare('PRAGMA table_info(pages)').all().some(x => x.name === 'area')) db.exec("ALTER TABLE pages ADD COLUMN area TEXT NOT NULL DEFAULT 'ladpura'");

db.exec(`CREATE TABLE IF NOT EXISTS slips (vkey TEXT PRIMARY KEY, given_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, given_by TEXT);
CREATE TABLE IF NOT EXISTS slip_log (id INTEGER PRIMARY KEY AUTOINCREMENT, vkey TEXT NOT NULL, given INTEGER NOT NULL, by_name TEXT, at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);

const upsertPageStmt = db.prepare(`INSERT INTO pages(source_file,stored_file,status,area)
 VALUES(@source_file,@stored_file,'processing',COALESCE(@area,'ladpura'))
 ON CONFLICT(source_file) DO UPDATE SET stored_file=excluded.stored_file,status='processing',error=NULL,area=COALESCE(@area,pages.area)
 RETURNING id`);
const upsertPage = { get: p => upsertPageStmt.get({ area: null, ...p }) };
const clearVoters = db.prepare('DELETE FROM voters WHERE page_id=?');
const insertVoter = db.prepare(`INSERT INTO voters
(page_id,serial_no,voter_id,name,relative_name,relation_type,house_no,age,gender,ward_no,page_no,name_norm,relative_norm,name_key,relative_key)
VALUES(@page_id,@serial_no,@voter_id,@name,@relative_name,@relation_type,@house_no,@age,@gender,@ward_no,@page_no,@name_norm,@relative_norm,@name_key,@relative_key)`);
const finishPage = db.prepare(`UPDATE pages SET ward_no=@ward_no,page_no=@page_no,total_pages=@total_pages,
 assembly_name=@assembly_name,polling_station=@polling_station,main_village=@main_village,sections=@sections,status='ready',error=NULL,record_count=@record_count,
 processed_at=CURRENT_TIMESTAMP WHERE id=@id`);
const failPage = db.prepare(`UPDATE pages SET status='error',error=?,processed_at=CURRENT_TIMESTAMP WHERE id=?`);

const saveExtraction = db.transaction((sourceFile, storedFile, data, area) => {
  const pageId = Number(upsertPage.get({ source_file: sourceFile, stored_file: storedFile, area: area || null }).id);
  clearVoters.run(pageId);
  const ward = text(data.ward_no);
  const page = text(data.page_no);
  const records = Array.isArray(data.voters) ? data.voters : [];
  let count = 0;
  for (const row of records) {
    const name = text(row.name);
    if (!name) continue;
    const relative = text(row.relative_name);
    insertVoter.run({
      page_id: pageId,
      serial_no: text(row.serial_no), voter_id: text(row.voter_id), name,
      relative_name: relative, relation_type: text(row.relation_type), house_no: text(row.house_no),
      age: text(row.age), gender: text(row.gender), ward_no: ward, page_no: page,
      name_norm: normText(name), relative_norm: normText(relative), name_key: anyKey(name), relative_key: anyKey(relative)
    });
    count++;
  }
  finishPage.run({
    id: pageId, ward_no: ward, page_no: page, total_pages: text(data.total_pages),
    assembly_name: text(data.assembly_name), polling_station: text(data.polling_station), record_count: count,
    main_village: text(data.main_village), sections: Array.isArray(data.sections) ? JSON.stringify(data.sections) : null
  });
  return { pageId, count, ward, page };
});
db.exec(`CREATE TABLE IF NOT EXISTS areas (key TEXT PRIMARY KEY, name TEXT NOT NULL, district TEXT NOT NULL DEFAULT '', aliases TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0, home INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, file_name TEXT NOT NULL, stored TEXT NOT NULL, kind TEXT NOT NULL,
  want_area TEXT, area TEXT, status TEXT NOT NULL DEFAULT 'queued', total INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0, voters INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT);`);
if (!db.prepare('PRAGMA table_info(areas)').all().some(x => x.name === 'samiti')) db.exec("ALTER TABLE areas ADD COLUMN samiti TEXT NOT NULL DEFAULT ''");
const listAreas = () => db.prepare('SELECT * FROM areas ORDER BY sort, created_at').all();
const areaByKey = k => db.prepare('SELECT * FROM areas WHERE key=?').get(String(k || ''));
const insertArea = db.prepare('INSERT OR IGNORE INTO areas(key,name,district,samiti,aliases,sort) VALUES(@key,@name,@district,@samiti,@aliases,@sort)');

// Village / mohalla headings are printed between voter boxes; a voter belongs to the last heading at or before its serial.
const serialNum = v => Number((String(v || '').match(/\d+/) || [])[0]) || 0;
const placeName = s => text(s).replace(/\s*,\s*/g, ', ').replace(/\s+/g, ' ').replace(/^[\d\s.-]+(?=[^\d\s])/, '');
const setVillage = db.prepare('UPDATE voters SET village=? WHERE id=?');
const assignVillages = db.transaction(area => {
  const pages = db.prepare("SELECT id, ward_no, sections, main_village FROM pages WHERE status='ready' AND area=?").all(area);
  const voters = db.prepare("SELECT v.id, v.page_id, v.serial_no, v.village FROM voters v JOIN pages p ON p.id=v.page_id WHERE p.area=?").all(area);
  const byPage = new Map(pages.map(p => [p.id, { ...p, secs: [], voters: [] }]));
  for (const v of voters) byPage.get(v.page_id)?.voters.push(v);
  const counts = new Map();
  for (const p of byPage.values()) {
    let list = [];
    try { list = JSON.parse(p.sections || '[]'); } catch {}
    p.secs = list.map(x => ({ n: serialNum(x.first_serial), name: placeName(x.name) })).filter(x => x.n && x.name);
    // A heading at the very top of a voter page is sometimes read as main_village instead of a section.
    const first = Math.min(...p.voters.map(v => serialNum(v.serial_no)).filter(Boolean));
    if (p.main_village && p.voters.length && Number.isFinite(first) && !p.secs.some(x => x.n <= first)) p.secs.push({ n: first, name: placeName(p.main_village) });
    for (const x of p.secs) counts.set(x.name, (counts.get(x.name) || 0) + 1);
  }
  // OCR spells the same place slightly differently on different pages; map each spelling to the most common close one.
  // OCR spells the same place slightly differently; map each spelling to the most common close one, the village part (after the last comma) and the mohalla part separately.
  const cluster = (names, lim) => {
    const heads = [], of = new Map();
    for (const [name] of [...names].sort((a, b) => b[1] - a[1])) {
      const k = anyKey(name), h = heads.find(h => h.k === k || editDistance(h.k, k) <= lim(k));
      if (h) of.set(name, h.name); else { heads.push({ k, name }); of.set(name, name); }
    }
    return of;
  };
  const split = n => { const i = n.lastIndexOf(','); return i < 0 ? ['', n.trim()] : [n.slice(0, i).trim(), n.slice(i + 1).trim()]; };
  const vc = new Map(), mc = new Map();
  for (const [name, c] of counts) { const [m, v] = split(name); vc.set(v, (vc.get(v) || 0) + c); if (m) mc.set(m, (mc.get(m) || 0) + c); }
  const vOf = cluster(vc, k => k.length >= 4 ? 2 : k.length >= 3 ? 1 : 0), mOf = cluster(mc, k => k.length >= 12 ? 2 : k.length >= 5 ? 1 : 0);
  const canonOf = new Map([...counts.keys()].map(n => { const [m, v] = split(n); return [n, (m ? mOf.get(m) + ', ' : '') + vOf.get(v)]; }));
  const canon = name => canonOf.get(name) || name;
  const wards = new Map();
  for (const p of byPage.values()) { const w = wards.get(p.ward_no) || []; w.push(p); wards.set(p.ward_no, w); }
  let changed = 0;
  for (const list of wards.values()) {
    // Main-roll pages hold one contiguous run of plain serials; supplement/deletion pages repeat old serials and only apply to their own voters.
    const main = list.filter(p => { const s = p.voters.map(v => String(v.serial_no || '')); const n = s.map(serialNum);
      return s.length && s.every(x => /^\d+$/.test(x)) && Math.max(...n) - Math.min(...n) + 1 === new Set(n).size; });
    const breaks = main.flatMap(p => p.secs).sort((a, b) => a.n - b.n);
    const fallback = canon(placeName(list.filter(p => !p.voters.length).map(p => p.main_village).find(Boolean) || ''));
    const pick = (secs, n) => secs.filter(x => x.n <= n).sort((a, b) => b.n - a.n)[0];
    for (const p of list) for (const v of p.voters) {
      const n = serialNum(v.serial_no);
      const hit = pick(p.secs, n) || pick(breaks, n);
      const village = hit ? canon(hit.name) : fallback || (breaks[0] ? canon(breaks[0].name) : '');
      if ((v.village || '') !== village) { setVillage.run(village || null, v.id); changed++; }
    }
  }
  return changed;
});

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
function text(v) { return v == null ? '' : String(v).trim(); }
module.exports = { db, saveExtraction, failPage, upsertPage, listAreas, areaByKey, insertArea, assignVillages };
