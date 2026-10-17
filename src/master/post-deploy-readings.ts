// Concern: the live readings the loop takes itself for a loop-owned observation item's proof on the serving release (GY-1779) — what this host can measure, and why it cannot.
import { criterionHoldDays, criterionWindowDays, criterionWindowHours, patternOfProof, type PatternProjection, type PatternReader } from '../model/observation-window.js';
import type { Criterion, Work } from '../model.js';
import { onboardingTargetReading, type OnboardingTargetPorts } from '../cli/master-deployment.js';

/** What a reading found: the proof's result on the serving release with the measured values named, or why this host cannot take it. */
export type PostDeployReading = { result: 'pass' | 'fail'; detail: string } | { unavailable: string };
/** The intervention report's projection for a pattern proof as the caller already read it (null: no row), or why the read failed. */
export type ProjectionRead = { read: PatternProjection | null } | { error: string };
/**
 * The reading of one proof: the delivered parent whose criterion declared it, the follow-up owing it,
 * the release the control plane serves and the instant; `projection` carries the report's row the
 * caller read for the filer, so the report is not read twice for one reading.
 */
export interface PostDeployReadingInput { proof: string; parent: Work; item: Work; criterion: Criterion | null; release: string; now: Date; projection?: ProjectionRead }
export type PostDeployReader = (input: PostDeployReadingInput) => Promise<PostDeployReading>;

const hour = 3_600_000, day = 24 * hour;
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * The reader of `manual:post-deploy/intervention-pattern-KIND-STAGE` from the intervention report's
 * own row (`patterns[].underThreshold`, as the follow-up's window was computed from it): the pair has
 * held under its threshold since `since` for at least the criterion's window — its rate window, else
 * the consecutive-day hold the report measures, else its live window in hours — and the reading
 * passes naming both; a streak too short or none at all (`since` null, projected to begin later) is a
 * failed reading naming the measured values. A report with no row for the pair cannot be read as
 * either. The row the caller already read for the filer (`input.projection`) is read, not the report again.
 */
export async function interventionPatternReading(input: PostDeployReadingInput, patterns: PatternReader): Promise<PostDeployReading | null> {
  const pattern = patternOfProof(input.proof);
  if (!pattern) return null;
  const name = `the ${pattern.kind} reading at ${pattern.stage === 'none' ? 'no stage' : `the ${pattern.stage} stage`}`;
  let projection: PatternProjection | null;
  if (input.projection && 'error' in input.projection) return { unavailable: `the intervention report could not be read for ${name}: ${input.projection.error}` };
  if (input.projection) projection = input.projection.read;
  else try { projection = await patterns(pattern); } catch (error) { return { unavailable: `the intervention report could not be read for ${name}: ${error instanceof Error ? error.message : String(error)}` }; }
  if (!projection) return { unavailable: `the intervention report holds no row for ${name}, so its reading cannot be taken from the report` };
  // The window the criterion names: its rate or hold window in days, else its live window in hours (observation-window.ts reads the same text).
  const text = input.criterion?.text ?? '', days = criterionWindowDays(text) ?? criterionHoldDays(text), hours = days === null ? criterionWindowHours(text) : null;
  const windowMs = days !== null ? days * day : hours !== null ? hours * hour : 0, window = days !== null ? `${days}-day` : hours !== null ? `${hours}-hour` : '0-day';
  const since = projection.since ? Date.parse(projection.since) : null;
  if (since === null) return { result: 'fail', detail: `the intervention report reads ${name} not under its threshold on release ${input.release.slice(0, 12)} at ${iso(input.now.getTime())} (since null${projection.projected ? `, projected to begin at ${projection.projected}` : ''}), so the ${window} window has not run` };
  const heldMs = input.now.getTime() - since, held = days !== null || hours === null ? `${(heldMs / day).toFixed(1)} days` : `${(heldMs / hour).toFixed(1)} hours`;
  if (heldMs < windowMs) return { result: 'fail', detail: `the intervention report reads ${name} under its threshold since ${iso(since)}, ${held} at ${iso(input.now.getTime())}, short of the ${window} window on release ${input.release.slice(0, 12)}` };
  return { result: 'pass', detail: `the intervention report reads ${name} under its threshold since ${iso(since)}, ${held} at ${iso(input.now.getTime())}, which meets the ${window} window on release ${input.release.slice(0, 12)}` };
}

/**
 * The readers this host runs, over the coordinator's own reads: the intervention report for a
 * pattern proof, and the release ledger for `manual:post-deploy/onboarding-default-target` (GY-1906)
 * when `ledger` reads the coordinator checkout's; every other proof names what it needs that no loop step can take — a browser
 * sign-in, a provider's log, a window of live status readings nobody recorded — so the loop records
 * why rather than leaving the item owed, and the master records the reading by hand when it has it.
 */
export function postDeployReader(patterns: PatternReader, cliPath = 'graphyard', ledger?: OnboardingTargetPorts): PostDeployReader {
  return async input => {
    const fromReport = await interventionPatternReading(input, patterns);
    if (fromReport) return fromReport;
    const fromLedger = ledger ? await onboardingTargetReading(input, ledger) : null;
    if (fromLedger) return fromLedger;
    return { unavailable: `no reader of ${input.proof} runs on this host: ${input.parent.key} ${input.criterion?.id ?? 'its criterion'} asks for an observation the loop cannot take from the control plane's own reads (${(input.criterion?.text ?? '').slice(0, 300)}); record it with ${cliPath} master reading ${input.item.key} pass|fail DETAIL once observed on release ${input.release.slice(0, 12)}` };
  };
}
