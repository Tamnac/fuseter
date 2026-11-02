import { fillCharTable } from "./kernel-js.mjs";
import { lazyModule, allocate, wasmSupported } from "./wasm-util.mjs";
import scalarBase64 from "./wasm/scalar.mjs";

const module = lazyModule(async () => scalarBase64);
const UNWEIGHTED = { mask: 0, midWord: 1 };

export const wasmBackend = {
  name: "wasm",
  async load() {   // one module holds all kernels
    if (!wasmSupported()) throw new Error("WebAssembly is not available");
    await module.load();
  },
  create({ corpus }, { transposition }) {
    const { exports: ex } = module.instantiate(), mem = ex.memory, { starts } = corpus;
    const P = allocate(mem, { data: corpus.data.byteLength, starts: starts?.byteLength ?? 0, offs: corpus.offs.byteLength, table: 65536 * 4, out: corpus.n * 8, st: 512 });
    new Uint16Array(mem.buffer, P.data, corpus.data.length).set(corpus.data);
    if (starts) new Uint8Array(mem.buffer, P.starts, starts.length).set(starts);
    new Uint32Array(mem.buffer, P.offs, corpus.offs.length).set(corpus.offs);
    const table = new Uint32Array(mem.buffer, P.table, 65536), out = new Float64Array(mem.buffer, P.out, corpus.n), previous = [];
    const scanPlain = transposition ? ex.scan2t : ex.scan2, scanWeighted = transposition ? ex.scan2wt : ex.scan2w;
    return {
      out,
      prep(pattern) { fillCharTable(table, pattern, previous); },
      // With word-start flags every scan is weighted; a missing rule (no weighted position, chunked pattern) weights nothing.
      scan(patLen, kmax, rule = null) {
        if (starts) {
          const { mask, midWord, denom = patLen } = rule ?? UNWEIGHTED;
          scanWeighted(P.data, P.starts, P.offs, corpus.n, P.table, patLen, kmax, P.out, P.st, mask, midWord, denom);
        } else scanPlain(P.data, P.offs, corpus.n, P.table, patLen, kmax, P.out, P.st, 0, 0, 0);
        return out;
      },
    };
  },
};
