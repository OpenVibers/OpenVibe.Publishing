'use strict';
/**
 * Line and word diffs (Myers' O(ND) algorithm over tokens), used by revisions.diff and ssr.diffHtml.
 *
 *   diffText(a, b, { mode: 'line' | 'word' }) ->
 *     { mode, ops: [{ op: 'equal'|'insert'|'delete', text }], added, removed, approximate }
 *
 * `added` / `removed` count tokens (lines or words). Common prefix and suffix are trimmed before
 * the search; if the two texts differ by more than `maxEdits` tokens the middle is reported as one
 * delete plus one insert and `approximate` is true, so a pathological input cannot exhaust memory.
 */

const WORD_RE = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;

function tokenize(text, mode) {
    const s = String(text == null ? '' : text);
    if (!s) return [];
    if (mode === 'word') return s.match(WORD_RE) || [];
    return s.match(/[^\n]*\n|[^\n]+$/g) || [];
}

function myers(a, b, maxEdits) {
    const n = a.length;
    const m = b.length;
    const max = n + m;
    const offset = max + 1;
    const v = new Int32Array(2 * max + 3);
    const trace = [];
    for (let d = 0; d <= max; d++) {
        if (d > maxEdits) return null;
        trace.push(v.slice(offset - d - 1, offset + d + 2));
        for (let k = -d; k <= d; k += 2) {
            let x = (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) ? v[offset + k + 1] : v[offset + k - 1] + 1;
            let y = x - k;
            while (x < n && y < m && a[x] === b[y]) { x++; y++; }
            v[offset + k] = x;
            if (x >= n && y >= m) return backtrack(trace, a, b);
        }
    }
    return backtrack(trace, a, b);
}

function backtrack(trace, a, b) {
    const ops = [];
    let x = a.length;
    let y = b.length;
    for (let d = trace.length - 1; d >= 0; d--) {
        const row = trace[d];
        const at = (k) => row[k + d + 1];
        const k = x - y;
        const prevK = (k === -d || (k !== d && at(k - 1) < at(k + 1))) ? k + 1 : k - 1;
        const prevX = at(prevK);
        const prevY = prevX - prevK;
        while (x > prevX && y > prevY) { ops.push({ op: 'equal', text: a[x - 1] }); x--; y--; }
        if (d > 0) {
            if (x === prevX) { ops.push({ op: 'insert', text: b[y - 1] }); y--; }
            else { ops.push({ op: 'delete', text: a[x - 1] }); x--; }
        }
        x = prevX;
        y = prevY;
    }
    return ops.reverse();
}

function merge(ops) {
    const out = [];
    for (const o of ops) {
        const last = out[out.length - 1];
        if (last && last.op === o.op) last.text += o.text;
        else out.push({ op: o.op, text: o.text });
    }
    return out;
}

function diffTokens(a, b, { maxEdits = 4000 } = {}) {
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
    const midA = a.slice(start, endA);
    const midB = b.slice(start, endB);
    let middle = myers(midA, midB, maxEdits);
    let approximate = false;
    if (!middle) {
        approximate = true;
        middle = [...midA.map((t) => ({ op: 'delete', text: t })), ...midB.map((t) => ({ op: 'insert', text: t }))];
    }
    const ops = [
        ...a.slice(0, start).map((t) => ({ op: 'equal', text: t })),
        ...middle,
        ...a.slice(endA).map((t) => ({ op: 'equal', text: t })),
    ];
    let added = 0;
    let removed = 0;
    for (const o of ops) {
        if (o.op === 'insert' && o.text.trim()) added++;
        if (o.op === 'delete' && o.text.trim()) removed++;
    }
    return { ops: merge(ops), added, removed, approximate };
}

function diffText(a, b, { mode = 'line', maxEdits } = {}) {
    if (mode !== 'line' && mode !== 'word') throw new TypeError('mode must be "line" or "word"');
    return { mode, ...diffTokens(tokenize(a, mode), tokenize(b, mode), { maxEdits }) };
}

/** Unified-style text for a line diff: "+ added", "- removed", "  kept". */
function formatLines(result) {
    const out = [];
    for (const o of result.ops) {
        const sign = o.op === 'insert' ? '+ ' : o.op === 'delete' ? '- ' : '  ';
        for (const line of tokenize(o.text, 'line')) out.push(sign + line.replace(/\n$/, ''));
    }
    return out.join('\n');
}

module.exports = { diffText, formatLines, tokenize };
