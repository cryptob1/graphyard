import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, cp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { trialContainerWords } from '../src/merge-writer/trial-container.js';
import { trialEnvironment, trialHomeVariables } from '../src/merge-writer/trial.js';
import { command, git } from '../benchmarks/hard-math/process.js';
import { prepareWorkerLaunch } from '../src/master/dispatch.js';
import { masterConfigSchema } from '../src/master.js';
import { atomicPrivateWrite } from '../src/master/config.js';
import { discover } from '../src/onboarding.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { runFixture } from './helpers/hard-math-fixture.js';
import { generate, profile } from '../benchmarks/hard-math/generator.js';
import { oracle, oracleDigest, oracleSource } from '../benchmarks/hard-math/oracle.js';
import { verifyArtifact } from '../benchmarks/hard-math/artifact.js';
import { benchmarkRoot } from '../benchmarks/hard-math/isolation.js';
import { pinnedPython } from '../benchmarks/hard-math/python.js';
import { writeControlledArtifact } from '../benchmarks/hard-math/fixture.js';
import { routeAccounts } from '../benchmarks/hard-math/routing.js';
import { emptyRegistry } from '../src/model/registry.js';
import { applyRegistryMutation } from '../src/model-boundary/registry.js';
import { chooseSession } from '../src/model/registry-sessions.js';
import { countProofCases } from '../src/merge-writer/executor.js';

// Pinned dependencies outside implementation worktrees: the trial image's, or digest-pinned wheels.
const python=await pinnedPython(await temporaryDirectory('hard-math-python',process.cwd()));
const pythonEnvironment=dirname(dirname(python));
test('integration:hard-math-smoke — seed npm test emits a positive canonical TAP proof count',async()=>{
  const root=await temporaryDirectory('hard-math-seed-tap',process.cwd());
  await cp(join(benchmarkRoot,'seed'),root,{recursive:true});
  const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
  assert.match(pkg.scripts.test,/--test-reporter=tap(?:\s|$)/);
  const result=await command('npm',['test'],{cwd:root,env:trialEnvironment(),includeStdout:true});
  assert.match(result.stdout,/TAP version 13/);
  assert.deepEqual(countProofCases(result.stdout,'unit:workbench-contract'),{executed:1,failed:0,skipped:0});
});
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

test('integration:hard-math-smoke — fresh local remote supports native preparation and real CLI claims/worktrees', {timeout:120_000},async()=>{
  let prepared=0;
  const receipt=await runFixture(python,'native-preparation',{},1000,'team',async c=>{
    const config=masterConfigSchema.parse({version:1,url:c.plane.url,credentialFile:join(c.install,'benchmark-coordinator.token'),cliPath:join(c.config.sourceRoot,'bin/graphyard.mjs'),repository:'scratch/hard-math',baseBranch:'main',githubAppId:0,hostId:'scratch',masterAgentName:'fixture-master',herdrWorkspace:'fixture',
      workers:c.workers.map(w=>({name:w.id,principal:w.id,agentName:w.id,mode:'launch',kind:'pi',credentialFile:join(c.install,`${w.id}.token`)}))});
    await mkdir(join(c.root,'.graphyard'),{recursive:true});
    await atomicPrivateWrite(join(c.root,'.graphyard/master.json'),config);
    assert.equal((await discover(c.root)).repository,'scratch/hard-math');
    await git(c.root,'remote','set-url','origin','git@github.com:scratch/wrong.git');
    await assert.rejects(prepareWorkerLaunch(c.root,c.receipt.work[0].key,c.workers[0].id),/different repositories/);
    await git(c.root,'remote','set-url','origin','git@github.com:scratch/hard-math.git');
    const results=await Promise.all(c.receipt.work.slice(0,3).map(async(work,i)=>{
      const result=await prepareWorkerLaunch(c.root,work.key,c.workers[i].id);
      const record=await c.plane.call(`work/${work.id}`,c.coordinator);
      assert.equal(record.lease.owner,c.workers[i].id);
      assert.equal(record.epoch,result.epoch);
      assert.ok(record.workspaces.some((w:any)=>w.path===result.path && w.branch===result.branch));
      assert.equal(await git(result.path,'rev-parse','HEAD'),c.receipt.startingCommit);
      assert.equal((await discover(result.path)).repository,'scratch/hard-math');
      await git(result.path,'fetch','origin','main');
      prepared++;
      return result;
    }));
    assert.equal(new Set(results.map(r=>r.path)).size,3);
    assert.equal(new Set(results.map(r=>r.branch)).size,3);
    await c.snapshot();
  });
  assert.equal(prepared,3,JSON.stringify(receipt.failures));
  assert.equal(receipt.outcome,'FAIL','preparation alone is not a delivered artifact');
});

test('integration:hard-math-smoke — private-root trials expose the immutable pinned producer Python environment',async()=>{
  const allocation=await temporaryDirectory('hard-math-oracle-container',process.cwd());
  const [program,...wrapper]=trialContainerWords([allocation],[pythonEnvironment]);
  const result=await command(program,[...wrapper,python,'-I','-c',`
import sympy, mpmath
assert sympy.__version__ == '1.14.0'
assert mpmath.__version__ == '1.3.0'
try:
    open(${JSON.stringify(pythonEnvironment+'/producer-write-probe')}, 'w')
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
