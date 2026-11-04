import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { closeHerdrPane, herdrJson } from '../../src/master.js';
import { liveRun, listRunDirectories, runsDirectory } from '../../src/runner/registry.js';
import type { RunContext } from './runner.js';
import { childRunner } from '../../src/child-runner.js';
import type { DaemonState } from '../../src/daemon/state.js';

async function closePresentPane(pane:string) {
  const run=childRunner({timeoutMs:5_000});
  const inventory=await herdrJson(['pane','list'],run);
  if(!Array.isArray(inventory.panes)) throw new Error('Herdr pane inventory unavailable during benchmark cleanup');
  if(inventory.panes.some((p:any)=>p.pane_id===pane)) await closeHerdrPane(pane,run);
}

/** Only handles belonging to this isolated installation are eligible for shutdown. */
export async function stopRun(c:RunContext,state?:DaemonState,close: (pane:string)=>Promise<unknown>=closePresentPane) {
  const reason='Bounded benchmark ended; stop run-owned sessions and release leases';
  const errors:string[]=[],closed=new Set<string>();
  const attempt=async(label:string,body:()=>Promise<unknown>)=>{try {await body();} catch(error) {errors.push(`${label}: ${error}`);}};
  const pane=async(id:string)=>{if(!closed.has(id)) {await close(id);closed.add(id);}};
  // The headless registry is process-wide; restrict by the run's on-disk owner directory.
  for(const {owner} of listRunDirectories(runsDirectory(c.root))) {
    const entry=liveRun(owner.name);
    if(entry?.run.directory?.startsWith(runsDirectory(c.root)+'/')) {
      entry.run.cancel(reason);
      await attempt(`headless ${owner.name}`,()=>entry.run.result());
    }
  }
  for(const id of c.panes??[]) await attempt(`created pane ${id}`,()=>pane(id));
  if(state?.master.pane) await attempt('master',()=>pane(state.master.pane!));
  for(const file of ['reviews.json','producers.json']) {
    const ledger=await readFile(join(c.root,'.graphyard',file),'utf8').then(JSON.parse,error=>{if(error.code==='ENOENT') return {};throw error;});
    for(const records of Object.values(ledger)) if(Array.isArray(records)) for(const record of records) if(record.pane) await attempt(`ledger pane ${record.pane}`,()=>pane(record.pane));
  }
  const items=await c.plane.call('work',c.coordinator);
  for(const item of items) {
    let workerStopped=true;
    for(const s of item.sessions??[]) {
      // Finished handles can still have a live pane after submission or proof delivery.
      let stopped=true;
      if(s.pane) await attempt(`pane ${s.pane}`,async()=>{try {await pane(s.pane);} catch(error) {stopped=false;if(s.kind==='implementation') workerStopped=false;throw error;}});
      if(s.state==='running' && stopped) await attempt(`handle ${s.id}`,()=>c.plane.call(`work/${item.id}/session`,c.coordinator,{
        id:s.id,kind:s.kind,principal:s.principal,...(s.epoch?{epoch:s.epoch}:{}),runtime:s.runtime,host:s.host,subject:s.subject,state:'finished',outcome:reason,...(s.launch?{launch:s.launch}:{}),
      }));
    }
    if(item.lease && workerStopped) await attempt(`lease ${item.key}`,()=>c.plane.call(`work/${item.id}/capacity`,c.coordinator,{
      event:'exhausted',role:'worker',epoch:item.lease.epoch,cause:'interrupted',profile:item.lease.owner,account:null,runtime:null,reason,resetsAt:null,
      partialWork:{state:'not-applicable',detail:'Benchmark retains the entire run directory and all implementation worktrees'},
    }));
  }
  const registry=await c.plane.call('agent-registry/document',c.coordinator);
  for(const s of registry.sessions) if(!s.endedAt && !errors.length) await attempt(`registry ${s.id}`,()=>c.plane.call(`agent-registry/sessions/${s.id}/end`,c.coordinator,{reason}));
  if(errors.length) throw new Error(`Run cleanup failed: ${errors.join('; ')}`);
}

/** A watchdog runs independently of certification and coordination cycle latency. */
export async function watchBudget(signal:AbortSignal,check:()=>Promise<void>) {
  while(!signal.aborted) {
    await check();
    await delay(250,undefined,{signal}).catch(error=>{if(!signal.aborted) throw error;});
  }
}
