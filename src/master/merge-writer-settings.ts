// Concern: the merge writer's `run.shadowGate` (GY-1522), `run.mergeWriter` (GY-1524) and `run.candidates` (GY-1526) settings and the defaults they resolve to.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

/** How long one trial (build plus the affected tests) may run before it is killed; a timeout is no verdict and is retried later (cycle-shadow.ts). */
export const defaultShadowTimeoutMinutes = 20;
/** The longest trial an install may ask for: two hours already dwarfs the pipeline's p90 target, and one trial runs at a time. */
export const maxShadowTimeoutMinutes = 120;

/**
 * `run.shadowGate` in .graphyard/master.json: the shadow gate trial-merges every submitted head
 * onto main beside GitHub's gate and records the verdict; it writes nothing. Unset, it runs (github
 * mode is the only mode) with `defaultShadowTimeoutMinutes`.
 */
export const shadowGateSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  timeoutMinutes: z.number().int().min(1).max(maxShadowTimeoutMinutes).optional(),
}).strict();
export type ShadowGateSettings = z.infer<typeof shadowGateSettingsSchema>;

/** The settings with their defaults applied. */
export const shadowGateSettings = (run: { shadowGate?: ShadowGateSettings }) => ({
  enabled: run.shadowGate?.enabled ?? true,
  timeoutMinutes: run.shadowGate?.timeoutMinutes ?? defaultShadowTimeoutMinutes,
});

// ---- The merge executor's settings (GY-1524) -------------------------------------------------------

/** How many times a push the base tip moved under is re-trialled on the new tip before the head is refused `base moved N times` and left queued. */
export const defaultMergeWriterRetrials = 3;
/** The most re-trials an install may ask for: every one is a full build and test run on a fresh merge commit. */
export const maxMergeWriterRetrials = 10;
/** The install's deploy key by default: `~/.config/graphyard/<install>/deploy-key`, the one credential the push child sees. */
export const defaultDeployKeyFile = (installId: string, home: string = homedir()) => join(home, '.config', 'graphyard', installId, 'deploy-key');

/**
 * `run.mergeWriter` in .graphyard/master.json: the control-plane merge executor's deploy key and
 * its re-trial bound. Unset, the key is the install's default and the bound `defaultMergeWriterRetrials`.
 */
export const mergeWriterSettingsSchema = z.object({
  deployKeyFile: z.string().trim().min(1).max(1000).optional(),
  retrials: z.number().int().min(0).max(maxMergeWriterRetrials).optional(),
}).strict();
export type MergeWriterSettings = z.infer<typeof mergeWriterSettingsSchema>;

/** `~/` at the start of a configured path is the home directory, as a shell would read it. */
const expandHome = (path: string, home: string) => path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path;

/** The settings with their defaults applied, for the install `installId` (install/types.ts `installIdFor`). */
export const mergeWriterSettings = (run: { mergeWriter?: MergeWriterSettings }, installId: string, home: string = homedir()) => ({
  deployKeyFile: expandHome(run.mergeWriter?.deployKeyFile ?? defaultDeployKeyFile(installId, home), home),
  retrials: run.mergeWriter?.retrials ?? defaultMergeWriterRetrials,
});

// ---- The loop-driven candidate cut (GY-1526) ------------------------------------------------------

/** A candidate is cut once this many first-parent merges have landed after the newest cut (the workflow's own cap, GY-1491). */
export const defaultCandidateEveryMerges = 10;
/** A candidate is cut once any merge after the newest cut has waited this long, main quiet or not: a lone merge never waits for nine more. */
export const defaultCandidateIdleMinutes = 15;
/** The widest cut an install may ask for: past this a failed candidate implicates too many changes to revert by area. */
export const maxCandidateEveryMerges = 100;
/** The longest a merge may wait for its candidate: a day, past which the cut is no longer continuous delivery. */
export const maxCandidateIdleMinutes = 24 * 60;

/**
 * `run.candidates` in .graphyard/master.json: when the loop cuts a release candidate itself
 * (control-plane mode, daemon/candidate-cut.ts). Unset, it cuts at `defaultCandidateEveryMerges`
 * merges or `defaultCandidateIdleMinutes` idle minutes.
 */
export const candidateSettingsSchema = z.object({
  everyMerges: z.number().int().min(1).max(maxCandidateEveryMerges).optional(),
  idleMinutes: z.number().int().min(1).max(maxCandidateIdleMinutes).optional(),
}).strict();
export type CandidateSettings = z.infer<typeof candidateSettingsSchema>;

/** The settings with their defaults applied. */
export const candidateSettings = (run: { candidates?: CandidateSettings }) => ({
  everyMerges: run.candidates?.everyMerges ?? defaultCandidateEveryMerges,
  idleMinutes: run.candidates?.idleMinutes ?? defaultCandidateIdleMinutes,
});
