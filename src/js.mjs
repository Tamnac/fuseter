import { defineFastFuse } from "./fastfuse.mjs";
import { jsBackend } from "./backend-js.mjs";

export const FastFuse = defineFastFuse({ js: jsBackend }, "js");
export default FastFuse;
