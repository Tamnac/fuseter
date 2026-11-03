import { textNormalizer, fieldNorm } from "./text.mjs";
import { wordStartFlags } from "./typing.mjs";

const MAX_SLOTS = 64;

function parseKey(key) {
  const spec = typeof key === "string" || Array.isArray(key) ? { name: key } : key;
  if (spec === null || typeof spec !== "object" || spec.getFn) throw new TypeError("fuseter: unsupported key definition (getFn is not supported)");
  const { name, weight = 1 } = spec;
  if (!(weight > 0)) throw new RangeError(`fuseter: key weight for '${name}' must be greater than 0`);
  return { id: Array.isArray(name) ? name.join(".") : String(name), path: Array.isArray(name) ? name : String(name).split("."), weight };
}

const leafText = v => typeof v === "string" ? v
  : typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" ? (Object.is(v, -0) ? "-0" : String(v))
  : undefined;

// Collects every string reachable through `path`, descending into arrays like Fuse's default getFn.
// `at` (optional) receives the position of each string in the innermost array it was found in, undefined outside arrays.
function collect(obj, path, i, out, at, arrayIndex) {
  if (obj == null) return;
  if (i === path.length) {
    const s = leafText(obj);
    if (s !== undefined && s.trim().length) { out.push(s); at?.push(arrayIndex); }
    return;
  }
  const v = obj[path[i]];
  if (v == null) return;
  if (Array.isArray(v)) for (let e = 0; e < v.length; e++) collect(v[e], path, i + 1, out, at, e);
  else collect(v, path, i + 1, out, at, arrayIndex);
}

// The strings of one key of one document in slot order, with the array position Fuse reports as refIndex for each (undefined when not inside an array).
export function slotValues(doc, path) {
  const texts = [], at = [];
  collect(doc, path, 0, texts, at);
  return { texts, at };
}

// A string for the common case (one plain string value), otherwise an array, or undefined when nothing usable is found.
function extract(doc, path) {
  if (path.length === 1) {
    const v = doc?.[path[0]];
    if (typeof v === "string") return v.trim().length ? v : undefined;
  }
  const list = [];
  collect(doc, path, 0, list);
  return list.length ? list : undefined;
}

// Flattens the collection into one string per (document, slot). A key gets as many slots as its longest array,
// slots are laid out key-major so per-document scores multiply in the same order as in Fuse.
// Typing heuristics: `starts` adds a word-start flag per corpus character.
export function buildIndex(docs, { keys = [], fieldNormWeight = 1, isCaseSensitive = false, ignoreDiacritics = false, starts = false } = {}) {
  if (!Array.isArray(docs)) throw new TypeError("fuseter: the collection must be an array");
  const nDocs = docs.length, keyless = typeof docs[0] === "string";
  const defs = keyless ? [{ path: [], weight: 1 }] : keys.map(parseKey);
  const nk = defs.length;
  let totalWeight = 0; for (const k of defs) totalWeight += k.weight;

  const found = new Array(nDocs * nk), width = new Array(nk).fill(1);
  for (let d = 0; d < nDocs; d++) for (let k = 0; k < nk; k++) {
    let value;
    if (keyless) { const v = docs[d]; value = typeof v === "string" && v.trim().length ? v : undefined; }
    else value = docs[d] == null ? undefined : extract(docs[d], defs[k].path);
    found[d * nk + k] = value;
    if (Array.isArray(value) && value.length > width[k]) width[k] = value.length;
  }
  const base = new Array(nk); let K = 0;
  for (let k = 0; k < nk; k++) { base[k] = K; K += width[k]; }
  if (K > MAX_SLOTS) throw new RangeError(`fuseter: documents expand to ${K} string slots per document (max ${MAX_SLOTS}); array values are too long`);

  const weights = new Float64Array(K);
  for (let k = 0; k < nk; k++) weights.fill(defs[k].weight / totalWeight, base[k], base[k] + width[k]);

  const nStr = nDocs * K, norm = fieldNorm(fieldNormWeight), prepare = textNormalizer({ isCaseSensitive, ignoreDiacritics });
  const prepared = new Array(nStr).fill(""), present = new Uint8Array(nStr), norms = new Float64Array(nStr);
  let total = 0;
  const startFlags = starts ? new Array(nStr) : null, pieceCache = new Map();
  const put = (s, raw) => {
    const text = prepare(raw);
    present[s] = 1; norms[s] = norm(raw); prepared[s] = text; total += text.length;
    if (starts) startFlags[s] = wordStartFlags(raw, text, prepare, pieceCache);
  };
  for (let d = 0; d < nDocs; d++) for (let k = 0; k < nk; k++) {
    const value = found[d * nk + k], s = d * K + base[k];
    if (typeof value === "string") put(s, value);
    else if (value !== undefined) for (let i = 0; i < value.length; i++) put(s + i, value[i]);
  }
  const data = new Uint16Array(total), offs = new Uint32Array(nStr + 1), wordStartAt = starts ? new Uint8Array(total) : null;
  let p = 0, maxLen = 0;
  for (let s = 0; s < nStr; s++) {
    offs[s] = p;
    const t = prepared[s];
    if (starts && present[s]) wordStartAt.set(startFlags[s], p);
    for (let i = 0; i < t.length; i++) data[p++] = t.charCodeAt(i);
    if (t.length > maxLen) maxLen = t.length;
  }
  offs[nStr] = p;
  return { docs, K, nDocs, nStr, keyless, keys: defs.map((def, k) => ({ ...def, base: base[k] })), weights, norms, present, corpus: { data, offs, n: nStr, maxLen, starts: wordStartAt } };
}
