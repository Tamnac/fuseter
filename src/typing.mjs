// Opt-in typing heuristics. They change the ranking (and, through the threshold, the hit set), so results no longer match Fuse.
// Each heuristic is resolved here, applied after the kernels have produced the per-string error level.

const KNOWN = ["firstLetter", "transposition"];
const FIRST_LETTER_KNOWN = ["weighted", "midWord"];

// typing: { firstLetter: true | { weighted: true | 'first', midWord: 1 | 2 }, transposition: true }
// transposition: swapping two adjacent characters counts as one error instead of two (the kernels implement it, see kernel-js.mjs).
// firstLetter: the first character of every word of the query counts double: editing it costs 2 errors, it only matches for
// free on a word-initial text character, and the score is errors / (patLen + number of words). An exact match of such a character that
// is not on a word start costs `midWord` (default 1; 2 prices it like a wrong or missing one, which always costs 2).
// With `weighted: 'first'` only the first character of the query counts (the score divides by patLen + 1).
// Queries longer than 32 characters are scored chunk by chunk without it.
export function resolveTyping(typing) {
  if (typing == null) return { firstLetter: null, transposition: false };
  if (typeof typing !== "object") throw new TypeError("fastfuse: 'typing' must be an object");
  for (const name of Object.keys(typing)) if (!KNOWN.includes(name)) throw new TypeError(`fastfuse: unknown typing heuristic '${name}'`);
  return { firstLetter: resolveFirstLetter(typing.firstLetter), transposition: Boolean(typing.transposition) };
}

function resolveFirstLetter(option) {
  if (!option) return null;
  if (option === true) option = {};
  if (typeof option !== "object") throw new TypeError("fastfuse: typing.firstLetter must be true or an object");
  for (const name of Object.keys(option)) if (!FIRST_LETTER_KNOWN.includes(name)) throw new TypeError(`fastfuse: unknown typing.firstLetter option '${name}'`);
  const { weighted = true, midWord = 1 } = option;
  if (weighted !== true && weighted !== "first") throw new TypeError("fastfuse: typing.firstLetter.weighted must be true or 'first'");
  if (midWord !== 1 && midWord !== 2) throw new RangeError("fastfuse: typing.firstLetter.midWord must be 1 or 2");
  return { weighted, midWord };
}

const ALNUM = /[\p{L}\p{N}]/u;
const isAlnum = ch => {
  const c = ch.charCodeAt(0);
  if (c < 128) return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
  return ALNUM.test(ch);
};
const isLower = ch => ch !== ch.toUpperCase();
const isUpper = ch => ch !== ch.toLowerCase();

// A word starts at a letter/digit that follows a non-letter/digit (or the start), or at an upper-case letter that follows a lower-case one.
function startsWord(text, i) {
  if (!isAlnum(text[i])) return false;
  const prev = text[i - 1];
  return prev === undefined || !isAlnum(prev) || (isLower(prev) && isUpper(text[i]));
}

// One flag per character of the normalised `text` (the result of prepare(raw)): 1 where a word starts. Word starts are found in the raw
// string (case matters) and carried over through the per-character normalisation, which keeps the lengths of every case but
// exotic ones; if the lengths disagree the rule is applied to the normalised text instead.
export function wordStartFlags(raw, text, prepare, cache) {
  const flags = new Uint8Array(text.length);
  let at = 0;
  for (let i = 0; i < raw.length; i++) {
    let piece = cache.get(raw[i]);
    if (piece === undefined) cache.set(raw[i], piece = prepare(raw[i]));
    if (piece.length && at < flags.length && startsWord(raw, i)) flags[at] = 1;
    at += piece.length;
  }
  if (at !== text.length) for (let i = 0; i < text.length; i++) flags[i] = startsWord(text, i) ? 1 : 0;
  return flags;
}

// The weighted positions of a (normalised, at most 32 characters) query as a scanner rule: bit (patLen - 1 - i) like the char table.
// `weighted: true` weights the first character of every query word, 'first' only the first character; null when no position qualifies.
export function weightRule(q, { weighted, midWord }) {
  let mask = 0, count = 0;
  for (let i = 0; i < q.length; i++) {
    if (weighted === "first" && i > 0) break;
    if (startsWord(q, i)) { mask |= 1 << (q.length - 1 - i); count++; }
  }
  return count ? { mask, midWord, denom: q.length + count } : null;
}
