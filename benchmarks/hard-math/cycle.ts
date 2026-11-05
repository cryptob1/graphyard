import type { Work } from '../../src/model.js';
import type { MasterConfig } from '../../src/master.js';
import type { DaemonEffects } from '../../src/daemon/effects.js';
import type { DaemonState } from '../../src/daemon/state.js';
import { runCycle, type Launcher } from '../../src/daemon/cycle.js';

/** The merge selector must consume the same authoritative snapshot the oracle examined. */
export async function runCertifiedCycle(input:{config:MasterConfig;state:DaemonState;effects:DaemonEffects;items:Work[];finalId:string;checked:Map<string,boolean>;certify:(item:Work)=>Promise<boolean>;repair:(item:Work)=>Promise<void>;launcher?:Launcher;now?:()=>number}) {
  const final=input.items.find(item=>item.id===input.finalId);
  if(!final) throw new Error('Final benchmark item is missing from the cycle snapshot');
  if(final.candidate && !final.reworkRequested && final.stage!=='done') {
    const binding=`${final.candidate.sha}:${final.candidate.baseSha}:${final.policyRevision}`;
    if(!input.checked.has(binding)) input.checked.set(binding,await input.certify(final));
    if(!input.checked.get(binding)) {await input.repair(final);return;}
  }
  const now=input.now??Date.now;
  await runCycle(input.config,input.state,{...input.effects,snapshot:async()=>({work:input.items,now:new Date(now()).toISOString()})},now,input.launcher);
}
