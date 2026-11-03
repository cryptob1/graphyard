import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { generate, profile } from '../benchmarks/hard-math/generator.js';
import { oracle, oracleDigest } from '../benchmarks/hard-math/oracle.js';
import { execute } from '../benchmarks/hard-math/runner.js';
import { fixtureExecutor } from '../benchmarks/hard-math/fixture.js';
import { validateReceipt, comparison } from '../benchmarks/hard-math/receipt-schema.js';
import { routeAccounts } from '../benchmarks/hard-math/routing.js';
import { emptyRegistry, applyRegistryMutation } from '../src/model/registry.js';
import { chooseSession } from '../src/model/registry-sessions.js';

// CI/producer installs these pinned dependencies outside implementation worktrees.
const python=process.env.HARD_MATH_PYTHON??'/home/vish/graphyard-recovery-20261031/hard-math-oracle-venv/bin/python';
test('integration:hard-math-smoke — frozen generator covers all families and independent exact oracle rejects incomplete, overlapping, wide, unreduced, endpoint and multiplicity errors',async()=>{
  const frozen=JSON.parse(await readFile('benchmarks/hard-math/profiles/frozen-v1.json','utf8'));
  assert.equal(await oracleDigest(),frozen.oracleDigest);
  for(const seed of [1,2,3]) {
    const samples=generate(seed);assert.ok(samples.length<=24);assert.deepEqual(new Set(samples.map(s=>s.family)),new Set(profile.families));
    assert.deepEqual(generate(seed),samples);
    for(const s of samples) {assert.ok(s.coefficients.length-1<=32);assert.ok(s.coefficients.every(c=>(BigInt(c)<0n?-BigInt(c):BigInt(c)).toString(2).length<=256));}
    const refs=await oracle(python,samples.map(request=>({request,reference:true})));
    const checks=await oracle(python,samples.map((request,i)=>({request,output:refs[i]})));
    assert.ok(checks.every(c=>c.pass),JSON.stringify(checks));
  }
  const request={coefficients:['1','-2','1'],precisionBits:64};
  const root={lo:{n:'1',d:'1'},hi:{n:'1',d:'1'},multiplicity:2};
  const bad=[{roots:[]},{roots:[{...root,multiplicity:1}]},{roots:[root,root]},{roots:[{...root,lo:{n:'2',d:'2'}}]},{roots:[{...root,hi:{n:'2',d:'1'}}]},{roots:[{...root,lo:{n:'0',d:'1'},hi:{n:'2',d:'1'}}]},{roots:[{...root,lo:{n:'0',d:'1'},hi:{n:'0',d:'1'}}]}];
  assert.ok((await oracle(python,bad.map(output=>({request,output})))).every(c=>c.pass===false));
  assert.equal((await oracle(python,[{request,output:{roots:[root]}}]))[0].pass,true);
});

test('integration:hard-math-smoke — routing retains eligible models, capability/cost order and skips unavailable accounts through the existing registry policy',()=>{
  const at=new Date().toISOString();
  let r=applyRegistryMutation(emptyRegistry(),'apply',{runtimes:[{name:'runtime',launch:{kind:'codex'}}],models:[{name:'cheap',capability:{tier:'strong'},cost:{inputPerMTok:1,outputPerMTok:2}},{name:'costly',capability:{tier:'strong'},cost:{inputPerMTok:4,outputPerMTok:8}}],accounts:[{name:'expensive',model:'costly',runtime:'runtime',credential:{host:'test'}},{name:'affordable',model:'cheap',runtime:'runtime',credential:{host:'test'}}],roles:[{name:'worker',accounts:['expensive','affordable'],concurrency:3}],reason:'Test existing policy'}, {actor:'test',at}).registry;
  r.roles=routeAccounts(r,['cheap','costly']);assert.deepEqual(r.roles[0].accounts,['affordable','expensive']);
  assert.equal(chooseSession(r,{role:'worker',host:'test'},Date.now()).account?.name,'affordable');
  r=applyRegistryMutation(r,'account.quota',{name:'affordable',quota:{loggedIn:true,state:'exhausted',usage:[],resetsAt:new Date(Date.now()+60_000).toISOString(),reason:'deterministic fault'},reason:'Test availability'},{actor:'test',at}).registry;
  const selected=chooseSession(r,{role:'worker',host:'test'},Date.now());
  assert.equal(selected.account?.name,'expensive');assert.ok(selected.skipped.some(s=>s.account==='affordable'));
});

async function runFixture(label:string,options:Parameters<typeof fixtureExecutor>[1]={}) {
  const parent=await temporaryDirectory(`hard-math-${label}`);
  return execute({id:`fixture-${label}`,mode:'team',profileVersion:'v1',seed:1,wallClockSeconds:180,budget:{authorization:'Controlled fixtures, no model calls or spending',maxAgentSeconds:1000,maxTokens:null,maxCost:null,currency:'USD',priceSource:{url:null,date:null,reason:'No real model usage in controlled executor fixtures'}},eligibleModels:['fixture-cheap','fixture-expensive'],sourceRoot:process.cwd(),oraclePython:python,oracleDirectory:join(parent,'oracle'),runDirectory:join(parent,'run'),credentialDirectory:join(parent,'install')},c=>fixtureExecutor(c,options));
}

test('integration:hard-math-smoke — real scratch Postgres/control plane and Git deliver eight reviewed fixture components, reject an integration fault, repair and certify pushed CLI/API/UI', {timeout:180_000},async()=>{
  const receipt=await runFixture('repair',{injectRepair:true});
  assert.equal(receipt.outcome,'PASS',receipt.reason);assert.equal(receipt.kind,'controlled-fixture');
  assert.ok(receipt.overlaps.length);assert.equal(receipt.work.at(-1)?.repairs,1);
  assert.ok(receipt.failures.some(f=>f.component==='integration'));assert.equal(receipt.cost,null);assert.equal(receipt.costBudgetProven,false);
  assert.ok(receipt.sessions.some(s=>s.reason.includes('passed over')));
  for(const edit of [
    (r:any)=>{r.work[0].record.delivery=null;},(r:any)=>{r.artifact.sha='f'.repeat(40);},
    (r:any)=>{r.work[0].record.observation.reviews=[];},(r:any)=>{r.overlaps=[];},(r:any)=>{r.cost=0;},
  ]) {const bad=structuredClone(receipt);edit(bad);assert.throws(()=>validateReceipt(bad));}
  assert.throws(()=>comparison(receipt,{...receipt,mode:'single'}),/actual team/);
});

test('integration:hard-math-smoke — missing pushed delivery and incorrect artifacts cannot produce PASS', {timeout:180_000},async()=>{
  const missing=await runFixture('missing',{missingDelivery:true});assert.equal(missing.outcome,'FAIL');assert.match(missing.reason,/Missing delivery/);
  const incorrect=await runFixture('incorrect',{incorrectArtifact:true});assert.equal(incorrect.outcome,'FAIL');assert.equal(incorrect.artifact,null);
});
