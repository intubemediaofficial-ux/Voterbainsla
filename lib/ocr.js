const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// Gemini tends to "fix" uncommon spellings (गिर्राज -> गिरर्ज, ब्रह्म -> ब्रहम); these rules plus zoomed column strips keep names as printed.
const NAME_RULES = `Names must be copied EXACTLY as printed, glyph by glyph. Do not correct, standardise or "fix" spellings, and never replace a name with a more common one.
Pay special attention to conjuncts and half letters: र्र (e.g. गिर्राज, गिर्राजी), reph र्, ह्म (ब्रह्म), ल्ल (खिल्लू), भ vs ब्ह (ब्रजभान), द्र, न्द्र vs ंद्र, क्ष, ज्ञ, श्र, nukta, anusvara/chandrabindu, ि vs ी, ु vs ू.
The label and the name are often printed touching, like "पिता का नाम:करण सिंह" - the name starts right after the colon; never merge label letters into the name.
Keep spaces exactly as printed ("मान सिंह" vs "मानसिंह").
After the full page you get the three voter columns again, zoomed (left, middle, right). Read names from the zoomed strips; list each voter box only once.`;

const PROMPT = `Read this photographed Hindi electoral-roll page very carefully. The photo may be rotated; mentally rotate it upright.
Return ONLY JSON. Extract page metadata and EVERY voter card visible, including supplement/deletion sections.
Important fields per voter:
- serial_no: boxed क्रम संख्या printed beside the voter (not age/house number)
- voter_id: EPIC identifier such as WZM..., BKR..., RJ/...
- name: exact Hindi text after नाम:
- relative_name: exact Hindi text after पिता का नाम:, पति का नाम:, माता का नाम:, or अन्य
- relation_type: one of पिता, पति, माता, अन्य, blank if absent
- house_no: मकान संख्या
- age and gender
Metadata:
- ward_no from header "वार्ड क्रमांक"
- page_no and total_pages from footer "पृष्ठ संख्या: X/Y". page_no must be X.
- assembly_name from विधानसभा क्षेत्र की संख्या एवं नाम
- polling_station if visible.
- main_village: name after "मुख्य गांव" (cover page), else empty.
- sections: plain-text village/mohalla headings printed between voter boxes (e.g. "लींगरी पट्टी,झाडीसा", "मौजीनाथ का पूरा"), each with first_serial = boxed serial of the first voter directly below it. Skip header-table text and list titles (deletion/supplement/correction lists).
- gram_panchayat: Hindi name after "ग्रामपंचायत :" / "ग्राम पंचायत" in the header, and gram_panchayat_en: that name in English letters (e.g. झाड़ीसा -> Jharisa).
- panchayat_samiti: Hindi name after "पंचायत समिति का नाम", and panchayat_samiti_en in English letters (e.g. टोडाभीम -> Todabhim). Empty string if not printed.
- district: Hindi district from "जिला" / "जिलापरिषद का नाम", and district_en in English letters (e.g. करौली -> Karauli). Empty string if not printed on this page.
Do not invent unreadable text. Use empty string when genuinely unreadable. Preserve Devanagari spelling. Count every visible voter box.
${NAME_RULES}`;

const SECTION = { type: 'OBJECT', properties: { name: { type: 'STRING' }, first_serial: { type: 'STRING' } }, required: ['name', 'first_serial'] };
const SECTION_PROMPT = `This is a page of a Hindi panchayat electoral roll. Return ONLY JSON.
- ward_no from header "वार्ड क्रमांक"; page_no = X from footer "पृष्ठ संख्या: X/Y".
- main_village: text after "मुख्य गांव" if this is a cover page, else empty.
- sections: every plain-text village/mohalla heading printed on its own line between/above the voter boxes (outside the header table), e.g. "लींगरी पट्टी,झाडीसा", "मौजीनाथ का पूरा", "बैरवा मौहल्ला,रामनगर दौसी". For each give the exact Devanagari name and first_serial = the boxed serial number of the first voter box directly below that heading. Do not include header-table text or list titles (deletion/supplement/correction list titles). Empty array if the page has no such heading.`;
const sectionSchema = { type: 'OBJECT', properties: { ward_no: { type: 'STRING' }, page_no: { type: 'STRING' }, main_village: { type: 'STRING' },
  sections: { type: 'ARRAY', items: SECTION } }, required: ['ward_no', 'page_no', 'main_village', 'sections'] };
const responseSchema = {
  type: 'OBJECT',
  properties: {
    ward_no: { type: 'STRING' }, page_no: { type: 'STRING' }, total_pages: { type: 'STRING' },
    assembly_name: { type: 'STRING' }, polling_station: { type: 'STRING' }, main_village: { type: 'STRING' },
    sections: { type: 'ARRAY', items: SECTION },
    gram_panchayat: { type: 'STRING' }, gram_panchayat_en: { type: 'STRING' }, district: { type: 'STRING' }, district_en: { type: 'STRING' },
    panchayat_samiti: { type: 'STRING' }, panchayat_samiti_en: { type: 'STRING' },
    voters: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
      serial_no: { type: 'STRING' }, voter_id: { type: 'STRING' }, name: { type: 'STRING' },
      relative_name: { type: 'STRING' }, relation_type: { type: 'STRING' }, house_no: { type: 'STRING' },
      age: { type: 'STRING' }, gender: { type: 'STRING' }
    }, required: ['serial_no','voter_id','name','relative_name','relation_type','house_no','age','gender'] } }
  }, required: ['ward_no','page_no','total_pages','assembly_name','polling_station','gram_panchayat','gram_panchayat_en','district','district_en','voters']
};

let keyTurn = 0;
function apiKeys() {
  return [...new Set([process.env.GEMINI_API_KEY_BAINSLA, process.env.GEMINI_API_KEY, ...(process.env.GEMINI_API_KEYS || '').split(',')].map(k => (k || '').trim()).filter(Boolean))];
}
const inline = (data, mimeType = 'image/jpeg') => ({ inlineData: { mimeType, data: data.toString('base64') } });
// Three overlapping full-height column strips at 2x, so small conjuncts are legible to the model.
async function columns(file) {
  const img = sharp(file).rotate();
  const { width, height } = await img.metadata();
  const pad = Math.round(width * 0.04), cw = width / 3;
  return Promise.all([0, 1, 2].map(i => {
    const left = Math.max(0, Math.round(i * cw) - pad), right = Math.min(width, Math.round((i + 1) * cw) + pad);
    return sharp(file).rotate().extract({ left, top: 0, width: right - left, height })
      .resize({ width: (right - left) * 2, kernel: 'lanczos3' }).jpeg({ quality: 90 }).toBuffer();
  }));
}
async function zoomed(file) {
  try { return (await columns(file)).map(b => inline(b)); } catch { return []; }
}
const dedupe = d => {
  if (!Array.isArray(d.voters)) return d;
  const seen = new Set();
  d.voters = d.voters.filter(v => { const k = `${v.serial_no}|${String(v.voter_id || '').replace(/\s/g, '')}`; return !seen.has(k) && seen.add(k); });
  return d;
};
const extractPage = async file => dedupe(await callGemini(file, PROMPT, responseSchema, 32768, await zoomed(file)));
const extractSections = file => callGemini(file, SECTION_PROMPT, sectionSchema, 4096);
const NAMES_PROMPT = `Read this Hindi electoral-roll page. Return ONLY JSON: every voter box with serial_no (boxed number), voter_id, name (Hindi text after "नाम:") and relative_name (Hindi text after "पिता का नाम:"/"पति का नाम:"/"माता का नाम:"/"अन्य").
${NAME_RULES}`;
const namesSchema = { type: 'ARRAY', items: { type: 'OBJECT', properties: { serial_no: { type: 'STRING' }, voter_id: { type: 'STRING' }, name: { type: 'STRING' }, relative_name: { type: 'STRING' } }, required: ['serial_no', 'voter_id', 'name', 'relative_name'] } };
const readNames = async file => (await callGemini(file, NAMES_PROMPT, namesSchema, 16384, await zoomed(file))) || [];
async function callGemini(file, prompt, schema, maxOutputTokens, extra = []) {
  const keys = apiKeys();
  if (!keys.length) throw new Error('Gemini API key is not configured');
  const mime = mimeFor(file);
  const body = {
    contents: [{ role: 'user', parts: [
      { text: prompt },
      inline(fs.readFileSync(file), mime),
      ...extra
    ] }],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json',
      responseSchema: schema,
      maxOutputTokens,
      thinkingConfig: { thinkingLevel: process.env.GEMINI_THINKING || 'low' }
    }
  };
  // Every key x model pair has its own daily free quota; a pair that runs out is skipped until its reset time.
  const models = (process.env.GEMINI_MODELS || process.env.GEMINI_MODEL || 'gemini-3.8-flash,gemini-3.5-flash,gemini-3.5-flash-lite').split(',').map(m => m.trim()).filter(Boolean);
  const pairs = models.flatMap(model => keys.map(key => ({ model, key })));
  let last;
  for (let attempt = 1; attempt <= Math.max(8, pairs.length * 2); attempt++) {
    const open = pairs.filter(p => (blocked.get(p.model + p.key) || 0) < Date.now());
    if (!open.length) throw last || new Error('Gemini quota is used up on every key; try again later');
    const { model, key } = open[keyTurn++ % open.length];
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
    let res, json;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(Number(process.env.OCR_TIMEOUT_MS || 240000)) });
      json = await res.json();
    } catch (err) {
      last = new Error(`Gemini request failed: ${err.message}`);
      await new Promise(r => setTimeout(r, attempt * 2500));
      continue;
    }
    if (res.ok) {
      const raw = json.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
      try { return JSON.parse(raw); } catch { throw new Error(`Invalid OCR JSON: ${raw.slice(0, 300)}`); }
    }
    const msg = json.error?.message || `Gemini HTTP ${res.status}`;
    last = new Error(msg);
    if ([400, 401, 403, 404].includes(res.status)) { blocked.set(model + key, Date.now() + 3600e3); continue; }
    if (![429, 500, 503].includes(res.status)) break;
    const retry = parseRetry(msg);
    if (res.status === 429 && (retry > 120 || /per ?day|PerDay/i.test(msg))) { blocked.set(model + key, Date.now() + Math.max(retry, 600) * 1000); continue; }
    await new Promise(r => setTimeout(r, res.status === 429 ? (retry || 30) * 1000 / open.length + 1500 : attempt * 2500));
  }
  throw last;
}
const blocked = new Map();
function parseRetry(msg) {
  const m = /retry in (?:(\d+)h)?(?:(\d+)m)?([\d.]+)s/.exec(msg);
  return m ? (Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3])) : 0;
}
function mimeFor(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}
module.exports = { extractPage, extractSections, readNames };
