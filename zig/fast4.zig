// Myers' bit-vector algorithm (see distance and distanceTransposed in kernel-js.mjs): the lowest edit distance of the pattern to a substring of
// data[ts, te), or kmax + 1 when it exceeds kmax. D: adjacent transposition counts as one error.
fn distance(comptime D: bool, data: [*]const u16, ts: isize, te: isize, table: [*]const u32, pat_len: u32, kmax: u32) i32 {
    const top: u5 = @intCast(pat_len - 1);
    var pv: u32 = ~@as(u32, 0);
    var mv: u32 = 0;
    var d0: u32 = 0;
    var previous: u32 = 0;
    var errors: i32 = @intCast(pat_len);
    var best: i32 = @intCast(kmax + 1);
    var p: isize = te - 1;
    while (p >= ts + errors - best) : (p -= 1) {
        const eq = table[data[@intCast(p)]];
        var zero_diag = (((eq & pv) +% pv) ^ pv) | eq | mv;
        if (D) {
            zero_diag |= ((~d0 & eq) << 1) & previous;
            previous = eq;
        }
        d0 = zero_diag;
        var ph = mv | ~(d0 | pv);
        const mh = pv & d0;
        errors += @as(i32, @intCast((ph >> top) & 1)) - @as(i32, @intCast((mh >> top) & 1));
        ph <<= 1;
        pv = (mh << 1) | ~(d0 | ph);
        mv = ph & d0;
        if (errors < best) {
            best = errors;
            if (best == 0) break;
        }
    }
    return best;
}

// A string that lacks more characters of the pattern than kmax (counted per bucket up to three times, see bucketMasks in kernel-js.mjs) cannot match.
inline fn lacks(once: [*]const u32, twice: [*]const u32, thrice: [*]const u32, s: usize, p1: u32, p2: u32, p3: u32, kmax: u32) bool {
    return @popCount(~once[s] & p1) + @popCount(~twice[s] & p2) + @popCount(~thrice[s] & p3) > kmax;
}

fn scanMyers(
    comptime D: bool, data: [*]const u16, offs: [*]const u32, n: u32, table: [*]const u32, pat_len: u32, kmax: u32, out: [*]f64,
    once: [*]const u32, twice: [*]const u32, thrice: [*]const u32, p1: u32, p2: u32, p3: u32,
) void {
    const plf: f64 = @floatFromInt(pat_len);
    const need: u32 = pat_len - kmax;
    var s: usize = 0;
    while (s < n) : (s += 1) {
        const ts: isize = @intCast(offs[s]);
        const te: isize = @intCast(offs[s + 1]);
        if (te - ts < need or lacks(once, twice, thrice, s, p1, p2, p3, kmax)) { out[s] = -1.0; continue; }
        const best = distance(D, data, ts, te, table, pat_len, kmax);
        out[s] = if (best <= kmax) @max(@as(f64, @floatFromInt(best)) / plf, 0.001) else -1.0;
    }
}

export fn scan_myers(
    data: [*]const u16, offs: [*]const u32, n: u32, table: [*]const u32, pat_len: u32, kmax: u32, out: [*]f64,
    once: [*]const u32, twice: [*]const u32, thrice: [*]const u32, p1: u32, p2: u32, p3: u32,
) void {
    scanMyers(false, data, offs, n, table, pat_len, kmax, out, once, twice, thrice, p1, p2, p3);
}

export fn scan_myers_t(
    data: [*]const u16, offs: [*]const u32, n: u32, table: [*]const u32, pat_len: u32, kmax: u32, out: [*]f64,
    once: [*]const u32, twice: [*]const u32, thrice: [*]const u32, p1: u32, p2: u32, p3: u32,
) void {
    scanMyers(true, data, offs, n, table, pat_len, kmax, out, once, twice, thrice, p1, p2, p3);
}

// Weighted pattern positions (typing.firstLetter, see scanWeighted in kernel-js.mjs): `w` has a bit per weighted position,
// `flags` one word-start byte per corpus character. The deletion-run costs at the start of a match are derived here.
fn scanWeightedImpl(
    comptime D: bool, data: [*]const u16, flags: [*]const u8, offs: [*]const u32, n: u32, table: [*]const u32, pat_len: u32, kmax: u32,
    out: [*]f64, st: [*]u32, w: u32, mid_word: u32, denom: u32,
    once: [*]const u32, twice: [*]const u32, thrice: [*]const u32, p1: u32, p2: u32, p3: u32,
) void {
    const dnf: f64 = @floatFromInt(denom);
    const not_w = ~w;
    const top: u32 = @as(u32, 1) << @intCast(pat_len - 1);
    const need: u32 = pat_len - kmax;
    const st2 = st + 32;
    var init: [32]u32 = @splat(0);
    var cost: u32 = 0;
    var b: u32 = 0;
    while (b < pat_len) : (b += 1) {
        cost += 1 + ((w >> @intCast(b)) & 1);
        if (cost > kmax) break;
        var i = cost;
        while (i <= kmax) : (i += 1) init[i] |= @as(u32, 1) << @intCast(b);
    }
    var s: usize = 0;
    while (s < n) : (s += 1) {
        const ts: usize = offs[s];
        const text_len = offs[s + 1] - ts;
        const text = data + ts;
        const text_flags = flags + ts;
        // No operation costs less than in the unweighted scan, so a string whose unweighted distance exceeds kmax cannot match.
        if (text_len < need or lacks(once, twice, thrice, s, p1, p2, p3, kmax) or distance(D, data, @intCast(ts), @intCast(ts + text_len), table, pat_len, kmax) > kmax) { out[s] = -1.0; continue; }
        var K: i32 = @intCast(kmax);
        var best: i32 = -1;
        var prev_raw: u32 = 0;
        var q: u32 = 0;
        while (q <= kmax) : (q += 1) {
            st[q] = init[q];
            st2[q] = init[q];
        }
        var j: usize = text_len;
        outer: while (j >= 1) : (j -= 1) {
            const raw = table[text[j - 1]];
            const at_start = text_flags[j - 1] != 0;
            const cm = if (at_start) raw else raw & not_w;
            const c1 = if (mid_word == 1) not_w | (raw & w) else not_w;
            const swap: u32 = if (D) prev_raw & (raw << 1) & (if (at_start) ~@as(u32, 0) else not_w) else 0;
            prev_raw = raw;
            var old_l: u32 = 0;
            var new_l: u32 = 0;
            var older_l: u32 = 0;
            var old_l2: u32 = 0;
            var new_l2: u32 = 0;
            var i: i32 = 0;
            while (i <= K) : (i += 1) {
                const iu: usize = @intCast(i);
                const oi = st[iu];
                const o2 = st2[iu];
                var nv: u32 = ((oi << 1) | 1) & cm;
                if (i != 0) {
                    nv |= (((old_l << 1) | 1) & c1) | ((new_l << 1) & not_w) | old_l;
                    if (D) nv |= ((older_l << 2) | 2) & swap;
                    if (i >= 2) nv |= (((old_l2 | new_l2) << 1) | 1) & w;
                }
                st[iu] = nv;
                st2[iu] = oi;
                if (nv & top != 0) {
                    best = i;
                    K = i - 1;
                    if (K < 0) break :outer;
                    break;
                }
                older_l = o2;
                old_l2 = old_l;
                new_l2 = new_l;
                old_l = oi;
                new_l = nv;
            }
        }
        out[s] = if (best >= 0) @max(@as(f64, @floatFromInt(best)) / dnf, 0.001) else -1.0;
    }
}

export fn scan2w(
    data: [*]const u16, flags: [*]const u8, offs: [*]const u32, n: u32, table: [*]const u32, pat_len: u32, kmax: u32,
    out: [*]f64, st: [*]u32, w: u32, mid_word: u32, denom: u32,
    once: [*]const u32, twice: [*]const u32, thrice: [*]const u32, p1: u32, p2: u32, p3: u32,
) void {
    scanWeightedImpl(false, data, flags, offs, n, table, pat_len, kmax, out, st, w, mid_word, denom, once, twice, thrice, p1, p2, p3);
}

export fn scan2wt(
    data: [*]const u16, flags: [*]const u8, offs: [*]const u32, n: u32, table: [*]const u32, pat_len: u32, kmax: u32,
    out: [*]f64, st: [*]u32, w: u32, mid_word: u32, denom: u32,
    once: [*]const u32, twice: [*]const u32, thrice: [*]const u32, p1: u32, p2: u32, p3: u32,
) void {
    scanWeightedImpl(true, data, flags, offs, n, table, pat_len, kmax, out, st, w, mid_word, denom, once, twice, thrice, p1, p2, p3);
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
