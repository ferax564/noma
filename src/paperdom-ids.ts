// @ts-nocheck — vendored PaperDOM kernel; host policy lives in enterprise-paperdom-host.ts
// Vendored from https://github.com/ferax564/paperDOM/blob/a12198cdad8c7487242834941a34ed5adf5d4d74/app/ids.ts (MIT). Do not edit to add Noma host policy.
/** Stable object IDs also work in HTTP previews, where randomUUID is unavailable. */
export function randomId(prefix:string,random:Pick<Crypto,'getRandomValues'> & Partial<Pick<Crypto,'randomUUID'>>=globalThis.crypto):string {
  const value=random.randomUUID?.()??Array.from(random.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,'0')).join('');
  return `${prefix}_${value}`;
}
