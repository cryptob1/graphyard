import type { AgentRegistry } from '../../src/model/registry.js';
/** Keep configured role eligibility/capacity; use known price only within a capability tier. */
export function routeAccounts(registry:AgentRegistry,eligibleModels:string[]) {
  const tier={frontier:0,strong:1,fast:2};
  const order=(names:string[])=>names.filter(name=>{
    const account=registry.accounts.find(a=>a.name===name);
    return account && eligibleModels.includes(account.model);
  }).sort((a,b)=>{
    const ma=registry.models.find(m=>m.name===registry.accounts.find(x=>x.name===a)!.model)!;
    const mb=registry.models.find(m=>m.name===registry.accounts.find(x=>x.name===b)!.model)!;
    return tier[ma.capability.tier]-tier[mb.capability.tier] ||
      ((ma.cost.inputPerMTok===null || ma.cost.outputPerMTok===null?Infinity:ma.cost.inputPerMTok+ma.cost.outputPerMTok)-(mb.cost.inputPerMTok===null || mb.cost.outputPerMTok===null?Infinity:mb.cost.inputPerMTok+mb.cost.outputPerMTok)) || names.indexOf(a)-names.indexOf(b);
  });
  return registry.roles.map(role=>({...role,accounts:order(role.accounts)}));
}
