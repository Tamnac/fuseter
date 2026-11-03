import { createAligner } from "./align.mjs";
import { createLocator } from "./kernel-js.mjs";
import { slotValues } from "./index-build.mjs";

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

// Computes Fuse's `matches` for result documents. The kernels only produce scores, so this runs after sorting and limiting, only for the documents
// that are returned, in js on every backend.
// Fuse's indices (bitap/search.ts) are a character mask over the normalised text: every non-overlapping error-free occurrence of the pattern, plus every
// character that occurs in the pattern within [start, start + patLen - 1 + level], where start is the lowest start of a match at the best error level.
// Chunks of long patterns are searched one by one and their ranges merged.
export function createMatcher(index, { transposition, normalize, original, highlighting }) {
  const { docs, K, keyless, keys, present, corpus } = index, { data, offs } = corpus;
  const locator = createLocator(corpus, transposition), aligner = highlighting && createAligner(corpus, transposition);
  let mask = new Uint8Array(0);

  function chunkRanges(s, patLen, expected, { level, start, exact }) {
    const ts = offs[s], textLen = offs[s + 1] - ts, { table } = locator;
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
    return ranges;
  }

  // The experimental ranges: around every alignment, or only the first, as the alignment itself or as Fuse's window of characters.
  function alignedRanges(s, patLen, pattern, spans) {
    const ts = offs[s], textLen = offs[s + 1] - ts, ranges = [];
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
    return ranges;
  }

  // One entry per string slot of the documents that could have matched: { s, key, refIndex, value, ranges }.
  function slotsOf(d) {
    const slots = [], add = (s, value, key, refIndex) => { if (present[s]) slots.push({ s, key, refIndex, value, ranges: [] }); };
    if (keyless) add(d * K, docs[d]);
    else for (const key of keys) {
      const { texts, at } = slotValues(docs[d], key.path);
      for (let j = 0; j < texts.length; j++) add(d * K + key.base + j, texts[j], key.id, at[j]);
    }
    return slots;
  }

  // The `matches` array of each document in `ids`: one entry per string that matched, in key order.
  return function matchesFor(ids, q, chunks, kmax, rule) {
    const perDoc = ids.map(slotsOf), pending = [];
    for (const slots of perDoc) for (const slot of slots) {
      if (equalsPattern(corpus, slot.s, q)) slot.ranges.push([0, q.length - 1]); else pending.push(slot);
    }
    for (const { pattern, start } of chunks) {
      if (highlighting) aligner.prep(pattern, kmax, rule); else locator.prep(pattern, kmax, rule);
      for (const slot of pending) {
        if (highlighting) {
          const found = aligner.find(slot.s);
          if (found) slot.ranges.push(...alignedRanges(slot.s, pattern.length, pattern, found));
          continue;
        }
        const expected = Math.min(start, offs[slot.s + 1] - offs[slot.s]), found = locator.find(slot.s, expected);
        if (found) slot.ranges.push(...chunkRanges(slot.s, pattern.length, expected, found));
      }
    }
    return perDoc.map(slots => slots.filter(slot => slot.ranges.length).map(({ ranges, value, key, refIndex }) => {
      const indices = mergeIndices(ranges), match = { indices: original ? toOriginal(value, indices, normalize) : indices, value };
      if (key !== undefined) match.key = key;
      if (refIndex !== undefined) match.refIndex = refIndex;
      return match;
    }));
  };
}
