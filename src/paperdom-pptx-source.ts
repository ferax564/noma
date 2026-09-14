// @ts-nocheck — vendored PaperDOM kernel; host policy lives in enterprise-paperdom-host.ts
// Vendored from https://github.com/ferax564/paperDOM/blob/a12198cdad8c7487242834941a34ed5adf5d4d74/app/pptx-source.ts (MIT). Do not edit to add Noma host policy.
import { parsePaperDOMDocument, type PaperDOMDocument } from './paperdom-document-model.js';

// Keep source packages bounded: documents are cloned, persisted and shared as JSON.
export const MAX_PPTX_SOURCE_BYTES = 8 * 1024 * 1024;
export type PowerPointSource = { base64: string; sha256: string; modelSha256: string };
const hash = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)), b => b.toString(16).padStart(2, '0')).join('');
const modelHash = (document: PaperDOMDocument) => {
    const parsed = parsePaperDOMDocument({ ...document, powerPointSource: undefined });
    if (!parsed.ok) throw new Error(parsed.error);
    const { title, pages, masters, library, theme } = parsed.document;
    return hash(new TextEncoder().encode(JSON.stringify({ title, pages, masters, library, theme }, (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value)));
};
export async function retainPowerPointSource(document: PaperDOMDocument, bytes: ArrayBuffer): Promise<boolean> {
    if (bytes.byteLength > MAX_PPTX_SOURCE_BYTES) return false;
    const data = new Uint8Array(bytes); let binary = '';
    for (let i = 0; i < data.length; i += 8192) binary += String.fromCharCode(...data.subarray(i, i + 8192));
    document.powerPointSource = { base64: btoa(binary), sha256: await hash(data), modelSha256: await modelHash(document) };
    return true;
}
export async function originalPowerPointBytes(document: PaperDOMDocument, requireUnchanged = true): Promise<Uint8Array | null> {
    const source = document.powerPointSource;
    if (!source || requireUnchanged && await modelHash(document) !== source.modelSha256) return null;
    const data = Uint8Array.from(atob(source.base64), c => c.charCodeAt(0));
    if (await hash(data) !== source.sha256) throw new Error('The retained PowerPoint source failed its integrity check.');
    return data;
}
