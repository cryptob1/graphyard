import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { trialContainerWords } from '../src/merge-writer/trial-container.js';
import { trialEnvironment, trialHomeVariables } from '../src/merge-writer/trial.js';
import { command } from '../benchmarks/hard-math/process.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { generate, profile } from '../benchmarks/hard-math/generator.js';
import { oracle, oracleDigest, oracleSource } from '../benchmarks/hard-math/oracle.js';
import { execute } from '../benchmarks/hard-math/runner.js';
import { verifyArtifact } from '../benchmarks/hard-math/artifact.js';
import { benchmarkRoot } from '../benchmarks/hard-math/isolation.js';
import { fixtureExecutor, writeControlledArtifact } from '../benchmarks/hard-math/fixture.js';
import { validateReceipt, comparison } from '../benchmarks/hard-math/receipt-schema.js';
import { routeAccounts } from '../benchmarks/hard-math/routing.js';
import { emptyRegistry, applyRegistryMutation } from '../src/model/registry.js';
import { chooseSession } from '../src/model/registry-sessions.js';

// CI/producer installs these pinned dependencies outside implementation worktrees.
const python=process.env.HARD_MATH_PYTHON??'/opt/graphyard-hard-math-oracle/bin/python';
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

async function runFixture(label:string,options:Parameters<typeof fixtureExecutor>[1]={},maxAgentSeconds=1000,mode:'team'|'single'='team') {
  const testRoot=join(process.cwd(),'.graphyard','hard-math-fixtures');
  await mkdir(testRoot,{recursive:true});
  const parent=await temporaryDirectory(`hard-math-${label}`,testRoot);
  // Measured canonical trials take ~22s each: eight merges alone need ~175s.
  // Only controlled scheduling changes; frozen math and actual-agent limits are unchanged.
  const wallClockSeconds=options.injectRepair?300:90;
  return execute({id:`fixture-${label}`,mode,profileVersion:'v1',seed:1,wallClockSeconds,budget:{authorization:'Controlled fixtures, no model calls or spending',maxAgentSeconds,maxTokens:null,maxCost:null,currency:'USD',priceSource:{url:null,date:null,reason:'No real model usage in controlled executor fixtures'}},eligibleModels:['fixture-cheap','fixture-expensive'],sourceRoot:process.cwd(),oraclePython:python,oracleDirectory:join(parent,'oracle'),runDirectory:join(parent,'run'),credentialDirectory:join(parent,'install')},c=>fixtureExecutor(c,options));
}

test('integration:hard-math-smoke — real scratch Postgres/control plane and Git deliver eight reviewed fixture components, reject an integration fault, repair and certify pushed CLI/API/UI', {timeout:330_000},async()=>{
  const receipt=await runFixture('repair',{injectRepair:true});
  assert.equal(receipt.outcome,'PASS',`${receipt.reason}\n${JSON.stringify(receipt.failures,null,2)}`);assert.equal(receipt.kind,'controlled-fixture');
  assert.ok(receipt.overlaps.length);assert.equal(receipt.work.at(-1)?.repairs,1);
  assert.ok(receipt.failures.some(f=>f.component==='integration'));assert.equal(receipt.cost,null);assert.equal(receipt.costBudgetProven,false);
  assert.ok(receipt.sessions.some(s=>s.reason.includes('passed over')));
  for(const edit of [
    (r:any)=>{r.work[0].record.delivery=null;},
    (r:any)=>{delete r.work[0].record.pipeline;},(r:any)=>{r.work[0].record.workspaces=[];},(r:any)=>{r.artifact.sha='f'.repeat(40);},
    (r:any)=>{r.overlaps=[];},(r:any)=>{r.cost=0;},
  ]) {const bad=structuredClone(receipt);edit(bad);assert.throws(()=>validateReceipt(bad));}
  const unreviewed=structuredClone(receipt);(unreviewed.work[0].record as any).observation.reviews=[];
  assert.throws(()=>validateReceipt(unreviewed),/Missing independent approval/,'benchmark receipt rejects a missing review regardless of the production queue policy');
  const uncertified=structuredClone(receipt);(uncertified.work.at(-1)!.record as any).evidence=[];
  assert.throws(()=>validateReceipt(uncertified),/Missing independent final candidate certification/);
  assert.throws(()=>comparison(receipt,{...receipt,mode:'single'}),/actual team/);
});

test('integration:hard-math-smoke — missing pushed delivery and incorrect artifacts cannot produce PASS', {timeout:210_000},async()=>{
  const missing=await runFixture('missing',{missingDelivery:true},1000,'single');assert.equal(missing.outcome,'FAIL');assert.match(missing.reason,/Missing delivery/);
  const incorrect=await runFixture('incorrect',{incorrectArtifact:true},1000,'single');assert.equal(incorrect.outcome,'FAIL');assert.equal(incorrect.artifact,null);
  assert.ok(incorrect.failures.some(f=>f.component==='integration' && /CLI exact oracle rejected/.test(f.reason)),incorrect.reason);
  assert.ok((incorrect.work[0].record as any).evidence.some((e:any)=>e.proof==='manual:certified-artifact' && e.trusted && e.result==='fail'));
});


test('integration:hard-math-smoke — failed and usage-limited runs release actual scratch leases and sessions', {timeout:210_000},async()=>{
  for(const [label,options,budget] of [
    ['early-stop',{haltAfterClaims:true},1000],['usage-stop',{waitAfterClaims:true},3],
  ] as const) {
    const receipt=await runFixture(label,options,budget);
    assert.equal(receipt.outcome,'FAIL');assert.equal(receipt.cleanup.complete,true,receipt.reason);
    assert.ok(receipt.work.every(w=>!(w.record as any).lease));
    assert.ok(receipt.sessions.length>=3);assert.ok(receipt.sessions.every(s=>s.endedAt));
    if(label==='usage-stop') assert.match(receipt.reason,/usage limit|abort/i);
  }
});


test('integration:hard-math-smoke — private-root trials expose the immutable pinned producer Python environment',async()=>{
  const allocation=await temporaryDirectory('hard-math-oracle-container',process.cwd());
  const [program,...wrapper]=trialContainerWords([allocation]);
  const result=await command(program,[...wrapper,'/opt/graphyard-hard-math-oracle/bin/python','-I','-c',`
import sympy, mpmath
assert sympy.__version__ == '1.14.0'
assert mpmath.__version__ == '1.3.0'
try:
    open('/opt/graphyard-hard-math-oracle/producer-write-probe', 'w')
    raise AssertionError('producer oracle environment is writable')
except (PermissionError, OSError):
    pass
print('pinned immutable oracle')
`],{cwd:allocation,env:{...trialEnvironment(),...trialHomeVariables(allocation),PATH:'/usr/local/bin:/usr/bin:/bin'}});
  assert.match(result.stdout,/pinned immutable oracle/);
});


test('integration:hard-math-smoke — controlled lookup artifact independently passes CLI/API/UI certification', {timeout:60_000},async()=>{
  const parent=await temporaryDirectory('hard-math-artifact',process.cwd()),root=join(parent,'repository'),scratch=join(parent,'scratch');
  await cp(join(benchmarkRoot,'seed'),root,{recursive:true});
  await writeControlledArtifact(root,python,oracleSource);
  const result=await verifyArtifact({root,sha:'a'.repeat(40),seed:1,python,oracleSource,oracleDigest:await oracleDigest(),scratch,hidden:[join(process.cwd(),'.graphyard')]});
  assert.equal(result.cli,true);assert.equal(result.api,true);assert.equal(result.ui,true);assert.equal(result.cases,generate(1).length);
});

test('integration:hard-math-smoke — controlled lookup normalizes CLI keys and emitted browser whitespace through the contract',async()=>{
  const parent=await temporaryDirectory('hard-math-adapters',process.cwd()),root=join(parent,'repository');
  await cp(join(benchmarkRoot,'seed'),root,{recursive:true});
  await writeControlledArtifact(root,python,oracleSource);
  const samples=[1,2,3].flatMap(seed=>generate(seed));
  const output=await command(process.execPath,['src/cli.mjs'],{cwd:root,input:samples.map(request=>JSON.stringify(request)).join('\n')+'\n',includeStdout:true});
  const answers=output.stdout.trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(answers.length,samples.length);
  const checks=await oracle(python,samples.map((request,i)=>({request,output:answers[i]})));
  assert.ok(checks.every(c=>c.pass),JSON.stringify(checks));
  const {runInNewContext}=await import('node:vm');
  let submit:((event:{preventDefault():void})=>Promise<void>)|undefined;
  const nodes:any={
    '#form':{addEventListener:(event:string,handler:typeof submit)=>{assert.equal(event,'submit');submit=handler;}},
    '#coefficients':{value:' 1\t0\n-2 '},'#precisionBits':{value:'64'},'#error':{textContent:''},'#results':{textContent:''},
  };
  const jobs:any[]=[];
  runInNewContext(await readFile(join(root,'public/app.mjs'),'utf8'),{
    document:{querySelector:(selector:string)=>nodes[selector]},
    fetch:async(_url:string,options:any)=>{jobs.push(JSON.parse(options.body));return {json:async()=>({results:[{roots:[{lo:{n:'1',d:'1'},hi:{n:'1',d:'1'},multiplicity:1},{lo:{n:'2',d:'1'},hi:{n:'2',d:'1'},multiplicity:2}]}]})};},
  });
  assert.ok(submit);await submit({preventDefault(){}});
  assert.deepEqual(jobs,[{jobs:[{coefficients:['1','0','-2'],precisionBits:64}]}]);
  assert.equal(nodes['#error'].textContent,'');assert.equal(nodes['#results'].textContent.split('\n').length,2);
});
