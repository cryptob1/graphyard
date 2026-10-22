// Concern: the live readings the loop takes itself for a loop-owned observation item's proof on the serving release (GY-1779) — what this host can measure, and why it cannot.
import type { Criterion, Work } from '../model.js';

/** What a reading found: the proof's result on the serving release with the measured values named, or why this host cannot take it. */
export type PostDeployReading = { result: 'pass' | 'fail'; detail: string } | { unavailable: string };
/** The reading of one proof: the delivered parent whose criterion declared it, the follow-up owing it, the release the control plane serves and the instant. */
export interface PostDeployReadingInput { proof: string; parent: Work; item: Work; criterion: Criterion | null; release: string; now: Date }
export type PostDeployReader = (input: PostDeployReadingInput) => Promise<PostDeployReading>;

/**
 * The readers this host runs: every proof names what it needs that no loop step can take — a browser
 * sign-in, a provider's log, a window of live status readings nobody recorded — so the loop records
 * why rather than leaving the item owed, and the master records the reading by hand when it has it.
 */
export function postDeployReader(cliPath = 'graphyard'): PostDeployReader {
  return async input => {
    return { unavailable: `no reader of ${input.proof} runs on this host: ${input.parent.key} ${input.criterion?.id ?? 'its criterion'} asks for an observation the loop cannot take from the control plane's own reads (${(input.criterion?.text ?? '').slice(0, 300)}); record it with ${cliPath} master reading ${input.item.key} pass|fail DETAIL once observed on release ${input.release.slice(0, 12)}` };
  };
}
