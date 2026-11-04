// Token search accumulation (shared by every module, see src/tokens.mjs for the js version). Only IEEE additions, subtractions, multiplications and
// divisions, in the order Fuse does them, so the scores are bit-identical to the js ones.

// acc += idf * (1 - score) for the strings the term matched (score >= 0, -1 means no match); hit marks them.
pub fn tokenAdd(out: [*]const f64, acc: [*]f64, hit: [*]u8, n: u32, idf: f64) void {
    var s: usize = 0;
    while (s < n) : (s += 1) {
        const v = out[s];
        if (v >= 0) {
            acc[s] += idf * (1.0 - v);
            hit[s] = 1;
        }
    }
}

// covered[d] += 1 for every document with a string the term matched (tokenMatch "all").
pub fn tokenCover(out: [*]const f64, kk: u32, n_docs: u32, covered: [*]u32) void {
    var d: usize = 0;
    while (d < n_docs) : (d += 1) {
        var k: usize = 0;
        while (k < kk) : (k += 1) {
            if (out[d * kk + k] >= 0) {
                covered[d] += 1;
                break;
            }
        }
    }
}

// The string scores: max(0.001, 1 - acc / max_score) where a term matched, else -1; with terms > 0 only documents that cover every term count.
pub fn tokenFinish(acc: [*]f64, hit: [*]const u8, n: u32, max_score: f64, kk: u32, covered: [*]const u32, terms: u32) void {
    var s: usize = 0;
    while (s < n) : (s += 1) {
        const complete = terms == 0 or covered[s / kk] == terms;
        acc[s] = if (hit[s] != 0 and complete) @max(0.001, if (max_score > 0) 1.0 - acc[s] / max_score else 0.0) else -1.0;
    }
}
