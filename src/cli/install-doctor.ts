// Concern: the `doctor` command's reading of local discovery, live readiness and the completion-profile checklist, moved out of src/cli/install.ts (GY-1879) to keep that command module under its budget.
import { parseArgs } from 'node:util';
import { discover } from '../onboarding.js';
import { loadProposal, readSetupStatus } from '../repository-setup.js';
import { completionProfiles, readinessChecklist, summarizeDefinitions, type CompletionProfile } from '../readiness.js';
import type { CliContext } from './context.js';
import { doctorRepositoryPolicy } from '../model/repository-policy.js';
import { agentEnvironmentRoot } from '../master/environments.js';
import { masterCredential, planeAnswers, planeRequest, setupFromZeroChecks, setupLine, setupNext } from '../setup-from-zero.js';
import { coordinatorDoctor } from '../master/known-good.js';

/** `graphyard doctor [--profile PROFILE]`: local discovery, live integration readiness and the readiness checklist for a completion profile. */
export async function runDoctor(context: CliContext) {
  const { base } = context;
  const root = context.repositoryRoot();
  // With no GRAPHYARD_TOKEN(_FILE), doctor reads as the master identity install --apply recorded (GY-1412).
  const master = await masterCredential(root, base);
  const api = master ? planeRequest(base, master.token) : context.api;
  const discovered = await discover(root);
  const { values } = parseArgs({ args: context.rest, options: { profile: { type: 'string' } }, allowPositionals: false });
  const profile = (values.profile ?? 'through-merge') as CompletionProfile;
  if (!completionProfiles.includes(profile)) throw new Error(`Unknown completion profile ${values.profile}; choose one of ${completionProfiles.join(', ')}`);
  let live: any = null, failure: string | undefined;
  try { live = await api('status'); } catch (error: any) { failure = error.message; }
  const setup = await readSetupStatus(root).catch((error: any) => ({ error: error.message }));
  const stored = await loadProposal(root).catch(() => null);
  // Capacity drift and production lag, which a deploy can break silently: the server reports both.
  const delegationLimits = live?.delegationLimits ?? null, production = live?.production ?? null;
  // Validation definitions are readable by operators and readers; every other credential
  // leaves the runner-path items `unknown` with the command that reads them.
  let definitions: { kind: string; id: string; revision: number; role?: string; enabled?: boolean }[] | null = null;
  if (live && ['admin', 'reader'].includes(live.actor?.role)) { try { definitions = (await api('validation/definitions')).definitions; } catch { definitions = null; } }
  const readiness = readinessChecklist(profile, {
    repository: discovered.repository ?? null,
    server: { url: base, reachable: !!live, role: live?.actor?.role, failure },
    setup: 'error' in setup ? { proposal: null, appliedAt: null, githubApp: null, drift: [], unreadable: [String(setup.error)] } : { ...setup, unreadable: setup.unreadable.filter((entry): entry is string => typeof entry === 'string') },
    proposal: stored?.proposal ?? null,
    validation: definitions ? summarizeDefinitions(definitions) : null,
  });
  // The machine-local prerequisites docs/setup-from-zero.md depends on (GY-1352), each naming its step.
  const checks = await setupFromZeroChecks({ root, status: live, failure, reachable: !!live || await planeAnswers(base), masterCredential: master?.file, environments: agentEnvironmentRoot() });
  const setupFromZero = { ready: checks.every(check => check.status === 'pass'), lines: checks.map(setupLine) };
  // A ready checklist still deploys nothing: once every item is ready, capacity drift and
  // an undeployed merge are the next actions; until then the checklist's own gap comes first.
  const firstFailed = checks.find(check => check.status === 'fail');
  const next = !readiness.ready ? setupNext(readiness, checks)
    : firstFailed ? setupLine(firstFailed)
    : delegationLimits?.drift?.length ? `Set ${delegationLimits.drift.map((entry: any) => `${entry.variable}=${entry.required}`).join(' ')} on the deployment: ${delegationLimits.drift[0].reason}`
    : production?.incidents?.length ? `Production has not deployed ${production.incidents.map((incident: any) => incident.key).join(', ')}: ${production.incidents[0].reason}`
    : readiness.next;
  await coordinatorDoctor(root, discovered.repository, production);
  return context.print({ discovered, server: base, cliPath: await context.activeCliPath(), hostId: context.individualHostId(), connected: !!live, role: live?.actor?.role, release: live?.release ?? null, failure,
    setup,
    heldJobs: live?.heldJobs ?? 0,
    mainGuard: live?.mainGuard ?? null,
    build: live?.build ?? null,
    delegationLimits: delegationLimits ? { limits: delegationLimits.limits, deployed: delegationLimits.deployed, drift: delegationLimits.drift, attention: delegationLimits.attention } : null,
    production: production ? { provider: production.provider, serving: production.serving, running: production.running, aheadBy: production.ahead?.by ?? null, incidents: production.incidents, attention: production.attention, error: production.error } : null,
    repositoryPolicy: doctorRepositoryPolicy(root),
    setupFromZero,
    readiness,
    next,
    limits: ['CI discovery is a proposal, not executed-test inventory', 'Herdr two-host recovery and GitHub refusal-to-acceptance must be demonstrated', 'A ready checklist is configuration, never evidence: the first real PR must visibly pass every gate'] });
}
