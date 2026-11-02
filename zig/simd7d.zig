// Root of simd-transposition.wasm: an adjacent transposition counts as one error (the kernels live in simd_core.zig).
const core = @import("simd_core.zig");

const MAXSPEC = 8;

export fn scan_simd32(data: [*]const u16, goff: [*]const u32, offs: [*]const u32, order: [*]const u32, n: u32, table: [*]const u32, pat_len: u32, kmax: u32, out: [*]f64) void {
    core.Scan(u32, 4, true, MAXSPEC).run(data, goff, offs, order, n, table, pat_len, kmax, out);
}
export fn scan_simd16(data: [*]const u16, goff: [*]const u32, offs: [*]const u32, order: [*]const u32, n: u32, table: [*]const u16, pat_len: u32, kmax: u32, out: [*]f64) void {
    core.Scan(u16, 8, true, MAXSPEC).run(data, goff, offs, order, n, table, pat_len, kmax, out);
}
export fn combine_sort(
    out: [*]const f64, n_docs: u32, kk: u32, norm_id: [*]const u8, offs: [*]const u32, tbl: [*]const f64, nn: u32,
    pat_len: u32, denom: u32, kmax: u32, keys: [*]u64, ids: [*]u32, keys2: [*]u64, ids2: [*]u32, hist: [*]u32, limit: u32,
) u32 {
    return core.combineSort(out, n_docs, kk, norm_id, offs, tbl, nn, pat_len, denom, kmax, keys, ids, keys2, ids2, hist, limit);
}
