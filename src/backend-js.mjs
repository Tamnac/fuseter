import { jsScanner } from "./kernel-js.mjs";
import { jsTokenAccumulator } from "./tokens.mjs";

export const jsBackend = {
  name: "js",
  load: async () => {},
  create: (index, { transposition }) => ({ ...jsScanner(index.corpus, { transposition }), tokens: jsTokenAccumulator(index) }),
};
