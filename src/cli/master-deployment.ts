// Concern: the loop's reading of `manual:post-deploy/onboarding-default-target` (GY-1906) — the onboarding-default-path hold's clear record, its passing UAT execution, and the serving release's own UAT pass, read from the release ledger with no network call.
import { foldHolds, holdTagPrefix, type Hold, type HoldRecord } from '../release-holds.js';
import { recordsArguments, uatTagPrefix, type AsyncGit, type UatRecord } from '../release-candidate.js';
import type { PostDeployReading, PostDeployReadingInput } from '../master/post-deploy-readings.js';

export const onboardingTargetProof = 'manual:post-deploy/onboarding-default-target';
/** The customer outcome whose release hold the repair clears, and the case its UAT executions must pass. */
export const onboardingOutcome = 'onboarding-default-path', onboardingCase = 'onboarding-delivery-defaults';

/** What the reader reads: the ledger's UAT records and hold records as recorded, and ancestry this checkout can tell (null: it cannot). */
export interface OnboardingTargetPorts {
  uatRecords(): Promise<UatRecord[]>;
  holdRecords(): Promise<HoldRecord[]>;
  contains(ancestor: string, descendant: string): Promise<boolean | null>;
}

const parsed = <T>(out: string): T[] => out.split('\0\0').map(entry => entry.replace(/^\n/, '')).filter(Boolean).flatMap(entry => {
  const [, body] = entry.split('\0');
  try { return [JSON.parse((body ?? '').trim()) as T]; } catch { return []; }
});
/**
 * The ports over the coordinator checkout's own ledger tags and object store: `rc-uat/` and `rc-hold/`
 * records as the release jobs wrote them, and `merge-base --is-ancestor` over commits already held.
 * Nothing is fetched (one door to the remote): the release drive keeps the tags current, and a
 * commit this checkout does not hold is ancestry it cannot tell, never a pass.
 */
export function ledgerPorts(git: AsyncGit): OnboardingTargetPorts {
  return {
    uatRecords: async () => parsed<UatRecord>(await git(recordsArguments(uatTagPrefix))),
    holdRecords: async () => parsed<HoldRecord>(await git(recordsArguments(holdTagPrefix))),
    contains: async (ancestor, descendant) => {
      if (ancestor === descendant) return true;
      try { await git(['merge-base', '--is-ancestor', ancestor, descendant]); return true; }
      catch (error) { return (error as { status?: number; code?: number })?.status === 1 || (error as { code?: number })?.code === 1 ? false : null; }
    },
  };
}

const short = (sha: string) => sha.slice(0, 12);
/** The newest UAT record of candidate `id` at `sha`, deployed and run at exactly that SHA as that candidate's own run, or null. */
const exactRun = (records: readonly UatRecord[], sha: string, id?: string) => records
  .filter(record => record.sha === sha && record.deployedSha === sha && record.e2e?.sha === sha && record.e2e.runId === `rc-${record.id}` && (id === undefined || record.id === id))
  .sort((a, b) => b.at.localeCompare(a.at))[0] ?? null;
const verdictOf = (record: UatRecord | null, id: string) => record?.e2e?.cases.find(entry => entry.case === id)?.verdict ?? null;

/**
 * The onboarding-default-path hold the parent repairs: the one whose item the parent's criterion
 * names (GY-1909), else the newest that covers the outcome.
 */
function repairedHold(holds: readonly Hold[], text: string): Hold | null {
  const covering = holds.filter(hold => hold.outcomes.includes(onboardingOutcome));
  const named = covering.filter(hold => hold.item && new RegExp(`\\b${hold.item}\\b`).test(text));
  return (named.length ? named : covering).at(-1) ?? null;
}

/**
 * The reading of `manual:post-deploy/onboarding-default-target` on the serving release, or null for
 * any other proof. It passes only when every link is independently recorded and exact:
 * the onboarding-default-path hold cleared by a `clear` record under its original rule (every
 * attached case passed on a newer candidate); that clear's own UAT execution bound to the clearing
 * candidate at its exact SHA, deployed there, passing onboarding-delivery-defaults; the serving
 * release containing both the parent's repair merge and the clearing candidate; and a UAT
 * execution at the serving release's exact SHA passing onboarding-delivery-defaults — the clearing
 * candidate's own when the release is that candidate, else a verified descendant's own pass. A
 * current execution that failed is a failed reading; anything missing, attributed to another SHA or
 * of ancestry this checkout cannot tell stays unproven (unavailable), naming what is missing.
 */
export async function onboardingTargetReading(input: PostDeployReadingInput, ports: OnboardingTargetPorts): Promise<PostDeployReading | null> {
  if (input.proof !== onboardingTargetProof) return null;
  const release = input.release.toLowerCase(), repair = input.parent.delivery?.mergeSha?.toLowerCase() ?? null;
  const unproven = (why: string): PostDeployReading => ({ unavailable: `${onboardingTargetProof} is unproven on release ${short(release)}: ${why}` });
  if (!repair) return unproven(`${input.parent.key} records no delivered merge, so there is no repair to find in the release`);
  let holds: Hold[], records: UatRecord[];
  try { holds = foldHolds(await ports.holdRecords()); records = await ports.uatRecords(); }
  catch (error) { return unproven(`the release ledger could not be read: ${error instanceof Error ? error.message : String(error)}`); }
  const hold = repairedHold(holds, input.criterion?.text ?? '');
  if (!hold) return unproven(`the ledger holds no ${onboardingOutcome} release hold`);
  const clear = hold.records.find(record => record.kind === 'clear');
  if (hold.state !== 'cleared' || !hold.cleared || !clear?.candidate || !clear.sha) return unproven(`the ${onboardingOutcome} hold${hold.item ? ` ${hold.item}` : ''} has no clear record (it is ${hold.state})`);
  const clearing = { candidate: clear.candidate, sha: clear.sha.toLowerCase() };
  // The original rule: a clear stands only on a candidate newer than every case attached to the hold.
  const older = hold.cases.filter(entry => !(entry.candidate < clearing.candidate));
  if (older.length) return unproven(`the clear record's candidate ${clearing.candidate} is not newer than attached ${older.map(entry => `${entry.case} on ${entry.candidate}`).join(', ')}, so it does not clear under the hold's rule`);
  const clearRun = exactRun(records, clearing.sha, clearing.candidate);
  if (!clearRun) return unproven(`no UAT execution of the clearing candidate ${clearing.candidate} is recorded deployed and run at its exact SHA ${short(clearing.sha)}`);
  const unpassed = [...new Set([onboardingCase, ...hold.cases.map(entry => entry.case)])].filter(id => verdictOf(clearRun, id) !== 'passed');
  if (unpassed.length) return unproven(`the clearing execution ${clearRun.e2e!.runId} at ${short(clearing.sha)} did not pass ${unpassed.map(id => `${id} (${verdictOf(clearRun, id) ?? 'not run'})`).join(', ')}`);
  let carriesRepair: boolean | null, carriesClear: boolean | null;
  try { [carriesRepair, carriesClear] = [await ports.contains(repair, release), await ports.contains(clearing.sha, release)]; }
  catch (error) { return unproven(`ancestry could not be read: ${error instanceof Error ? error.message : String(error)}`); }
  if (carriesRepair !== true) return unproven(`the release is ${carriesRepair === false ? 'not' : 'not verifiably'} a descendant of ${input.parent.key}'s repair merge ${short(repair)}`);
  if (carriesClear !== true) return unproven(`the release is ${carriesClear === false ? 'not' : 'not verifiably'} a descendant of the clearing candidate ${clearing.candidate} at ${short(clearing.sha)}`);
  const current = release === clearing.sha ? clearRun : exactRun(records, release);
  if (!current) return unproven(`no UAT execution is recorded deployed and run at the release's exact SHA, so ${onboardingCase} has no pass of its own there`);
  const verdict = verdictOf(current, onboardingCase);
  const which = release === clearing.sha ? `the clearing candidate's own execution` : `descendant candidate ${current.id}'s own execution`;
  if (verdict === 'failed' || verdict === 'flaky') return { result: 'fail', detail: `${onboardingCase} ${verdict} in ${which} ${current.e2e!.runId} at the release's exact SHA ${short(release)}, though the ${onboardingOutcome} hold${hold.item ? ` ${hold.item}` : ''} cleared on ${clearing.candidate}` };
  if (verdict !== 'passed') return unproven(`${which} ${current.e2e!.runId} at ${short(release)} ${verdict === null ? 'never ran' : 'did not run'} ${onboardingCase}`);
  return { result: 'pass', detail: `${onboardingCase} passed in ${which} ${current.e2e!.runId} deployed at the release's exact SHA ${short(release)}; the ${onboardingOutcome} hold${hold.item ? ` ${hold.item}` : ''} cleared on candidate ${clearing.candidate} at ${short(clearing.sha)} under its rule, its execution ${clearRun.e2e!.runId} passing ${onboardingCase}; the release contains that candidate and ${input.parent.key}'s repair ${short(repair)}` };
}
