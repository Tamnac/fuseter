// D: adjacent transposition counts as one error (see simd_core.zig); st holds 2 * 32 level states.
fn scanImpl(
    comptime D: bool, data: [*]const u16, offs: [*]const u32, n: u32, table: [*]const u32, pat_len: u32, kmax: u32,
    out: [*]f64, st: [*]u32, pc: [*]const u8, rem: [*]u8, use_filter: u32,
) void {
    const plf: f64 = @floatFromInt(pat_len);
    const mask: u32 = @as(u32, 1) << @intCast(pat_len - 1);
    const need: u32 = pat_len - kmax;
    const st2 = st + 32;
    var s: usize = 0;
    while (s < n) : (s += 1) {
        const ts: usize = offs[s];
        const te: usize = offs[s + 1];
        const text_len = te - ts;
        const text = data + ts;
        if (text_len < need) { out[s] = -1.0; continue; } // a match needs at least pat_len - kmax characters
        if (use_filter != 0) {
            var matched: u32 = 0;
            var p: usize = 0;
            while (p < text_len) : (p += 1) {
                const c = text[p];
                if (rem[c] > 0) { rem[c] -= 1; matched += 1; }
            }
            p = 0;
            while (p < text_len) : (p += 1) { const c = text[p]; rem[c] = pc[c]; }
            if (matched < need) { out[s] = -1.0; continue; }
        }
        var K: i32 = @intCast(kmax);
        var best: i32 = -1;
        var q: u32 = 0;
        while (q <= kmax) : (q += 1) {
            st[q] = (@as(u32, 1) << @intCast(q)) -% 1;
            st2[q] = st[q];
        }
        var prev_cm: u32 = 0;
        var j: usize = text_len; // padding positions are a fixed point: skip them
        outer: while (j >= 1) : (j -= 1) {
            const loc = j - 1;
            const cm: u32 = if (loc < text_len) table[text[loc]] else 0;
            const swap: u32 = if (D) prev_cm & (cm << 1) else 0;
            prev_cm = cm;
            var old_l: u32 = 0;
            var new_l: u32 = 0;
            var older_l: u32 = 0;
            var i: i32 = 0;
            while (i <= K) : (i += 1) {
                const iu: usize = @intCast(i);
                const oi = st[iu];
                const o2 = st2[iu];
                var nv: u32 = ((oi << 1) | 1) & cm;
                if (i != 0) nv |= ((old_l | new_l) << 1) | 1 | old_l;
                if (D and i != 0) nv |= ((older_l << 2) | 2) & swap;
                st[iu] = nv;
                st2[iu] = oi;
                if (nv & mask != 0) {
                    best = i;
                    K = i - 1;
                    if (K < 0) break :outer;
                    break;
                }
                older_l = o2;
                old_l = oi;
                new_l = nv;
            }
        }
        out[s] = if (best >= 0) @max(@as(f64, @floatFromInt(best)) / plf, 0.001) else -1.0;
    }
}

export fn scan2(
    data: [*]const u16, offs: [*]const u32, n: u32, table: [*]const u32, pat_len: u32, kmax: u32,
    out: [*]f64, st: [*]u32, pc: [*]const u8, rem: [*]u8, use_filter: u32,
) void {
    scanImpl(false, data, offs, n, table, pat_len, kmax, out, st, pc, rem, use_filter);
}

export fn scan2t(
    data: [*]const u16, offs: [*]const u32, n: u32, table: [*]const u32, pat_len: u32, kmax: u32,
    out: [*]f64, st: [*]u32, pc: [*]const u8, rem: [*]u8, use_filter: u32,
) void {
    scanImpl(true, data, offs, n, table, pat_len, kmax, out, st, pc, rem, use_filter);
}

// Weighted pattern positions (typing.firstLetter, see scanWeighted in kernel-js.mjs): `w` has a bit per weighted position,
// `flags` one word-start byte per corpus character. The deletion-run costs at the start of a match are derived here.
fn scanWeightedImpl(
    comptime D: bool, data: [*]const u16, flags: [*]const u8, offs: [*]const u32, n: u32, table: [*]const u32, pat_len: u32, kmax: u32,
    out: [*]f64, st: [*]u32, w: u32, mid_word: u32, denom: u32,
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
        if (text_len < need) { out[s] = -1.0; continue; }
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
) void {
    scanWeightedImpl(false, data, flags, offs, n, table, pat_len, kmax, out, st, w, mid_word, denom);
}

export fn scan2wt(
    data: [*]const u16, flags: [*]const u8, offs: [*]const u32, n: u32, table: [*]const u32, pat_len: u32, kmax: u32,
    out: [*]f64, st: [*]u32, w: u32, mid_word: u32, denom: u32,
) void {
    scanWeightedImpl(true, data, flags, offs, n, table, pat_len, kmax, out, st, w, mid_word, denom);
}
