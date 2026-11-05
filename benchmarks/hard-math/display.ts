import { expect, type Locator } from '@playwright/test';

type Root = {lo:{n:string;d:string};hi:{n:string;d:string};multiplicity:number};

/** Read the frozen human-readable contract, independent of rows, tags or CSS.
 * Fractions are single tokens: their digits cannot stand in for multiplicities.
 * Comparing the whole sequence binds both endpoints and multiplicity to each
 * root, and rejects omitted, reordered, duplicated and extra records.
 */
export function displayedRootValues(text:string):string[] {
  return text
    .replace(/\broot\s*#?\s*\d+\s*[:.)]/gi,'') // Optional human-readable row labels.
    .replace(/\b0\s+(?:real\s+)?roots?\b/gi,'')
    .match(/[+-]?\d+\s*\/\s*[+-]?\d+|[+-]?\d+/g)
    ?.map(value=>value.replace(/\s/g,''))??[];
}

export async function verifyDisplayedRoots(results:Locator,roots:Root[],timeout=10_000):Promise<void> {
  const expected=roots.flatMap(root=>[`${root.lo.n}/${root.lo.d}`,`${root.hi.n}/${root.hi.d}`,String(root.multiplicity)]);
  await expect.poll(async()=>displayedRootValues(await results.innerText()),{
    timeout,message:'UI complete root records disagree with oracle-certified CLI',
  }).toEqual(expected);
}
