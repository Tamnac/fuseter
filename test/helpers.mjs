import Fuse from "fuse.js";

export function rng(seed) {
  let s = seed >>> 0;
  const next = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const int = n => Math.floor(next() * n);
  const pick = a => a[int(a.length)];
  return { next, int, pick };
}

const WORDS = ["the", "lord", "of", "rings", "harry", "potter", "and", "prisoner", "azkaban", "pride", "prejudice", "war", "peace", "gilt", "edges", "hobbit",
  "Agatha", "Christie", "Stephen", "King", "Tolkien", "ñandú", "Café", "naïve", "Ørsted", "Straße", "ŁÓDŹ", "日本語", "😀", "a", "b", "x", "worn-spine", "dust jacket", "1984", "R2-D2"];
const SPACES = [" ", " ", " ", "  ", "\t", "\u00a0"];

export function randomText(r, minWords = 1, maxWords = 6) {
  const n = minWords + r.int(maxWords - minWords + 1);
  let s = "";
  for (let i = 0; i < n; i++) s += (i ? r.pick(SPACES) : "") + r.pick(WORDS);
  return r.int(4) === 0 ? s.toUpperCase() : s;
}

export function randomDocs(r, n) {
  const docs = [];
  for (let i = 0; i < n; i++) {
    const d = { title: randomText(r), author: randomText(r, 1, 3), tags: Array.from({ length: r.int(4) }, () => randomText(r, 1, 2)), meta: { note: randomText(r, 1, 8), n: r.int(1000) } };
    const roll = r.int(20);
    if (roll === 0) delete d.title; else if (roll === 1) d.title = "   "; else if (roll === 2) d.author = null; else if (roll === 3) d.title = ""; else if (roll === 4) d.title = 12345;
    if (roll === 5) d.tags = [null, "", "solo"];
    docs.push(i % 17 === 5 ? { ...docs[i - 1] } : d);
  }
  return docs;
}

export function edit(r, s) {
  const chars = [...s];
  for (let e = r.int(4); e > 0 && chars.length; e--) {
    const i = r.int(chars.length), kind = r.int(3);
    if (kind === 0) chars[i] = String.fromCharCode(97 + r.int(26)); else if (kind === 1) chars.splice(i, 1); else chars.splice(i, 0, String.fromCharCode(97 + r.int(26)));
  }
  return chars.join("");
}

// Queries cut from the documents' own text (so most have hits), with edits, plus junk and chunked (> 32 chars) patterns.
export function randomQueries(r, strings, count) {
  const qs = ["a", "ab", "x", "zzzz", "the lord of the rings", "HARRY pOtter", "ñandu", "cafe", "strasse", "日本", "😀", "R2-D2", "  ", "\u00a0", ""];
  while (qs.length < count) {
    const s = r.pick(strings);
    if (typeof s !== "string" || !s.length) continue;
    const start = r.int(s.length), len = 1 + r.int(Math.min(s.length - start, 28));
    qs.push(edit(r, s.substr(start, len)));
  }
  for (let i = 0; i < 6; i++) qs.push(strings.map(s => String(s)).filter(Boolean).slice(i * 3, i * 3 + 9).join(" ").slice(0, 33 + r.int(40)));
  return qs;
}

export function stringsOf(docs, keys) {
  const out = [];
  for (const d of docs) for (const k of keys) { const v = d?.[k]; if (typeof v === "string") out.push(v); }
  return out;
}

export function compare(got, want) {
  if (got.length !== want.length) return `length ${got.length} != ${want.length}`;
  for (let i = 0; i < got.length; i++) {
    const a = got[i], b = want[i];
    if (a.refIndex !== b.refIndex || a.score !== b.score || a.item !== b.item) return `rank ${i}: #${a.refIndex} ${a.score} != #${b.refIndex} ${b.score}`;
  }
  return null;
}

export const fuseFor = (docs, options) => new Fuse(docs, { ...options, ignoreLocation: true, includeScore: true });
