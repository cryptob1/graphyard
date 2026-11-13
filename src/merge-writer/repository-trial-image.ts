// Concern: GY-3275 — a managed repository extends the trial image with its own toolchain.
// A repository may commit `graphyard.trial.Dockerfile`, whose `FROM` names the build arg
// `GRAPHYARD_TRIAL_IMAGE`: it layers the repository's toolchain over the image Graphyard runs
// trials in. The merge writer builds it from the trial's base tip (and a head that edits the file
// from that head too, see runTrialAttempt) and caches the built image by the file's digest and the base
// image, so two trials of one base build it once (a change the file does not name, a COPY the
// Dockerfile leaves untouched, rides a later edit of the file).
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChildRun } from '../child-runner.js';
import { dockerEnvironment } from '../compose-preview.js';
import { trialImage } from './trial-container.js';

/** The file a repository commits to extend the trial image; its `FROM` names the build arg `GRAPHYARD_TRIAL_IMAGE`. */
export const trialDockerfile = 'graphyard.trial.Dockerfile';
/** Where a repository's extended trial image is tagged, beside the trial images the leftovers report already counts. */
export const repositoryTrialImageRepository = 'graphyard-trial-repo';

/** The tag a repository's Dockerfile builds under: the digest of the file's content, the base image and the checkout naming the repository — so an edit of the file changes it and two repositories never share one. */
export const repositoryTrialImageTag = (repository: string, base: string, dockerfile: string) =>
  `${repositoryTrialImageRepository}:${createHash('sha256').update(`${repository}\0${base}\0${dockerfile}`).digest('hex').slice(0, 24)}`;

/** GY-3275: the repository's trial image could not be built — the trial host's Docker, not the head's: no verdict, not retried, and reported upstream like a fetch fault (GY-3249). */
export const trialRepositoryImageFaultPrefix = `Trial-host fault: the trial host could not build the repository's trial image (${trialDockerfile}): `;
export class TrialRepositoryImageError extends Error {
  constructor(readonly detail: string) {
    super(`${trialRepositoryImageFaultPrefix}${detail}`);
    this.name = 'TrialRepositoryImageError';
  }
}
/** The detail of a repository trial-image build fault, from the error or the message it crossed a process boundary as; null for any other error. */
export const trialRepositoryImageFault = (error: unknown): string | null => {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith(trialRepositoryImageFaultPrefix) ? message.slice(trialRepositoryImageFaultPrefix.length) : null;
};

/**
 * The image this repository's trials run in (GY-3275): its `graphyard.trial.Dockerfile` at `tip`
 * built over the base trial image through the
 * build arg `GRAPHYARD_TRIAL_IMAGE` and tagged by the file's digest and the base image, so a second
 * trial of the same base reuses the built image (`docker image inspect`). A repository that commits
 * no file runs the standard image (null) and nothing is built. A build that fails throws
 * `TrialRepositoryImageError`: the trial host's fault for the base tip, the head's own for its edit.
 */
export async function repositoryTrialImage(input: {
  /** The coordinator checkout whose object store holds the tip. */
  root: string;
  /** The commit the Dockerfile and its build context are read from: the base tip, or a head that edits the file. */
  tip: string;
  /** The trial's scratch, where the build's context worktree goes. */
  scratch: string;
  /** The trial's environment: the docker client resolves on its PATH, as the Compose services' does. */
  env: Record<string, string>;
  run: ChildRun;
  timeoutMs: number;
  log?: (line: string) => void;
  /** Called once a build actually starts (GY-2963: a slow build names where the trial is); a cached image starts no step. */
  onStep?: (step: string) => void;
}): Promise<string | null> {
  try { await input.run('git', ['-C', input.root, 'cat-file', '-e', `${input.tip}:${trialDockerfile}`], { timeoutMs: input.timeoutMs }); }
  catch { return null; }
  const dockerfile = String(await input.run('git', ['-C', input.root, 'show', `${input.tip}:${trialDockerfile}`], { timeoutMs: input.timeoutMs }));
  const base = trialImage(), tag = repositoryTrialImageTag(input.root, base, dockerfile);
  const docker = (args: string[]) => input.run('docker', args, { env: dockerEnvironment(input.env, { DOCKER_HOST: 'unix:///var/run/docker.sock' }), timeoutMs: input.timeoutMs });
  try { await docker(['image', 'inspect', tag]); return tag; } catch { /* not built yet: built below */ }
  const context = await mkdtemp(join(input.scratch, 'trial-image-'));
  input.onStep?.('install: repository image');
  input.log?.(`building ${trialDockerfile} of ${input.tip.slice(0, 12)} as ${tag} over ${base}`);
  await input.run('git', ['-C', input.root, 'worktree', 'add', '--detach', context, input.tip], { timeoutMs: input.timeoutMs });
  try {
    await docker(['build', '--build-arg', `GRAPHYARD_TRIAL_IMAGE=${base}`, '--file', trialDockerfile, '--tag', tag, context]);
    return tag;
  } catch (error) {
    if ((error as { timedOut?: boolean }).timedOut) throw error; // the trial's deadline ended it, not the Dockerfile
    const failed = error as { stdout?: unknown; stderr?: unknown; message?: string };
    const output = `${failed.stdout ?? ''}${failed.stderr ?? ''}`.trim().slice(-600) || failed.message || String(error);
    throw new TrialRepositoryImageError(output);
  } finally {
    try { await input.run('git', ['-C', input.root, 'worktree', 'remove', '--force', context], { timeoutMs: input.timeoutMs }); } catch { /* the context goes with the trial's scratch anyway */ }
    try { await input.run('git', ['-C', input.root, 'worktree', 'prune'], { timeoutMs: input.timeoutMs }); } catch { /* best effort */ }
  }
}
