import { readFileSync } from 'node:fs';
export const profile = JSON.parse(readFileSync(new URL('./profiles/v1.json', import.meta.url), 'utf8'));
export interface Request { coefficients: string[]; precisionBits: number }
export interface Sample extends Request { family: string }
const multiply = (a: bigint[], b: bigint[]) => {
  const result = Array<bigint>(a.length+b.length-1).fill(0n);
  a.forEach((x,i)=>b.forEach((y,j)=>{result[i+j]+=x*y;})); return result;
};
export function generate(seed: number): Sample[] {
  if (!profile.seeds.includes(seed)) throw new Error('v1 seed must be 1, 2 or 3');
  let state = seed >>> 0;
  const next = () => { state = (Math.imul(state,1664525)+1013904223)>>>0; return BigInt(state); };
  const samples: Sample[]=[];
  const add=(family:string,p:bigint[])=>samples.push({family,coefficients:p.map(String),precisionBits:64});
  // Dense degree 32, full 224-bit coefficients, nonzero leading coefficient.
  add('dense-high-degree',Array.from({length:33},()=>((next()<<192n)+(next()<<128n)+(next()<<64n)+next())*(next()%2n?1n:-1n)));
  add('large-coefficients',[1n<<250n, -(next()<<180n), -(1n<<249n)]);
  // Eight adjacent rational roots separated by 2^-24, degree 8 and ~193 coefficient bits.
  let clustered=[1n]; for(let i=0;i<8;i++) clustered=multiply(clustered,[1n<<24n,-((1n<<24n)+BigInt(i+seed))]);
  add('clustered',clustered);
  let repeated=[1n]; for(let i=0;i<8;i++) repeated=multiply(repeated,[1n,0n,-2n]);
  for(let i=0;i<4;i++) repeated=multiply(repeated,[1n,-BigInt(seed)]);
  add('repeated',repeated);
  let positive=[1n]; for(let i=0;i<16;i++) positive=multiply(positive,[1n,0n,BigInt(i+seed)]);
  add('no-real-roots',positive);
  add('zero-root',multiply([1n,0n,0n,0n],[1n,0n,-BigInt(seed+1)]));
  add('zero-root',[0n,0n,1n,0n]);
  add('large-coefficients',[next()+1n]);
  return samples;
}
