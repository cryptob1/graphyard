// Concern: the merge writer's trial timeout and `run.mergeWriter` (GY-1524) settings and the defaults they resolve to, and the retired `run.candidates` (GY-1526).
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { configHome } from '../install/secrets.js';

/** How long one merge-writer trial (build plus the affected tests) may run before it is killed; a timeout is no verdict. */
export const trialTimeoutMinutes = 20;

// ---- The merge executor's settings (GY-1524) -------------------------------------------------------

/** How many times a push the base tip moved under is re-trialled on the new tip before the head is refused `base moved N times` and left queued. */
export const defaultMergeWriterRetrials = 3;
/** The most re-trials an install may ask for: every one is a full build and test run on a fresh merge commit. */
export const maxMergeWriterRetrials = 10;
/** The install's deploy key by default: `<config home>/<install>/deploy-key` (`~/.config/graphyard`, or GRAPHYARD_CONFIG_HOME), the one credential the push child sees. */
export const defaultDeployKeyFile = (installId: string, home?: string) => join(home === undefined ? configHome() : join(home, '.config', 'graphyard'), installId, 'deploy-key');

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
export const mergeWriterSettings = (run: { mergeWriter?: MergeWriterSettings }, installId: string, home?: string) => ({
  deployKeyFile: expandHome(run.mergeWriter?.deployKeyFile ?? defaultDeployKeyFile(installId, home), home ?? homedir()),
  retrials: run.mergeWriter?.retrials ?? defaultMergeWriterRetrials,
});

// ---- The retired candidate cut (GY-1526, removed by GY-1983) ----------------------------------------

/** `run.candidates` in .graphyard/master.json: unused since GY-1983 removed the loop's candidate cut; still parsed so an older master.json loads. */
export const candidateSettingsSchema = z.object({
  everyMerges: z.number().int().min(1).optional(),
  idleMinutes: z.number().int().min(1).optional(),
}).strict();
