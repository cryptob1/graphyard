import type { AgentRegistry } from '../../src/model/registry.js';
/** A benchmark uses a quiescent source install, rather than pretending copied limits are shared. */
export function sourceCapacity(status:any,registry:AgentRegistry,eligibleModels:string[]) {
  const accounts=registry.accounts.filter(a=>eligibleModels.includes(a.model));
  const names=new Set(accounts.map(a=>a.name));
  const sessions=registry.sessions.filter(s=>!s.endedAt && names.has(s.account));
  const fact={at:new Date().toISOString(),sourceBuild:status.build,sourceLoopLive:status.setup?.loop??null,registryRevision:registry.revision,
    accounts:accounts.map(a=>({name:a.name,model:a.model,maxSessions:a.maxSessions,enabled:a.enabled,quota:a.quota,live:sessions.filter(s=>s.account===a.name).length})),
    roles:registry.roles.map(r=>({name:r.name,concurrency:r.concurrency,accounts:r.accounts,live:registry.sessions.filter(s=>!s.endedAt&&s.role===r.name).length})),liveSessions:sessions};
  if(status.setup?.loop!==false) throw Object.assign(new Error('Real benchmark requires a quiescent source loop for its entire bounded run'),{capacity:fact});
  if(sessions.length) throw Object.assign(new Error('Source eligible accounts still have live sessions; copied limits do not reserve shared capacity'),{capacity:fact});
  if(!accounts.length) throw Object.assign(new Error('No configured eligible source accounts'),{capacity:fact});
  return fact;
}
