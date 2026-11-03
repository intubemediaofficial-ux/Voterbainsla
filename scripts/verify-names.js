// Second-pass proofreading: re-reads each page photo against the stored OCR rows and saves the model's corrected reading.
const fs = require('fs');
const path = require('path');
const { db } = require('../lib/db');
const { execFileSync } = require('child_process');
const TMP = path.join(__dirname, '..', 'data', 'verify', 'tiles');

const OUT = path.join(__dirname, '..', 'data', 'verify');
const UP = path.join(__dirname, '..', 'uploads');
const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const keys = [...new Set([process.env.GEMINI_API_KEY_BAINSLA, process.env.GEMINI_API_KEY].filter(Boolean))];
fs.mkdirSync(TMP, { recursive: true });
const ROTF = path.join(OUT, 'rot.json');
const rot = fs.existsSync(ROTF) ? JSON.parse(fs.readFileSync(ROTF, 'utf8')) : {};

const schema = { type: 'ARRAY', items: { type: 'OBJECT', properties: {
  serial_no: { type: 'STRING' }, voter_id: { type: 'STRING' }, name: { type: 'STRING' },
  relative_name: { type: 'STRING' }, relation_type: { type: 'STRING' }, house_no: { type: 'STRING' },
  age: { type: 'STRING' }, gender: { type: 'STRING' }
}, required: ['serial_no', 'voter_id', 'name', 'relative_name', 'relation_type', 'house_no', 'age', 'gender'] } };

const prompt = () => `Read this Hindi electoral-roll page (given as 3 overlapping horizontal strips, top to bottom) and transcribe EVERY voter box exactly as printed.
Read each name letter by letter: matras, half letters, anusvara (ं), chandrabindu, nukta, and look-alike letters (श/स/ष/व, ब/व, ड/ढ/द, घ/ध, भ/म, ख/रव). Never guess a common name when the print shows a different one.
List each voter box only once even if it appears in two strips. Use empty string only when truly unreadable. Ignore any other page partly visible in the background.`;

const img = f => ({ inlineData: { mimeType: 'image/jpeg', data: fs.readFileSync(f).toString('base64') } });
async function call(parts, sch, think) {
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: sch, maxOutputTokens: 32768,
      mediaResolution: 'MEDIA_RESOLUTION_HIGH', thinkingConfig: { thinkingLevel: think } }
  };
  let last;
  for (let a = 0; a < 8; a++) {
    const key = keys[a % keys.length];
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(300000) });
      const j = await res.json();
      if (res.ok) return JSON.parse(j.candidates[0].content.parts.map(p => p.text || '').join(''));
      last = new Error(j.error?.message || res.status);
      if (![429, 500, 503].includes(res.status)) break;
    } catch (e) { last = e; }
    await new Promise(r => setTimeout(r, 5000 * (a + 1)));
  }
  throw last;
}

// Make the photo upright (model picks the rotation once per page) and cut it into 3 overlapping strips for sharper reading.
async function strips(p) {
  const src = path.join(UP, p.stored_file);
  if (rot[p.id] === undefined) {
    const opts = [0, 90, 180, 270], thumbs = opts.map(d => {
      const f = path.join(TMP, `${p.id}-r${d}.jpg`);
      execFileSync('convert', [src, '-auto-orient', '-rotate', String(d), '-resize', '900x900', f]);
      return f;
    });
    const r = await call([{ text: 'These are 4 rotated copies (A, B, C, D) of the same printed Hindi page. Which single copy shows the Hindi text upright and readable left-to-right, with the page title at the top?' },
      ...thumbs.flatMap((f, i) => [{ text: 'Copy ' + 'ABCD'[i] }, img(f)])],
      { type: 'OBJECT', properties: { copy: { type: 'STRING', enum: ['A', 'B', 'C', 'D'] } }, required: ['copy'] }, 'low');
    rot[p.id] = opts['ABCD'.indexOf(r.copy)];
    fs.writeFileSync(ROTF, JSON.stringify(rot));
  }
  const up = path.join(TMP, p.id + '-up.jpg');
  execFileSync('convert', [src, '-auto-orient', '-rotate', String(rot[p.id]), up]);
  const [w, h] = execFileSync('identify', ['-format', '%w %h', up]).toString().split(' ').map(Number);
  const sh = Math.round(h * 0.4), step = Math.round((h - sh) / 2);
  return [0, 1, 2].map(i => {
    const f = path.join(TMP, `${p.id}-${i}.jpg`);
    execFileSync('convert', [up, '-crop', `${w}x${sh}+0+${i * step}`, '+repage', '-quality', '90', f]);
    return f;
  });
}
const ask = async (p, rows) => call([{ text: prompt() }, ...(await strips(p)).map(img)], schema, process.env.GEMINI_THINKING || 'high');

(async () => {
  const only = process.argv.slice(2);
  const pages = db.prepare("SELECT id, stored_file, ward_no, page_no FROM pages WHERE status='ready' ORDER BY id").all()
    .filter(p => !only.length || only.includes(String(p.id)));
  const conc = Number(process.env.CONC || 3);
  let i = 0;
  const worker = async () => {
    while (i < pages.length) {
      const p = pages[i++];
      const out = path.join(OUT, p.id + '.json');
      if (fs.existsSync(out) && !process.env.FORCE) continue;
      const rows = db.prepare('SELECT serial_no, voter_id, name, relation_type, relative_name FROM voters WHERE page_id=? ORDER BY CAST(serial_no AS INT)').all(p.id);
      try {
        const v = await ask(p, rows);
        fs.writeFileSync(out, JSON.stringify(v));
        console.log(`ok page ${p.id} (W${p.ward_no} P${p.page_no}) ${rows.length}->${v.length}`);
      } catch (e) { console.log(`FAIL page ${p.id}: ${e.message}`); }
    }
  };
  await Promise.all(Array.from({ length: conc }, worker));
})();
