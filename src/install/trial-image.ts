import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { publishedSourceImages, type AdapterContext } from './adapters.js';
import type { PlanAction } from './types.js';
import { pulledTrialImageFile, trialContainerImage, trialImage } from '../merge-writer/trial-container.js';
import { localTransport, shellQuote } from './transport.js';

/** GY-3188: trial images build on Graphyard's own builder, so its cache is pruned without touching another project's. */
export const trialBuilder = 'graphyard-trial';
export const trialBuilderCreateArgs = ['buildx', 'create', '--name', trialBuilder, '--driver', 'docker-container'];
export const trialImageBuildArgs = (root: string) => ['buildx', 'build', '--builder', trialBuilder, '--load', '--target', 'trial', '--tag', trialContainerImage, root];
/** `published` (GY-3214) is the trial image Graphyard published for the source checkout's commit, null for a tree no published image holds. */
export const trialImagePlan = (ctx: AdapterContext, published: string | null): PlanAction => ({
  id: 'provider.trial-image', target: 'provider', state: 'update',
  title: published ? `Pull the private-root merge-trial image ${published}, or build it here when it is not published (Docker is required for trials)` : 'Build the private-root merge-trial image (Docker is required for trials)',
  command: (build => published ? `docker image pull ${published} || { ${build}; }` : build)(
    [`docker buildx inspect ${trialBuilder} >/dev/null 2>&1 || docker ${trialBuilderCreateArgs.join(' ')}`, ['docker', ...trialImageBuildArgs(ctx.sourceRoot)].map(shellQuote).join(' ')].join('; ')),
});
/** Pulls the published trial image and names it for the release tree's trials (trial-container.ts `trialImage`); builds it here otherwise. */
export const provisionTrialImage = async (ctx: Pick<AdapterContext, 'sourceRoot' | 'transport'>, published: string | null) => {
  const marker = pulledTrialImageFile(ctx.sourceRoot);
  if (published && (await ctx.transport.exec('docker', ['image', 'pull', published], { allowFailure: true, timeout: 1_800_000 })).code === 0) return ctx.transport.putFile(marker, `${published}\n`, 0o644);
  await rm(marker, { force: true });
  if ((await ctx.transport.exec('docker', ['buildx', 'inspect', trialBuilder], { allowFailure: true })).code !== 0) await ctx.transport.exec('docker', trialBuilderCreateArgs);
  await ctx.transport.exec('docker', trialImageBuildArgs(ctx.sourceRoot), { timeout: 1_800_000 });
};

/** GY-3328: the trial image could not be provisioned on this host — the trial host's fault, never a head's: no verdict, no rework. */
export const trialImageMissingPrefix = 'Trial-host fault: the trial image ';
export const trialImageMissingFault = (error: unknown): string | null => {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith(trialImageMissingPrefix) ? message : null;
};
let provisioning: Promise<void> | null = null;
/**
 * GY-3328: the image trials run is provisioned here when this host lacks it (a new host, a pruned
 * cache) — pulled, else built, by the install's own code. Concurrent callers wait on one provision.
 */
export function ensureTrialImage(root = fileURLToPath(new URL('../..', import.meta.url))): Promise<void> {
  if (process.env.GRAPHYARD_TRIAL_IMAGE) return Promise.resolve();
  return provisioning ??= (async () => {
    const transport = localTransport(), image = trialImage(root);
    if ((await transport.exec('docker', ['image', 'inspect', image], { allowFailure: true })).code === 0) return;
    try { await provisionTrialImage({ sourceRoot: root, transport }, publishedSourceImages(root)?.trial ?? null); }
    catch (error) { throw new Error(`${trialImageMissingPrefix}${image} is missing on this host and could not be provisioned: ${error instanceof Error ? error.message : String(error)}`); }
  })().finally(() => { provisioning = null; });
}
