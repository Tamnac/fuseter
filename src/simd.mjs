import { defineFastFuse } from "./fastfuse.mjs";
import { jsBackend } from "./backend-js.mjs";
import { wasmBackend } from "./backend-wasm.mjs";
import { simdBackend } from "./backend-simd.mjs";

export const FastFuse = defineFastFuse({ simd: simdBackend, wasm: wasmBackend, js: jsBackend }, "simd");
export default FastFuse;
