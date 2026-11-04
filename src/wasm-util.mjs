// Minimal valid module using a v128 instruction; validates only where wasm simd128 is supported.
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);

export const wasmSupported = () => typeof WebAssembly === "object" && typeof WebAssembly.compile === "function";
export const simdSupported = () => wasmSupported() && WebAssembly.validate(SIMD_PROBE);

export const decodeBase64 = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));

// Compiles a module once; a failed attempt is not cached so a later call can retry.
// `source` is an async function returning the base64 text, so rarely used modules can be dynamic imports.
export function lazyModule(source) {
  let pending = null, module = null;
  return {
    load() {
      pending ??= source().then(base64 => WebAssembly.compile(decodeBase64(base64))).then(m => (module = m), e => { pending = null; throw e; });
      return pending;
    },
    instantiate() {
      if (!module) throw new Error("fuseter: wasm module is not loaded yet");
      return new WebAssembly.Instance(module, {});
    },
  };
}

// Grows the instance memory once and carves aligned regions out of the new pages. Views must be created after this call.
export function allocate(memory, sizes) {
  const align = b => (b + 7) & ~7;
  let total = 0; for (const b of Object.values(sizes)) total += align(b);
  let p = memory.buffer.byteLength;
  memory.grow(Math.ceil(total / 65536) + 1);
  const ptr = {};
  for (const [name, b] of Object.entries(sizes)) { ptr[name] = p; p += align(b); }
  return ptr;
}

// Memory for wasmTokenAccumulator, to be added to the sizes given to `allocate`.
export const tokenSizes = ({ nStr, nDocs }) => ({ acc: nStr * 8, hit: nStr, covered: nDocs * 4 });

// The in-wasm version of jsTokenAccumulator (tokens.mjs); `P` holds the pointers of tokenSizes, `out` is the view of the scanner's score array.
export function wasmTokenAccumulator(ex, mem, P, { nStr, K, nDocs, out }) {
  const pointerTo = scores => {
    if (scores.buffer === mem.buffer) return scores.byteOffset;
    out.set(scores);   // scores computed outside the module (chunked patterns)
    return P.out;
  };
  const acc = new Float64Array(mem.buffer, P.acc, nStr), hit = new Uint8Array(mem.buffer, P.hit, nStr), covered = new Uint32Array(mem.buffer, P.covered, nDocs);
  return {
    begin() { acc.fill(0); hit.fill(0); covered.fill(0); },
    add(scores, idf) { ex.token_add(pointerTo(scores), P.acc, P.hit, nStr, idf); },
    cover(scores) { ex.token_cover(pointerTo(scores), K, nDocs, P.covered); },
    finish(maxScore, terms) {
      ex.token_finish(P.acc, P.hit, nStr, maxScore, K, P.covered, terms);
      return acc;
    },
  };
}
