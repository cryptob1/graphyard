import type { AdapterContext } from './adapters.js';
import type { PlanAction } from './types.js';
import { trialContainerImage } from '../merge-writer/trial-container.js';
import { shellQuote } from './transport.js';

/** GY-3188: trial images build on Graphyard's own builder, so its cache is pruned without touching another project's. */
export const trialBuilder = 'graphyard-trial';
export const trialBuilderCreateArgs = ['buildx', 'create', '--name', trialBuilder, '--driver', 'docker-container'];
export const trialImageBuildArgs = (root: string) => ['buildx', 'build', '--builder', trialBuilder, '--load', '--target', 'trial', '--tag', trialContainerImage, root];
export const trialImagePlan = (ctx: AdapterContext): PlanAction => ({
  id: 'provider.trial-image', target: 'provider', state: 'update',
  title: 'Build the private-root merge-trial image (Docker is required for trials)',
  command: [`docker buildx inspect ${trialBuilder} >/dev/null 2>&1 || docker ${trialBuilderCreateArgs.join(' ')}`, ['docker', ...trialImageBuildArgs(ctx.sourceRoot)].map(shellQuote).join(' ')].join('; '),
});
export const buildTrialImage = async (ctx: AdapterContext) => {
  if ((await ctx.transport.exec('docker', ['buildx', 'inspect', trialBuilder], { allowFailure: true })).code !== 0) await ctx.transport.exec('docker', trialBuilderCreateArgs);
  return ctx.transport.exec('docker', trialImageBuildArgs(ctx.sourceRoot), { timeout: 1_800_000 });
};
