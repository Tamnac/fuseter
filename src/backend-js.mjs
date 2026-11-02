import { jsScanner } from "./kernel-js.mjs";

export const jsBackend = {
  name: "js",
  load: async () => {},
  create: (index, { transposition }) => jsScanner(index.corpus, { transposition }),
};
