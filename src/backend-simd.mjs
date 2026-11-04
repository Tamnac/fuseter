import { lazyModule, allocate, simdSupported, tokenSizes, wasmTokenAccumulator } from "./wasm-util.mjs";
import { groupByLength } from "./matches.mjs";
import simdBase64 from "./wasm/simd.mjs";

// The typing options need other kernels: each combination is a module fetched only when used (transposition +4.5 KB raw, weighted first letter
// +8.6 KB, both +14.6 KB; the weighted modules have no unweighted kernels).
const modules = {
  standard: lazyModule(async () => simdBase64),
  transposition: lazyModule(async () => (await import("./wasm/simd-transposition.mjs")).default),
  weighted: lazyModule(async () => (await import("./wasm/simd-weighted.mjs")).default),
  weightedTransposition: lazyModule(async () => (await import("./wasm/simd-weighted-transposition.mjs")).default),
};
const moduleFor = ({ transposition, weighted }) => modules[weighted ? (transposition ? "weightedTransposition" : "weighted") : transposition ? "transposition" : "standard"];
const UNWEIGHTED = { mask: 0, midWord: 1 };
const MAX_NORM_CLASSES = 255;   // norm ids are bytes, 255 marks an absent string
const MAX_TABLE_STRIDE = 34;    // kmax + 2 columns per (slot, norm class)

// Groups of L strings stored transposed ([position][lane]) in reversed text order; the word-start flags (if any) get the same layout.
function transpose({ data, offs, n, starts }, order, L) {
  const groups = Math.ceil(n / L), goff = new Uint32Array(groups + 1);
  let total = 0;
  for (let g = 0; g < groups; g++) {
    goff[g] = total;
    let m = 0;
    for (let l = 0; l < L && g * L + l < n; l++) { const s = order[g * L + l]; m = Math.max(m, offs[s + 1] - offs[s]); }
    total += m * L;
  }
  goff[groups] = total;
  const t = new Uint16Array(total), flags = starts ? new Uint8Array(total) : null;
  for (let g = 0; g < groups; g++) for (let l = 0; l < L && g * L + l < n; l++) {
    const s = order[g * L + l], st = offs[s], len = offs[s + 1] - st;
    for (let r = 0; r < len; r++) {
      t[goff[g] + r * L + l] = data[st + len - 1 - r];
      if (flags) flags[goff[g] + r * L + l] = starts[st + len - 1 - r];
    }
  }
  return { t, flags, goff };
}

// Distinct field norms become byte ids; null when there are too many for the in-wasm combine step.
function normClasses({ norms, present }) {
  const values = [], ids = new Map(), normId = new Uint8Array(norms.length);
  for (let s = 0; s < norms.length; s++) {
    if (!present[s]) { normId[s] = 255; continue; }
    let id = ids.get(norms[s]);
    if (id === undefined) {
      if (values.length >= MAX_NORM_CLASSES) return null;
      id = values.length; ids.set(norms[s], id); values.push(norms[s]);
    }
    normId[s] = id;
  }
  return { values, normId };
}

export const simdBackend = {
  name: "simd",
  async load(options = {}) {
    if (!simdSupported()) throw new Error("WebAssembly SIMD is not supported");
    await moduleFor(options).load();
  },
  create(index, { ignoreFieldNorm, transposition }) {
    const { corpus, K, nDocs, weights, keyless } = index, n = corpus.n, nStr = index.nStr, weighted = Boolean(corpus.starts);
    const { exports: ex } = moduleFor({ transposition, weighted }).instantiate(), mem = ex.memory;
    const classes = normClasses(index), nn = classes ? Math.max(1, classes.values.length) : 0;
    const { order } = groupByLength(corpus), T4 = transpose(corpus, order, 4), T8 = transpose(corpus, order, 8);
    const P = allocate(mem, {
      d4: T4.t.byteLength, s4: T4.flags?.byteLength ?? 0, g4: T4.goff.byteLength, d8: T8.t.byteLength, s8: T8.flags?.byteLength ?? 0, g8: T8.goff.byteLength,
      offs: corpus.offs.byteLength, order: order.byteLength, t32: 65536 * 4, t16: 65536 * 2, out: n * 8,
      normId: nStr, tbl: K * nn * MAX_TABLE_STRIDE * 8, keys: nDocs * 8, ids: nDocs * 4, keys2: nDocs * 8, ids2: nDocs * 4, hist: 8 * 256 * 4, ...tokenSizes(index),
    });
    new Uint16Array(mem.buffer, P.d4, T4.t.length).set(T4.t); new Uint32Array(mem.buffer, P.g4, T4.goff.length).set(T4.goff);
    new Uint16Array(mem.buffer, P.d8, T8.t.length).set(T8.t); new Uint32Array(mem.buffer, P.g8, T8.goff.length).set(T8.goff);
    if (weighted) {
      new Uint8Array(mem.buffer, P.s4, T4.flags.length).set(T4.flags);
      new Uint8Array(mem.buffer, P.s8, T8.flags.length).set(T8.flags);
    }
    new Uint32Array(mem.buffer, P.offs, corpus.offs.length).set(corpus.offs);
    new Uint32Array(mem.buffer, P.order, n).set(order);
    const t32 = new Uint32Array(mem.buffer, P.t32, 65536), t16 = new Uint16Array(mem.buffer, P.t16, 65536);
    const out = new Float64Array(mem.buffer, P.out, n);
    const ids = new Uint32Array(mem.buffer, P.ids, nDocs), scores = new Float64Array(mem.buffer, P.keys, nDocs);
    const tblView = new Float64Array(mem.buffer, P.tbl, K * nn * MAX_TABLE_STRIDE), tables = new Map();
    if (classes) new Uint8Array(mem.buffer, P.normId, nStr).set(classes.normId);

    // tbl[slot][norm class][level] = Fuse's per-slot factor for the score level / denom; built with Math.pow so scores are bit-identical (wasm has no pow).
    // The last column is the whole-string-equality factor (Fuse scores an exact match 0, or EPSILON when the slot has a key weight).
    function table(denom, kmax) {
      const cacheKey = denom * 64 + kmax, cached = tables.get(cacheKey);
      if (cached) return cached;
      const stride = kmax + 2, t = new Float64Array(K * nn * stride);
      for (let k = 0; k < K; k++) for (let id = 0; id < nn; id++) for (let c = 0; c < stride; c++) {
        const v = c === stride - 1 ? 0 : Math.max(c / denom, 0.001);
        t[(k * nn + id) * stride + c] = Math.pow(v === 0 && !keyless ? Number.EPSILON : v, weights[k] * (ignoreFieldNorm ? 1 : classes.values[id] ?? 1));
      }
      tables.set(cacheKey, t);
      return t;
    }

    const previous = [];
    const scanner = {
      out,
      tokens: wasmTokenAccumulator(ex, mem, P, { nStr, K, nDocs, out }),
      prep(pattern) {
        for (const c of previous) { t32[c] = 0; t16[c] = 0; }
        previous.length = 0;
        const m = pattern.length;
        for (let i = 0; i < m; i++) {
          const c = pattern.charCodeAt(i), b = 1 << (m - i - 1);
          t32[c] |= b;
          if (m <= 16) t16[c] |= b;
          previous.push(c);
        }
      },
      // With word-start flags every scan is weighted; a missing rule (no weighted position, chunked pattern) weights nothing.
      // Hits are written to hitIds/hitScores by position; sortHits orders the first m by (score, id) and keeps the first min(limit, m) (all with limit 0).
      hitIds: ids,
      hitScores: scores,
      sortHits(m, limit) {
        ex.sort_hits(P.keys, P.ids, P.keys2, P.ids2, P.hist, m, limit);
        return { ids, scores };
      },
      scan(patLen, kmax, rule = null) {
        if (weighted) {
          const { mask, midWord, denom = patLen } = rule ?? UNWEIGHTED;
          if (patLen <= 16) ex.scan_w16(P.d8, P.s8, P.g8, P.offs, P.order, n, P.t16, patLen, kmax, mask, midWord, denom, P.out);
          else ex.scan_w32(P.d4, P.s4, P.g4, P.offs, P.order, n, P.t32, patLen, kmax, mask, midWord, denom, P.out);
        } else if (patLen <= 16) ex.scan_simd16(P.d8, P.g8, P.offs, P.order, n, P.t16, patLen, kmax, P.out);
        else ex.scan_simd32(P.d4, P.g4, P.offs, P.order, n, P.t32, patLen, kmax, P.out);
        return out;
      },
    };
    if (classes) {
      // Sorted document ids/scores of the hits of the last scan (scored level / denom); only the first min(limit, hits) entries are valid.
      scanner.combineSort = (patLen, denom, kmax, limit) => {
        tblView.set(table(denom, kmax));
        const hits = ex.combine_sort(P.out, nDocs, K, P.normId, P.offs, P.tbl, nn, patLen, denom, kmax, P.keys, P.ids, P.keys2, P.ids2, P.hist, limit);
        return { hits, ids, scores };
      };
    }
    return scanner;
  },
};
