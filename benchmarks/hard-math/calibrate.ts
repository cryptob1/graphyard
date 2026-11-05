// A single bounded run for v1; never called during evaluated benchmark runs.
import { writeFile, readFile } from 'node:fs/promises';
import { generate, profile } from './generator.js';
import { oracle, oracleDigest, digest } from './oracle.js';
import { fileURLToPath } from 'node:url';
const destination=new URL('./profiles/frozen-v1.json',import.meta.url);
if(await readFile(destination).then(()=>true,()=>false)) throw new Error('v1 is already frozen; evaluated profiles cannot be recalibrated');
const python=process.argv[2]; if(!python) throw new Error('Usage: calibrate.ts PINNED_PYTHON');
const started=Date.now(),cases=profile.seeds.flatMap((seed:number)=>generate(seed).map(sample=>({seed,...sample})));
const reference=await oracle(python,cases.map(request=>({request,reference:true})));
const verified=await oracle(python,cases.map((request,i)=>({request,output:reference[i]})));
if(verified.some(result=>!result.pass)) throw new Error('Calibration reference rejected');
const maxBits=Math.max(...cases.flatMap(sample=>sample.coefficients.map(c=>BigInt(c)<0n?(-BigInt(c)).toString(2).length:BigInt(c).toString(2).length)));
if(maxBits>256 || cases.some(sample=>sample.coefficients.length-1>32)) throw new Error('Generator exceeds finite limits');
const frozen={version:'v1',profileDigest:digest(await readFile(new URL('./profiles/v1.json',import.meta.url))),generatorDigest:digest(await readFile(new URL('./generator.ts',import.meta.url))),contractDigest:digest(await readFile(new URL('./seed/CONTRACT.md',import.meta.url))),oracleDigest:await oracleDigest(),calibration:{runs:1,candidateProfiles:2,seeds:profile.seeds,polynomials:cases.length,maxCoefficientBits:maxBits,elapsedMs:Date.now()-started,distinctRoots:verified.map(result=>result.distinctRoots),purpose:'Exact oracle calibration only; no agent performance or collaboration claim.'}};
await writeFile(destination,JSON.stringify(frozen,null,2)+'\n',{flag:'wx'});
console.log(`Frozen ${fileURLToPath(destination)} in ${frozen.calibration.elapsedMs}ms`);
