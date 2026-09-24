// Forked from ferax564/paperDOM@a12198c app/ids.ts (MIT). Maintained in this repository; see src/paperdom-pin.ts.
/** Stable object IDs also work in HTTP previews, where randomUUID is unavailable. */
type RandomSource={getRandomValues<T extends Uint8Array>(array:T):T;randomUUID?:()=>string};
export function randomId(prefix:string,random:RandomSource=globalThis.crypto as RandomSource):string {
  const value=random.randomUUID?.()??Array.from(random.getRandomValues(new Uint8Array(16)),(byte:number)=>byte.toString(16).padStart(2,'0')).join('');
  return `${prefix}_${value}`;
}
