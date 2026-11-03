// Additively copy ready pages + voters from another voters.db (e.g. one indexed with AREA=kheldi) into this DB.
// Usage: DB_PATH=<target> node scripts/merge-db.js <source.db>
const Database = require('better-sqlite3');
const { db } = require('../lib/db');
const src = new Database(process.argv[2], { readonly: true });
const pcols = db.prepare('PRAGMA table_info(pages)').all().map(c => c.name).filter(c => c !== 'id');
const vcols = db.prepare('PRAGMA table_info(voters)').all().map(c => c.name).filter(c => c !== 'id' && c !== 'page_id');
const has = db.prepare('SELECT id FROM pages WHERE source_file=?');
const insP = db.prepare(`INSERT INTO pages(${pcols}) VALUES(${pcols.map(c => '@' + c)}) RETURNING id`);
const insV = db.prepare(`INSERT INTO voters(page_id,${vcols}) VALUES(@page_id,${vcols.map(c => '@' + c)})`);
const pick = (row, cols) => Object.fromEntries(cols.map(c => [c, row[c] ?? null]));
let pages = 0, voters = 0, skipped = 0;
db.transaction(() => {
  for (const p of src.prepare("SELECT * FROM pages WHERE status='ready'").all()) {
    if (has.get(p.source_file)) { skipped++; continue; }
    const id = insP.get(pick(p, pcols)).id;
    pages++;
    for (const v of src.prepare('SELECT * FROM voters WHERE page_id=?').all(p.id)) { insV.run({ ...pick(v, vcols), page_id: id }); voters++; }
  }
})();
console.log({ pages, voters, skipped });
