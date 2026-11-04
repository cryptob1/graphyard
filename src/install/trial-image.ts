import type { AdapterContext } from './adapters.js';
import type { PlanAction } from './types.js';
import { trialContainerImage } from '../merge-writer/trial-container.js';
import { shellQuote } from './transport.js';

export const trialImageBuildArgs = (root: string) => ['build', '--target', 'trial', '--tag', trialContainerImage, root];
export const trialImagePlan = (ctx: AdapterContext): PlanAction => ({
  id: 'provider.trial-image', target: 'provider', state: 'update',
  title: 'Build the private-root merge-trial image (Docker is required for trials)',
  command: ['docker', ...trialImageBuildArgs(ctx.sourceRoot)].map(shellQuote).join(' '),
});
export const buildTrialImage = (ctx: AdapterContext) => ctx.transport.exec('docker', trialImageBuildArgs(ctx.sourceRoot), { timeout: 1_800_000 });
