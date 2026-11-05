import { baseFailurePrefix } from '../../src/merge-writer/executor.js';
import type { Receipt, RunConfig } from './receipt-schema.js';

// No-verdict trials have no folded trial: read the newest actual merge.trial row.
export function assertTrialHealth(work:any, latestTrial:any) {
  if(work.stage==='done' || work.mergeLedger?.state==='reconciled') return;
  if(work.mergeLedger?.refusal?.reason.startsWith(baseFailurePrefix)) throw new Error(`Unresolved shared base failure: ${work.key}`);
  if(latestTrial && ['host-failure','timeout','cancelled'].includes(latestTrial.outcome)) throw new Error(`Unresolved shared trial ${latestTrial.outcome}: ${work.key}: ${latestTrial.reason}`);
}

export function knownUsage(usage:Receipt['usage']) {
  return usage.reduce((sum,u)=>({cost:sum.cost+(u.cost??0),tokens:sum.tokens+(u.inputTokens??0)+(u.outputTokens??0)}),{cost:0,tokens:0});
}
export function enforceUsage(budget:RunConfig['budget'], seconds:number, usage:Receipt['usage']) {
  const known=knownUsage(usage);
  if(seconds>=budget.maxAgentSeconds || budget.maxCost!==null && known.cost>=budget.maxCost || budget.maxTokens!==null && known.tokens>=budget.maxTokens) throw new Error('Configured aggregate usage limit reached');
}

export function assertUsageMeasurement(config:RunConfig) {
  if((config.budget.maxCost!==null || config.budget.maxTokens!==null) && !config.usageCommand?.length) throw new Error('Configured monetary/token bound requires a usageCommand measurement adapter before launch');
}

// Read-only: no provisioning, accounts, sessions, or directory writes.
export function comparisonPreflight(config:RunConfig) {
  const budget=config.budget;
  assertUsageMeasurement(config);
  if(!budget.authorization.trim() || !Number.isFinite(budget.maxAgentSeconds) || budget.maxAgentSeconds<=0) throw new Error('Comparison requires an authorized aggregate allocation-second bound before either condition starts');
  return {
    conditions:['team','single'],
    perCondition:{authorization:budget.authorization,aggregate:{basis:'allocation-seconds',cap:budget.maxAgentSeconds,includes:'master, implementation, review, proof and repair allocations'},wallClockSeconds:config.wallClockSeconds,maxTokens:budget.maxTokens,maxCost:budget.maxCost,currency:budget.currency},
    financialEstimate:{cost:null,currency:budget.currency,priceSource:budget.priceSource,reason:budget.priceSource.reason||'No measured workload usage forecast is available; a price source alone cannot estimate this rebuild.'},
    monetaryParityProven:false,
  };
}
