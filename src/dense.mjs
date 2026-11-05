// The bookkeeping of an extended search that looks at every string (denseScores in search.mjs): per string `alive` is 0 (the group failed so far) or 1, plus 2 once
// an inverse term matched, `sum` adds up the fuzzy scores. begin starts a group, fuzzy and term apply one term, finish gives the survivors their score unless an earlier
// group did (the first group assigns every string). scores, group (-1: none) and inverse are the results.

export function jsDenseState(nStr, present) {
  const scores = new Float64Array(nStr), group = new Int32Array(nStr), inverse = new Uint8Array(nStr), alive = new Uint8Array(nStr), sum = new Float64Array(nStr);
  return {
    scores, group, inverse,
    begin(hasFuzzy) { alive.set(present); if (hasFuzzy) sum.fill(0); },
    fuzzy(found) { for (let s = 0; s < nStr; s++) { if (found[s] < 0) alive[s] = 0; else sum[s] += found[s]; } },
    term(flags, inverted) { for (let s = 0; s < nStr; s++) { const a = alive[s]; if (a) alive[s] = flags[s] ? a | inverted : 0; } },
    finish(g, terms, hasFuzzy, initial) {
      for (let s = 0; s < nStr; s++) {
        const a = alive[s];
        if (a && (initial || group[s] < 0)) { scores[s] = hasFuzzy ? sum[s] / terms : 0; group[s] = g; inverse[s] = a >> 1; }
        else if (initial) { scores[s] = -1; group[s] = -1; inverse[s] = 0; }
      }
    },
  };
}

// Memory for wasmDenseState, to be added to the sizes given to `allocate`.
export const denseSizes = nStr => ({ dPresent: nStr, dAlive: nStr, dTerm: nStr, dFound: nStr * 8, dSum: nStr * 8, dScores: nStr * 8, dGroup: nStr * 4, dInverse: nStr });

// The same in the wasm module (the scores of a fuzzy term are copied into it); `P` holds the pointers of denseSizes.
export function wasmDenseState(ex, mem, P, nStr, present) {
  const view = (Type, at) => new Type(mem.buffer, at, nStr);
  const alive = view(Uint8Array, P.dAlive), term = view(Uint8Array, P.dTerm), sum = view(Float64Array, P.dSum), found = view(Float64Array, P.dFound), stored = view(Uint8Array, P.dPresent);
  stored.set(present);
  return {
    scores: view(Float64Array, P.dScores), group: view(Int32Array, P.dGroup), inverse: view(Uint8Array, P.dInverse),
    begin(hasFuzzy) { alive.set(stored); if (hasFuzzy) sum.fill(0); },
    fuzzy(scores) { found.set(scores); ex.ext_fuzzy(P.dFound, P.dAlive, P.dSum, nStr); },
    term(flags, inverted) { term.set(flags); ex.ext_term(P.dTerm, P.dAlive, nStr, inverted); },
    finish(g, terms, hasFuzzy, initial) { ex.ext_finish(P.dAlive, P.dSum, P.dScores, P.dGroup, P.dInverse, nStr, g, terms, hasFuzzy ? 1 : 0, initial ? 1 : 0); },
  };
}
