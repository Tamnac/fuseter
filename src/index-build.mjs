import { textNormalizer, fieldNorm } from "./text.mjs";
import { wordStartFlags } from "./typing.mjs";

const MAX_SLOTS = 64;

// Fuse's default getFn: the string at `path` (numbers and booleans as text), or, when the path passes through arrays, a list of strings and { v, i } records
// (i the position in the array). Collections without a getFn of their own do not call it, they take the faster walk in `collect`, which
// differs only for objects in arrays (ignored there, "[object Object]" here).
export function defaultGetFn(obj, path) {
  const list = [], text = value => typeof value === "string" ? value : typeof value === "bigint" ? value.toString() : Object.is(value, -0) ? "-0" : value + "";
  let arr = false;
  const deepGet = (value, parts, index, arrayIndex) => {
    if (value == null) return;
    if (!parts[index]) { list.push(arrayIndex !== undefined ? { v: value, i: arrayIndex } : value); return; }
    const next = value[parts[index]];
    if (next == null) return;
    if (index === parts.length - 1 && (typeof next === "string" || typeof next === "number" || typeof next === "boolean" || typeof next === "bigint")) list.push(arrayIndex !== undefined ? { v: text(next), i: arrayIndex } : text(next));
    else if (Array.isArray(next)) { arr = true; for (let i = 0; i < next.length; i++) deepGet(next[i], parts, index + 1, i); }
    else if (parts.length) deepGet(next, parts, index + 1, arrayIndex);
  };
  deepGet(obj, typeof path === "string" ? path.split(".") : path, 0);
  return arr ? list : list[0];
}

// `read(doc)` is the custom getFn of the key, or of the collection bound to the key's path, or undefined for the built-in path walk.
export function parseKey(key, getFn) {
  const spec = typeof key === "string" || Array.isArray(key) ? { name: key } : key;
  if (spec === null || typeof spec !== "object") throw new TypeError("fuseter: unsupported key definition");
  const { name, weight = 1 } = spec;
  if (!(weight > 0)) throw new RangeError(`fuseter: key weight for '${name}' must be greater than 0`);
  if (spec.getFn != null && typeof spec.getFn !== "function") throw new TypeError(`fuseter: getFn of key '${name}' must be a function`);
  const path = Array.isArray(name) ? name : String(name).split(".");
  return { id: Array.isArray(name) ? name.join(".") : String(name), path, weight, src: name, getFn: spec.getFn ?? null, read: spec.getFn ?? (getFn && getFn !== defaultGetFn ? doc => getFn(doc, path) : undefined) };
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

// What Fuse indexes of a custom getFn result: a non-blank string, or the non-blank strings of an array (position = refIndex) and of its { v, i } records.
function collectCustom(value, out, at) {
  const add = (text, position) => { if (text.trim().length) { out.push(text); at.push(position); } };
  if (typeof value === "string") add(value, undefined);
  else if (Array.isArray(value)) value.forEach((item, i) => {
    if (typeof item === "string") add(item, i);
    else if (item?.v != null) add(typeof item.v === "string" ? item.v : leafText(item.v) ?? String(item.v), item.i);
  });
}

// The strings of one key of one document in slot order, with the array position Fuse reports as refIndex for each (undefined when not inside an array).
export function slotValues(doc, { path, read }) {
  const texts = [], at = [];
  if (read) collectCustom(read(doc), texts, at); else collect(doc, path, 0, texts, at);
  return { texts, at };
}

// A string for the common case (one plain string value), otherwise { texts, at } (see slotValues), or undefined when nothing usable is found.
function extract(doc, def) {
  const { path, read } = def;
  if (!read && path.length === 1) {
    const v = doc?.[path[0]];
    if (typeof v === "string") return v.trim().length ? v : undefined;
  }
  const values = slotValues(doc, def);
  return values.texts.length ? values : undefined;
}

// The values of a Fuse-format index laid out like the extraction in buildIndex: per (document, key) a string (its field norm in `single`) or { texts, at, norms }.
function readRecords(records, nDocs, nk, keyless) {
  const found = new Array(nDocs * nk), single = new Array(nDocs * nk);
  for (const record of records) {
    const d = record.i;
    if (!Number.isInteger(d) || d < 0 || d >= nDocs) throw new RangeError(`fuseter: the index has a record for document ${d}, but the collection has ${nDocs}`);
    if (keyless) { found[d] = record.v; single[d] = record.n; continue; }
    for (let k = 0; k < nk; k++) {
      const sub = record.$?.[k], at = d * nk + k;
      if (Array.isArray(sub)) found[at] = { texts: sub.map(item => item.v), at: sub.map(item => item.i), norms: sub.map(item => item.n) };
      else if (sub) { found[at] = sub.v; single[at] = sub.n; }
    }
  }
  return { found, single };
}

// Flattens the collection into one string per (document, slot). A key gets as many slots as its longest array,
// slots are laid out key-major so per-document scores multiply in the same order as in Fuse.
// Typing heuristics: `starts` adds a word-start flag per corpus character.
// With `index` (a FuseterIndex, see fuse-index.mjs) the strings, field norms and key order come from the index instead of the documents. As in Fuse, the
// weights are those of the keys in the options (a key of the index that they lack keeps its weight as it is).
// The indexed strings and their positions in array values are kept (`values`, `refAt`) for includeMatches and sortFn.
export function buildIndex(docs, { keys = [], getFn = null, fieldNormWeight = 1, isCaseSensitive = false, ignoreDiacritics = false, starts = false } = {}, index = null) {
  if (!Array.isArray(docs)) throw new TypeError("fuseter: the collection must be an array");
  const nDocs = docs.length, keyless = typeof docs[0] === "string";
  const optionDefs = keys.map(key => parseKey(key, getFn));
  let optionWeight = 0; for (const def of optionDefs) optionWeight += def.weight;
  for (const def of optionDefs) def.share = def.weight / optionWeight;
  const defs = keyless ? [{ path: [], weight: 1, share: 1 }]
    : index ? index.defs.map(def => optionDefs.find(({ id }) => id === def.id) ?? { ...def, share: def.weight })
    : optionDefs;
  const nk = defs.length;

  const width = new Array(nk).fill(1);
  const { found, single } = index ? readRecords(index.records, nDocs, nk, keyless) : { found: new Array(nDocs * nk), single: null };
  for (let d = 0; d < nDocs; d++) for (let k = 0; k < nk; k++) {
    let value = found[d * nk + k];
    if (!index) {
      if (keyless) { const v = docs[d]; value = typeof v === "string" && v.trim().length ? v : undefined; }
      else value = docs[d] == null && !defs[k].read ? undefined : extract(docs[d], defs[k]);
      found[d * nk + k] = value;
    }
    if (value !== undefined && typeof value !== "string" && value.texts.length > width[k]) width[k] = value.texts.length;
  }
  const base = new Array(nk); let K = 0;
  for (let k = 0; k < nk; k++) { base[k] = K; K += width[k]; }
  if (K > MAX_SLOTS) throw new RangeError(`fuseter: documents expand to ${K} string slots per document (max ${MAX_SLOTS}); array values are too long`);

  const weights = new Float64Array(K);
  for (let k = 0; k < nk; k++) weights.fill(defs[k].share, base[k], base[k] + width[k]);

  const nStr = nDocs * K, norm = fieldNorm(fieldNormWeight), prepare = textNormalizer({ isCaseSensitive, ignoreDiacritics });
  const prepared = new Array(nStr).fill(""), present = new Uint8Array(nStr), norms = new Float64Array(nStr);
  const values = new Array(nStr), refAt = new Int32Array(nStr).fill(-1);
  let total = 0;
  const startFlags = starts ? new Array(nStr) : null, pieceCache = new Map();
  const put = (s, raw, given, at = -1) => {
    const text = prepare(raw);
    values[s] = raw; refAt[s] = at; present[s] = 1; norms[s] = given ?? norm(raw); prepared[s] = text; total += text.length;
    if (starts) startFlags[s] = wordStartFlags(raw, text, prepare, pieceCache);
  };
  for (let d = 0; d < nDocs; d++) for (let k = 0; k < nk; k++) {
    const value = found[d * nk + k], s = d * K + base[k];
    if (typeof value === "string") put(s, value, single?.[d * nk + k]);
    else if (value !== undefined) for (let i = 0; i < value.texts.length; i++) put(s + i, value.texts[i], value.norms?.[i], value.at[i] ?? -1);
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
  return { docs, K, nDocs, nStr, keyless, keys: defs.map((def, k) => ({ ...def, base: base[k], width: width[k] })), weights, norms, present, values, refAt, corpus: { data, offs, n: nStr, maxLen, starts: wordStartAt } };
}
