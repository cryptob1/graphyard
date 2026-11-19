import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { publishedSourceImages, type AdapterContext } from './adapters.js';
import type { PlanAction } from './types.js';
import { pulledTrialImageFile, trialContainerImage, trialImage } from '../merge-writer/trial-container.js';
import { localTransport, shellQuote } from './transport.js';
import { appArmorEnabled, trialAppArmorLoadCommand, trialAppArmorProfile, trialAppArmorProfilePath, trialAppArmorProfileText } from '../merge-writer/trial-apparmor.js';

/** GY-3188: trial images build on Graphyard's own builder, so its cache is pruned without touching another project's. */
export const trialBuilder = 'graphyard-trial';
export const trialBuilderCreateArgs = ['buildx', 'create', '--name', trialBuilder, '--driver', 'docker-container'];
export const trialImageBuildArgs = (root: string) => ['buildx', 'build', '--builder', trialBuilder, '--load', '--target', 'trial', '--tag', trialContainerImage, root];
/** `published` (GY-3214) is the trial image Graphyard published for the source checkout's commit, null for a tree no published image holds. */
export const trialImagePlan = (ctx: Pick<AdapterContext, 'sourceRoot'>, published: string | null): PlanAction => ({
  id: 'provider.trial-image', target: 'provider', state: 'update',
  title: published ? `Pull the private-root merge-trial image ${published}, or build it here when it is not published (Docker is required for trials)` : 'Build the private-root merge-trial image (Docker is required for trials)',
  command: (build => published ? `docker image pull ${published} || { ${build}; }` : build)(
    [`docker buildx inspect ${trialBuilder} >/dev/null 2>&1 || docker ${trialBuilderCreateArgs.join(' ')}`, ['docker', ...trialImageBuildArgs(ctx.sourceRoot)].map(shellQuote).join(' ')].join('; ')),
});
/** Pulls the published trial image and names it for the release tree's trials (trial-container.ts `trialImage`); builds it here otherwise. The marker is removed through the transport, so it goes where the image is provisioned — the target of a move, not the machine that ran it. */
export const provisionTrialImage = async (ctx: Pick<AdapterContext, 'transport' | 'sourceRoot'>, published: string | null) => {
  const marker = pulledTrialImageFile(ctx.sourceRoot);
  if (published && (await ctx.transport.exec('docker', ['image', 'pull', published], { allowFailure: true, timeout: 1_800_000 })).code === 0) return ctx.transport.putFile(marker, `${published}\n`, 0o644);
  await ctx.transport.exec('rm', ['-f', marker], { allowFailure: true });
  if ((await ctx.transport.exec('docker', ['buildx', 'inspect', trialBuilder], { allowFailure: true })).code !== 0) await ctx.transport.exec('docker', trialBuilderCreateArgs);
  await ctx.transport.exec('docker', trialImageBuildArgs(ctx.sourceRoot), { timeout: 1_800_000 });
};
/** GY-3339: on an AppArmor host, the profile trial containers run under (merge-writer/trial-apparmor.ts); none elsewhere. */
export const trialAppArmorPlan = (enabled = appArmorEnabled()): PlanAction[] => enabled ? [{
  id: 'provider.trial-apparmor', target: 'provider', state: 'update', command: trialAppArmorLoadCommand,
  title: `Load the AppArmor profile ${trialAppArmorProfile} (flags=(unconfined) with userns) at ${trialAppArmorProfilePath}, loaded again on boot, so merge-trial tests can start nested sandboxes; other containers keep docker-default`,
}] : [];
/** The profile file as this host has it, or null when it is absent or unreadable. */
const installedTrialAppArmorProfile = () => { try { return readFileSync(trialAppArmorProfilePath, 'utf8'); } catch { return null; } };
/** A profile already written with this text is loaded on boot (apparmor_parser -W cached it), so a rerun
 *  needs no root: an administrator who loaded it once by hand lets an installer without sudo go on. */
export const provisionTrialAppArmor = async (ctx: AdapterContext, enabled = appArmorEnabled(), installed = installedTrialAppArmorProfile) => {
  if (!enabled || installed() === trialAppArmorProfileText) return;
  try {
    await ctx.transport.exec('sudo', ['-n', 'tee', trialAppArmorProfilePath], { input: trialAppArmorProfileText });
    await ctx.transport.exec('sudo', ['-n', 'apparmor_parser', '-r', '-W', trialAppArmorProfilePath]);
  } catch (error) {
    throw new Error(`AppArmor is enabled on this host, and merge trials need the ${trialAppArmorProfile} profile loaded, which needs root (${error instanceof Error ? error.message : String(error)}). Run: ${trialAppArmorLoadCommand}; then rerun the installer`);
  }
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
