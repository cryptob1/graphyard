import type { Work } from '../../src/model.js';
import type { FleetSession } from '../../src/model/registry.js';
import type { Receipt } from './receipt-schema.js';

/** Fleet projections can omit their summary marker; always read each tracked document by ID. */
export async function trackedDocuments(items:Work[],tracked:{id:string;key:string}[],read:(path:string)=>Promise<any>) {
  for(const w of tracked) if(!items.some(item=>item.id===w.id)) throw new Error(`Missing authoritative item ${w.key}`);
  const documents=new Map(await Promise.all(tracked.map(async w=>[w.id,await read(`work/${encodeURIComponent(w.id)}`) as Work] as const)));
  return items.map(item=>documents.get(item.id)??item);
}

export function lifecycleCounts(record:Work) {
  const unclaimed=record.epoch===0 && !record.lease && !record.lastAssignment && !record.candidate && !record.submission && !record.delivery;
  const pipeline=record.pipeline;
  if(!pipeline && !unclaimed) throw new Error(`Missing authoritative claim timeline: ${record.key}`);
  if(pipeline && (!Array.isArray(pipeline.attempts) || !Number.isInteger(pipeline.reworkRounds) || record.epoch>0 && !pipeline.attempts.some(a=>a.epoch===record.epoch))) throw new Error(`Incomplete authoritative claim timeline: ${record.key}`);
  if(record.observation && !Array.isArray(record.observation.reviews)) throw new Error(`Missing authoritative review history: ${record.key}`);
  return {attempts:pipeline?pipeline.attempts.length:0,repairs:pipeline?pipeline.reworkRounds:0,reviews:record.observation?record.observation.reviews.length:0};
}

export const failureStack=(error:unknown)=>error instanceof Error?error.stack??null:null;

/** Allocation time remains budgeted; only recorded runtime start establishes real overlap. */
export function receiptSession(kind:Receipt['kind'],s:FleetSession,allocations:FleetSession[],item?:Work):Receipt['sessions'][number] {
  const handles=(item?.sessions??[]).filter(h=>h.kind==='implementation' && h.principal===s.principal && Date.parse(h.startedAt)>=Date.parse(s.selectedAt));
  // A later allocation must never borrow an earlier attempt's implementation handle.
  const next=allocations.filter(n=>n.role===s.role && n.work===s.work && n.principal===s.principal && Date.parse(n.selectedAt)>Date.parse(s.selectedAt)).sort((a,b)=>Date.parse(a.selectedAt)-Date.parse(b.selectedAt))[0];
  const handle=handles.find(h=>!next || Date.parse(h.startedAt)<Date.parse(next.selectedAt));
  const workspace=item?.workspaces?.find(w=>w.epoch===handle?.epoch);
  const attempt=item?.pipeline?.attempts?.find(a=>a.epoch===handle?.epoch);
  const implementationEnd=[handle?.endedAt,attempt?.endedAt].filter(Boolean).sort()[0]??null;
  // Controlled executors have no AI runtime; preserve their explicit fixture-only intervals.
  const implementationStart=kind==='controlled-fixture'?handle?.startedAt:handle?.runtimeStartedAt;
  return {id:s.id,role:s.role,work:s.work,principal:s.principal,runtime:s.runtime,account:s.account,model:s.model,reason:s.reason,startedAt:s.selectedAt,endedAt:s.endedAt,record:s,
    implementation:handle && workspace && implementationStart?{id:handle.id,epoch:workspace.epoch,branch:workspace.branch,path:workspace.path,pane:handle.pane,agentName:handle.agentName,startedAt:implementationStart,endedAt:implementationEnd}:null};
}
