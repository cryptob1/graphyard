// Concern: GY-1844's digest delivery — the fenced deployment generations every UAT and production deploy takes, the command adapter that builds a candidate once, deploys its exact digests and reports what instances run, and production's digest verification.
import { spawn } from 'node:child_process';
import type { Manifest } from './delivery.js';
import { verifyPromotedDigests, type DigestVerification, type RecordedInstance } from './production-delivery.js';
import type { AsyncBuildResolver, AsyncDigestDeploy, CandidateBuild, Ledger, Suite } from './release-candidate.js';

/**
 * Every deployment to UAT or production, by digest or by branch move, first takes the
 * environment's next generation as `rc-deploy/ENV/GENERATION`. A tag is created once, so of two
 * deploys that read the same ledger only one publishes that generation; the other is refused
 * before any external effect. The generation is handed to the deployer — a provider that keeps the
 * highest generation it applied refuses a stale one — and is settled as `rc-deployed/ENV/GENERATION`
 * once the effect succeeded or failed. While the newest generation is unsettled no other deploy
 * starts, so an older deploy can never finish after a newer one began. The newest generation not
 * failed is what the environment was last put to run, with its mode and digests.
 */
export const deploymentTagPrefix = 'rc-deploy/';
export const deploymentOutcomeTagPrefix = 'rc-deployed/';
/** How long an unsettled generation fences its environment: a deploy that crashed before settling is waited out, not forever. Longer than `digestCommandTimeoutMs`. */
export const deploymentFenceWindowMs = 3_600_000;
export type DeployEnvironment = 'uat' | 'production';
/** One deployment generation, recorded before its effect: the candidate, how it deploys and, by digest, exactly which artifacts. */
export interface DeploymentRecord { environment: DeployEnvironment; generation: number; id: string; sha: string; at: string; mode: 'digest' | 'sha'; digests?: Manifest }
/** How one generation's effect ended. */
export interface DeploymentOutcome { environment: DeployEnvironment; generation: number; id: string; result: 'succeeded' | 'failed'; at: string; detail?: string }
/** What a deployer is handed with the digests: the environment and the generation it deploys under. */
export interface DeployFence { environment: DeployEnvironment; generation: number }

const padded = (generation: number) => String(generation).padStart(8, '0');
export const deploymentTag = (environment: DeployEnvironment, generation: number) => `${deploymentTagPrefix}${environment}/${padded(generation)}`;
export const deploymentOutcomeTag = (environment: DeployEnvironment, generation: number) => `${deploymentOutcomeTagPrefix}${environment}/${padded(generation)}`;

type Deployments = Pick<Ledger, 'deployments' | 'deployed'>;
/** One environment's generations, newest first. */
export const deploymentsIn = (ledger: Deployments, environment: DeployEnvironment) => ledger.deployments.filter(record => record.environment === environment).sort((a, b) => b.generation - a.generation);
export const outcomeOf = (ledger: Deployments, record: DeploymentRecord) => ledger.deployed.find(outcome => outcome.environment === record.environment && outcome.generation === record.generation) ?? null;
/** What the environment was last put to run: its newest generation that did not fail (one still in flight included). */
export const currentDeployment = (ledger: Deployments, environment: DeployEnvironment) => deploymentsIn(ledger, environment).find(record => outcomeOf(ledger, record)?.result !== 'failed') ?? null;

/** Pure: the generation the next deploy to `environment` takes, or the refusal while the newest one is still in flight. */
export function assessDeploymentFence(ledger: Deployments, environment: DeployEnvironment, now: Date): { generation: number } | { refusal: string } {
  const newest = deploymentsIn(ledger, environment)[0];
  if (newest && !outcomeOf(ledger, newest) && now.getTime() - Date.parse(newest.at) < deploymentFenceWindowMs) {
    return { refusal: `${environment} deployment generation ${newest.generation} (candidate ${newest.id} by ${newest.mode}, started ${newest.at}) has no outcome yet; deploying over it could let it finish last. Wait for its outcome, or until ${new Date(Date.parse(newest.at) + deploymentFenceWindowMs).toISOString()} if it was abandoned` };
  }
  return { generation: (newest?.generation ?? 0) + 1 };
}

type Write = (tag: string, sha: string, record: unknown) => void;
type Intent = Omit<DeploymentRecord, 'generation'>;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const taken = (intent: Intent, generation: number, error: unknown) => new Error(`Another deploy took ${intent.environment} deployment generation ${generation} first, so candidate ${intent.id} was not deployed: ${message(error)}`);
const settled = (intent: Intent, generation: number, result: DeploymentOutcome['result'], detail?: string): DeploymentOutcome =>
  ({ environment: intent.environment, generation, id: intent.id, result, at: intent.at, ...(detail ? { detail: detail.slice(0, 500) } : {}) });

/**
 * Run one deployment's effect under its environment's fence: refused while the newest generation is
 * in flight, the next generation published before the effect (a concurrent publish refuses this
 * one), and the outcome settled after it. A failed effect is settled `failed` and rethrown.
 */
export function fencedDeploy<T>(ledger: Deployments, intent: Intent, now: Date, write: Write, effect: (fence: DeployFence) => T): T {
  const fence = assessDeploymentFence(ledger, intent.environment, now);
  if ('refusal' in fence) throw new Error(fence.refusal);
  const record: DeploymentRecord = { ...intent, generation: fence.generation };
  try { write(deploymentTag(intent.environment, fence.generation), intent.sha, record); } catch (error) { throw taken(intent, fence.generation, error); }
  let result: T;
  try { result = effect({ environment: intent.environment, generation: fence.generation }); } catch (error) {
    try { write(deploymentOutcomeTag(intent.environment, fence.generation), intent.sha, settled(intent, fence.generation, 'failed', message(error))); } catch { /* the window waits it out */ }
    throw error;
  }
  write(deploymentOutcomeTag(intent.environment, fence.generation), intent.sha, settled(intent, fence.generation, 'succeeded'));
  return result;
}
export async function fencedDeployAsync<T>(ledger: Deployments, intent: Intent, now: Date, write: (tag: string, sha: string, record: unknown) => Promise<void>, effect: (fence: DeployFence) => Promise<T>): Promise<T> {
  const fence = assessDeploymentFence(ledger, intent.environment, now);
  if ('refusal' in fence) throw new Error(fence.refusal);
  const record: DeploymentRecord = { ...intent, generation: fence.generation };
  try { await write(deploymentTag(intent.environment, fence.generation), intent.sha, record); } catch (error) { throw taken(intent, fence.generation, error); }
  let result: T;
  try { result = await effect({ environment: intent.environment, generation: fence.generation }); } catch (error) {
    try { await write(deploymentOutcomeTag(intent.environment, fence.generation), intent.sha, settled(intent, fence.generation, 'failed', message(error))); } catch { /* the window waits it out */ }
    throw error;
  }
  await write(deploymentOutcomeTag(intent.environment, fence.generation), intent.sha, settled(intent, fence.generation, 'succeeded'));
  return result;
}

// ——— The command adapter: a repository names the commands that make its deploys digest-capable. ———

/**
 * The variables naming the adapter's shell commands, run in the checkout. `GRAPHYARD_RELEASE_BUILD`
 * builds the cut candidate once (`GRAPHYARD_CANDIDATE_ID`, `GRAPHYARD_CANDIDATE_SHA`) and prints its
 * build registration as JSON; `GRAPHYARD_DEPLOY_DIGESTS` puts exactly `GRAPHYARD_DEPLOY_MANIFEST`
 * (`[{"service","digest"}]`) into `GRAPHYARD_DEPLOY_ENVIRONMENT` under `GRAPHYARD_DEPLOY_GENERATION`
 * without building; `GRAPHYARD_INSTANCE_DIGESTS` prints the environment's running instances as
 * `[{"service","instance","digest"}]`. Without the deploy command the adapter cannot deploy by
 * digest and every deploy keeps the sha branch move.
 */
export const digestVariables = { build: 'GRAPHYARD_RELEASE_BUILD', deploy: 'GRAPHYARD_DEPLOY_DIGESTS', instances: 'GRAPHYARD_INSTANCE_DIGESTS' } as const;
/** Bounds each adapter command, inside `deploymentFenceWindowMs`. */
export const digestCommandTimeoutMs = 50 * 60_000;
/** Runs one shell command with extra environment, answering its stdout. */
export type ShellRun = (command: string, env: Record<string, string>) => Promise<string>;

export const shellRun = (cwd: string, environment: NodeJS.ProcessEnv = process.env): ShellRun => (command, env) => new Promise((resolve, reject) => {
  const child = spawn('sh', ['-c', command], { cwd, env: { ...environment, ...env }, stdio: ['ignore', 'pipe', 'inherit'], timeout: digestCommandTimeoutMs });
  let out = '';
  child.stdout.on('data', chunk => { out += chunk; });
  child.on('error', reject);
  child.on('close', code => code === 0 ? resolve(out) : reject(new Error(`${command} exited ${code}`)));
});

/** The last JSON value a command printed: build and deploy tools print logs before their answer. */
export function lastJsonValue(output: string): unknown {
  const lines = output.split('\n');
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].trim();
    if (!line.startsWith('{') && !line.startsWith('[')) continue;
    try { return JSON.parse(lines.slice(index).join('\n')); } catch { /* a line inside the command's log */ }
  }
  throw new Error(`the command printed no JSON answer: ${output.slice(-300)}`);
}

export interface DigestAdapter {
  build?: AsyncBuildResolver;
  deploy?: AsyncDigestDeploy;
  instances?: (environment: DeployEnvironment) => Promise<RecordedInstance[]>;
}
/** The adapter `environment` names, each port present only when its command is set. */
export function commandDigestAdapter(environment: NodeJS.ProcessEnv, run: ShellRun): DigestAdapter {
  const build = environment[digestVariables.build], deploy = environment[digestVariables.deploy], instances = environment[digestVariables.instances];
  return {
    ...(build ? { build: async cut => lastJsonValue(await run(build, { GRAPHYARD_CANDIDATE_ID: cut.id, GRAPHYARD_CANDIDATE_SHA: cut.sha })) as CandidateBuild } : {}),
    ...(deploy ? { deploy: async (digests, sha, fence) => { await run(deploy, { GRAPHYARD_DEPLOY_ENVIRONMENT: fence.environment, GRAPHYARD_DEPLOY_GENERATION: String(fence.generation), GRAPHYARD_CANDIDATE_SHA: sha, GRAPHYARD_DEPLOY_MANIFEST: JSON.stringify(digests) }); } } : {}),
    ...(instances ? { instances: async environmentName => {
      const answer = lastJsonValue(await run(instances, { GRAPHYARD_DEPLOY_ENVIRONMENT: environmentName }));
      if (!Array.isArray(answer)) throw new Error(`${digestVariables.instances} printed no instance list`);
      return answer.map(entry => ({ service: String(entry?.service ?? ''), instance: String(entry?.instance ?? ''), digest: typeof entry?.digest === 'string' ? entry.digest : null }));
    } } : {}),
  };
}

/**
 * Production's digest verification: the generation production was last put to run is compared,
 * instance by instance, with what the adapter reports running. A sha generation (or none) is
 * reported sha-promoted; a digest generation with no instance command configured is unverified,
 * naming every promoted service, since nothing observed what runs.
 */
export async function verifyProductionDigests(ledger: Deployments, instances?: DigestAdapter['instances']): Promise<DigestVerification & { candidate: string | null; generation: number | null }> {
  const current = currentDeployment(ledger, 'production');
  const at = { candidate: current?.id ?? null, generation: current?.generation ?? null };
  if (current?.mode !== 'digest' || !current.digests?.length) return { ...at, ...verifyPromotedDigests({ sha: current?.sha ?? '' }, []) };
  if (!instances) return { ...at, mode: 'digest', verified: false, mismatches: current.digests.map(({ service }) => ({ service, detail: `${digestVariables.instances} is not set, so no running instance of ${service} was observed` })) };
  return { ...at, ...verifyPromotedDigests({ sha: current.sha, digests: current.digests }, await instances('production')) };
}

/** UAT's digest suite: every service of the digests UAT was deployed with runs exactly them, so the verdict that names them tested them. */
export const uatDigestSuite = (digests: Manifest, instances: NonNullable<DigestAdapter['instances']>): Suite => ({
  name: 'digests',
  run: async () => {
    const verification = verifyPromotedDigests({ sha: '', digests }, await instances('uat'));
    return { name: 'digests', passed: verification.verified, detail: verification.verified ? `every instance runs ${digests.map(entry => entry.service).join(', ')}'s recorded digest` : verification.mismatches.map(mismatch => mismatch.detail).join('; ') };
  },
});
