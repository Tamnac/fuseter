// Root of simd-weighted.wasm: weighted first-letter scoring, Levenshtein otherwise; the plain kernels are not included (an unweighted pattern runs with no weighted position) (the kernels live in simd_core.zig).
const core = @import("simd_core.zig");

const MAXSPEC = 8;

export fn scan_w32(data: [*]const u16, flags: [*]const u8, goff: [*]const u32, offs: [*]const u32, order: [*]const u32, n: u32, table: [*]const u32, pat_len: u32, kmax: u32, w: u32, mid_word: u32, denom: u32, out: [*]f64) void {
    core.Scan(u32, 4, false, MAXSPEC).runWeighted(data, flags, goff, offs, order, n, table, pat_len, kmax, w, mid_word, denom, out);
}
export fn scan_w16(data: [*]const u16, flags: [*]const u8, goff: [*]const u32, offs: [*]const u32, order: [*]const u32, n: u32, table: [*]const u16, pat_len: u32, kmax: u32, w: u32, mid_word: u32, denom: u32, out: [*]f64) void {
    core.Scan(u16, 8, false, MAXSPEC).runWeighted(data, flags, goff, offs, order, n, table, pat_len, kmax, w, mid_word, denom, out);
}
export fn combine_sort(
    out: [*]const f64, n_docs: u32, kk: u32, norm_id: [*]const u8, offs: [*]const u32, tbl: [*]const f64, nn: u32,
    pat_len: u32, denom: u32, kmax: u32, keys: [*]u64, ids: [*]u32, keys2: [*]u64, ids2: [*]u32, hist: [*]u32, limit: u32,
) u32 {
    return core.combineSort(out, n_docs, kk, norm_id, offs, tbl, nn, pat_len, denom, kmax, keys, ids, keys2, ids2, hist, limit);
}

export fn sort_hits(keys: [*]u64, ids: [*]u32, keys2: [*]u64, ids2: [*]u32, hist: [*]u32, m: u32, limit: u32) void {
    core.radixSort(keys, ids, keys2, ids2, hist, m, limit);
}

const tokens = @import("token_core.zig");

export fn token_add(out: [*]const f64, acc: [*]f64, hit: [*]u8, n: u32, idf: f64) void {
    tokens.tokenAdd(out, acc, hit, n, idf);
}
export fn token_cover(out: [*]const f64, kk: u32, n_docs: u32, covered: [*]u32) void {
    tokens.tokenCover(out, kk, n_docs, covered);
}
export fn token_finish(acc: [*]f64, hit: [*]const u8, n: u32, max_score: f64, kk: u32, covered: [*]const u32, terms: u32) void {
    tokens.tokenFinish(acc, hit, n, max_score, kk, covered, terms);
}
