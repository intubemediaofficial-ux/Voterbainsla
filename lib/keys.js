// Loose phonetic keys so "Ramghani", "ramgani" and "रामघनी" all match.
const DEV = {
  'क':'k','ख':'k','ग':'g','घ':'g','ङ':'n','च':'c','छ':'c','ज':'j','झ':'j','ञ':'n',
  'ट':'t','ठ':'t','ड':'d','ढ':'d','ण':'n','त':'t','थ':'t','द':'d','ध':'d','न':'n',
  'प':'p','फ':'f','ब':'b','भ':'b','म':'m','य':'','र':'r','ल':'l','ळ':'l','व':'v',
  'श':'s','ष':'s','स':'s','ह':'','ं':'n','ऩ':'n','ऱ':'r','क़':'k','ख़':'k','ग़':'g',
  'ज़':'j','ड़':'r','ढ़':'r','फ़':'f','य़':'',
  'ॐ':'m',
};
function devKey(s) {
  s = (s || '').normalize('NFC');
  let out = '';
  for (const ch of s) {
    if (DEV[ch] !== undefined) out += DEV[ch];
    else if (/[a-z]/i.test(ch)) out += romanKey(ch);
    else if (/\s/.test(ch)) out += ' ';
  }
  return squash(out);
}
function romanKey(s) {
  s = (s || '').toLowerCase().replace(/[^a-z\s]/g, '');
  s = s.replace(/chh/g, 'c').replace(/ch/g, 'c').replace(/sh/g, 's').replace(/ph/g, 'f')
    .replace(/kh/g, 'k').replace(/gh/g, 'g').replace(/jh/g, 'j').replace(/th/g, 't')
    .replace(/dh/g, 'd').replace(/bh/g, 'b').replace(/x/g, 'ks').replace(/q/g, 'k')
    .replace(/z/g, 'j').replace(/w/g, 'v').replace(/c(?!h)/g, 'c');
  s = s.replace(/[aeiouyh]/g, '');
  return squash(s);
}
function squash(s) {
  return s.split(/\s+/).map(w => w.replace(/(.)\1+/g, '$1')).filter(Boolean).join(' ');
}
function anyKey(s) {
  return /[\u0900-\u097F]/.test(s || '') ? devKey(s) : romanKey(s);
}
function normText(s) {
  return (s || '').toLowerCase().normalize('NFC').replace(/[\u093C\u0901]/g, '')
    .replace(/\u0940/g, '\u093F').replace(/\u0942/g, '\u0941').replace(/[^a-z0-9\u0900-\u097F]/g, '');
}
module.exports = { devKey, romanKey, anyKey, normText };
