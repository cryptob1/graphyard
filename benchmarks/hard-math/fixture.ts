import { setTimeout as delay } from 'node:timers/promises';
import { runWorkerPull } from '../../src/auto-dispatch.js';
import { masterRunSchema } from '../../src/master/profiles.js';
/** Controlled executors test the runner and real Graphyard gates; never model/agent evidence. */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { mergeWriterReads } from '../../src/daemon/cycle-merge-writer.js';
import { mergeOne, runMergeTrial } from '../../src/merge-writer/executor.js';
import { defaultChildRun } from '../../src/child-runner.js';
import { git, command } from './process.js';
import { generate } from './generator.js';
import { oracle } from './oracle.js';
import type { RunContext } from './runner.js';

const app=`document.querySelector('#form').addEventListener('submit',async event=>{event.preventDefault();const error=document.querySelector('#error'),results=document.querySelector('#results');error.textContent='';results.textContent='';try{const request={coefficients:document.querySelector('#coefficients').value.trim().split(/\\s+/),precisionBits:Number(document.querySelector('#precisionBits').value)};const response=await fetch('/roots',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jobs:[request]})});const body=await response.json(),result=body.results?.[0];if(body.error||result.error){error.textContent=(body.error||result.error).code;return;}results.textContent=result.roots.map(root=>root.lo.n+'/'+root.lo.d+' .. '+root.hi.n+'/'+root.hi.d+' multiplicity '+root.multiplicity).join('\\n');}catch(e){error.textContent=String(e);}});\n`;
export async function fixtureExecutor(c:RunContext,options:{missingDelivery?:boolean;incorrectArtifact?:boolean;injectRepair?:boolean;haltAfterClaims?:boolean;waitAfterClaims?:boolean}={}) {
  const trials=join(c.directory,'trials');await mkdir(trials);
  await c.plane.call('agent-registry/apply',c.coordinator,{
    runtimes:[{name:'controlled-fixture',launch:{kind:'codex'}}],
    models:[{name:'fixture-expensive',capability:{tier:'strong'},cost:{inputPerMTok:5,outputPerMTok:10}},{name:'fixture-cheap',capability:{tier:'strong'},cost:{inputPerMTok:1,outputPerMTok:2}}],
    accounts:[{name:'fixture-limited',runtime:'controlled-fixture',model:'fixture-cheap',credential:{host:'scratch',home:null},maxSessions:1},...c.workers.map((_,i)=>({name:`fixture-${i}`,runtime:'controlled-fixture',model:i===0?'fixture-cheap':'fixture-expensive',credential:{host:'scratch',home:null},maxSessions:1}))],
    roles:[{name:'worker',accounts:['fixture-limited',...c.workers.map((_,i)=>`fixture-${i}`)],concurrency:3}],reason:'Controlled deterministic executor fixtures; no real coding agents or paid usage',
  });
  await c.plane.call('agent-registry/accounts/fixture-limited/quota',c.coordinator,{quota:{loggedIn:true,state:'exhausted',usage:[],resetsAt:new Date(Date.now()+3600_000).toISOString(),reason:'Controlled availability routing fault'},reason:'Exercise existing unavailable-account skip'});
  const writer=mergeWriterReads({baseBranch:'main',repository:'scratch/hard-math',run:masterRunSchema.parse({mergeWriter:{deployKeyFile:join(c.install,'unused')}})},c.root,defaultChildRun,{
    base:trials,
    trial:input=>runMergeTrial({...input,checkoutRoots:[trials],temporaryRoots:[trials],retries:0,hidden:[c.install,c.config.oracleDirectory,join(c.config.sourceRoot,'.graphyard')]}),
    record:(item,event)=>c.plane.call(`work/${item.id}/merge-record`,c.coordinator,event),
  });
  type Attempt={work:typeof c.receipt.work[number];item:any;worker:typeof c.workers[number];directory:string;branch:string;selection:any};
  const claim=async(work:typeof c.receipt.work[number],index:number):Promise<Attempt>=>{
    const worker=c.workers[index%c.workers.length];
    const selected=await runWorkerPull(()=>c.plane.call('assignments/claim',worker.token,{work:work.id}),{intervalMs:250,maxPolls:120,signal:c.signal});
    c.signal.throwIfAborted();
    assert.equal(selected.assigned?.id,work.id,JSON.stringify(selected));
    const item=await c.plane.call(`work/${work.id}`,c.coordinator),epoch=item.epoch;
    const previous=item.submission?item.workspaces.find((w:any)=>w.epoch===item.submission.epoch):null;
    const branch=previous?.branch??`graphyard/${item.key.toLowerCase()}-${epoch}`;
    const directory=join(c.directory,`${item.key}-${epoch}`);
    const baseTip=await writer.fetch();
    if(previous) {
      await git(previous.path,'checkout','--detach');
      await git(c.root,'worktree','add','-q',directory,branch);
      await git(directory,'merge','--no-edit',baseTip);
    } else await git(c.root,'worktree','add','-q','-b',branch,directory,baseTip);
    await c.plane.call(`work/${item.id}/workspace`,worker.token,{epoch,branch,host:'scratch',path:directory});
    const selection=await c.plane.call('agent-registry/select',c.coordinator,{role:'worker',host:'scratch',work:item.key,principal:worker.id});
    assert.equal(selection.selected,true,JSON.stringify(selection));
    assert.notEqual(selection.account.name,'fixture-limited');
    await c.plane.call(`work/${item.id}/session`,worker.token,{id:`${worker.id}:${epoch}`,kind:'implementation',principal:worker.id,epoch,runtime:'controlled-fixture',host:'scratch',agentName:`fixture-${index}`,subject:`Controlled executor ${work.component}`,workspace:item.key,state:'running'});
    return {work,item,worker,directory,branch,selection};
  };
  const submit=async(a:Attempt,correct:boolean)=>{
    await mkdir(join(a.directory,'fixture'),{recursive:true});
    await writeFile(join(a.directory,'fixture',`${a.work.component}.txt`),`Controlled executor fixture: ${a.work.component}; correct=${correct}\n`);
    if(a.work.component==='integration'||a.work.component==='single') {
      if(correct) {
        const samples=[1,2,3].flatMap(seed=>generate(seed));
        const refs=await oracle(c.config.oraclePython,samples.map(request=>({request,reference:true})),c.oracleFile);
        const table=Object.fromEntries(samples.map((sample,i)=>[sample.coefficients.map(BigInt).map(String).join(','),refs[i]]));
        // An explicit lookup fixture, never an implementation solver or real-agent result.
        await writeFile(join(a.directory,'src/solver.mjs'),`import {parseRequest} from './contract.mjs';\nconst table=${JSON.stringify(table)};\nexport function solve(value){const {coefficients}=parseRequest(value);if(coefficients.length===1)return {roots:[]};const result=table[coefficients.map(String).join(',')];if(!result)throw {code:'INVALID_REQUEST'};return result;}\n`);
        await writeFile(join(a.directory,'public/app.mjs'),app);
      }
    }
    await git(a.directory,'add','.');await git(a.directory,'commit','-q','-m',`Controlled ${a.work.component} ${correct?'fixture':'negative fixture'}`);
    const head=await git(a.directory,'rev-parse','HEAD');
    const item=await c.plane.call(`work/${a.item.id}/submit`,a.worker.token,{epoch:a.item.epoch,head});
    assert.equal(item.lease,null);
    await c.plane.call(`work/${a.item.id}/session`,c.coordinator,{id:`${a.worker.id}:${a.item.epoch}`,kind:'implementation',principal:a.worker.id,runtime:'controlled-fixture',host:'scratch',subject:'Controlled executor finished',state:'finished',outcome:'submitted'});
    await c.plane.call(`agent-registry/sessions/${a.selection.session.id}/end`,c.coordinator,{reason:'Controlled executor submitted'});
    return item;
  };
  const proofAndReview=async(item:any)=>{
    // Execute the submitted checkout, and a negative contract assertion, before binding its proof.
    const directory=item.workspaces.find((w:any)=>w.epoch===item.submission.epoch).path;
    await command(process.execPath,['--test','tests/contract.test.mjs'],{cwd:directory});
    await command(process.execPath,['--input-type=module','-e',"import {parseRequest} from './src/contract.mjs';import assert from 'node:assert/strict';assert.throws(()=>parseRequest({coefficients:['0'],precisionBits:64}),{code:'ZERO_POLYNOMIAL'});"],{cwd:directory});
    await c.plane.call(`work/${item.id}/evidence`,c.producer,{proof:'unit:workbench-contract',sha:item.candidate.sha,baseSha:item.candidate.baseSha,policyRevision:item.policyRevision,result:'pass',executed:1,skipped:0,exercise:{behaviour:'Contract fixture without zero polynomial rejection',result:'fail',executed:1}});
    const reviewToken=randomBytes(32).toString('hex');
    await c.plane.call(`work/${item.id}/review-launch`,c.coordinator,{reviewer:'controlled-independent-reviewer',head:item.candidate.sha,baseTip:item.observation.mergeBase??item.candidate.baseSha,tokenHash:createHash('sha256').update(reviewToken).digest('hex'),expiresAt:new Date(Date.now()+120_000).toISOString()});
    await c.plane.call(`work/${item.id}/review-verdict`,reviewToken,{event:'APPROVE',body:'Controlled fixture review; not a real coding-agent review.',sha:item.candidate.sha,token:reviewToken});
    const reviewed=await c.plane.call(`work/${item.id}`,c.coordinator);
    assert.ok(reviewed.observation.reviews.some((r:any)=>r.sha===item.candidate.sha && r.state==='APPROVED' && r.reviewer==='controlled-independent-reviewer'),'fixture obtains independent exact-head approval before its canonical merge call');
    return reviewed;
  };
  // Team fixtures hold three independent worktrees together; negative single fixtures hold one.
  const first=await Promise.all(c.receipt.work.slice(0,3).map(claim));
  if(options.haltAfterClaims || options.waitAfterClaims) {
    await c.snapshot();
    if(options.waitAfterClaims) await delay(180_000,undefined,{signal:c.signal});
    return;
  }
  for(let i=0;i<c.receipt.work.length;i++) {
    const work=c.receipt.work[i];let attempt=i<3?first[i]:await claim(work,i);
    let item=await submit(attempt,!(options.incorrectArtifact || options.injectRepair && work.component==='integration'));
    if(work.component==='integration'||work.component==='single') {
      if(options.injectRepair && work.component==='integration') {
        assert.equal(await c.certify(item),false,'known bad starter must fail the external producer');
        item=await c.plane.call(`work/${item.id}`,c.coordinator);
        assert.ok(item.evidence.some((e:any)=>e.proof==='manual:certified-artifact' && e.trusted && e.result==='fail'));
        assert.equal(item.delivery??null,null,'controlled failed certification is retained before rework and any canonical merge call');
        await c.plane.call(`work/${item.id}/rework`,c.operator,{reason:'External exact oracle rejected controlled integration fault',previousWorkerStopped:true});
        attempt=await claim(work,i);item=await submit(attempt,true);
      }
      if(!options.incorrectArtifact) assert.equal(await c.certify(item),true,'correct fixture is independently certified');
      else {assert.equal(await c.certify(item),false);return;}
      if(options.missingDelivery) return;
    }
    item=await proofAndReview(item);
    const merged=await mergeOne(writer,item);
    assert.equal(merged.outcome,'merged',JSON.stringify(merged));
    await c.snapshot();
  }
}
