// Fuse's extended search syntax (src/search/extended): the query is OR groups separated by `|` (`\|` is a literal bar), each an AND of space-separated
// terms. A term is a fuzzy pattern unless an operator says otherwise:
//   =x exact   'x includes   ^x prefix   x$ suffix   !x not included   !^x not a prefix   !x$ not a suffix   "x y" a term with spaces (also behind an operator)

const OPERATORS = [
  ["exact", /^="(.*)"$/, /^=(.*)$/],
  ["include", /^'"(.*)"$/, /^'(.*)$/],
  ["prefix-exact", /^\^"(.*)"$/, /^\^(.*)$/],
  ["inverse-prefix-exact", /^!\^"(.*)"$/, /^!\^(.*)$/],
  ["inverse-suffix-exact", /^!"(.*)"\$$/, /^!(.*)\$$/],
  ["suffix-exact", /^"(.*)"\$$/, /^(.*)\$$/],
  ["inverse-exact", /^!"(.*)"$/, /^!(.*)$/],
  ["fuzzy", /^"(.*)"$/, /^(.*)$/],
];
const ESCAPED_BAR = "\0";

export const isInverse = type => type.startsWith("inverse");

// Splits a group at spaces; a term that starts with (an operator and) a quote runs to the closing quote, which must be followed by a space, the end or `$`.
function splitTerms(text) {
  const terms = [], len = text.length;
  let i = 0;
  while (i < len) {
    while (i < len && text[i] === " ") i++;
    if (i >= len) break;
    let j = i;
    while (j < len && text[j] !== " " && text[j] !== "\"") j++;
    if (j < len && text[j] === "\"") {
      j++;
      while (j < len) {
        if (text[j] === "\"") {
          const next = j + 1;
          if (next >= len || text[next] === " ") { j++; break; }
          if (text[next] === "$" && (next + 1 >= len || text[next + 1] === " ")) { j += 2; break; }
        }
        j++;
      }
    } else while (j < len && text[j] !== " ") j++;
    terms.push(text.substring(i, j));
    i = j;
  }
  return terms;
}

// An operator whose pattern comes out empty does not count (`'` alone is a fuzzy search for "'"), the quoted forms are tried before the plain ones.
function parseTerm(term) {
  for (const column of [1, 2]) for (const operator of OPERATORS) {
    const pattern = term.match(operator[column])?.[1];
    if (pattern) return { type: operator[0], pattern };
  }
  return null;
}

// The (already normalised) query as groups of { type, pattern }; a group can be empty.
export function parseExtended(query) {
  return query.replace(/\\\|/g, ESCAPED_BAR).split("|").map(group => splitTerms(group.replace(/\0/g, "|").trim()).filter(term => term.trim()).map(parseTerm).filter(Boolean));
}

const INCLUDE = 0, PREFIX = 1, SUFFIX = 2, EXACT = 3;
const KINDS = {
  "exact": [EXACT, 0],
  "include": [INCLUDE, 0],
  "prefix-exact": [PREFIX, 0],
  "suffix-exact": [SUFFIX, 0],
  "inverse-exact": [INCLUDE, 1],
  "inverse-prefix-exact": [PREFIX, 1],
  "inverse-suffix-exact": [SUFFIX, 1],
};

// The operators that list the strings they match (see drive below); the other terms of a group are then tested on those strings only.
export const DRIVERS = new Set(["exact", "prefix-exact", "suffix-exact", "include"]);

// The exact-style operators on the strings of a corpus, with the optional wasm side of extended-wasm.mjs (the same work in wasm, over the same `cand` and `bits`).
// A sparse search keeps a list of string ids in `cand` and a byte per string in `bits` and a float in `sum` (`begin` zeroes them for the strings in cand): `drive` fills cand with the strings (ascending) that a term of a DRIVERS type
// matches, `narrow` drops the strings of cand where another term does not hold (and sets bits for an inverse operator that does); both return the count of ids in cand.
// `bound` is the most strings `drive` can list, `mark` returns flags (valid until the next
// call) for every string, `ranges` gives the match ranges of a string.
export function createStringMatchers({ data, offs, n }, wasm = null) {
  const cand = wasm?.cand ?? new Int32Array(n), bits = wasm?.bits ?? new Uint8Array(n), sum = wasm?.sum ?? new Float64Array(n);
  let flags = null;                  // for mark
  let text = null;                   // all the strings as one, for the engine's string search
  let byFirst = null, byLast = null; // the strings grouped by their first or last character
  const lengthOf = s => offs[s + 1] - offs[s];
  // Whether the pattern is at data position p, given that its first character is.
  const restAt = (p, pattern) => {
    for (let i = 1; i < pattern.length; i++) if (data[p + i] !== pattern.charCodeAt(i)) return false;
    return true;
  };
  const occursAt = (s, pattern, at) => data[offs[s] + at] === pattern.charCodeAt(0) && restAt(offs[s] + at, pattern);
  const indexOf = (s, pattern, from) => {
    const first = pattern.charCodeAt(0), start = offs[s];
    for (let p = start + from, last = offs[s + 1] - pattern.length; p <= last; p++) if (data[p] === first && restAt(p, pattern)) return p - start;
    return -1;
  };
  const exact = (s, pattern) => lengthOf(s) === pattern.length && occursAt(s, pattern, 0);
  const prefix = (s, pattern) => lengthOf(s) >= pattern.length && occursAt(s, pattern, 0);
  const suffix = (s, pattern) => lengthOf(s) >= pattern.length && occursAt(s, pattern, lengthOf(s) - pattern.length);
  const includes = (s, pattern) => indexOf(s, pattern, 0) >= 0;
  const tests = {
    "exact": exact,
    "include": includes,
    "prefix-exact": prefix,
    "suffix-exact": suffix,
    "inverse-exact": (s, pattern) => !includes(s, pattern),
    "inverse-prefix-exact": (s, pattern) => !prefix(s, pattern),
    "inverse-suffix-exact": (s, pattern) => !suffix(s, pattern),
  };

  const joined = () => {
    if (text === null) {
      const parts = [];
      for (let i = 0; i < data.length; i += 8192) parts.push(String.fromCharCode.apply(null, data.subarray(i, i + 8192)));
      text = parts.join("");
    }
    return text;
  };

  // A match in the joined text counts when it lies within one string; the next search starts at the following string.
  function listIncluding(pattern) {
    const found = wasm?.find(pattern) ?? -1;
    if (found >= 0) return found;
    const all = joined();
    let count = 0, s = 0;
    for (let at = all.indexOf(pattern); at >= 0;) {
      while (offs[s + 1] <= at) s++;
      if (at + pattern.length <= offs[s + 1]) { cand[count++] = s; at = all.indexOf(pattern, offs[s + 1]); }
      else at = all.indexOf(pattern, at + 1);
    }
    return count;
  }

  // Bucket c of the result is order[start[c]..start[c + 1]], the (non-empty) strings that begin (or end) with character c, in string order.
  function bucketed(end) {
    const start = new Uint32Array(65538), order = new Uint32Array(n);
    const key = s => data[end ? offs[s + 1] - 1 : offs[s]];
    for (let s = 0; s < n; s++) if (lengthOf(s)) start[key(s) + 2]++;
    for (let c = 2; c < start.length; c++) start[c] += start[c - 1];
    for (let s = 0; s < n; s++) if (lengthOf(s)) order[start[key(s) + 1]++] = s;
    wasm?.setBuckets(end, order);
    return { start, order };
  }

  const bucketsOf = kind => kind === SUFFIX ? (byLast ??= bucketed(true)) : (byFirst ??= bucketed(false));
  const characterOf = (kind, pattern) => pattern.charCodeAt(kind === SUFFIX ? pattern.length - 1 : 0);

  // An upper bound of what drive lists: the strings with the same first (last) character, or all of them for an include.
  function bound(type, pattern) {
    const kind = KINDS[type][0];
    if (kind === INCLUDE) return n;
    const { start } = bucketsOf(kind), c = characterOf(kind, pattern);
    return start[c + 1] - start[c];
  }

  function list(kind, pattern) {
    if (kind === INCLUDE) return listIncluding(pattern);
    const { start, order } = bucketsOf(kind), c = characterOf(kind, pattern), last = kind === SUFFIX;
    const found = wasm?.listBucket(kind, last, start[c], start[c + 1], pattern) ?? -1;
    if (found >= 0) return found;
    const test = kind === EXACT ? exact : kind === PREFIX ? prefix : suffix;
    let count = 0;
    for (let i = start[c], end = start[c + 1]; i < end; i++) if (test(order[i], pattern)) cand[count++] = order[i];
    return count;
  }

  function narrow(type, pattern, count) {
    const [kind, inverted] = KINDS[type];
    const done = wasm?.narrow(kind, inverted, pattern, count) ?? -1;
    if (done >= 0) return done;
    const test = tests[type];
    let kept = 0;
    for (let i = 0; i < count; i++) { const s = cand[i]; if (test(s, pattern)) { cand[kept++] = s; bits[s] |= inverted; } }
    return kept;
  }

  function begin(count) {
    if (wasm) wasm.clear(count);
    else for (let i = 0; i < count; i++) { bits[cand[i]] = 0; sum[cand[i]] = 0; }
  }

  function mark(type, pattern) {
    flags ??= new Uint8Array(n);
    const [kind, inverted] = KINDS[type];
    flags.fill(inverted);
    const count = list(kind, pattern);
    for (let i = 0; i < count; i++) flags[cand[i]] = 1 - inverted;
    return flags;
  }

  // Fuse's indices of a matching string (inverse operators mark the whole string).
  function ranges(type, pattern, s) {
    const len = lengthOf(s);
    if (isInverse(type)) return [[0, len - 1]];
    if (type === "suffix-exact") return [[len - pattern.length, len - 1]];
    if (type !== "include") return [[0, pattern.length - 1]];
    const found = [];
    for (let at = indexOf(s, pattern, 0); at >= 0; at = indexOf(s, pattern, at + pattern.length)) found.push([at, at + pattern.length - 1]);
    return found;
  }
  return { cand, bits, sum, begin, bound, drive: (type, pattern) => list(KINDS[type][0], pattern), narrow, mark, ranges };
}
