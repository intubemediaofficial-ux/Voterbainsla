const fs = require('fs');
const path = require('path');

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
- gram_panchayat: Hindi name after "ग्रामपंचायत :" / "ग्राम पंचायत" in the header, and gram_panchayat_en: that name in English letters (e.g. झाड़ीसा -> Jharisa).
- district: Hindi district from "जिला" / "जिलापरिषद का नाम", and district_en in English letters (e.g. करौली -> Karauli). Empty string if not printed on this page.
Do not invent unreadable text. Use empty string when genuinely unreadable. Preserve Devanagari spelling. Count every visible voter box.`;

const responseSchema = {
  type: 'OBJECT',
  properties: {
    ward_no: { type: 'STRING' }, page_no: { type: 'STRING' }, total_pages: { type: 'STRING' },
    assembly_name: { type: 'STRING' }, polling_station: { type: 'STRING' },
    gram_panchayat: { type: 'STRING' }, gram_panchayat_en: { type: 'STRING' }, district: { type: 'STRING' }, district_en: { type: 'STRING' },
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
async function extractPage(file) {
  const keys = apiKeys();
  if (!keys.length) throw new Error('Gemini API key is not configured');
  const mime = mimeFor(file);
  const body = {
    contents: [{ role: 'user', parts: [
      { text: PROMPT },
      { inlineData: { mimeType: mime, data: fs.readFileSync(file).toString('base64') } }
    ] }],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json',
      responseSchema,
      maxOutputTokens: 32768,
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
module.exports = { extractPage };
