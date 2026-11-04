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
import { overlappingWorkers } from '../benchmarks/hard-math/receipt-schema.js';

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
    if(path==='work') return [{id:'one',key:'GY-1',lease:{owner:'worker',epoch:4},sessions:[{id:'worker:4',kind:'implementation',principal:'worker',epoch:4,runtime:'codex',host:'host',subject:'work',pane:'worker-pane',state:'running'}]}];
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

test('hard math comparison accepts equal existing time caps with unavailable money and rejects unequal bounds',async()=>{
  const {comparison,receiptSchema}=await import('../benchmarks/hard-math/receipt-schema.js');
  const receipt=(mode:'team'|'single')=>receiptSchema.parse({
    version:1,id:`synthetic-${mode}`,kind:'real-agent',mode,configDigest:'a'.repeat(64),graphyardCommit:'a'.repeat(40),graphyardVersion:'unit',
    profileVersion:'v1',profileDigest:'a'.repeat(64),generatorDigest:'a'.repeat(64),contractDigest:'a'.repeat(64),seed:1,startingCommit:'b'.repeat(40),oracleDigest:'a'.repeat(64),
    startedAt:'2026-01-01T00:00:00Z',endedAt:'2026-01-01T00:00:01Z',outcome:'FAIL',reason:'Synthetic validation input; no agents ran',
    budget:{authorization:'Synthetic validation only',maxAgentSeconds:60,maxTokens:null,maxCost:null,currency:'USD',priceSource:{url:null,date:null,reason:'Unavailable subscription allocation'}},
    eligibleModels:['existing'],accountLimits:[],sourceCapacity:[],runtimeReceipts:[],cleanup:{complete:true,errors:[]},wallClockLimitSeconds:60,
    work:[],sessions:[],overlaps:[],failures:[],artifact:null,usage:[],usageComplete:false,cost:null,costBudgetProven:false,costReason:'Unavailable subscription allocation',agentSeconds:0,wallClockMs:1000,comparativeSelection:'untested',speedupClaim:false,
  });
  const team=receipt('team'),single=receipt('single'),result=comparison(team,single);
  assert.equal(result.team.correct,false);assert.equal(result.team.cost,null);
  assert.equal(result.monetaryParityProven,false);assert.equal(result.costAdvantageProven,false);
  assert.throws(()=>comparison(team,{...single,budget:{...single.budget,maxAgentSeconds:61}}),/bounds/);
  assert.throws(()=>comparison(team,{...single,wallClockLimitSeconds:61}),/differs/);
  assert.throws(()=>comparison(team,{...single,seed:2}),/differs/);
});

test('hard math snapshots distinguish unclaimed work from missing claim history and hydrate settled summaries',async()=>{
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
  assert.equal((await trackedDocuments([fresh],[fresh],async()=>{throw new Error('unexpected read');}))[0],fresh);
  await assert.rejects(trackedDocuments([], [fresh],async()=>delivered),/Missing authoritative item/);
  const error=new TypeError('located runner failure');
  assert.match(failureStack(error)!,/TypeError: located runner failure/);
  assert.ok(failureStack(error)!.includes('hard-math-lifecycle.test.ts'));
});
