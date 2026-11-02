import { defineFuseter } from "./fuseter.mjs";
import { jsBackend } from "./backend-js.mjs";
import { wasmBackend } from "./backend-wasm.mjs";

export const Fuseter = defineFuseter({ wasm: wasmBackend, js: jsBackend }, "wasm");
export default Fuseter;
