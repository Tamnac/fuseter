// Root of extended.wasm, the kernels of extended search (src/extended.mjs, src/dense.mjs): the substring search behind the `'` operator, and the bookkeeping of a
// search over every string.
const L = 8;
const V = @Vector(L, u16);

// Writes the ids of the strings that contain pat to hits (ascending) and returns how many there are. The strings are stored back to back in text (total characters), offs holds their boundaries.
// A candidate start has the first and the last character of the pattern in place, checked for L positions at a time; after a match the search goes on in the next string.
export fn find(text: [*]const u16, total: u32, offs: [*]const u32, pat: [*]const u16, plen: u32, hits: [*]u32) u32 {
    if (plen == 0 or plen > total) return 0;
    var count: u32 = 0;
    const first: V = @splat(pat[0]);
    const last: V = @splat(pat[plen - 1]);
    const end: usize = total - plen + 1; // candidate starts are below this
    var s: usize = 0;
    var p: usize = 0;
    while (p < end) {
        var m: u8 = 0;
        if (p + L <= end) {
            const a: V = (text + p)[0..L].*;
            const b: V = (text + p + plen - 1)[0..L].*;
            m = @bitCast((a == first) & (b == last));
        } else {
            var i: usize = 0;
            while (p + i < end) : (i += 1) {
                if (text[p + i] == pat[0] and text[p + i + plen - 1] == pat[plen - 1]) m |= @as(u8, 1) << @intCast(i);
            }
        }
        var next = p + L;
        while (m != 0) {
            const q = p + @as(usize, @ctz(m));
            m &= m - 1;
            while (offs[s + 1] <= q) s += 1;
            const e = offs[s + 1];
            if (q + plen > e) continue;
            var k: usize = 1;
            while (k + 1 < plen and text[q + k] == pat[k]) k += 1;
            if (k + 1 < plen) continue;
            hits[count] = @intCast(s);
            count += 1;
            next = e;
            break;
        }
        p = next;
    }
    return count;
}

// alive is 0 (the group failed so far) or 1, plus 2 once an inverse term matched.

// A fuzzy term: strings it did not match (found < 0) fail the group, the others add its score.
export fn ext_fuzzy(found: [*]const f64, alive: [*]u8, sum: [*]f64, n: u32) void {
    var s: usize = 0;
    while (s < n) : (s += 1) {
        if (found[s] < 0) alive[s] = 0 else sum[s] += found[s];
    }
}

// An exact-style term: flags say which strings satisfy it; inverted is 2 for an inverse operator, 0 otherwise.
export fn ext_term(flags: [*]const u8, alive: [*]u8, n: u32, inverted: u8) void {
    var s: usize = 0;
    while (s < n) : (s += 1) {
        const a = alive[s];
        if (a != 0) alive[s] = if (flags[s] != 0) a | inverted else 0;
    }
}

// Gives the strings that survived the group their score (the mean of the fuzzy scores) unless an earlier group did; the first group assigns every string.
export fn ext_finish(alive: [*]const u8, sum: [*]const f64, scores: [*]f64, group: [*]i32, inverse: [*]u8, n: u32, g: i32, terms: u32, fuzzy: u32, initial: u32) void {
    const count: f64 = @floatFromInt(terms);
    var s: usize = 0;
    while (s < n) : (s += 1) {
        const a = alive[s];
        if (a != 0 and (initial != 0 or group[s] < 0)) {
            scores[s] = if (fuzzy != 0) sum[s] / count else 0.0;
            group[s] = g;
            inverse[s] = a >> 1;
        } else if (initial != 0) {
            scores[s] = -1.0;
            group[s] = -1;
            inverse[s] = 0;
        }
    }
}

// Keeps the strings of ids[0..count) that match a fuzzy pattern of up to 32 characters, adds their scores to sum[s], and returns how many there are. The scan is the
// scalar one of fast4.zig (src/kernel-js.mjs has the same in js): the score is the best error level / pat_len (at least 0.001, 0 for a string equal to the pattern).
// table is the pattern's character table, transposed counts an adjacent transposition as one error, st holds 2 * 32 level states.
fn narrowFuzzy(comptime D: bool, text: [*]const u16, offs: [*]const u32, ids: [*]u32, count: u32, table: [*]const u32, pat_len: u32, kmax: u32, sum: [*]f64, st: [*]u32) u32 {
    var kept: u32 = 0;
    const plf: f64 = @floatFromInt(pat_len);
    const mask: u32 = @as(u32, 1) << @intCast(pat_len - 1);
    const need: u32 = pat_len - kmax;
    const st2 = st + 32;
    var r: usize = 0;
    while (r < count) : (r += 1) {
        const s: usize = ids[r];
        const ts: usize = offs[s];
        const len = offs[s + 1] - ts;
        if (len < need) continue;
        var K: i32 = @intCast(kmax);
        var best: i32 = -1;
        var q: u32 = 0;
        while (q <= kmax) : (q += 1) {
            st[q] = (@as(u32, 1) << @intCast(q)) -% 1;
            st2[q] = st[q];
        }
        var prev_cm: u32 = 0;
        var j: usize = len;
        outer: while (j >= 1) : (j -= 1) {
            const cm: u32 = table[text[ts + j - 1]];
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
        if (best < 0) continue;
        sum[s] += if (best == 0 and len == pat_len) 0.0 else @max(@as(f64, @floatFromInt(best)) / plf, 0.001);
        ids[kept] = @intCast(s);
        kept += 1;
    }
    return kept;
}

export fn narrow_fuzzy(text: [*]const u16, offs: [*]const u32, ids: [*]u32, count: u32, table: [*]const u32, pat_len: u32, kmax: u32, transposed: u32, sum: [*]f64, st: [*]u32) u32 {
    if (transposed != 0) return narrowFuzzy(true, text, offs, ids, count, table, pat_len, kmax, sum, st);
    return narrowFuzzy(false, text, offs, ids, count, table, pat_len, kmax, sum, st);
}

// Starts a group over the strings ids[0..count): no inverse operator has matched, no fuzzy score is added up.
export fn clear_candidates(ids: [*]const u32, count: u32, bits: [*]u8, sum: [*]f64) void {
    var i: usize = 0;
    while (i < count) : (i += 1) {
        bits[ids[i]] = 0;
        sum[ids[i]] = 0.0;
    }
}

// The exact-style operators on one string (kind: 0 includes, 1 starts with, 2 ends with, 3 equals), see src/extended.mjs.
fn occurs(text: [*]const u16, at: usize, pat: [*]const u16, plen: usize) bool {
    var k: usize = 0;
    while (k < plen) : (k += 1) if (text[at + k] != pat[k]) return false;
    return true;
}

fn stringMatches(kind: u32, text: [*]const u16, offs: [*]const u32, s: usize, pat: [*]const u16, plen: usize) bool {
    const start: usize = offs[s];
    const len: usize = offs[s + 1] - start;
    return switch (kind) {
        0 => blk: {
            if (len < plen) break :blk false;
            var at = start;
            const last = start + len - plen;
            while (at <= last) : (at += 1) if (text[at] == pat[0] and occurs(text, at, pat, plen)) break :blk true;
            break :blk false;
        },
        1 => len >= plen and occurs(text, start, pat, plen),
        2 => len >= plen and occurs(text, start + len - plen, pat, plen),
        else => len == plen and occurs(text, start, pat, plen),
    };
}

// Writes the strings order[from..to) that match to out and returns their number.
export fn list_bucket(kind: u32, text: [*]const u16, offs: [*]const u32, order: [*]const u32, from: u32, to: u32, pat: [*]const u16, plen: u32, out: [*]u32) u32 {
    var count: u32 = 0;
    var i: usize = from;
    while (i < to) : (i += 1) {
        if (stringMatches(kind, text, offs, order[i], pat, plen)) {
            out[count] = order[i];
            count += 1;
        }
    }
    return count;
}

// Keeps the strings of ids[0..count) for which the term holds (it matches, or does not for an inverse operator) and returns their number;
// for an inverse operator bits[s] is set on those.
export fn narrow(kind: u32, inverted: u32, text: [*]const u16, offs: [*]const u32, ids: [*]u32, count: u32, pat: [*]const u16, plen: u32, bits: [*]u8) u32 {
    var kept: u32 = 0;
    var i: usize = 0;
    while (i < count) : (i += 1) {
        const s = ids[i];
        if (stringMatches(kind, text, offs, s, pat, plen) != (inverted != 0)) {
            ids[kept] = s;
            kept += 1;
            if (inverted != 0) bits[s] |= 1;
        }
    }
    return kept;
}
