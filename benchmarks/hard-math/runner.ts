import { cp, mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { loadStoredMasterConfig, readCredentialFile, atomicPrivateWrite, atomicPrivateText, applyHerdrConfig } from '../../src/master/config.js';
import { masterConfigSchema, type MasterConfig } from '../../src/master/profiles.js';
import { daemonEffects } from '../../src/daemon/effects-production.js';
import { Launcher } from '../../src/daemon/cycle.js';
import { emptyDaemonState, readDaemonState, type DaemonState } from '../../src/daemon/state.js';
import { createdHerdrTab, isHerdrCommand, herdrSubcommand } from '../../src/master/herdr.js';
import { runCertifiedCycle } from './cycle.js';
import { stopRun, stopImplementation, watchBudget } from './lifecycle.js';
import { setTimeout as delay } from 'node:timers/promises';
import { MERGE_PROTOCOL } from '../../src/protocol-version.js';
import { type ChildRun } from '../../src/child-runner.js';
import { boundedChildRun, command, git } from './process.js';
import { oracleDigest, oracleSource, digest, oracle } from './oracle.js';
import { generate } from './generator.js';
import { configSchema, validateReceipt, reviewedDeliveries, overlappingWorkers, comparison, usageSchema, type RunConfig, type Receipt } from './receipt-schema.js';
import { components, workDescription } from './work.js';
import { listRunDirectories, runsDirectory } from '../../src/runner/registry.js';
import { trackedDocuments, lifecycleCounts, failureStack, receiptSession } from './snapshot.js';
import { sourceCapacity } from './capacity.js';
import { routeAccounts } from './routing.js';
import { codeRoot, benchmarkRoot, isolatedRepository, startPlane, credential, operator } from './isolation.js';
import { verifyArtifact } from './artifact.js';

import { assertTrialHealth, enforceUsage, comparisonPreflight, assertUsageMeasurement } from './enforcement.js';

export type Plane=Awaited<ReturnType<typeof startPlane>>;
export interface RunContext {
  config:RunConfig; receipt:Receipt; directory:string; root:string;origin:string;install:string;
  plane:Plane;admin:string;coordinator:string;producer:string;operator:string;workers:{id:string;token:string}[];
  fixtureRuntime?:ChildRun;
  oracleFile:string; signal:AbortSignal; panes:Set<string>; checkpoint():Promise<void>; snapshot():Promise<any[]>; certify(item:any):Promise<boolean>;
}
async function frozenInputs() {
  const frozen=JSON.parse(await readFile(join(benchmarkRoot,'profiles/frozen-v1.json'),'utf8'));
  for(const [field,file] of [['profileDigest','profiles/v1.json'],['generatorDigest','generator.ts'],['contractDigest','seed/CONTRACT.md']] as const) if(digest(await readFile(join(benchmarkRoot,file)))!==frozen[field]) throw new Error(`Frozen ${field} changed; refusing evaluated run`);
  if(await oracleDigest()!==frozen.oracleDigest) throw new Error('Frozen oracle changed');
  return frozen;
}
async function sourceCall(config:MasterConfig,path:string) {
  const token=await readCredentialFile(config.credentialFile);
  const response=await fetch(`${config.url}/api/${path}`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(30_000)});
  if(!response.ok) throw new Error(`Source ${path} HTTP${response.status}`);
  return response.json() as Promise<any>;
}
export async function realPrerequisites(source:MasterConfig,commit:string) {
  const status=await sourceCall(source,'status');
  if(status.build?.protocol!==MERGE_PROTOCOL || status.build?.commit!==commit) throw new Error('Real runs require healthy matching CLI/server commit and protocol');
  const work=await sourceCall(source,'work');
  for(const key of ['GY-3044','GY-3045','GY-3046','GY-3047','GY-3050','GY-3048']) if(!work.some((w:any)=>w.key===key && w.stage==='done' && w.delivery)) throw new Error(`Real run requires delivered ${key}`);
  const state=await readDaemonState(codeRoot,source);
  if(state.mergeWriter.inFlight) throw new Error('Unresolved shared trial flight');
  for(const item of work.filter((w:any)=>w.stage!=='done')) {
    const record=await sourceCall(source,`work/${item.id}`);
    const trials=await sourceCall(source,`events?work=${item.id}&kind=merge.trial&limit=1&order=desc`);
    assertTrialHealth(record,trials[0]?.payload);
  }
}
export async function createItems(context:RunContext) {
  const ids=new Map<string,string>();
  const definitions=context.config.mode==='team'?components:[{id:'single',title:'Build complete certified exact roots workbench',depends:[] as string[],files:['src/','public/','tests/'],brief:components.map(c=>`${c.title}: ${workDescription(c.id)}`).join('\n')}];
  for(const component of definitions) {
    context.signal.throwIfAborted();
    const final=component.id==='integration'||component.id==='single';
    const criterion=component.id==='single'?'Complete all eight component requirements in the full description and CONTRACT.md: exact arithmetic, square-free multiplicities, certified isolation, CLI, HTTP batch API, browser UI and integration tests.':component.brief;
    const item=await context.plane.call('work',context.operator,{
      reason:`Run ${context.config.id}: create ${component.id} for the ${context.config.mode} frozen-v1 certified real-root workbench rebuild, seed ${context.config.seed}.`,
      type:'chore',title:component.title,description:component.id==='single'?`${component.brief}\nOne implementation agent only; do not delegate.`:workDescription(component.id),
      criteria:[{id:'AC-1',text:`${criterion} Files: ${component.files.join(', ')}. Preserve CONTRACT.md.`,proofs:['unit:workbench-contract','e2e:workbench',...(final?['manual:certified-artifact']:[])]}],
      dependencies:component.depends.map(id=>ids.get(id)),producerProofs:final?['manual:certified-artifact']:[],policy:{checks:['test'],review:true},
    });
    ids.set(component.id,item.id);
    context.receipt.work.push({component:component.id,id:item.id,key:item.key,epoch:0,candidate:null,merge:null,attempts:0,reviews:0,repairs:0,record:item});
    await context.plane.call(`work/${item.id}/ready`,context.operator,{expectedRevision:item.revision,reason:`Run ${context.config.id}: release ${component.id} under the frozen-v1 work plan; preserve its dependencies, independent proofs and review gates.`});
  }
}
export async function execute(configInput:unknown,fixture?: (context:RunContext)=>Promise<void>):Promise<Receipt> {
  const config=configSchema.parse(configInput),directory=resolve(config.runDirectory),install=resolve(config.credentialDirectory);
  assertUsageMeasurement(config);
  const frozen=await frozenInputs(),graphyardCommit=await git(codeRoot,'rev-parse','HEAD');
  const graphyardVersion=JSON.parse(await readFile(join(codeRoot,'package.json'),'utf8')).version;
  if(!fixture) {
    const base=join(homedir(),'.config/graphyard');
    if(relative(base,install).startsWith('..') || install===base) throw new Error('Real installation credentials belong under ~/.config/graphyard/<install>/');
    if(!config.budget.authorization) throw new Error('Existing authorized usage cap required');
  }
  // Never overwrite an earlier run or its failed receipt.
  await mkdir(directory,{recursive:false});
  const started=Date.now();
  let context:RunContext|undefined,plane:Plane|undefined,master:MasterConfig|undefined,effects:ReturnType<typeof daemonEffects>|undefined,state:DaemonState|undefined,launcher:Launcher|undefined;
  const receipt:Receipt={version:1,id:config.id,kind:fixture?'controlled-fixture':'real-agent',mode:config.mode,configDigest:digest(JSON.stringify(config)),graphyardCommit,graphyardVersion,profileVersion:'v1',profileDigest:frozen.profileDigest,generatorDigest:frozen.generatorDigest,contractDigest:frozen.contractDigest,seed:config.seed,startingCommit:'0'.repeat(40),oracleDigest:frozen.oracleDigest,startedAt:new Date(started).toISOString(),endedAt:null,outcome:'RUNNING',reason:'Starting isolated repository and control plane',budget:config.budget,eligibleModels:config.eligibleModels,accountLimits:[],sourceCapacity:[],runtimeReceipts:[],cleanup:{complete:false,errors:[]},wallClockLimitSeconds:config.wallClockSeconds,work:[],sessions:[],overlaps:[],failures:[],artifact:null,usage:[],usageComplete:false,cost:null,costReason:'Monetary usage unavailable on these accounts; equal agent-second and wall limits do not establish monetary parity.',costBudgetProven:false,agentSeconds:0,wallClockMs:0,comparativeSelection:'untested',speedupClaim:false};
  const checkpoint=async()=>{receipt.wallClockMs=Date.now()-started;await atomicPrivateWrite(join(directory,'receipt.json'),receipt);};
  await checkpoint();await writeFile(join(directory,'config.json'),JSON.stringify(config,null,2)+'\n',{mode:0o600});
  const abort=new AbortController(),deadline=started+config.wallClockSeconds*1000;
  const limit=(reason:string|Error)=>{if(!abort.signal.aborted) abort.abort(reason instanceof Error?reason:new Error(reason));};
  const interrupted=()=>limit('Benchmark interrupted by process signal');
  process.once('SIGTERM',interrupted);process.once('SIGINT',interrupted);
  const timer=setTimeout(()=>limit('Wall-clock deadline reached'),config.wallClockSeconds*1000);
  const enforce=()=>{
    abort.signal.throwIfAborted();
    if(Date.now()>=deadline) limit('Wall-clock deadline reached');
    const seconds=receipt.sessions.reduce((sum,s)=>sum+(Date.parse(s.endedAt??new Date().toISOString())-Date.parse(s.startedAt))/1000,0);
    receipt.agentSeconds=seconds;
    try {enforceUsage(config.budget,seconds,receipt.usage);} catch(error) {limit(error as Error);}
    abort.signal.throwIfAborted();
  };
  const panes=new Set<string>();
  const capture=(program:string,args:string[],stdout:string)=>{
    const sub=herdrSubcommand(args);
    if(isHerdrCommand(program) && sub[0]==='tab' && sub[1]==='create') {
      try {const parsed=JSON.parse(stdout),created=createdHerdrTab(parsed.result??parsed);panes.add(created.pane);receipt.runtimeReceipts.push({file:'created-pane',record:created});} catch {/* failure before a handle was returned */}
    }
  };
  const boundedRun=boundedChildRun({deadline,signal:abort.signal,enforce,capture});
  let pendingTick:Promise<unknown>|undefined;
  let watchdog:Promise<void>|undefined,stopping=false,emergencyStop:Promise<void>|undefined;
  abort.signal.addEventListener('abort',()=>{
    if(context && !stopping) emergencyStop=stopRun(context,state).catch(error=>{receipt.failures.push({at:new Date().toISOString(),component:'deadline-cleanup',head:null,reason:String(error)});});
  },{once:true});
  let source:MasterConfig|undefined;
  try {
    if(!fixture) {source=await loadStoredMasterConfig(config.sourceRoot);await realPrerequisites(source,graphyardCommit);
      const status=await sourceCall(source,'status'),registry=await sourceCall(source,'agent-registry/document');
      try {receipt.sourceCapacity.push(sourceCapacity(status,registry,config.eligibleModels));} catch(error:any) {if(error.capacity) receipt.sourceCapacity.push(error.capacity);throw error;}
    }
    await mkdir(install,{recursive:false,mode:0o700});await chmod(install,0o700);
    enforce();const repository=await isolatedRepository(directory,abort.signal);receipt.startingCommit=repository.startingCommit;
    const admin=credential('benchmark-admin','admin'),coordinator=credential('benchmark-coordinator','coordinator'),producer=credential('benchmark-oracle','producer',['manual:certified-artifact','unit:workbench-contract']);
    const workers=Array.from({length:config.mode==='team'?3:1},(_,i)=>credential(`benchmark-worker-${i+1}`,'worker'));
    const producers=(source?.producers??[]).map((_,i)=>credential(`benchmark-proof-${i}`,'producer',['unit:*','integration:*']));
    for(const c of [coordinator,producer,...workers,...producers]) await atomicPrivateText(join(install,`${c.id}.token`),c.token);
    // Producer provisions the frozen oracle outside every implementation checkout.
    const oracleDirectory=resolve(config.oracleDirectory);
    if(oracleDirectory.startsWith(repository.root+'/') || oracleDirectory===repository.root) throw new Error('Oracle must be outside implementation repository');
    await mkdir(oracleDirectory,{recursive:false,mode:0o700});
    await cp(oracleSource,join(oracleDirectory,'verify.py'));await chmod(join(oracleDirectory,'verify.py'),0o400);
    await writeFile(join(oracleDirectory,'freeze.json'),JSON.stringify({oracleDigest:receipt.oracleDigest,python:config.oraclePython,sympy:'1.14.0',mpmath:'1.3.0'}),{mode:0o400});
    const baseline=await oracle(config.oraclePython,[{request:generate(config.seed)[2],output:{roots:[]}}],join(oracleDirectory,'verify.py'),abort.signal);
    enforce();
    if(baseline[0]?.pass!==false) throw new Error('Oracle accepted known-bad empty root baseline');
    receipt.failures.push({at:new Date().toISOString(),component:'starter-baseline',head:receipt.startingCommit,reason:baseline[0].reason});
    enforce();plane=await startPlane(install,repository.root,[admin,coordinator,producer,...workers,...producers],graphyardCommit);
    const operatorToken=await operator(plane,admin.token);await atomicPrivateText(join(install,'operator.token'),operatorToken);
    let reading:Promise<any[]>|undefined;
    const readSnapshot=()=>reading??=(async()=>{
      const items=await trackedDocuments(await plane!.call('work',coordinator.token),receipt.work,path=>plane!.call(path,coordinator.token));
      let gateFailure:string|undefined;
      for(const w of receipt.work) {
        const record=items.find((i:any)=>i.id===w.id);if(!record) throw new Error(`Missing authoritative item ${w.key}`);
        Object.assign(w,{epoch:record.epoch,candidate:record.candidate?.sha??null,merge:record.delivery?.mergeSha??null,...lifecycleCounts(record),record});
        if(w.repairs>2 || w.attempts>3) gateFailure=`Repair bound exceeded for ${w.key}`;
        if(record.blocker || record.humanRequest&&!record.humanRequest.answer) gateFailure=`${w.key}: unrecoverable gate failure: ${record.blocker??record.humanRequest?.needed??'Unanswered operator request'}`;
      }
      const registry=await plane!.call('agent-registry/document',coordinator.token);
      const sessions=new Map(receipt.sessions.map(s=>[s.id,s]));
      for(const s of registry.sessions) {
        const item=items.find((w:any)=>w.key===s.work);
        sessions.set(s.id,receiptSession(receipt.kind,s,registry.sessions,item));
      }
      receipt.sessions=[...sessions.values()];
      receipt.agentSeconds=receipt.sessions.reduce((sum,s)=>sum+(Date.parse(s.endedAt??new Date().toISOString())-Date.parse(s.startedAt))/1000,0);
      receipt.overlaps=overlappingWorkers(receipt.sessions);
      receipt.comparativeSelection=new Set(receipt.sessions.filter(s=>s.role==='worker').map(s=>s.model)).size>1 && new Set(receipt.sessions.filter(s=>s.role==='worker').map(s=>s.runtime)).size>1?'exercised':'untested';
      receipt.usage=receipt.sessions.map(s=>({role:s.role,session:s.id,inputTokens:null,outputTokens:null,cost:null,reason:'Runtime usage unavailable; subscription allocation is not measured token cost.'}));
      if(config.usageCommand) {
        const measured=JSON.parse((await command(config.usageCommand[0],config.usageCommand.slice(1),{input:JSON.stringify({sessions:receipt.sessions,runDirectory:directory}),timeoutMs:10_000})).stdout);
        const entries=(measured as unknown[]).map(value=>usageSchema.parse(value));
        receipt.usage=receipt.usage.map(unknown=>entries.find(u=>u.session===unknown.session && u.role===unknown.role)??unknown);
      }
      receipt.usageComplete=receipt.sessions.length>0 && receipt.sessions.every(s=>receipt.usage.some(u=>u.session===s.id && u.role===s.role && u.inputTokens!==null && u.outputTokens!==null && u.cost!==null));
      receipt.cost=receipt.usageComplete?receipt.usage.reduce((sum,u)=>sum+u.cost!,0):null;
      receipt.costReason=receipt.usageComplete?null:'Runtime monetary usage unavailable; monetary parity and cost compliance are unproven.';
      receipt.costBudgetProven=receipt.usageComplete && config.budget.maxCost!==null && receipt.cost!<=config.budget.maxCost;
      await checkpoint();
      if(!stopping) {if(gateFailure) throw new Error(gateFailure);enforce();}
      return items;
    })().finally(()=>{reading=undefined;});
    const snapshot=async(checkSource=false)=>{
      if(source && checkSource && !stopping) {
        const status=await sourceCall(source,'status'),registry=await sourceCall(source,'agent-registry/document');
        try {receipt.sourceCapacity.push(sourceCapacity(status,registry,config.eligibleModels));} catch(error:any) {if(error.capacity) receipt.sourceCapacity.push(error.capacity);throw error;}
      }
      return readSnapshot();
    };
    const certify=async(item:any)=>{
      const head=item.candidate?.sha;if(!head) return false;
      const binding=`${head}-${item.candidate.baseSha}-${item.policyRevision}`;
      const target=join(directory,`certify-${binding}`),scratch=join(directory,`scratch-${binding}`);
      await git(repository.root,'worktree','add','--detach','-q',target,head);
      let passed=false,reason='';
      try {await verifyArtifact({root:target,sha:head,seed:config.seed,python:config.oraclePython,oracleSource:join(oracleDirectory,'verify.py'),oracleDigest:receipt.oracleDigest,scratch,hidden:[install,repository.root,oracleDirectory,join(config.sourceRoot,'.graphyard')],signal:abort.signal});passed=true;}
      catch(error){reason=String(error);receipt.failures.push({at:new Date().toISOString(),component:'integration',head,reason,stack:failureStack(error)});}
      await plane!.call(`work/${item.id}/evidence`,producer.token,{proof:'manual:certified-artifact',sha:head,baseSha:item.candidate.baseSha,policyRevision:item.policyRevision,result:passed?'pass':'fail',executed:generate(config.seed).length,skipped:0,exercise:{behaviour:'Empty-root starter solver, independently rejected before implementation',result:'fail',executed:1}});
      await checkpoint();return passed;
    };
    context={config,receipt,directory,...repository,install,plane,admin:admin.token,coordinator:coordinator.token,producer:producer.token,operator:operatorToken,workers,oracleFile:join(oracleDirectory,'verify.py'),signal:abort.signal,panes,checkpoint,snapshot,certify};
    enforce();await createItems(context);
    watchdog=watchBudget(abort.signal,async()=>{enforce();await snapshot();}).catch(error=>{limit(error instanceof Error?error:new Error(String(error)));});
    if(fixture) await fixture(context);
    else {
      master=await configureMaster(context,source!,producers);
      applyHerdrConfig(master);
      state=emptyDaemonState(master);launcher=new Launcher(3);
      effects=daemonEffects(repository.root,master,{coordinatorRoot:repository.root,snapshot:async()=>({work:await plane!.call('work',coordinator.token),now:new Date().toISOString()}),mutate:(path,data)=>{enforce();return plane!.call(path,coordinator.token,data);},run:boundedRun,fetcher:(input,init)=>fetch(input,{...init,signal:AbortSignal.any([abort.signal,...(init?.signal?[init.signal]:[])])})});
      const dispatchTick=effects.dispatchTick!;
      effects.dispatchTick=snapshot=>{enforce();return pendingTick=dispatchTick(snapshot);};
      const checked=new Map<string,boolean>();
      while(true) {
        const items=await snapshot(true);
        if(reviewedDeliveries(receipt.work)) break;
        enforce();await runCertifiedCycle({config:master,state,effects,items,finalId:receipt.work.at(-1)!.id,checked,certify,launcher,
          repair:async item=>{
            await launcher!.idle();
            const current=await plane!.call(`work/${item.id}`,coordinator.token);
            if(current.stage==='done') throw new Error('Uncertified final candidate was delivered before repair');
            if(current.candidate?.sha!==item.candidate?.sha || current.candidate?.baseSha!==item.candidate?.baseSha || current.policyRevision!==item.policyRevision || current.reworkRequested) return;
            await stopImplementation(context!,current);
            await effects!.rework!(current,`Run ${config.id}: independent exact CLI/API/UI certification rejected candidate ${item.candidate!.sha}; repair the implementation without changing the frozen contract, generator or oracle.`);
          },
        });enforce();
        await delay(1000,undefined,{signal:abort.signal});
      }
      await launcher.idle();
    }
    await snapshot();
    const final=receipt.work.at(-1)!;
    if(!receipt.work.every(w=>w.merge)) throw new Error('Missing delivery from authoritative control plane');
    const tip=await git(repository.origin,'rev-parse','refs/heads/main');
    if(tip!==final.merge) throw new Error('Final artifact is not origin/main delivery');
    const delivered=join(directory,'delivered');
    await git(repository.root,'worktree','add','--detach','-q',delivered,tip);
    receipt.artifact=await verifyArtifact({root:delivered,sha:tip,seed:config.seed,python:config.oraclePython,oracleSource:context.oracleFile,oracleDigest:receipt.oracleDigest,scratch:join(directory,'artifact-scratch'),hidden:[install,repository.root,config.oracleDirectory,join(config.sourceRoot,'.graphyard')],signal:abort.signal});
    enforce();receipt.outcome='PASS';receipt.reason=fixture?'Controlled executor fixture passed isolated delivery and certification; this is not a real-agent rebuild.':'Independently verified CLI/API/UI built from the pushed final merge.';
    receipt.endedAt=new Date().toISOString();
  } catch(error) {
    receipt.outcome='FAIL';receipt.reason=error instanceof Error?error.message:String(error);receipt.failures.push({at:new Date().toISOString(),component:'runner',head:receipt.artifact?.sha??null,reason:receipt.reason,stack:failureStack(error)});
  } finally {
    clearTimeout(timer);process.removeListener('SIGTERM',interrupted);process.removeListener('SIGINT',interrupted);stopping=true;abort.abort();await watchdog;await emergencyStop;
    // Refuse new launches, drain already started launches, then close their actual handles.
    await launcher?.idle();await pendingTick?.catch(error=>{receipt.failures.push({at:new Date().toISOString(),component:'dispatch-shutdown',head:null,reason:String(error)});});
    if(context) {
      try {await stopRun(context,state);receipt.cleanup.complete=true;}
      catch(error) {receipt.cleanup.errors.push(String(error));receipt.outcome='FAIL';receipt.reason=String(error);}
      try {await context.snapshot();}
      catch(error) {receipt.failures.push({at:new Date().toISOString(),component:'final-snapshot',head:null,reason:String(error),stack:failureStack(error)});receipt.outcome='FAIL';receipt.reason=String(error);}
      for(const file of ['reviews.json','producers.json']) {
        try {receipt.runtimeReceipts.push({file,record:JSON.parse(await readFile(join(context.root,'.graphyard',file),'utf8'))});} catch(error:any) {if(error.code!=='ENOENT') receipt.runtimeReceipts.push({file,error:String(error)});}
      }
      if(master) {
        const {readEnvironmentLog}=await import('../../src/master/environments.js');
        receipt.runtimeReceipts.push({file:'environment-log',record:await readEnvironmentLog(master)});
      }
      for(const run of listRunDirectories(runsDirectory(context.root))) receipt.runtimeReceipts.push({file:'headless-run',...run});
      if(state) receipt.runtimeReceipts.push({file:'daemon-state',record:state});
    }
    try {await plane?.stop();} catch(error) {receipt.cleanup.errors.push(String(error));receipt.cleanup.complete=false;receipt.outcome='FAIL';receipt.reason=`Control plane cleanup failed: ${error}`;}
    receipt.endedAt=new Date().toISOString();await checkpoint();
    if(receipt.outcome==='PASS') {
      try {validateReceipt(receipt);} catch(error) {receipt.outcome='FAIL';receipt.reason=String(error);receipt.failures.push({at:new Date().toISOString(),component:'receipt-validation',head:receipt.artifact?.sha??null,reason:receipt.reason,stack:failureStack(error)});await checkpoint();}
    }
  }
  return validateReceipt(receipt);
}
async function configureMaster(c:RunContext,source:MasterConfig,producers:{id:string;token:string}[]) {
  const registry=await sourceCall(source,'agent-registry/document');
  const roles=routeAccounts(registry,c.config.eligibleModels).map(role=>({...role,concurrency:role.name==='worker'?Math.min(role.concurrency,c.config.mode==='team'?3:1):role.concurrency}));
  for(const role of ['worker','reviewer','producer','master']) if(!roles.some(r=>r.name===role && r.concurrency>0 && r.accounts.length)) throw new Error(`No configured eligible ${role} role`);
  c.receipt.accountLimits=registry.accounts.map((a:any)=>({account:a.name,enabled:a.enabled,maxSessions:a.maxSessions,quota:a.quota}));
  await c.plane.call('agent-registry/apply',c.coordinator,{runtimes:registry.runtimes,models:registry.models,accounts:registry.accounts.map(({quota,smoke,unjudged,...a}:any)=>a),roles,reason:'Bounded benchmark: existing eligible accounts, capability then known cost, existing availability/capacity preserved'});
  for(const account of registry.accounts) {
    const {observedAt,observedBy,source,...quota}=account.quota;
    await c.plane.call(`agent-registry/accounts/${encodeURIComponent(account.name)}/quota`,c.coordinator,{quota,reason:'Preserve existing source account availability and exhaustion holds for this bounded run'});
  }
  const prefix=c.config.id.slice(0,20), credentialFile=join(c.install,'benchmark-coordinator.token');
  const master=masterConfigSchema.parse({version:1,url:c.plane.url,credentialFile,cliPath:source.cliPath,repository:'scratch/hard-math',baseBranch:'main',githubAppId:0,hostId:source.hostId,masterAgentName:`hm-${prefix}-master`,herdrInstance:source.herdrInstance,herdrWorkspace:source.herdrWorkspace,
    workers:c.workers.map((w,i)=>({name:`hm-worker-${i}`,principal:w.id,agentName:`hm-${prefix}-w${i}`,mode:'launch',kind:source.workers.find(w=>w.mode==='launch')?.kind,credentialFile:join(c.install,`${w.id}.token`),accounts:source.workers.find(w=>w.mode==='launch')?.accounts,agentArgs:[],approvals:'auto',environment:{}})),
    reviewers:source.reviewers.map((r,i)=>({...r,agentName:`hm-${prefix}-r${i}`})),producers:source.producers.map((p,i)=>({...p,principal:producers[i].id,credentialFile:join(c.install,`${producers[i].id}.token`),agentName:`hm-${prefix}-p${i}`})),
    environments:source.environments,operatorAgent:{id:'benchmark-master',credentialFile:join(c.install,'operator.token')},confinement:{maskPaths:[c.install,c.config.oracleDirectory,dirname(dirname(resolve(c.config.oraclePython))),c.config.sourceRoot,...(source.confinement?.maskPaths??[])]},
    run:{...source.run,intervalSeconds:5,worktreeRoot:join(c.directory,'worktrees'),launchConcurrency:c.config.mode==='team'?3:1,mergeWriter:{deployKeyFile:join(c.install,'unused-local-remote-key'),retrials:0}},
  });
  await mkdir(join(c.root,'.graphyard'),{recursive:true});await mkdir(join(c.directory,'worktrees'),{recursive:true});
  await atomicPrivateWrite(join(c.root,'.graphyard/master.json'),master);
  await writeFile(join(c.root,'BENCHMARK.md'),`Run ${c.config.id}: ${c.config.mode}. Do not alter CONTRACT.md or benchmark criteria.\n${c.config.mode==='single'?'Exactly one implementation session, no delegation.':'Use the eight existing component items; preserve at least three concurrent independent workers. Master coordinates and resolves integration failures, never implements.'}\nStop after two repairs per component. Frozen oracle outside implementation repositories.\n`);
  return master;
}

export async function compareRuns(configInput:unknown) {
  const config=configSchema.parse(configInput);
  const preflight=comparisonPreflight(config);
  const team=await execute({...config,mode:'team',id:`${config.id}-team`,runDirectory:`${config.runDirectory}-team`,credentialDirectory:`${config.credentialDirectory}-team`,oracleDirectory:`${config.oracleDirectory}-team`});
  const single=await execute({...config,mode:'single',id:`${config.id}-single`,runDirectory:`${config.runDirectory}-single`,credentialDirectory:`${config.credentialDirectory}-single`,oracleDirectory:`${config.oracleDirectory}-single`});
  const result={...comparison(team,single),preflight};await writeFile(`${config.runDirectory}-comparison.json`,JSON.stringify(result,null,2)+'\n');return result;
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const [mode,file]=process.argv.slice(2);
  if(!file || !['run','post-deploy','compare','estimate'].includes(mode)) throw new Error('Usage: runner.ts run|post-deploy|compare|estimate CONFIG.json');
  const config=JSON.parse(await readFile(file,'utf8'));
  if(mode==='post-deploy' && config.mode!=='team') throw new Error('First post-deploy run must use team mode');
  const result=mode==='estimate'?comparisonPreflight(configSchema.parse(config)):mode==='compare'?await compareRuns(config):await execute(config);
  console.log(JSON.stringify(result,null,2));
  if('outcome' in result && result.outcome!=='PASS') process.exitCode=1;
}
