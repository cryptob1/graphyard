import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertTrialHealth, comparisonPreflight, enforceUsage, knownUsage } from '../benchmarks/hard-math/enforcement.js';
import { foldMergeLedger } from '../src/model-boundary/merge-ledger.js';
import { baseFailureReason } from '../src/merge-writer/executor.js';
import { configSchema } from '../benchmarks/hard-math/receipt-schema.js';

const head='a'.repeat(40),base='b'.repeat(40),merge='c'.repeat(40),at='2026-01-01T00:00:00Z';
const intent={kind:'merge.intent',work:'GY-1',payload:{key:'GY-1',head,baseTip:base,mergeSha:merge,risk:'normal',at}};
const budget={authorization:'Existing operator authorization: 21600 allocation-seconds per condition',maxAgentSeconds:21600,maxTokens:null,maxCost:null,currency:'USD' as const,priceSource:{url:null,date:null,reason:'Subscription usage and prices unavailable'}};
const config=configSchema.parse({id:'readonly',mode:'team',seed:1,profileVersion:'v1',wallClockSeconds:3600,budget,eligibleModels:['existing'],sourceRoot:'/unused/source',oraclePython:'/unused/python',oracleDirectory:'/unused/oracle',runDirectory:'/unused/run',credentialDirectory:'/unused/credentials'});

test('hard math enforcement reads actual folded base refusal and latest raw no-verdict; later successful records resolve them',()=>{
  const refusal={kind:'merge.refused',work:'GY-1',payload:{head,kind:'merge',reason:baseFailureReason({tip:base,files:['tests/shared.test.ts'],tests:['shared base']})}};
  const rows=[intent,refusal];
  const work=(events:any[])=>({key:'GY-1',stage:'build',mergeLedger:foldMergeLedger(events)['GY-1']});
  assert.throws(()=>assertTrialHealth(work(rows),null),/shared base failure/);
  const noVerdict={kind:'merge.trial',work:'GY-1',payload:{head,baseTip:base,mergeSha:merge,outcome:'host-failure',phase:'install',reason:'host lost',phases:{},attempts:[]}};
  const failed=work([intent,noVerdict]);
  assert.equal(failed.mergeLedger.trial,undefined,'no-verdict cannot be found in folded trial');
  for(const outcome of ['host-failure','timeout','cancelled']) assert.throws(()=>assertTrialHealth(failed,{...noVerdict.payload,outcome}),/Unresolved shared trial/);
  const verdict={kind:'merge.trial',work:'GY-1',payload:{head,mergeSha:merge,outcome:'verdict',build:'pass',proofs:{}}};
  const repaired=work([...rows,intent,verdict]);
  assert.doesNotThrow(()=>assertTrialHealth(repaired,verdict.payload));
  assert.doesNotThrow(()=>assertTrialHealth({...failed,stage:'done'},noVerdict.payload));
  const reconciled=work([...rows,{kind:'merge.reconciled',work:'GY-1',payload:{mergeSha:merge,observedTip:merge}}]);
  assert.doesNotThrow(()=>assertTrialHealth(reconciled,noVerdict.payload),'historical refusal does not block reconciled delivery');
  assert.doesNotThrow(()=>assertTrialHealth(work([intent,{...refusal,payload:{...refusal.payload,reason:'candidate test failure'}}]),null));
});

test('hard math caps enforce known monetary and token lower bounds while missing usage stays unknown',()=>{
  const usage=[{role:'worker',session:'known',cost:12,inputTokens:8,outputTokens:null,reason:'Output unknown'}, {role:'reviewer',session:'unknown',cost:null,inputTokens:null,outputTokens:null,reason:'Unavailable'}];
  assert.deepEqual(knownUsage(usage),{cost:12,tokens:8});
  assert.throws(()=>enforceUsage({...budget,maxCost:10},1,usage),/aggregate usage limit/);
  assert.throws(()=>enforceUsage({...budget,maxTokens:8},1,usage),/aggregate usage limit/);
  assert.doesNotThrow(()=>enforceUsage({...budget,maxCost:13,maxTokens:9},1,usage));
  assert.equal(usage[1].cost,null);assert.equal(usage[0].outputTokens,null);
  assert.throws(()=>enforceUsage(budget,21600,usage),/aggregate usage limit/);
});

test('hard math read-only comparison preflight exposes authorized allocation units and separate unavailable money',()=>{
  const result=comparisonPreflight(config);
  assert.deepEqual(result.conditions,['team','single']);
  assert.equal(result.perCondition.aggregate.basis,'allocation-seconds');
  assert.equal(result.perCondition.aggregate.cap,21600);assert.equal(result.perCondition.wallClockSeconds,3600);
  assert.match(result.perCondition.aggregate.includes,/master.*review.*repair/);
  assert.equal(result.financialEstimate.cost,null);assert.match(result.financialEstimate.reason,/unavailable/i);
  assert.deepEqual(result.financialEstimate.priceSource,budget.priceSource);
  assert.equal(result.monetaryParityProven,false);
  for(const invalid of [undefined,null,0,Infinity]) assert.throws(()=>comparisonPreflight({...config,budget:{...budget,maxAgentSeconds:invalid}} as any),/authorized aggregate/);
  assert.throws(()=>comparisonPreflight({...config,budget:{...budget,authorization:' '}}),/authorized aggregate/);
  for(const cap of [{maxCost:10},{maxTokens:100}]) {
    assert.throws(()=>comparisonPreflight({...config,budget:{...budget,...cap}}),/measurement adapter/);
    assert.doesNotThrow(()=>comparisonPreflight({...config,budget:{...budget,...cap},usageCommand:['existing-adapter']}));
  }
});


test('hard math estimate command is read-only with fresh nonexistent run paths',async()=>{
  const {temporaryDirectory}=await import('./helpers/temp-dirs.js');
  const {join}=await import('node:path');
  const {writeFile,readdir}=await import('node:fs/promises');
  const {command}=await import('../benchmarks/hard-math/process.js');
  const root=await temporaryDirectory('hard-math-estimate');
  const file=join(root,'config.json');
  await writeFile(file,JSON.stringify({...config,sourceRoot:join(root,'source'),runDirectory:join(root,'run'),oracleDirectory:join(root,'oracle'),credentialDirectory:join(root,'credentials')}));
  const result=JSON.parse((await command(process.execPath,['--import','tsx','benchmarks/hard-math/runner.ts','estimate',file])).stdout);
  assert.equal(result.perCondition.aggregate.cap,21600);
  assert.equal(result.financialEstimate.cost,null);
  assert.deepEqual(await readdir(root),['config.json'],'estimate neither provisions paths nor contacts source installation');
});


test('hard math real prerequisites read authoritative work, latest trial records and persisted flight',async()=>{
  const {createServer}=await import('node:http');
  const {join}=await import('node:path');
  const {temporaryDirectory}=await import('./helpers/temp-dirs.js');
  const {realPrerequisites}=await import('../benchmarks/hard-math/runner.js');
  const {masterConfigSchema}=await import('../src/master/profiles.js');
  const {atomicPrivateText,atomicPrivateWrite}=await import('../src/master/config.js');
  const {emptyDaemonState,daemonStatePath}=await import('../src/daemon/state.js');
  const {MERGE_PROTOCOL}=await import('../src/protocol-version.js');
  const root=await temporaryDirectory('hard-math-prerequisites'),id='00000000-0000-4000-8000-000000000001';
  let record:any={id,key:'GY-1',stage:'build'},trial:any={outcome:'host-failure',reason:'trial host unavailable'};
  const paths:string[]=[];
  const http=createServer((req,res)=>{
    const url=new URL(req.url!,'http://localhost');paths.push(req.url!);
    let value:any;
    if(url.pathname==='/api/status') value={build:{protocol:MERGE_PROTOCOL,commit:head}};
    if(url.pathname==='/api/work') value=[...['GY-3044','GY-3045','GY-3046','GY-3047','GY-3050','GY-3048'].map(key=>({key,stage:'done',delivery:{mergeSha:base}})),{id,key:'GY-1',stage:'build'}];
    if(url.pathname===`/api/work/${id}`) value=record;
    if(url.pathname==='/api/events') {assert.equal(url.searchParams.get('kind'),'merge.trial');assert.equal(url.searchParams.get('limit'),'1');assert.equal(url.searchParams.get('order'),'desc');value=[{kind:'merge.trial',payload:trial}];}
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));
  });
  await new Promise<void>(resolve=>http.listen(0,'127.0.0.1',resolve));
  const credentialFile=join(root,'coordinator.token');await atomicPrivateText(credentialFile,'test-only-credential-'.repeat(3));
  const source=masterConfigSchema.parse({version:1,url:`http://127.0.0.1:${(http.address() as any).port}`,credentialFile,cliPath:'/unused',repository:'scratch/prerequisites',baseBranch:'main',githubAppId:0,hostId:'fixture',masterAgentName:'fixture',workers:[]});
  try {
    await assert.rejects(realPrerequisites(source,head),/shared trial host-failure/);
    assert.ok(paths.includes(`/api/work/${id}`));
    trial={outcome:'verdict',build:'pass',proofs:{}};
    await assert.doesNotReject(realPrerequisites(source,head));
    record.mergeLedger=foldMergeLedger([intent,{kind:'merge.refused',work:'GY-1',payload:{head,kind:'merge',reason:baseFailureReason({tip:base,files:['shared.test.ts'],tests:[]})}}])['GY-1'];
    await assert.rejects(realPrerequisites(source,head),/shared base failure/);
    record.mergeLedger=foldMergeLedger([intent])['GY-1'];
    await assert.doesNotReject(realPrerequisites(source,head));
    const state=emptyDaemonState(source);state.mergeWriter.inFlight={key:'GY-1',id,head,startedAt:at};
    await atomicPrivateWrite(daemonStatePath(source),state);
    await assert.rejects(realPrerequisites(source,head),/shared trial flight/);
    state.mergeWriter.inFlight=null;await atomicPrivateWrite(daemonStatePath(source),state);
    await assert.doesNotReject(realPrerequisites(source,head));
  } finally {await new Promise<void>(resolve=>http.close(()=>resolve()));}
});
