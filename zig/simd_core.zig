// Shared by the two wasm modules (simd7.zig: Levenshtein as Fuse scores it, simd7d.zig: adjacent transposition counts as one error).
// D selects the transposition kernel. MS: kmax values with a fully unrolled level loop (larger values cost wasm size, not speed).
pub fn Scan(comptime T: type, comptime L: usize, comptime D: bool, comptime MS: u32) type {
    return struct {
        const V = @Vector(L, T);
        const B = @Vector(L, bool);
        fn splat(x: T) V { return @splat(x); }

        // older_l: the previous level two text positions back, swap: pattern positions whose two characters are the last two text characters, swapped.
        inline fn levelFast(oi: V, old_l: V, new_l: V, older_l: V, swap: V, cm: V, comptime first: bool) V {
            const one = splat(1);
            var nv = ((oi +% oi) | one) & cm;
            if (!first) {
                const m = old_l | new_l;
                nv |= (m +% m) | one | old_l;
                if (D) {
                    const d = older_l +% older_l;
                    nv |= ((d +% d) | splat(2)) & swap;
                }
            }
            return nv;
        }

        inline fn level(oi: V, old_l: V, new_l: V, older_l: V, swap: V, cm: V, active: B, comptime first: bool) V {
            return @select(T, active, levelFast(oi, old_l, new_l, older_l, swap, cm, first), oi);
        }

        // best level per lane, fully unrolled over levels 0..KM
        fn groupFixed(comptime KM: u32, row_base: [*]const u16, table: [*]const T, len_v: V, min_len: u32, max_len: u32, mask: V) V {
            const zero = splat(0);
            var st: [KM + 1]V = undefined;
            var st2: [KM + 1]V = undefined;
            var hit_st: [KM + 1]V = undefined;
            inline for (0..KM + 1) |q| {
                st[q] = splat((@as(T, 1) << @intCast(q)) -% 1);
                st2[q] = st[q];
                hit_st[q] = zero;
            }
            var prev_cm = zero;
            var r: u32 = 0;
            while (r < min_len) : (r += 1) {
                const row = row_base + r * L;
                var cm_arr: [L]T = undefined;
                inline for (0..L) |l| cm_arr[l] = table[row[l]];
                const cm: V = cm_arr;
                const swap = if (D) prev_cm & (cm +% cm) else zero;
                prev_cm = cm;
                var old_l = zero;
                var new_l = zero;
                var older_l = zero;
                inline for (0..KM + 1) |i| {
                    const oi = st[i];
                    const o2 = st2[i];
                    const nv = levelFast(oi, old_l, new_l, older_l, swap, cm, i == 0);
                    st[i] = nv;
                    st2[i] = oi;
                    hit_st[i] |= nv;
                    older_l = o2;
                    old_l = oi;
                    new_l = nv;
                }
            }
            while (r < max_len) : (r += 1) {
                const active: B = splat(@intCast(r)) < len_v;
                const row = row_base + r * L;
                var cm_arr: [L]T = undefined;
                inline for (0..L) |l| cm_arr[l] = table[row[l]];
                const cm: V = cm_arr;
                const swap = if (D) prev_cm & (cm +% cm) else zero;
                prev_cm = cm;
                var old_l = zero;
                var new_l = zero;
                var older_l = zero;
                inline for (0..KM + 1) |i| {
                    const oi = st[i];
                    const o2 = st2[i];
                    const nv = level(oi, old_l, new_l, older_l, swap, cm, active, i == 0);
                    st[i] = nv;
                    st2[i] = oi;
                    hit_st[i] |= nv;
                    older_l = o2;
                    old_l = oi;
                    new_l = nv;
                }
            }
            var best = splat(~@as(T, 0));
            inline for (0..KM + 1) |idx| {
                const i = KM - idx;
                best = @select(T, (hit_st[i] & mask) != zero, splat(@intCast(i)), best);
            }
            return best;
        }

        fn groupDyn(kmax: u32, row_base: [*]const u16, table: [*]const T, len_v: V, min_len: u32, max_len: u32, mask: V) V {
            const zero = splat(0);
            var st: [32]V = undefined;
            var st2: [32]V = undefined;
            var hit_st: [32]V = undefined;
            var q: u32 = 0;
            while (q <= kmax) : (q += 1) {
                st[q] = splat((@as(T, 1) << @intCast(q)) -% 1);
                st2[q] = st[q];
                hit_st[q] = zero;
            }
            var prev_cm = zero;
            var r: u32 = 0;
            while (r < min_len) : (r += 1) {
                const row = row_base + r * L;
                var cm_arr: [L]T = undefined;
                inline for (0..L) |l| cm_arr[l] = table[row[l]];
                const cm: V = cm_arr;
                const swap = if (D) prev_cm & (cm +% cm) else zero;
                prev_cm = cm;
                var old_l = zero;
                var new_l = zero;
                var older_l = zero;
                var i: u32 = 0;
                while (i <= kmax) : (i += 1) {
                    const oi = st[i];
                    const o2 = st2[i];
                    const nv = if (i == 0) levelFast(oi, old_l, new_l, older_l, swap, cm, true) else levelFast(oi, old_l, new_l, older_l, swap, cm, false);
                    st[i] = nv;
                    st2[i] = oi;
                    hit_st[i] |= nv;
                    older_l = o2;
                    old_l = oi;
                    new_l = nv;
                }
            }
            while (r < max_len) : (r += 1) {
                const active: B = splat(@intCast(r)) < len_v;
                const row = row_base + r * L;
                var cm_arr: [L]T = undefined;
                inline for (0..L) |l| cm_arr[l] = table[row[l]];
                const cm: V = cm_arr;
                const swap = if (D) prev_cm & (cm +% cm) else zero;
                prev_cm = cm;
                var old_l = zero;
                var new_l = zero;
                var older_l = zero;
                var i: u32 = 0;
                while (i <= kmax) : (i += 1) {
                    const oi = st[i];
                    const o2 = st2[i];
                    const nv = if (i == 0) level(oi, old_l, new_l, older_l, swap, cm, active, true) else level(oi, old_l, new_l, older_l, swap, cm, active, false);
                    st[i] = nv;
                    st2[i] = oi;
                    hit_st[i] |= nv;
                    older_l = o2;
                    old_l = oi;
                    new_l = nv;
                }
            }
            var best = splat(~@as(T, 0));
            var i: u32 = kmax + 1;
            while (i > 0) {
                i -= 1;
                best = @select(T, (hit_st[i] & mask) != zero, splat(@intCast(i)), best);
            }
            return best;
        }

        const Prep = struct { len_v: V, min_len: u32, max_len: u32 };

        inline fn prep(g: usize, offs: [*]const u32, order: [*]const u32, n: u32) Prep {
            var len_arr: [L]T = undefined;
            var min_len: u32 = ~@as(u32, 0);
            var max_len: u32 = 0;
            inline for (0..L) |l| {
                var len: u32 = 0;
                if (g + l < n) {
                    const s = order[g + l];
                    len = offs[s + 1] - offs[s];
                }
                len_arr[l] = @intCast(len);
                min_len = @min(min_len, len);
                max_len = @max(max_len, len);
            }
            return .{ .len_v = len_arr, .min_len = min_len, .max_len = max_len };
        }

        fn bestOf(kmax: u32, row_base: [*]const u16, table: [*]const T, p: Prep, mask: V) V {
            if (kmax <= MS) {
                return switch (kmax) {
                    inline 0...MS => |k| groupFixed(k, row_base, table, p.len_v, p.min_len, p.max_len, mask),
                    else => unreachable,
                };
            }
            return groupDyn(kmax, row_base, table, p.len_v, p.min_len, p.max_len, mask);
        }

        // first group index whose strings may match: a match needs at least pat_len - kmax text characters
        fn firstGroup(offs: [*]const u32, order: [*]const u32, n: u32, need: u32) usize {
            var lo: usize = 0;
            var hi: usize = n;
            while (lo < hi) {
                const mid = (lo + hi) / 2;
                const s = order[mid];
                if (offs[s + 1] - offs[s] < need) lo = mid + 1 else hi = mid;
            }
            return lo - lo % L;
        }

        // ---- weighted pattern positions (typing.firstLetter, see scanWeighted in kernel-js.mjs) ----
        // `flags` is laid out like `data` (one word-start byte per text position and lane).

        const Carry = struct { old_l: V, new_l: V, older_l: V, old_l2: V, new_l2: V };
        const Row = struct { cm: V, c1: V, swap: V, active: B };
        const Weights = struct { w: V, not_w: V, mid: bool };

        inline fn loadRow(row_ptr: [*]const u16, flag_ptr: [*]const u8, table: [*]const T, prev: *V, wt: Weights, active: B) Row {
            var raw_arr: [L]T = undefined;
            inline for (0..L) |l| raw_arr[l] = table[row_ptr[l]];
            const raw: V = raw_arr;
            const fv: @Vector(L, u8) = flag_ptr[0..L].*;
            const at_start = fv != @as(@Vector(L, u8), @splat(0));
            const swap = if (D) prev.* & (raw +% raw) & @select(T, at_start, splat(~@as(T, 0)), wt.not_w) else splat(0);
            prev.* = raw;
            const c1 = if (wt.mid) wt.not_w | (raw & wt.w) else wt.not_w;
            return .{ .cm = @select(T, at_start, raw, raw & wt.not_w), .c1 = c1, .swap = swap, .active = active };
        }

        inline fn levelW(comptime masked: bool, comptime first: bool, ge2: bool, c: *Carry, row: Row, wt: Weights, oi: V, o2: V) V {
            const one = splat(1);
            var nv = ((oi +% oi) | one) & row.cm;
            if (!first) {
                nv |= (((c.old_l +% c.old_l) | one) & row.c1) | ((c.new_l +% c.new_l) & wt.not_w) | c.old_l;
                if (D) {
                    const d = c.older_l +% c.older_l;
                    nv |= ((d +% d) | splat(2)) & row.swap;
                }
                if (ge2) {
                    const m2 = c.old_l2 | c.new_l2;
                    nv |= ((m2 +% m2) | one) & wt.w;
                }
            }
            if (masked) nv = @select(T, row.active, nv, oi);
            c.older_l = o2;
            c.old_l2 = c.old_l;
            c.new_l2 = c.new_l;
            c.old_l = oi;
            c.new_l = nv;
            return nv;
        }

        inline fn rowW(comptime KM: u32, comptime dyn: bool, comptime masked: bool, kmax: u32, st: anytype, st2: anytype, hit_st: anytype, row: Row, wt: Weights) void {
            const zero = splat(0);
            var c = Carry{ .old_l = zero, .new_l = zero, .older_l = zero, .old_l2 = zero, .new_l2 = zero };
            if (dyn) {
                var i: u32 = 0;
                while (i <= kmax) : (i += 1) {
                    const oi = st[i];
                    const o2 = st2[i];
                    const nv = if (i == 0) levelW(masked, true, false, &c, row, wt, oi, o2) else levelW(masked, false, i >= 2, &c, row, wt, oi, o2);
                    st[i] = nv;
                    st2[i] = oi;
                    hit_st[i] |= nv;
                }
            } else {
                inline for (0..KM + 1) |i| {
                    const oi = st[i];
                    const o2 = st2[i];
                    const nv = levelW(masked, i == 0, i >= 2, &c, row, wt, oi, o2);
                    st[i] = nv;
                    st2[i] = oi;
                    hit_st[i] |= nv;
                }
            }
        }

        // best level per lane; KM is the unrolled level count (dyn: kmax levels at run time)
        fn groupW(
            comptime KM: u32, comptime dyn: bool, kmax: u32, row_base: [*]const u16, flag_base: [*]const u8, table: [*]const T,
            len_v: V, min_len: u32, max_len: u32, mask: V, wt: Weights, ini: *const [32]T,
        ) V {
            const zero = splat(0);
            const NL = if (dyn) 32 else KM + 1;
            var st: [NL]V = undefined;
            var st2: [NL]V = undefined;
            var hit_st: [NL]V = undefined;
            if (dyn) {
                var q: u32 = 0;
                while (q <= kmax) : (q += 1) {
                    st[q] = splat(ini[q]);
                    st2[q] = st[q];
                    hit_st[q] = zero;
                }
            } else {
                inline for (0..KM + 1) |q| {
                    st[q] = splat(ini[q]);
                    st2[q] = st[q];
                    hit_st[q] = zero;
                }
            }
            var prev_raw = zero;
            var r: u32 = 0;
            while (r < min_len) : (r += 1) {
                const row = loadRow(row_base + r * L, flag_base + r * L, table, &prev_raw, wt, @splat(true));
                rowW(KM, dyn, false, kmax, &st, &st2, &hit_st, row, wt);
            }
            while (r < max_len) : (r += 1) {
                const row = loadRow(row_base + r * L, flag_base + r * L, table, &prev_raw, wt, splat(@intCast(r)) < len_v);
                rowW(KM, dyn, true, kmax, &st, &st2, &hit_st, row, wt);
            }
            var best = splat(~@as(T, 0));
            if (dyn) {
                var i: u32 = kmax + 1;
                while (i > 0) {
                    i -= 1;
                    best = @select(T, (hit_st[i] & mask) != zero, splat(@intCast(i)), best);
                }
            } else {
                inline for (0..KM + 1) |idx| {
                    const i = KM - idx;
                    best = @select(T, (hit_st[i] & mask) != zero, splat(@intCast(i)), best);
                }
            }
            return best;
        }

        fn bestOfW(kmax: u32, row_base: [*]const u16, flag_base: [*]const u8, table: [*]const T, p: Prep, mask: V, wt: Weights, ini: *const [32]T) V {
            if (kmax <= MS) {
                return switch (kmax) {
                    inline 0...MS => |k| groupW(k, false, k, row_base, flag_base, table, p.len_v, p.min_len, p.max_len, mask, wt, ini),
                    else => unreachable,
                };
            }
            return groupW(0, true, kmax, row_base, flag_base, table, p.len_v, p.min_len, p.max_len, mask, wt, ini);
        }

        // w: bit per weighted pattern position (like the char table), mid_word: cost of an exact weighted character off a word start,
        // denom: what the error count is divided by.
        pub fn runWeighted(
            data: [*]const u16, flags: [*]const u8, goff: [*]const u32, offs: [*]const u32, order: [*]const u32, n: u32, table: [*]const T,
            pat_len: u32, kmax: u32, w: u32, mid_word: u32, denom: u32, out: [*]f64,
        ) void {
            const dnf: f64 = @floatFromInt(denom);
            const mask = splat(@as(T, 1) << @intCast(pat_len - 1));
            const wv: V = splat(@intCast(w));
            const wt = Weights{ .w = wv, .not_w = ~wv, .mid = mid_word == 1 };
            var ini: [32]T = @splat(0);
            var cost: u32 = 0;
            var b: u32 = 0;
            while (b < pat_len) : (b += 1) {
                cost += 1 + ((w >> @intCast(b)) & 1);
                if (cost > kmax) break;
                var i = cost;
                while (i <= kmax) : (i += 1) ini[i] |= @as(T, 1) << @intCast(b);
            }
            const first = firstGroup(offs, order, n, pat_len - kmax);
            for (order[0..first]) |s| out[s] = -1.0;
            var g: usize = first;
            while (g < n) : (g += L) {
                const p = prep(g, offs, order, n);
                const bv = bestOfW(kmax, data + goff[g / L], flags + goff[g / L], table, p, mask, wt, &ini);
                inline for (0..L) |l| {
                    if (g + l < n) {
                        const v = bv[l];
                        out[order[g + l]] = if (v != ~@as(T, 0)) @max(@as(f64, @floatFromInt(v)) / dnf, 0.001) else -1.0;
                    }
                }
            }
        }

        pub fn run(
            data: [*]const u16, goff: [*]const u32, offs: [*]const u32, order: [*]const u32, n: u32, table: [*]const T,
            pat_len: u32, kmax: u32, out: [*]f64,
        ) void {
            const plf: f64 = @floatFromInt(pat_len);
            const mask = splat(@as(T, 1) << @intCast(pat_len - 1));
            const first = firstGroup(offs, order, n, pat_len - kmax);
            for (order[0..first]) |s| out[s] = -1.0;
            var g: usize = first;
            while (g < n) : (g += L) {
                const p = prep(g, offs, order, n);
                const b = bestOf(kmax, data + goff[g / L], table, p, mask);
                inline for (0..L) |l| {
                    if (g + l < n) {
                        const v = b[l];
                        out[order[g + l]] = if (v != ~@as(T, 0)) @max(@as(f64, @floatFromInt(v)) / plf, 0.001) else -1.0;
                    }
                }
            }
        }
    };
}

// Per-document score: product over the keys that matched of tbl[key][norm class][level], in key order (same rounding as Fuse); the scan
// scores are level / denom (denom = pat_len unless first letters are weighted),
// then a stable LSD radix sort of the doubles' bit patterns (positive doubles order like their bits), so ties keep document order.
// The first min(limit, hits) sorted entries end up in ids/keys. Returns the number of hits.
pub fn combineSort(
    out: [*]const f64, n_docs: u32, kk: u32, norm_id: [*]const u8, offs: [*]const u32, tbl: [*]const f64, nn: u32,
    pat_len: u32, denom: u32, kmax: u32, keys: [*]u64, ids: [*]u32, keys2: [*]u64, ids2: [*]u32, hist: [*]u32, limit: u32,
) u32 {
    const stride = kmax + 2;
    const plf: f64 = @floatFromInt(denom);
    var m: u32 = 0;
    var d: u32 = 0;
    while (d < n_docs) : (d += 1) {
        var total: f64 = 1.0;
        var any = false;
        var k: u32 = 0;
        while (k < kk) : (k += 1) {
            const s = d * kk + k;
            const v = out[s];
            if (v < 0) continue;
            const nid = norm_id[s];
            if (nid == 255) continue;
            const col: u32 = if (v == 0.001)
                (if (offs[s + 1] - offs[s] == pat_len) kmax + 1 else 0)
            else
                @intFromFloat(@round(v * plf));
            total *= tbl[(k * nn + nid) * stride + col];
            any = true;
        }
        if (any) {
            keys[m] = @bitCast(total);
            ids[m] = d;
            m += 1;
        }
    }
    radixSort(keys, ids, keys2, ids2, hist, m, limit);
    return m;
}

// Stable LSD radix sort of the first m doubles in keys (positive doubles order like their bit patterns) with their ids; the first min(limit, m)
// sorted entries (all with limit 0) end up in keys/ids.
pub fn radixSort(keys: [*]u64, ids: [*]u32, keys2: [*]u64, ids2: [*]u32, hist: [*]u32, m: u32, limit: u32) void {
    if (m < 2) return;
    @memset(hist[0 .. 8 * 256], 0);
    for (keys[0..m]) |key| {
        inline for (0..8) |p| hist[p * 256 + @as(usize, @intCast((key >> (8 * p)) & 255))] += 1;
    }
    var src_k = keys;
    var src_i = ids;
    var dst_k = keys2;
    var dst_i = ids2;
    inline for (0..8) |p| {
        const h = hist + p * 256;
        if (h[@as(usize, @intCast((src_k[0] >> (8 * p)) & 255))] != m) {
            var sum: u32 = 0;
            for (h[0..256]) |*c| {
                const x = c.*;
                c.* = sum;
                sum += x;
            }
            var i: u32 = 0;
            while (i < m) : (i += 1) {
                const key = src_k[i];
                const b: usize = @intCast((key >> (8 * p)) & 255);
                const pos = h[b];
                h[b] = pos + 1;
                dst_k[pos] = key;
                dst_i[pos] = src_i[i];
            }
            const tk = src_k;
            const ti = src_i;
            src_k = dst_k;
            src_i = dst_i;
            dst_k = tk;
            dst_i = ti;
        }
    }
    if (src_k != keys) {
        const cnt = if (limit > 0) @min(limit, m) else m;
        @memcpy(keys[0..cnt], src_k[0..cnt]);
        @memcpy(ids[0..cnt], src_i[0..cnt]);
    }
}
