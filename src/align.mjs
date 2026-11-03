// Experimental match highlighting (the `highlighting` option): instead of Fuse's character mask, the places where the query matches are found by aligning
// it with the text. The costs are those of the scan kernels (see kernel-js.mjs), so the best cost found here is the error level the scan reports.

const WEIGHTED = 1;

// `find(s)` aligns the prepared pattern with string `s` of the corpus (free start and end in the text) and returns null when the best cost is above kmax,
// otherwise the inclusive text ranges { from, to, cost, matched } of the alignments that cost at most kmax, none overlapping, best first (lowest cost, then most
// characters matched, then shortest). `matched` counts the pattern characters aligned with an equal text character.
// Every end position is traced back; of overlapping alignments only the best is kept ("lorrd" for "lord" rather than "lorr" or "lor").
export function createAligner(corpus, transposition) {
  const { data, offs, starts } = corpus;
  let cells = new Int32Array(0), pattern = "", kmax = 0, midWord = 1, weights = null;

  function prep(text, maxErrors, rule) {
    pattern = text; kmax = maxErrors; midWord = rule?.midWord ?? 1;
    weights = rule ? Array.from(text, (_, i) => (rule.mask >>> (text.length - 1 - i)) & WEIGHTED) : null;
  }

  const edit = i => weights && weights[i] ? 2 : 1;

  function find(s) {
    const ts = offs[s], n = offs[s + 1] - ts, m = pattern.length, stride = m + 1;
    if (cells.length < (n + 1) * stride) cells = new Int32Array((n + 1) * stride);
    const word = j => !weights || starts[ts + j] === 1;
    const text = j => data[ts + j];
    const exact = (i, j) => pattern.charCodeAt(i) === text(j);
    const substitution = (i, j) => exact(i, j) ? (weights && weights[i] && !word(j) ? midWord : 0) : edit(i);
    const swapped = (i, j) => transposition && pattern.charCodeAt(i) === text(j - 1) && pattern.charCodeAt(i - 1) === text(j) && (!weights || !weights[i - 1] || word(j - 1));

    cells[0] = 0;
    for (let i = 1; i <= m; i++) cells[i] = cells[i - 1] + edit(i - 1);
    for (let j = 1; j <= n; j++) {
      const row = j * stride, above = row - stride;
      cells[row] = 0;
      for (let i = 1; i <= m; i++) {
        let v = Math.min(cells[above + i - 1] + substitution(i - 1, j - 1), cells[above + i] + 1, cells[row + i - 1] + edit(i - 1));
        if (j > 1 && i > 1 && swapped(i - 1, j - 1)) v = Math.min(v, cells[above - stride + i - 2] + 1);
        cells[row + i] = v;
      }
    }
    let best = Infinity;
    for (let j = 1; j <= n; j++) best = Math.min(best, cells[j * stride + m]);
    if (best > kmax) return null;

    const candidates = [];
    for (let end = 1; end <= n; end++) if (cells[end * stride + m] <= kmax) candidates.push(traceBack(end));
    candidates.sort((a, b) => a.cost - b.cost || b.matched - a.matched || (a.to - a.from) - (b.to - b.from) || a.from - b.from);
    const spans = [];
    for (const c of candidates) if (spans.every(k => c.from > k.to || c.to < k.from)) spans.push(c);
    return spans;

    // Follows the cheapest path back from the cell (m, end): a match or substitution first, then a transposition, a deletion (pattern character
    // missing from the text), an insertion (extra text character).
    function traceBack(end) {
      let i = m, j = end, from = Infinity, to = -1, matched = 0;
      const take = k => { if (k < from) from = k; if (k > to) to = k; };
      while (i > 0) {
        const v = cells[j * stride + i];
        if (j > 0 && cells[(j - 1) * stride + i - 1] + substitution(i - 1, j - 1) === v) {
          take(j - 1); if (exact(i - 1, j - 1)) matched++;
          i--; j--;
        } else if (j > 1 && i > 1 && swapped(i - 1, j - 1) && cells[(j - 2) * stride + i - 2] + 1 === v) {
          take(j - 1); take(j - 2); matched += 2;
          i -= 2; j -= 2;
        } else if (cells[j * stride + i - 1] + edit(i - 1) === v) i--;
        else { take(j - 1); j--; }
      }
      return { from, to, cost: cells[end * stride + m], matched };
    }
  }

  return { prep, find };
}
