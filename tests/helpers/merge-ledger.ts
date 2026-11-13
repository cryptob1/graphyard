import { proveFixtureCase } from './ledger-delivery.js';
import { randomUUID } from 'node:crypto';
import type { Engine } from '../../src/engine.js';
import type { Principal, Work } from '../../src/model.js';
import type { GitRunner } from '../../src/merge-writer/local-observation.js';
import { recordMergeEvent } from '../../src/server/merge-record.js';
import type { Services } from '../../src/server/routes.js';

// GY-2010: the merge writer's ledger is the only source of the test and merge gates. These record
// its steps for an item through the plane's own merge-record handler, as the loop's coordinator
// does, so a fixture reaches the merge stage (an intent: the trial passed) or done (pushed and
// reconciled) the way production does, never by a GitHub observation.

const writer: Principal = { id: 'merge-writer', role: 'coordinator', sessionKind: 'ai' };
/** The merge commit a fixture's merge writer makes of an item's head, unless the fixture names one. */
export const fixtureMergeSha = (work: Pick<Work, 'candidate'>) => `9${work.candidate!.sha.slice(1)}`.toLowerCase();

const record = (engine: Engine, work: Work, body: unknown) => recordMergeEvent({ engine } as unknown as Services, writer, work.id, body, randomUUID());

/** The writer's intent of the item's submitted head on its base: its trial passed, so the test gate passes and the merge gate waits on the push. */
export async function mergeIntent(engine: Engine, work: Work, mergeSha = fixtureMergeSha(work)): Promise<Work> {
  work = await proveFixtureCase(engine, work);
  await record(engine, work, { kind: 'intent', head: work.candidate!.sha, baseTip: work.candidate!.baseSha, mergeSha, risk: 'normal', at: new Date().toISOString() });
  if (work.observation?.source === 'control-plane') await record(engine, work, { kind: 'trial', head: work.candidate!.sha, baseTip: work.candidate!.baseSha, mergeSha,
    outcome: 'verdict', build: 'pass', tests: { passed: 1, failed: [], files: 1 }, files: [], durationMs: 1, attempts: [],
    proofs: Object.fromEntries(work.criteria.filter(c => !c.bootstrap).flatMap(c => c.proofs).filter(p => /^(unit|integration|e2e):/.test(p)).map(p => [p, { executed: 1, failed: 0 }])) });
  return (await engine.store.workItem(work.id))!;
}

/** The writer's whole delivery of the item's head: intent, push and a reconciliation main holds (the checkout read answers held). */
export async function mergeDelivered(engine: Engine, work: Work, mergeSha = fixtureMergeSha(work)): Promise<Work> {
  if (work.mergeLedger?.state !== 'intent' || work.mergeLedger.head !== work.candidate!.sha.toLowerCase()) work = await mergeIntent(engine, work, mergeSha);
  await record(engine, work, { kind: 'pushed', mergeSha, pushedAt: new Date().toISOString() });
  const previous = engine.gitRunner;
  engine.gitRunner = (async (args: string[]) => args[0] === 'merge-base' ? { status: 0, stdout: '', stderr: '' } : previous!(args)) as GitRunner;
  try { await record(engine, work, { kind: 'reconciled', mergeSha, observedTip: mergeSha }); }
  finally { engine.gitRunner = previous; }
  return (await engine.store.workItem(work.id))!;
}
