const NON_DECOMPOSABLE = { "ł": "l", "Ł": "L", "đ": "d", "Đ": "D", "ø": "o", "Ø": "O", "ħ": "h", "Ħ": "H", "ŧ": "t", "Ŧ": "T", "ı": "i", "ß": "ss" };
const NON_DECOMPOSABLE_RE = /[łŁđĐøØħĦŧŦıß]/g;

const stripDiacritics = s => s.normalize("NFD").replace(/\p{M}/gu, "").replace(NON_DECOMPOSABLE_RE, ch => NON_DECOMPOSABLE[ch]);

// The transform applied to every indexed string and to the query (Fuse: lower-case first, then strip diacritics).
export function textNormalizer({ isCaseSensitive, ignoreDiacritics }) {
  if (isCaseSensitive) return ignoreDiacritics ? stripDiacritics : s => s;
  return ignoreDiacritics ? s => stripDiacritics(s.toLowerCase()) : s => s.toLowerCase();
}

// Fuse's field-length norm: 1 / sqrt(words), rounded to 3 digits and cached per word count.
const isSeparator = c => (c >= 9 && c <= 13) || c === 32 || c === 160;
export function fieldNorm(weight = 1, mantissa = 3) {
  const cache = [], m = Math.pow(10, mantissa);
  return v => {
    let words = 0, inWord = false;
    for (let i = 0; i < v.length; i++) {
      if (!isSeparator(v.charCodeAt(i))) { if (!inWord) { words++; inWord = true; } } else inWord = false;
    }
    if (words === 0) words = 1;
    return cache[words] ??= Math.round(m / Math.pow(words, 0.5 * weight)) / m;
  };
}
