// Third pass: for rows where the two readings disagree, show the page strips again with both candidates and keep the exact printed text.
const fs = require('fs');
const path = require('path');
const D = path.join(__dirname, '..', 'data', 'verify');
const TMP = path.join(D, 'tiles');
const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const keys = [...new Set([process.env.GEMINI_API_KEY_BAINSLA, process.env.GEMINI_API_KEY].filter(Boolean))];
const img = f => ({ inlineData: { mimeType: 'image/jpeg', data: fs.readFileSync(f).toString('base64') } });
const schema = { type: 'ARRAY', items: { type: 'OBJECT', properties: { n: { type: 'STRING' }, printed: { type: 'STRING' } }, required: ['n', 'printed'] } };

async function call(parts) {
  let last;
  for (let a = 0; a < 8; a++) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${keys[a % keys.length]}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(300000),
        body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: schema,
          maxOutputTokens: 16384, mediaResolution: 'MEDIA_RESOLUTION_HIGH', thinkingConfig: { thinkingLevel: 'high' } } })
      });
      const j = await res.json();
      if (res.ok) return JSON.parse(j.candidates[0].content.parts.map(p => p.text || '').join(''));
      last = new Error(j.error?.message || res.status);
      if (![429, 500, 503].includes(res.status)) break;
    } catch (e) { last = e; }
    await new Promise(r => setTimeout(r, 5000 * (a + 1)));
  }
  throw last;
}

const label = { name: 'नाम', relative_name: 'पिता/पति/माता का नाम', voter_id: 'Voter ID (EPIC)' };
(async () => {
  const diff = JSON.parse(fs.readFileSync(path.join(D, 'diff.json'), 'utf8'));
  const JF = path.join(D, 'judge.json');
  const done = fs.existsSync(JF) ? JSON.parse(fs.readFileSync(JF, 'utf8')) : {};
  const pages = [...new Set(diff.map(d => d.page))].filter(p => !done[p]);
  let i = 0;
  const worker = async () => {
    while (i < pages.length) {
      const p = pages[i++];
      const items = diff.filter(d => d.page === p).flatMap(d => Object.entries(d.diff).map(([k, [a, b]]) => ({ id: d.id, serial: d.serial, k, a, b })));
      const text = `This Hindi electoral-roll page is given as 3 overlapping strips (top to bottom). For each question below, look at the voter box with that serial number and copy the field EXACTLY as printed, character by character (matras, half letters, ं, ँ, nukta, श/स/ष/व, ब/व, ड/ढ/द, घ/ध/च, भ/म). Two machine readings are given as hints; either may be wrong.
${items.map((t, n) => `${n + 1}. serial ${t.serial}, ${label[t.k]}: hint A "${t.a}", hint B "${t.b}"`).join('\n')}
Return one entry per question, n = question number.`;
      try {
        const strips = [0, 1, 2].map(s => path.join(TMP, `${p}-${s}.jpg`));
        const r = await call([{ text }, ...strips.map(img)]);
        done[p] = items.map((t, n) => ({ ...t, judge: (r.find(x => String(x.n) === String(n + 1)) || {}).printed || '' }));
        fs.writeFileSync(JF, JSON.stringify(done, null, 1));
        console.log('judged page', p, items.length);
      } catch (e) { console.log('FAIL', p, e.message); }
    }
  };
  await Promise.all(Array.from({ length: Number(process.env.CONC || 3) }, worker));
})();
