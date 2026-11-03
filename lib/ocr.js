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
Do not invent unreadable text. Use empty string when genuinely unreadable. Preserve Devanagari spelling. Count every visible voter box.`;

const responseSchema = {
  type: 'OBJECT',
  properties: {
    ward_no: { type: 'STRING' }, page_no: { type: 'STRING' }, total_pages: { type: 'STRING' },
    assembly_name: { type: 'STRING' }, polling_station: { type: 'STRING' },
    voters: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
      serial_no: { type: 'STRING' }, voter_id: { type: 'STRING' }, name: { type: 'STRING' },
      relative_name: { type: 'STRING' }, relation_type: { type: 'STRING' }, house_no: { type: 'STRING' },
      age: { type: 'STRING' }, gender: { type: 'STRING' }
    }, required: ['serial_no','voter_id','name','relative_name','relation_type','house_no','age','gender'] } }
  }, required: ['ward_no','page_no','total_pages','assembly_name','polling_station','voters']
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
  const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
  let last;
  for (let attempt = 1; attempt <= 8; attempt++) {
    const key = keys[keyTurn++ % keys.length];
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
    last = new Error(json.error?.message || `Gemini HTTP ${res.status}`);
    if (![429, 500, 503].includes(res.status)) break;
    const retry = Number((json.error?.message || '').match(/retry in ([\d.]+)s/)?.[1] || 0);
    await new Promise(r => setTimeout(r, res.status === 429 ? (retry || 30) * 1000 / keys.length + 1500 : attempt * 2500));
  }
  throw last;
}
function mimeFor(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}
module.exports = { extractPage };
