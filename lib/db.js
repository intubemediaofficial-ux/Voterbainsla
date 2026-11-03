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

const upsertPage = db.prepare(`INSERT INTO pages(source_file,stored_file,status)
 VALUES(@source_file,@stored_file,'processing')
 ON CONFLICT(source_file) DO UPDATE SET stored_file=excluded.stored_file,status='processing',error=NULL
 RETURNING id`);
const clearVoters = db.prepare('DELETE FROM voters WHERE page_id=?');
const insertVoter = db.prepare(`INSERT INTO voters
(page_id,serial_no,voter_id,name,relative_name,relation_type,house_no,age,gender,ward_no,page_no,name_norm,relative_norm,name_key,relative_key)
VALUES(@page_id,@serial_no,@voter_id,@name,@relative_name,@relation_type,@house_no,@age,@gender,@ward_no,@page_no,@name_norm,@relative_norm,@name_key,@relative_key)`);
const finishPage = db.prepare(`UPDATE pages SET ward_no=@ward_no,page_no=@page_no,total_pages=@total_pages,
 assembly_name=@assembly_name,polling_station=@polling_station,status='ready',error=NULL,record_count=@record_count,
 processed_at=CURRENT_TIMESTAMP WHERE id=@id`);
const failPage = db.prepare(`UPDATE pages SET status='error',error=?,processed_at=CURRENT_TIMESTAMP WHERE id=?`);

const saveExtraction = db.transaction((sourceFile, storedFile, data) => {
  const pageId = Number(upsertPage.get({ source_file: sourceFile, stored_file: storedFile }).id);
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
    assembly_name: text(data.assembly_name), polling_station: text(data.polling_station), record_count: count
  });
  return { pageId, count, ward, page };
});
function text(v) { return v == null ? '' : String(v).trim(); }
module.exports = { db, saveExtraction, failPage, upsertPage };
