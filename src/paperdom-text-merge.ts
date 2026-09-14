// @ts-nocheck — vendored PaperDOM kernel; host policy lives in enterprise-paperdom-host.ts
// Vendored from https://github.com/ferax564/paperDOM/blob/a12198cdad8c7487242834941a34ed5adf5d4d74/app/text-merge.ts (MIT). Do not edit to add Noma host policy.
import { compactRuns, type TextRun } from './paperdom-advanced-model.js';

type Edit<T> = { start: number; end: number; insert: T[] };
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Bounded character diff: large unrelated replacements require explicit conflict resolution. */
export function sequenceEdits<T>(base: T[], next: T[]): Edit<T>[] | null {
    let start = 0, end = base.length, stop = next.length;
    while (start < end && start < stop && equal(base[start], next[start])) start++;
    while (end > start && stop > start && equal(base[end - 1], next[stop - 1])) { end--; stop--; }
    if (start === end || start === stop) return start === end && start === stop ? [] : [{ start, end, insert: next.slice(start, stop) }];
    const n = end - start, m = stop - start;
    if ((n + 1) * (m + 1) > 1_000_000) return null;
    const rows = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
        rows[i][j] = equal(base[start + i], next[start + j]) ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1]);
    const edits: Edit<T>[] = [];
    let i = 0, j = 0, current: Edit<T> | undefined;
    while (i < n || j < m) {
        if (i < n && j < m && equal(base[start + i], next[start + j])) { current = undefined; i++; j++; continue; }
        if (!current) { current = { start: start + i, end: start + i, insert: [] }; edits.push(current); }
        if (j < m && (i === n || rows[i][j + 1] > rows[i + 1][j])) current.insert.push(next[start + j++]);
        else { i++; current.end = start + i; }
    }
    return edits;
}

export function mergeSequence<T>(base: T[], local: T[], remote: T[]): T[] | null {
    if (equal(local, remote) || equal(base, remote)) return local;
    if (equal(base, local)) return remote;
    const a = sequenceEdits(base, local), b = sequenceEdits(base, remote);
    if (!a || !b) return null;
    const edits = [...a];
    for (const candidate of b) {
        if (edits.some(e => equal(e, candidate))) continue;
        for (const e of a) {
            const overlap = Math.max(e.start, candidate.start) < Math.min(e.end, candidate.end);
            const inside = e.start === e.end && e.start > candidate.start && e.start < candidate.end || candidate.start === candidate.end && candidate.start > e.start && candidate.start < e.end;
            if (overlap || inside) return null;
        }
        edits.push(candidate);
    }
    // Concurrent insertions at the same position have a stable, peer-independent order.
    edits.sort((a, b) => a.start - b.start || a.end - b.end || (JSON.stringify(a.insert) < JSON.stringify(b.insert) ? -1 : 1));
    const result: T[] = []; let cursor = 0;
    for (const e of edits) { for (const value of base.slice(cursor, e.start)) result.push(value); for (const value of e.insert) result.push(value); cursor = e.end; }
    for (const value of base.slice(cursor)) result.push(value);
    return result;
}
export function mergeText(base: string, local: string, remote: string) {
    return mergeSequence(Array.from(base), Array.from(local), Array.from(remote))?.join('') ?? null;
}
export function mergeTextRuns(base: TextRun[], local: TextRun[], remote: TextRun[]): TextRun[] | null {
    const chars = (runs: TextRun[]) => runs.flatMap(r => Array.from(r.text, text => ({ text, ...(r.style && Object.keys(r.style).length ? { style: Object.fromEntries(Object.entries(r.style).sort(([a], [b]) => a.localeCompare(b))) } : {}), ...(r.link ? { link: r.link } : {}) })));
    const result = mergeSequence(chars(base), chars(local), chars(remote));
    return result ? compactRuns(result) : null;
}
/** DOM selections use UTF-16 offsets. Keep a caret attached to surviving text. */
export function mapTextOffset(before: string, after: string, offset: number) {
    const edits = sequenceEdits(before.split(''), after.split(''));
    if (!edits) return Math.min(offset, after.length);
    let shift = 0;
    for (const e of edits) {
        if (offset < e.start) break;
        if (offset <= e.end) return e.start + shift + e.insert.length;
        shift += e.insert.length - (e.end - e.start);
    }
    return Math.max(0, Math.min(after.length, offset + shift));
}
