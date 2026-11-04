import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { stopRun, watchBudget } from '../benchmarks/hard-math/lifecycle.js';
import { command } from '../benchmarks/hard-math/process.js';
import { registerRun, writeRunOwner, runsDirectory, endRun } from '../src/runner/registry.js';
import { sourceCapacity } from '../benchmarks/hard-math/capacity.js';
import { emptyRegistry } from '../src/model/registry.js';
import { overlappingWorkers, comparison, receiptSchema, validateReceipt } from '../benchmarks/hard-math/receipt-schema.js';

test('hard math cleanup stops only run-owned master, item and headless sessions and releases leases',async()=>{
  const root=await temporaryDirectory('hard-math-cleanup'),directory=join(runsDirectory(root),'proof');
  await mkdir(directory,{recursive:true});
  const startedAt=new Date().toISOString();
  const name=`owned-${root}`,other=`other-${root}`,cancelled:string[]=[],panes:string[]=[],writes:any[]=[];
  writeRunOwner(directory,{name,role:'producer',work:'GY-1',subject:'proof',context:{},startedAt});
  const run=(directory:string,id:string)=>({directory,cancel:()=>cancelled.push(id),result:async()=>({})}) as any;
  registerRun({name,role:'producer',work:'GY-1',subject:'proof',run:run(directory,name)});
  registerRun({name:other,role:'producer',work:'GY-2',subject:'proof',run:run('/elsewhere',other)});
  const c={root,coordinator:'coordinator',plane:{call:async(path:string,_token:string,body?:any)=>{
    if(body) {writes.push({path,body});return {};}
    const item={id:'one',key:'GY-1',lease:{owner:'worker',epoch:4},sessions:[{id:'worker:4',kind:'implementation',principal:'worker',epoch:4,runtime:'codex',host:'host',subject:'work',pane:'worker-pane',state:'running'}]};
    if(path==='work') return [{id:'one',key:'GY-1',stage:'done'}];
    if(path==='work/one') return item;
    return {sessions:[{id:'master-slot',endedAt:null},{id:'producer-slot',endedAt:null}]};
  }}} as any;
  try {
    await stopRun(c,{master:{pane:'master-pane'}} as any,async id=>{panes.push(id);});
    assert.deepEqual(cancelled,[name]);assert.deepEqual(panes,['master-pane','worker-pane']);
    assert.ok(writes.some(w=>w.path==='work/one/capacity' && w.body.epoch===4 && w.body.cause==='interrupted'));
    assert.ok(writes.some(w=>w.path==='work/one/session' && w.body.state==='finished'));
    assert.equal(writes.filter(w=>w.path.startsWith('agent-registry/sessions/')).length,2);
    writes.length=0;
    await assert.rejects(stopRun(c,undefined,async()=>{throw new Error('runtime still running');}),/cleanup failed/);
    assert.ok(!writes.some(w=>w.path==='work/one/capacity'),'failed runtime stop cannot release its lease');
  } finally {endRun(name,{} as any);endRun(other,{} as any);}
});

test('hard math watchdog enforces budget while coordination is busy; aborted commands kill descendants',async()=>{
  const abort=new AbortController();let checks=0;
  const watching=watchBudget(abort.signal,async()=>{if(++checks===2) abort.abort(new Error('aggregate usage limit'));});
  const started=Date.now();
  await assert.rejects(command(process.execPath,['-e',"require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});setInterval(()=>{},1000)"],{signal:abort.signal,timeoutMs:5000}),/aggregate usage limit/);
  await watching;assert.equal(checks,2);assert.ok(Date.now()-started<2000);
});

test('hard math source capacity refuses active loop and shared eligible account sessions',()=>{
  const r=emptyRegistry();
  r.accounts=[{name:'existing',model:'model',maxSessions:3,enabled:true} as any];
  assert.equal(sourceCapacity({setup:{loop:false}},r,['model']).accounts[0].maxSessions,3);
  assert.throws(()=>sourceCapacity({setup:{loop:true}},r,['model']),/quiescent/);
  r.sessions=[{id:'source-worker',account:'existing',endedAt:null} as any];
  assert.throws(()=>sourceCapacity({setup:{loop:false}},r,['model']),/live sessions/);
});

test('hard math overlap requires actual handles and three different implementation worktrees',()=>{
  const sessions=[0,1,2].map(i=>({id:String(i),role:'worker',work:`GY-${i}`,principal:`worker-${i}`,startedAt:'2026-01-01T00:00:00Z',endedAt:'2026-01-01T00:00:10Z',implementation:null})) as any;
  assert.deepEqual(overlappingWorkers(sessions),[]);
  for(const [i,s] of sessions.entries()) s.implementation={branch:`branch-${i}`,path:`/tree-${i}`,startedAt:'2026-01-01T00:00:02Z',endedAt:'2026-01-01T00:00:08Z'};
  assert.equal(overlappingWorkers(sessions)[0].milliseconds,6000);
  sessions[2].implementation.path=sessions[1].implementation.path;
  assert.deepEqual(overlappingWorkers(sessions),[]);
});

const syntheticReceipt=(mode:'team'|'single')=>receiptSchema.parse({
    version:1,id:`synthetic-${mode}`,kind:'real-agent',mode,configDigest:'a'.repeat(64),graphyardCommit:'a'.repeat(40),graphyardVersion:'unit',
    profileVersion:'v1',profileDigest:'a'.repeat(64),generatorDigest:'a'.repeat(64),contractDigest:'a'.repeat(64),seed:1,startingCommit:'b'.repeat(40),oracleDigest:'a'.repeat(64),
    startedAt:'2026-01-01T00:00:00Z',endedAt:'2026-01-01T00:00:01Z',outcome:'FAIL',reason:'Synthetic validation input; no agents ran',
    budget:{authorization:'Synthetic validation only',maxAgentSeconds:60,maxTokens:null,maxCost:null,currency:'USD',priceSource:{url:null,date:null,reason:'Unavailable subscription allocation'}},
    eligibleModels:['existing'],accountLimits:[],sourceCapacity:[],runtimeReceipts:[],cleanup:{complete:true,errors:[]},wallClockLimitSeconds:60,
    work:[],sessions:[],overlaps:[],failures:[],artifact:null,usage:[],usageComplete:false,cost:null,costBudgetProven:false,costReason:'Unavailable subscription allocation',agentSeconds:0,wallClockMs:1000,comparativeSelection:'untested',speedupClaim:false,
  });

test('hard math comparison accepts equal existing time caps with unavailable money and rejects unequal bounds',async()=>{
  const team=syntheticReceipt('team'),single=syntheticReceipt('single'),result=comparison(team,single);
  assert.equal(result.team.correct,false);assert.equal(result.team.cost,null);
  assert.equal(result.monetaryParityProven,false);assert.equal(result.costAdvantageProven,false);
  assert.throws(()=>comparison(team,{...single,budget:{...single.budget,maxAgentSeconds:61}}),/bounds/);
  assert.throws(()=>comparison(team,{...single,wallClockLimitSeconds:61}),/differs/);
  assert.throws(()=>comparison(team,{...single,seed:2}),/differs/);
});

test('hard math snapshots read authoritative tracked documents for marked and markerless settled projections',async()=>{
  const {trackedDocuments,lifecycleCounts,failureStack}=await import('../benchmarks/hard-math/snapshot.js');
  const {beginAttempt}=await import('../src/pipeline-speed.js');
  const fresh={id:'item',key:'GY-1',epoch:0,lease:null,lastAssignment:null,candidate:null,submission:null,delivery:null,observation:null} as any;
  assert.deepEqual(lifecycleCounts(fresh),{attempts:0,repairs:0,reviews:0});
  assert.equal(fresh.pipeline,undefined,'receipt reads must not manufacture authoritative history');
  assert.throws(()=>lifecycleCounts({...fresh,epoch:1}),/Missing authoritative claim timeline/);
  const delivered=structuredClone(fresh);delivered.epoch=1;
  beginAttempt(delivered,{epoch:1,owner:'worker'},new Date('2026-01-01T00:00:00Z'));
  delivered.delivery={mergeSha:'a'.repeat(40)};
  const reads:string[]=[],listed=[{id:'item',key:'GY-1',summary:true,epoch:1,pipeline:{submittedAt:null}}] as any;
  const hydrated=await trackedDocuments(listed,[fresh],async path=>{reads.push(path);return delivered;});
  assert.deepEqual(reads,['work/item']);assert.equal(hydrated[0],delivered);
  assert.deepEqual(lifecycleCounts(hydrated[0]),{attempts:1,repairs:0,reviews:0});
  assert.throws(()=>lifecycleCounts({...delivered,pipeline:{...delivered.pipeline,attempts:[]}}),/Incomplete authoritative claim timeline/);
  const markerless=[{id:'item',key:'GY-1',stage:'done',epoch:1,delivery:delivered.delivery}] as any;
  reads.length=0;
  const settled=await trackedDocuments(markerless,[fresh],async path=>{reads.push(path);return delivered;});
  assert.deepEqual(reads,['work/item']);assert.equal(settled[0],delivered);
  assert.deepEqual(lifecycleCounts(settled[0]),{attempts:1,repairs:0,reviews:0});
  assert.equal(markerless[0].pipeline,undefined,'the fleet projection is not patched with synthesized history');
  assert.equal((await trackedDocuments([fresh],[fresh],async path=>{assert.equal(path,'work/item');return fresh;}))[0],fresh);
  await assert.rejects(trackedDocuments([], [fresh],async()=>delivered),/Missing authoritative item/);
  const error=new TypeError('located runner failure');
  assert.match(failureStack(error)!,/TypeError: located runner failure/);
  assert.ok(failureStack(error)!.includes('hard-math-lifecycle.test.ts'));
});

test('hard math real API creates/releases the frozen plan with revisions, binds worker sessions and cleans active epochs',async()=>{
  const [{default:EmbeddedPostgres},{Store},{Engine},{server},{freePort},{createItems},{operator,credential},policy]=await Promise.all([
    import('embedded-postgres'),import('../src/store.js'),import('../src/engine.js'),import('../src/server.js'),import('../src/cli/test-isolation.js'),
    import('../benchmarks/hard-math/runner.js'),import('../benchmarks/hard-math/isolation.js'),import('../src/model/repository-policy.js'),
  ]);
  const {randomUUID}=await import('node:crypto');
  const root=await temporaryDirectory('hard-math-api'),port=await freePort(),databaseDir=await temporaryDirectory('postgres',root);
  const database=new EmbeddedPostgres({databaseDir,user:'graphyard',password:'testing-only',port,persistent:false,onLog:()=>{},onError:()=>{},postgresFlags:['-h','127.0.0.1']});
  const previousPolicy=policy.repositoryPolicy();
  policy.setRepositoryPolicy({...previousPolicy,e2e:{pendingOutcomes:'non-blocking',serve:{command:'true',url:'http://127.0.0.1:9',readySeconds:1}}});
  let store:InstanceType<typeof Store>|undefined,http:ReturnType<typeof server>|undefined;
  try {
    await database.initialise();await database.start();
    store=new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/postgres`);await store.init();
    const admin=credential('api-admin','admin'),coordinator=credential('api-coordinator','coordinator'),producer=credential('api-proof','producer',['unit:workbench-contract','manual:certified-artifact']);
    const workers=[0,1,2].map(i=>credential(`api-worker-${i}`,'worker'));
    http=server(new Engine(store,120,'scratch/hard-math'),[admin,coordinator,producer,...workers]);
    await new Promise<void>(resolve=>http!.listen(0,'127.0.0.1',resolve));
    const url=`http://127.0.0.1:${(http.address() as {port:number}).port}`;
    const call=async(path:string,token:string,body?:unknown)=>{
      const response=await fetch(`${url}/api/${path}`,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:body===undefined?undefined:JSON.stringify(body)});
      const result=await response.json();if(!response.ok) throw new Error(`${response.status}: ${JSON.stringify(result)}`);return result as any;
    };
    const plane={call},master=await operator(plane as any,admin.token);
    const c={root,plane,coordinator:coordinator.token,operator:master,signal:new AbortController().signal,config:{id:'api-contract',mode:'team',seed:1},receipt:{work:[]}} as any;
    await createItems(c);assert.equal(c.receipt.work.length,8);
    const claimed=[];
    for(let i=0;i<3;i++) {
      const item=(await call('assignments/claim',workers[i].token,{work:c.receipt.work[i].id})).assigned;
      assert.ok(item?.lease);assert.equal(item.lease.owner,workers[i].id);
      const handle={id:`${workers[i].id}:${item.epoch}`,kind:'implementation',principal:workers[i].id,epoch:item.epoch,runtime:'controlled-fixture',host:'scratch',subject:'Real API controlled lifecycle',state:'running'};
      await assert.rejects(call(`work/${item.id}/session`,coordinator.token,handle),/Lease missing/);
      await assert.rejects(call(`work/${item.id}/session`,workers[i].token,{...handle,startedAt:new Date().toISOString()}),/400|startedAt|Unrecognized/);
      await call(`work/${item.id}/session`,workers[i].token,handle);claimed.push(item);
    }
    await assert.rejects(call(`work/${claimed[0].id}/ready`,master,{reason:'Stale intent must be refused',expectedRevision:claimed[0].revision}),/revision changed/);
    await stopRun(c,undefined,async()=>{});
    for(const claimedItem of claimed) {
      const item=await call(`work/${claimedItem.id}`,coordinator.token);
      assert.equal(item.lease,null);assert.ok(item.sessions.every((s:any)=>s.state==='finished'));
      assert.equal(item.pipeline.attempts[0].epoch,claimedItem.epoch);
    }
  } finally {
    await new Promise<void>(resolve=>http?http.close(()=>resolve()):resolve());
    await store?.close();await database.stop();policy.setRepositoryPolicy(previousPolicy);
  }
});


test('hard math receipt independently requires approval, certification and positive trial proof counts',()=>{
  const receipt=syntheticReceipt('single'),head='c'.repeat(40),merge='d'.repeat(40),base='b'.repeat(40);
  receipt.kind='controlled-fixture';receipt.outcome='PASS';
  receipt.sessions=[{id:'synthetic-session',role:'worker',work:'GY-1',principal:'worker',runtime:'synthetic',account:'synthetic',model:'synthetic',reason:'Synthetic receipt validation only',startedAt:receipt.startedAt,endedAt:receipt.endedAt,record:{},implementation:null}];
  const record={criteria:[{proofs:['unit:workbench-contract','e2e:workbench']}],key:'GY-1',stage:'done',lease:null,policyRevision:1,candidate:{sha:head,baseSha:base},delivery:{mergeSha:merge},pipeline:{attempts:[{epoch:1}]},workspaces:[{epoch:1,owner:'worker'}],
    observation:{reviews:[{sha:head,state:'APPROVED',reviewer:'independent'}]},mergeLedger:{state:'reconciled',trial:{build:'pass',proofs:{'unit:workbench-contract':{executed:1,failed:0},'e2e:workbench':{executed:2,failed:0}}}},
    evidence:[{proof:'manual:certified-artifact',sha:head,baseSha:base,policyRevision:1,producer:'independent-producer',trusted:true,result:'pass',executed:8,skipped:0}]};
  receipt.work=[{component:'single',id:'synthetic-item',key:'GY-1',epoch:1,candidate:head,merge,attempts:1,reviews:1,repairs:0,record}];
  receipt.artifact={sha:merge,cli:true,api:true,ui:true,cases:8,oracleDigest:receipt.oracleDigest};
  assert.doesNotThrow(()=>validateReceipt(receipt));
  const missingReview=structuredClone(receipt);(missingReview.work[0].record as any).observation.reviews=[];
  assert.throws(()=>validateReceipt(missingReview),/Missing independent approval/);
  const otherHeadReview=structuredClone(receipt);(otherHeadReview.work[0].record as any).observation.reviews[0].sha=base;
  assert.throws(()=>validateReceipt(otherHeadReview),/Missing independent approval/);
  for(const edit of [(r:any)=>{r.evidence=[];},(r:any)=>{r.evidence[0].result='fail';},(r:any)=>{r.evidence[0].sha=base;},(r:any)=>{r.evidence[0].producer='worker';}]) {
    const bad=structuredClone(receipt);edit(bad.work[0].record);
    assert.throws(()=>validateReceipt(bad),/Missing independent final candidate certification/);
  }
  const uncounted=structuredClone(receipt);(uncounted.work[0].record as any).mergeLedger.trial.proofs['unit:workbench-contract'].executed=0;
  assert.throws(()=>validateReceipt(uncounted),/Missing authoritative proof trial/);
  const missingE2e=structuredClone(receipt);delete (missingE2e.work[0].record as any).mergeLedger.trial.proofs['e2e:workbench'];
  assert.throws(()=>validateReceipt(missingE2e),/Missing authoritative proof trial/);
});
