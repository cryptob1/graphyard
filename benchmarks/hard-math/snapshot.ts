import { wholeDocument } from '../../src/model/work-summary.js';
import type { Work } from '../../src/model.js';

/** Receipt histories require whole tracked documents, including settled deliveries. */
export async function trackedDocuments(items:Work[],tracked:{id:string;key:string}[],read:(path:string)=>Promise<any>) {
  const ids=new Set(tracked.map(w=>w.id));
  for(const w of tracked) if(!items.some(item=>item.id===w.id)) throw new Error(`Missing authoritative item ${w.key}`);
  return Promise.all(items.map(item=>ids.has(item.id)?wholeDocument(item,read):item));
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
