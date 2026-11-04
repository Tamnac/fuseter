import { createAligner } from "./align.mjs";
import { createLocator } from "./kernel-js.mjs";

// The string ids grouped by length (ascending, stable): the ids of length l are order[start[l] .. start[l + 1]).
export function groupByLength({ offs, n, maxLen }) {
  const start = new Uint32Array(maxLen + 2);
  for (let s = 0; s < n; s++) start[offs[s + 1] - offs[s] + 1]++;
  for (let l = 1; l < start.length; l++) start[l] += start[l - 1];
  const next = start.slice(), order = new Uint32Array(n);
  for (let s = 0; s < n; s++) order[next[offs[s + 1] - offs[s]]++] = s;
  return { start, order };
}

export function equalsPattern({ data, offs }, s, q) {
  if (offs[s + 1] - offs[s] !== q.length) return false;
  for (let i = 0, p = offs[s]; i < q.length; i++, p++) if (data[p] !== q.charCodeAt(i)) return false;
  return true;
}

// Fuse's mergeIndices: sorted, overlapping or touching ranges joined.
function mergeIndices(indices) {
  indices.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const range of indices) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

// Ranges over the normalised text of `raw` to ranges over `raw` itself. Each normalised character
// belongs to the raw code point it came from, and a character that normalisation removes (a combining mark) stays with the one before it.
// If the pieces do not add up to the normalised text, the ranges are only clamped.
function toOriginal(raw, indices, normalize) {
  const normalized = normalize(raw);
  if (normalized === raw) return indices;
  const first = [], end = [], pieceOf = [];
  for (let i = 0; i < raw.length;) {
    const width = raw.codePointAt(i) > 0xffff ? 2 : 1, piece = normalize(raw.slice(i, i + width));
    if (piece.length) {
      for (let k = 0; k < piece.length; k++) pieceOf.push(first.length);
      first.push(i); end.push(i + width);
    } else if (end.length) end[end.length - 1] = i + width;
    i += width;
  }
  if (pieceOf.length !== normalized.length) return indices.map(([a, b]) => [Math.min(a, raw.length - 1), Math.min(b, raw.length - 1)]);
  return mergeIndices(indices.map(([a, b]) => [first[pieceOf[a]], end[pieceOf[b]] - 1]));
}

const HIGHLIGHTING_KNOWN = ["aligned", "allOccurrences"];

// highlighting: { aligned: true, allOccurrences: true } (experimental, see align.mjs); null keeps Fuse's indices.
// aligned: a range is the text the query was aligned with, instead of Fuse's mask (every character of the best window that occurs in the query).
// allOccurrences: every place where the query matches within the threshold, not only the best one (Fuse marks all error-free occurrences but only one approximate one).
export function resolveHighlighting(highlighting) {
  if (highlighting == null) return null;
  if (typeof highlighting !== "object") throw new TypeError("fuseter: 'highlighting' must be an object");
  for (const name of Object.keys(highlighting)) if (!HIGHLIGHTING_KNOWN.includes(name)) throw new TypeError(`fuseter: unknown highlighting option '${name}'`);
  const { aligned = false, allOccurrences = false } = highlighting;
  return aligned || allOccurrences ? { aligned: Boolean(aligned), allOccurrences: Boolean(allOccurrences) } : null;
}

// The strings of each document in slot order: [{ s, keyDef, value, refIndex, ranges: [] }] for the present slots (keyDef is undefined for collections of strings).
export function createSlotReader({ K, keyless, keys, present, values, refAt }) {
  const keyDefs = new Array(K);
  if (!keyless) for (const keyDef of keys) keyDefs.fill(keyDef, keyDef.base, keyDef.base + keyDef.width);
  return function slotsOf(d) {
    const slots = [];
    for (let s = d * K; s < d * K + K; s++) {
      if (present[s]) slots.push({ s, keyDef: keyDefs[s - d * K], value: values[s], refIndex: refAt[s] < 0 ? undefined : refAt[s], ranges: [] });
    }
    return slots;
  };
}

// Fuse drops the ranges shorter than minMatchCharLength (convertMaskToIndices), and a string left without any is not a match.
const dropShort = (ranges, minLength) => minLength > 1 ? ranges.filter(([from, to]) => to - from + 1 >= minLength) : ranges;

// Fuse's character mask over the normalised text of a string (what `includeMatches` reports) as ranges, for the pattern chunk given to `prep`.
// `ranges(s, patLen, start)` returns null when the chunk does not match string `s`, else the (possibly empty) ranges of at least minLength characters.
// Every non-overlapping error-free occurrence of the pattern is marked, plus every character that occurs in the pattern within [start, start + patLen - 1 + level],
// where start is the lowest start of a match at the best error level (see createLocator).
export function createRangeFinder(corpus, { transposition, minLength }) {
  const { data, offs } = corpus, locator = createLocator(corpus, transposition), { table } = locator;
  let mask = new Uint8Array(0);

  function chunkRanges(s, patLen, expected, { level, start, exact }) {
    const ts = offs[s], textLen = offs[s + 1] - ts;
    if (mask.length < textLen) mask = new Uint8Array(textLen);
    mask.fill(0, 0, textLen);
    if (level === 0) {
      for (let i = exact.length - 1, free = expected; i >= 0; i--) {
        if (exact[i] < free) continue;
        free = exact[i] + patLen;
        mask.fill(1, exact[i], Math.min(free, textLen));
      }
    }
    for (let k = start, last = Math.min(textLen - 1, start + patLen - 1 + level); k <= last; k++) if (table[data[ts + k]]) mask[k] = 1;
    const ranges = [];
    for (let i = 0, from = -1; i <= textLen; i++) {
      if (i < textLen && mask[i]) { if (from < 0) from = i; } else if (from >= 0) { ranges.push([from, i - 1]); from = -1; }
    }
    return dropShort(ranges, minLength);
  }

  return {
    prep: locator.prep,
    // `start` is where the chunk begins in the whole pattern, which Fuse uses as the expected location.
    ranges(s, patLen, start) {
      const expected = Math.min(start, offs[s + 1] - offs[s]), found = locator.find(s, expected);
      return found && chunkRanges(s, patLen, expected, found);
    },
  };
}

// Computes Fuse's `matches` for result documents. The kernels only produce scores, so this runs after sorting and limiting, only for the documents
// that are returned (with a `sortFn`, for every hit), in js on every backend. Ranges are those of createRangeFinder; chunks of long patterns are searched
// one by one and their ranges merged.
export function createMatcher(index, { slotsOf, transposition, minLength, normalize, original, highlighting }) {
  const { corpus } = index, { data, offs } = corpus;
  const finder = createRangeFinder(corpus, { transposition, minLength }), aligner = highlighting && createAligner(corpus, transposition);

  // The experimental ranges: around every alignment, or only the first, as the alignment itself or as Fuse's window of characters.
  function alignedRanges(s, pattern) {
    const spans = aligner.find(s);
    if (!spans) return null;
    const ts = offs[s], textLen = offs[s + 1] - ts, patLen = pattern.length, ranges = [];
    for (const { from, to, cost } of highlighting.allOccurrences ? spans : spans.slice(0, 1)) {
      if (highlighting.aligned) { ranges.push([from, to]); continue; }
      const last = Math.min(textLen - 1, from + patLen - 1 + cost);
      let run = -1;
      for (let k = from; k <= last + 1; k++) {
        const inPattern = k <= last && pattern.includes(String.fromCharCode(data[ts + k]));
        if (inPattern && run < 0) run = k;
        else if (!inPattern && run >= 0) { ranges.push([run, k - 1]); run = -1; }
      }
    }
    return dropShort(ranges, minLength);
  }

  // For each document in `ids`, the slots that matched in key order, each with its merged `indices` (see slotsOf for the other fields).
  // `plans` are the patterns searched ({ q, chunks, kmax, rule }, see planFor in search.mjs): one, or one per term of a token search, whose ranges are merged.
  return function matchesFor(ids, plans) {
    const perDoc = ids.map(slotsOf);
    for (const { q, chunks, kmax, rule } of plans) {
      if (!q.length) continue;
      const pending = [];
      for (const slots of perDoc) for (const slot of slots) {
        if (!equalsPattern(corpus, slot.s, q)) pending.push(slot);
        else if (q.length >= minLength) slot.ranges.push([0, q.length - 1]);
      }
      for (const { pattern, start } of chunks) {
        if (highlighting) aligner.prep(pattern, kmax, rule); else finder.prep(pattern, kmax, rule);
        for (const slot of pending) {
          const found = highlighting ? alignedRanges(slot.s, pattern) : finder.ranges(slot.s, pattern.length, start);
          if (found) slot.ranges.push(...found);
        }
      }
    }
    return perDoc.map(slots => slots.filter(slot => slot.ranges.length).map(slot => {
      const indices = mergeIndices(slot.ranges);
      return { ...slot, indices: original ? toOriginal(slot.value, indices, normalize) : indices };
    }));
  };
}
