import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { boundedChildRun, command, git } from '../benchmarks/hard-math/process.js';
import { ChildProcessError } from '../src/child-runner.js';
import { mergeWriterReads, mergeWriterStep, mergeWriterIdle } from '../src/daemon/cycle-merge-writer.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { masterConfigSchema } from '../src/master.js';
import { type MergeRecordEvent } from '../src/merge-writer/executor.js';
import type { Work } from '../src/model/work.js';
import type { Cycle } from '../src/daemon/cycle.js';

const adapter=(timeoutMs=10_000)=>boundedChildRun({deadline:Date.now()+timeoutMs,signal:new AbortController().signal,enforce:()=>{},capture:()=>{}});

test('hard math bounded adapter retains native nonzero, signal and timeout errors with captured streams',async()=>{
  const output="process.stdout.write('out');process.stderr.write('err');";
  for(const [tail,options,status,signal,timedOut] of [
    ['process.exitCode=1',{},1,null,false],
    ["process.kill(process.pid,'SIGTERM')",{},null,'SIGTERM',false],
    ['setInterval(()=>{},1000)',{timeoutMs:500},null,'SIGKILL',true],
  ] as const) {
    await assert.rejects(async()=>adapter()(process.execPath,['-e',output+tail],options),error=>{
      assert.ok(error instanceof ChildProcessError);
      assert.equal(error.stdout,'out');assert.equal(error.stderr,'err');assert.equal(error.status,status);
      assert.equal(error.signal,signal);assert.equal(error.timedOut,timedOut);return true;
    });
  }
  const cancelled=new AbortController();
  const running=boundedChildRun({deadline:Date.now()+10_000,signal:cancelled.signal,enforce:()=>{},capture:()=>{}});
  const timer=setTimeout(()=>cancelled.abort(new Error('budget exhausted')),500);
  try {
    await assert.rejects(async()=>running(process.execPath,['-e',output+'setInterval(()=>{},1000)']),error=>{
      assert.ok(error instanceof ChildProcessError);assert.equal(error.status,null);assert.equal(error.signal,'SIGKILL');
      assert.equal(error.stdout,'out');assert.equal(error.stderr,'err');assert.equal(error.timedOut,false);
      assert.match(error.message,/budget exhausted/);return true;
    });
  } finally {clearTimeout(timer);}
  const allowed=await command(process.execPath,['-e',output+'process.exitCode=1'],{allowFailure:true});
  assert.deepEqual(allowed,{stdout:'out',stderr:'err',code:1});
});

test('hard math real Git conflict through the daemon bounded adapter records native refusal and requests rework',async()=>{
  const root=await temporaryDirectory('hard-math-process-conflict'),remote=await temporaryDirectory('hard-math-process-remote');
  await command('git',['init','-q','--bare',remote]);
  await git(root,'init','-q','-b','main');
  await git(root,'config','user.name','Controlled fixture');await git(root,'config','user.email','fixture@example.invalid');
  await writeFile(join(root,'shared.txt'),'initial\n');await git(root,'add','.');await git(root,'commit','-qm','initial');
  const base=await git(root,'rev-parse','HEAD');
  await git(root,'checkout','-qb','component');
  await writeFile(join(root,'shared.txt'),'component edit\n');await git(root,'commit','-qam','component');
  const head=await git(root,'rev-parse','HEAD');
  await git(root,'checkout','-q','main');
  await writeFile(join(root,'shared.txt'),'concurrent main edit\n');await git(root,'commit','-qam','main');
  await git(root,'remote','add','origin',remote);await git(root,'push','-q','origin','main');
  const tip=await git(root,'rev-parse','HEAD'),at=new Date().toISOString();
  const config=masterConfigSchema.parse({version:1,url:'http://unused',credentialFile:'/fixture/coordinator.token',cliPath:'/bin/graphyard',repository:'scratch/hard-math',baseBranch:'main',githubAppId:0,hostId:'fixture',masterAgentName:'fixture-master',workers:[]});
  const item={id:'component',key:'GY-1',title:'Component',type:'chore',description:'',priority:1,dependencies:[],criteria:[{id:'AC-1',text:'Works',proofs:['unit:component']}],policy:{checks:['test'],review:true},policyRevision:1,stage:'build',ready:true,epoch:1,lease:null,workspaces:[],submission:{epoch:1,pr:1},candidate:{sha:head,baseSha:base,pr:1,branch:'component',author:'worker'},reworkRequested:false,scenarioRequirements:[],evidence:[],violations:[],createdAt:at,updatedAt:at,stageEnteredAt:at,
    observation:{source:'control-plane',candidate:{sha:head,baseSha:base},checks:[],reviews:[],merged:false,mergeSha:null,mergeable:true,files:['shared.txt'],at,baseTip:tip},
    gates:['ready','build','review'].map(name=>({name,passed:true,reasons:[]})),
  } as unknown as Work;
  const events:MergeRecordEvent[]=[],reworked:{head:string;reason:string}[]=[];
  let mergeCalls=0;
  const run=adapter();
  const writer=mergeWriterReads(config,root,async(program,args,options)=>{
    if(args.includes('merge-tree')) mergeCalls++;
    return run(program,args,options);
  },{base:root,trial:async()=>{assert.fail('a conflicting merge cannot enter the trial');},record:async(_target,event)=>{
    events.push(event);
  }});
  // Conflict handling must stop before previews, trial execution or remote push.
  writer.itemPreviews=undefined;
  const state=emptyDaemonState(config),effects={mergeWriter:writer,persist:async()=>{},rework:async(target:Work,reason:string)=>{
    reworked.push({head:target.candidate!.sha,reason});target.reworkRequested=true;
  }};
  const step=()=>mergeWriterStep({config,state,effects,now:Date.now,snapshot:{work:[item]},performed:[]} as unknown as Cycle);
  await step();await mergeWriterIdle(state);await step();
  const reason='trial failed: the merge conflicts in shared.txt';
  assert.equal(mergeCalls,1);
  assert.equal(events.length,1);assert.deepEqual(events[0],{kind:'refused',head,reason});
  assert.deepEqual(state.mergeWriter.refusals.map(r=>({head:r.head,reason:r.reason})),[{head,reason}]);
  assert.ok(Object.values(state.actions).some(action=>action.state==='done' && action.detail?.includes('Returned GY-1 to a worker')));
  assert.equal(reworked.length,1);assert.equal(reworked[0].head,head);assert.match(reworked[0].reason,/shared\.txt/);
  await step();await mergeWriterIdle(state);await step();
  assert.equal(mergeCalls,1,'the refused head does not retry until the deadline');
  assert.equal(await git(remote,'rev-parse','refs/heads/main'),tip,'conflict never pushes');
});
