// @ts-nocheck — vendored PaperDOM kernel; host policy lives in enterprise-paperdom-host.ts
// Vendored from https://github.com/ferax564/paperDOM/blob/a12198cdad8c7487242834941a34ed5adf5d4d74/app/collaboration-model.ts (MIT). Do not edit to add Noma host policy.
import { parsePaperDOMDocument, type PaperDOMDocument } from './paperdom-document-model.js';
import { mergeText, mergeTextRuns } from './paperdom-text-merge.js';
import type { TextRun } from './paperdom-advanced-model.js';
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** Merge independent fields and character edits; overlapping replacements remain explicit conflicts. */
export function mergeDocuments(base: PaperDOMDocument, local: PaperDOMDocument, remote: PaperDOMDocument) {
    const conflicts: string[] = [];
    function merge(b: unknown, l: unknown, r: unknown, path: string): unknown {
        if (equal(l, r) || equal(b, r))
            return l;
        if (equal(b, l))
            return r;
        if (typeof b === 'string' && typeof l === 'string' && typeof r === 'string' && /\/(text|notes)$/.test(path)) {
            const text = mergeText(b, l, r);
            if (text !== null) return text;
        }
        if (object(b) && object(l) && object(r) && object(b.content) && object(l.content) && object(r.content) && [b, l, r].some(v => v.runs !== undefined)) {
            const runs = (v: Record<string, unknown>) => (v.runs ?? [{ text: (v.content as Record<string, unknown>).text ?? '' }]) as TextRun[];
            const merged = mergeTextRuns(runs(b), runs(l), runs(r));
            if (!merged) { conflicts.push(`${path}/runs`); return l; }
            const clean = (v: Record<string, unknown>) => ({ ...v, runs: undefined, content: { ...v.content as object, text: '' } });
            const result = merge(clean(b), clean(l), clean(r), path) as Record<string, unknown>;
            return { ...result, runs: merged, content: { ...result.content as object, text: merged.map(r => r.text).join('') } };
        }
        if (object(b) && object(l) && object(r))
            return Object.fromEntries([...new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)])].map(k => [k, merge(b[k], l[k], r[k], `${path}/${k}`)]));
        if (Array.isArray(b) && Array.isArray(l) && Array.isArray(r) && [...b, ...l, ...r].every(v => object(v) && typeof v.id === 'string')) {
            const ids = (a: Record<string, unknown>[]) => a.map(v => String(v.id));
            const bi = ids(b), li = ids(l), ri = ids(r), common = bi.filter(id => li.includes(id) && ri.includes(id));
            const order = (a: string[]) => a.filter(id => common.includes(id));
            const lb = equal(order(li), order(bi)), rb = equal(order(ri), order(bi));
            if (!lb && !rb && !equal(order(li), order(ri))) {
                conflicts.push(`${path}/order`);
                return l;
            }
            const orderIds = [...new Set([...(lb ? ri : li), ...li, ...ri])];
            return orderIds.map(id => merge(b.find(v => v.id === id), l.find(v => v.id === id), r.find(v => v.id === id), `${path}/${id}`)).filter(v => v !== undefined);
        }
        conflicts.push(path);
        return l;
    }
    const clean = (d: PaperDOMDocument) => ({ ...d, revision: 0, metadata: { ...d.metadata, updatedAt: '' } });
    const merged = merge(clean(base), clean(local), clean(remote), 'document') as PaperDOMDocument;
    merged.revision = Math.max(local.revision, remote.revision) + 1;
    merged.metadata.updatedAt = new Date().toISOString();
    const parsed = parsePaperDOMDocument(merged);
    if (!parsed.ok)
        conflicts.push(parsed.error);
    return { document: parsed.ok ? parsed.document : local, conflicts };
}
export function sameDocument(a: PaperDOMDocument, b: PaperDOMDocument) { return equal({ ...a, revision: 0, metadata: { ...a.metadata, updatedAt: '' } }, { ...b, revision: 0, metadata: { ...b.metadata, updatedAt: '' } }); }
