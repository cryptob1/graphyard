import { z } from 'zod';
const sha=z.string().regex(/^[0-9a-f]{40}$/), hash=z.string().regex(/^[0-9a-f]{64}$/);
export const budgetSchema=z.object({authorization:z.string().min(1),maxAgentSeconds:z.number().positive(),maxTokens:z.number().positive().nullable(),maxCost:z.number().positive().nullable(),currency:z.literal('USD'),priceSource:z.object({url:z.string().url().nullable(),date:z.string().nullable(),reason:z.string().nullable()})});
export const configSchema=z.object({id:z.string().regex(/^[a-zA-Z0-9._-]+$/),mode:z.enum(['team','single']),seed:z.union([z.literal(1),z.literal(2),z.literal(3)]),profileVersion:z.literal('v1'),wallClockSeconds:z.number().int().positive().max(3600).default(3600),budget:budgetSchema,eligibleModels:z.array(z.string().min(1)).min(1),sourceRoot:z.string().min(1),oraclePython:z.string().min(1),oracleDirectory:z.string().min(1),runDirectory:z.string().min(1),credentialDirectory:z.string().min(1),usageCommand:z.array(z.string()).min(1).optional()});
export type RunConfig=z.infer<typeof configSchema>;
export const usageSchema=z.object({role:z.string(),session:z.string(),inputTokens:z.number().nonnegative().nullable(),outputTokens:z.number().nonnegative().nullable(),cost:z.number().nonnegative().nullable(),reason:z.string().nullable()});
export const receiptSchema=z.object({
  version:z.literal(1),id:z.string(),kind:z.enum(['controlled-fixture','real-agent']),mode:z.enum(['team','single']),configDigest:hash,
  graphyardCommit:sha,profileVersion:z.literal('v1'),profileDigest:hash,generatorDigest:hash,contractDigest:hash,seed:z.number(),startingCommit:sha,oracleDigest:hash,
  startedAt:z.string().datetime(),endedAt:z.string().datetime().nullable(),outcome:z.enum(['RUNNING','PASS','FAIL']),reason:z.string(),
  budget:budgetSchema,eligibleModels:z.array(z.string()),accountLimits:z.array(z.unknown()),sourceCapacity:z.array(z.unknown()),runtimeReceipts:z.array(z.unknown()),cleanup:z.object({complete:z.boolean(),errors:z.array(z.string())}),wallClockLimitSeconds:z.number().positive(),
  work:z.array(z.object({component:z.string(),id:z.string(),key:z.string(),epoch:z.number(),candidate:sha.nullable(),merge:sha.nullable(),attempts:z.number(),reviews:z.number(),repairs:z.number(),record:z.unknown()})),
  sessions:z.array(z.object({id:z.string(),role:z.string(),work:z.string().nullable(),principal:z.string().nullable(),runtime:z.string(),account:z.string(),model:z.string(),reason:z.string(),startedAt:z.string().datetime(),endedAt:z.string().datetime().nullable(),record:z.unknown(),implementation:z.object({id:z.string(),epoch:z.number(),branch:z.string(),path:z.string(),pane:z.string().nullable(),agentName:z.string().nullable(),startedAt:z.string().datetime(),endedAt:z.string().datetime().nullable()}).nullable()})),
  overlaps:z.array(z.object({sessions:z.array(z.string()).length(3),milliseconds:z.number().positive()})),
  failures:z.array(z.object({at:z.string(),component:z.string(),head:z.string().nullable(),reason:z.string()})),
  artifact:z.object({sha,cli:z.boolean(),api:z.boolean(),ui:z.boolean(),cases:z.number().positive(),oracleDigest:hash}).nullable(),
  usage:z.array(usageSchema),usageComplete:z.boolean(),cost:z.number().nonnegative().nullable(),costBudgetProven:z.boolean(),costReason:z.string().nullable(),agentSeconds:z.number().nonnegative(),wallClockMs:z.number().nonnegative(),
  comparativeSelection:z.enum(['exercised','untested']),speedupClaim:z.literal(false),
});
export type Receipt=z.infer<typeof receiptSchema>;
export function overlappingWorkers(sessions:Receipt['sessions']) {
  const workers=sessions.filter(s=>s.role==='worker' && s.implementation?.endedAt),result:Receipt['overlaps']=[];
  for(let i=0;i<workers.length;i++) for(let j=i+1;j<workers.length;j++) for(let k=j+1;k<workers.length;k++) {
    const group=[workers[i],workers[j],workers[k]];
    if(new Set(group.map(s=>s.work)).size!==3 || new Set(group.map(s=>s.principal)).size!==3 || new Set(group.map(s=>s.implementation!.branch)).size!==3 || new Set(group.map(s=>s.implementation!.path)).size!==3) continue;
    const ms=Math.min(...group.map(s=>Date.parse(s.implementation!.endedAt!)))-Math.max(...group.map(s=>Date.parse(s.implementation!.startedAt)));
    if(ms>0) result.push({sessions:group.map(s=>s.id),milliseconds:ms});
  }
  return result;
}
export function validateReceipt(value:unknown):Receipt {
  const r=receiptSchema.parse(value);
  if(JSON.stringify(r.overlaps)!==JSON.stringify(overlappingWorkers(r.sessions))) throw new Error('Overlap receipt differs from implementation handles');
  if(r.outcome==='PASS') {
    if(!r.cleanup.complete || r.cleanup.errors.length || r.sessions.some(s=>!s.endedAt) || r.work.some(w=>(w.record as any)?.lease)) throw new Error('PASS requires all run-owned sessions and leases cleaned up');
    if(r.agentSeconds>r.budget.maxAgentSeconds || r.wallClockMs>r.wallClockLimitSeconds*1000) throw new Error('PASS exceeds finite benchmark limits');
    if(r.mode==='single' && new Set(r.sessions.filter(s=>s.role==='worker').map(s=>s.principal)).size!==1) throw new Error('Single comparison requires one implementation principal');
    if(!r.endedAt || !r.artifact || !r.artifact.cli || !r.artifact.api || !r.artifact.ui || r.artifact.oracleDigest!==r.oracleDigest) throw new Error('PASS requires independently verified CLI/API/UI artifact');
    if(r.work.length!==(r.mode==='team'?8:1)) throw new Error('Missing delivered components');
    for(const w of r.work) {
      const record=w.record as any;
      if(!w.candidate || !w.merge || record?.stage!=='done' || record.delivery?.mergeSha!==w.merge || record.mergeLedger?.state!=='reconciled' || record.candidate?.sha!==w.candidate) throw new Error(`Missing authoritative delivery: ${w.key}`);
      if(!record.pipeline?.attempts?.some((a:any)=>a.epoch===w.epoch) || !record.workspaces?.some((a:any)=>a.epoch===w.epoch)) throw new Error(`Missing claim/worktree: ${w.key}`);
      if(!record.observation?.reviews?.some((a:any)=>a.sha===w.candidate && a.state==='APPROVED')) throw new Error(`Missing independent approval: ${w.key}`);
      if(r.kind==='real-agent' && !r.sessions.some(s=>s.work===w.key && s.implementation?.epoch===w.epoch && (s.implementation.pane || s.implementation.agentName))) throw new Error(`Missing actual implementation handle: ${w.key}`);
      const trial=record.mergeLedger.trial;
      if(trial?.build!=='pass' || !Object.values(trial.proofs??{}).length || Object.values(trial.proofs).some((p:any)=>p.executed<1 || p.failed!==0)) throw new Error(`Missing authoritative proof trial: ${w.key}`);
      if(w.repairs>2) throw new Error('Repair bound exceeded');
    }
    if(r.artifact.sha!==r.work.at(-1)!.merge) throw new Error('Artifact is not the pushed final merge');
    if(r.mode==='team' && !r.overlaps.length) throw new Error('No three distinct overlapping implementation sessions');
  }
  if(!r.usageComplete && (r.cost!==null || r.costBudgetProven)) throw new Error('Unknown usage cannot prove cost compliance');
  if(r.usage.some(u=>(u.inputTokens===null || u.outputTokens===null || u.cost===null) && !u.reason)) throw new Error('Unknown usage needs a reason');
  return r;
}
export function comparison(team:Receipt,single:Receipt) {
  if(team.kind!=='real-agent' || single.kind!=='real-agent' || team.mode!=='team' || single.mode!=='single') throw new Error('Comparison requires actual team and single runs');
  validateReceipt(team);validateReceipt(single);
  for(const field of ['wallClockLimitSeconds','startingCommit','profileDigest','generatorDigest','contractDigest','oracleDigest','seed'] as const) if(team[field]!==single[field]) throw new Error(`Comparison differs: ${field}`);
  if(JSON.stringify(team.budget)!==JSON.stringify(single.budget) || JSON.stringify(team.eligibleModels)!==JSON.stringify(single.eligibleModels)) throw new Error('Comparison bounds/model sets differ');
  return {team:{correct:team.outcome==='PASS',milliseconds:team.wallClockMs,agentSeconds:team.agentSeconds,cost:team.cost},single:{correct:single.outcome==='PASS',milliseconds:single.wallClockMs,agentSeconds:single.agentSeconds,cost:single.cost},monetaryParityProven:team.costBudgetProven&&single.costBudgetProven,costAdvantageProven:team.costBudgetProven&&single.costBudgetProven&&team.cost!<single.cost!,repeatableAdvantageProven:false,reason:'One fixed seed is not evidence of a repeatable advantage; no serial speedup claim.'};
}
