import { defineFastFuse } from "./fastfuse.mjs";
import { jsBackend } from "./backend-js.mjs";
import { wasmBackend } from "./backend-wasm.mjs";

export const FastFuse = defineFastFuse({ wasm: wasmBackend, js: jsBackend }, "wasm");
export default FastFuse;
