import { defineFuseter } from "./fuseter.mjs";
import { jsBackend } from "./backend-js.mjs";

export const Fuseter = defineFuseter({ js: jsBackend }, "js");
export default Fuseter;
