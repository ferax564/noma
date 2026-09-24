// Forked from ferax564/paperDOM@a12198c app/advanced-model.ts (MIT). Maintained in this repository; see src/paperdom-pin.ts.
import type { CanvasElement, CanvasPage, ElementStyle, PaperDOMDocument } from './paperdom-document-model.js';
export type TextRun = {
    text: string;
    style?: Partial<Pick<ElementStyle, 'fontFamily' | 'fontSize' | 'fontWeight' | 'fontStyle' | 'underline' | 'strike' | 'color'>>;
    link?: string;
};
export type AnimationCue = {
    id: string;
    elementId: string;
    effect: 'appear' | 'fade-in' | 'fade-out' | 'fly-in' | 'zoom' | 'spin' | 'pulse' | 'move';
    trigger: 'click' | 'with-previous' | 'after-previous';
    duration: number;
    delay: number;
    dx?: number;
    dy?: number;
};
export type MediaData = {
    src: string;
    poster?: string;
    captions?: string;
    autoplay: boolean;
    loop: boolean;
    muted: boolean;
    start: number;
    end?: number;
};
export function safeLink(value: string) { return /^(https?:\/\/|mailto:)/i.test(value); }
export function safeMedia(value: string) { return /^(https:\/\/|data:(audio|video)\/(mp4|mpeg|ogg|webm|wav);base64,|\/api\/assets\/)/i.test(value); }
export function compactRuns(runs: TextRun[]): TextRun[] { const result: TextRun[] = []; for (const raw of runs) {
    if (!raw.text)
        continue;
    const r = structuredClone(raw), last = result.at(-1);
    if (last && JSON.stringify(last.style) === JSON.stringify(r.style) && last.link === r.link)
        last.text += r.text;
    else
        result.push(r);
} return result; }
export function formatRuns(runs: TextRun[], start: number, end: number, style: TextRun['style'], link?: string): TextRun[] { let offset = 0; const output: TextRun[] = []; for (const r of runs) {
    const a = Math.max(0, start - offset), b = Math.min(r.text.length, end - offset);
    if (a < b) {
        if (a > 0)
            output.push({ ...r, text: r.text.slice(0, a) });
        output.push({ ...r, text: r.text.slice(a, b), style: { ...r.style, ...style }, ...(link === undefined ? {} : { link: link || undefined }) });
        if (b < r.text.length)
            output.push({ ...r, text: r.text.slice(b) });
    }
    else
        output.push(r);
    offset += r.text.length;
} return compactRuns(output); }
export function replaceRunText(runs: TextRun[], text: string): TextRun[] { const old = runs.map(r => r.text).join(''); let a = 0, b = 0; while (a < old.length && a < text.length && old[a] === text[a])
    a++; while (b < old.length - a && b < text.length - a && old[old.length - b - 1] === text[text.length - b - 1])
    b++; let offset = 0; const before: TextRun[] = [], after: TextRun[] = []; let inherited: TextRun | undefined; for (const r of runs) {
    if (offset <= a && offset + r.text.length >= a)
        inherited = r;
    if (offset < a)
        before.push({ ...r, text: r.text.slice(0, a - offset) });
    if (offset + r.text.length > old.length - b)
        after.push({ ...r, text: r.text.slice(Math.max(0, old.length - b - offset)) });
    offset += r.text.length;
} return compactRuns([...before, { ...inherited, text: text.slice(a, text.length - b) }, ...after]); }
/** Masters stay linked. Rendering clones their objects; document IDs never change. */
export function composePage(page: CanvasPage, document?: PaperDOMDocument): CanvasPage { const master = document?.masters?.find(m => m.id === page.masterId); if (!master)
    return page; const sx = page.size.width / master.size.width, sy = page.size.height / master.size.height; return { ...page, masterId: undefined, background: page.inheritBackground ? master.background : page.background, elements: [...master.elements.map(raw => { const e = structuredClone(raw); e.id = `master_${page.id}_${e.id}`; e.frame = { ...e.frame, x: e.frame.x * sx, y: e.frame.y * sy, w: e.frame.w * sx, h: e.frame.h * sy }; e.locked = true; e.z -= 100000; for (const p of [e.from, e.to])
            if (p) {
                if (p.elementId)
                    p.elementId = `master_${page.id}_${p.elementId}`;
                else {
                    p.x = (p.x ?? 0) * sx;
                    p.y = (p.y ?? 0) * sy;
                }
            } return e; }), ...page.elements] }; }
/** Web Animations keyframe (the core tsconfig has no DOM lib). */
export type Keyframe = Record<string, string | number | null | undefined>;
export function cueFrames(cue: AnimationCue, opacity=1): Keyframe[] { switch (cue.effect) {
    case 'appear': return [{ opacity }, { opacity }];
    case 'fade-in': return [{ opacity: 0 }, { opacity }];
    case 'fade-out': return [{ opacity }, { opacity: 0 }];
    case 'fly-in': return [{ translate: `${cue.dx ?? -120}px ${cue.dy ?? 0}px`, opacity: 0 }, { translate: '0px 0px', opacity }];
    case 'zoom': return [{ scale: .2, opacity: 0 }, { scale: 1, opacity }];
    case 'spin': return [{ rotate: '0deg' }, { rotate: '360deg' }];
    case 'pulse': return [{ scale: 1 }, { scale: 1.12 }, { scale: 1 }];
    case 'move': return [{ translate: '0px 0px' }, { translate: `${cue.dx ?? 100}px ${cue.dy ?? 0}px` }];
} }
export function animationBatches(cues: AnimationCue[]) { const batches: {
    cue: AnimationCue;
    at: number;
}[][] = []; let end = 0, start = 0; for (const cue of cues) {
    if (cue.trigger === 'click' || !batches.length) {
        batches.push([]);
        end = 0;
        start = 0;
    }
    const at = (cue.trigger === 'after-previous' ? end : cue.trigger === 'with-previous' ? start : 0) + cue.delay;
    start = at;
    end = at + cue.duration;
    batches.at(-1)!.push({ cue, at });
} return batches; }
export function textRuns(element: CanvasElement): TextRun[] { return element.runs ?? [{ text: element.content?.text ?? '' }]; }
