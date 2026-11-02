import { defineFuseter } from "./fuseter.mjs";
import { jsBackend } from "./backend-js.mjs";
import { wasmBackend } from "./backend-wasm.mjs";
import { simdBackend } from "./backend-simd.mjs";

export const Fuseter = defineFuseter({ simd: simdBackend, wasm: wasmBackend, js: jsBackend }, "simd");
export default Fuseter;
