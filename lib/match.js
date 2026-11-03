// Word-level Hindi/English name matching that keeps vowels, so "dholi" = धोली/धौली
// but "harish singh" never matches "amar singh".
const CONS = {
  'क':'k','ख':'k','ग':'g','घ':'g','ङ':'n','च':'c','छ':'c','ज':'j','झ':'j','ञ':'n',
  'ट':'t','ठ':'t','ड':'d','ढ':'d','ण':'n','त':'t','थ':'t','द':'d','ध':'d','न':'n',
  'प':'p','फ':'f','ब':'b','भ':'b','म':'m','य':'y','र':'r','ल':'l','ळ':'l','व':'v',
  'श':'s','ष':'s','स':'s','ह':'','ऩ':'n','ऱ':'r','क़':'k','ख़':'k','ग़':'g','ज़':'j',
  'ड़':'r','ढ़':'r','फ़':'f','य़':'y','ं':'n','ँ':'n','ः':'',
  'ा':'','ि':'i','ी':'i','ु':'u','ू':'u','ृ':'ri','े':'e','ै':'e','ो':'o','ौ':'o','ॅ':'e','ॉ':'o',
  'अ':'','आ':'','इ':'i','ई':'i','उ':'u','ऊ':'u','ऋ':'ri','ए':'e','ऐ':'e','ओ':'o','औ':'o',
};
function romanWord(w) {
  return w.replace(/ay$/, 'Y').replace(/chh/g, 'c').replace(/ch/g, 'c').replace(/sh/g, 's').replace(/ph/g, 'f')
    .replace(/kh/g, 'k').replace(/gh/g, 'g').replace(/jh/g, 'j').replace(/th/g, 't')
    .replace(/dh/g, 'd').replace(/bh/g, 'b').replace(/x/g, 'ks').replace(/q/g, 'k')
    .replace(/z/g, 'j').replace(/w/g, 'v').replace(/ee|ii|ie/g, 'i').replace(/oo|uu/g, 'u')
    .replace(/ai|ei|ay(?![aeiou])/g, 'e').replace(/au|ou|aw/g, 'o').replace(/y$/g, 'i')
    .replace(/ng(?![aeiou])/g, 'n').replace(/[ah]/g, '').replace('Y', 'y');
}
function vkey(word) {
  let out = '';
  for (const ch of word.normalize('NFC').toLowerCase()) {
    if (CONS[ch] !== undefined) out += CONS[ch];
    else if (/[a-z]/.test(ch)) out += ch;
  }
  if (!/[\u0900-\u097F]/.test(word)) out = romanWord(out);
  return out.replace(/^y/, 'j').replace(/v/g, 'b').replace(/(.)\1+/g, '$1');
}
function words(s) {
  return String(s || '').split(/[\s.,()\-_/]+/).map(vkey).filter(Boolean);
}
function sim(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return 1 - d[b.length] / Math.max(a.length, b.length);
}
function wordScore(q, w) {
  if (q === w) return 100;
  if (q.length >= 3 && w.startsWith(q)) return 85;
  const s = sim(q, w);
  if (q[0] === w[0] && (q.length >= 8 ? s >= 0.75 : q.length >= 6 && s >= 0.83)) return Math.round(80 * s);
  return 0;
}
// Every query word must match a different word of the field; returns 0 when any word is missing.
function fieldScore(qw, fw) {
  if (!qw.length || !fw.length) return 0;
  const joinedQ = qw.join('');
  let joined = 0;
  // Compare the query with runs of consecutive field words, so "hathisingh" = "हाथी सिंह गुर्जर".
  for (let i = 0; i < fw.length; i++) {
    let span = '';
    for (let j = i; j < fw.length; j++) {
      span += fw[j];
      const n = j - i + 1, extra = 3 * (fw.length - n);
      if (span === joinedQ) joined = Math.max(joined, (i === 0 ? 100 : 90) - extra);
      else if (joinedQ.length >= 5 && n !== qw.length && span[0] === joinedQ[0]) {
        const s = sim(joinedQ, span);
        if (s >= 0.8) joined = Math.max(joined, Math.round(85 * s) - extra);
      }
    }
  }
  const used = new Set();
  let total = 0;
  for (const q of qw) {
    let best = 0, at = -1;
    fw.forEach((w, i) => { if (!used.has(i)) { const s = wordScore(q, w); if (s > best) { best = s; at = i; } } });
    if (!best) { total = 0; break; }
    used.add(at); total += best;
  }
  let words = total ? total / qw.length - (fw.length > qw.length ? 3 * (fw.length - qw.length) : 0) : 0;
  return Math.max(words, joined);
}
module.exports = { words, fieldScore, vkey, sim };
