// Concern: GY-2965 — the merge trial serves the head and runs its bound E2E cases (AC-2).
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { declaredEnvironments, localEnvironment, type AppEnvironment } from '../app-environments.js';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseCase, type CaseFile } from '../e2e/case.js';
import { projectCaseSuite } from '../release-project.js';
import type { CaseOutcome, E2eReport } from '../e2e/runner.js';
import { confinedSession } from '../e2e/steps.js';
import { composeProjectName } from '../compose-preview.js';
import { checkoutRepositoryPolicy } from '../model-boundary/repository-policy.js';
import { loadProjectDelivery } from '../model-boundary/project-applications.js';
import { previewable, type PreviewableApplication } from '../project-applications.js';
import { isPlaceholderServe, onboardingCaseId, placeholderServeRefusal } from '../model/onboarding-work.js';
import { commandApplication, serveHead, ServeCommandError, type CommandApplication, type ServedApplication } from './serve-head.js';

/** How one bound case came out of the trial's run against the served head. */
export interface TrialE2eCase {
  proof: string; case: string;
  /** 1 when the case ran, 0 when it never did (a missing case file, or the run stopped before it). */
  executed: number; failed: number;
  /** Set when the head holds no case at the proof's bound path. */
  missing?: boolean;
  /** The step that failed, as the runner names it, or why the case could not run. */
  failingStep?: string | null;
  /** GY-3265, GY-3343: the failing step's last lines of output, secrets redacted; a serve command that never served carries them so the refusal names why (the diagnostics' filing carries them the same way; the Graphyard record a trial posts still strips them). */
  output?: string[];
  /** GY-3180: the case's browser or runner could not start, so the head was never judged: the trial ends with no verdict. */
  hostFailure?: boolean;
  /**
   * GY-3267: the last screenshot of the case's browser run (base64 PNG), kept for the item page;
   * absent when the run kept none — an item whose cases drove no browser shows no screenshot.
   */
  screenshot?: string;
}

/** GY-3267: the most bytes of one kept screenshot (a small PNG) and the most cases whose screenshots one trial keeps. */
export const trialScreenshotBytesMax = 512 * 1024, trialScreenshotCasesMax = 10;
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** GY-3267: the last screenshot a case's run kept, as base64, when it is a PNG within the byte bound; none otherwise. */
export async function keptScreenshot(outcome: Pick<CaseOutcome, 'attemptResults'>): Promise<string | undefined> {
  const shot = (outcome.attemptResults.at(-1)?.steps ?? []).findLast(step => step.screenshots?.length)?.screenshots?.at(-1);
  if (!shot) return undefined;
  try {
    const bytes = await readFile(shot);
    if (bytes.length > trialScreenshotBytesMax || !bytes.subarray(0, pngSignature.length).equals(pngSignature)) return undefined;
    return bytes.toString('base64');
  } catch { /* a screenshot that cannot be read is not kept */ }
}

/** Why a case cannot run and the trial refuses the head: the declaration to add. */
export const noServeRefusal = 'no way to serve the head: declare "e2e": { "serve": { "command", "url", "readySeconds" } } in graphyard.json, or declare a previewable application in delivery.applications';

/** GY-3343: the file a serve command's whole output is kept in, beside the trial's run. */
export const serveOutputName = (id: string, sha: string) => `serve-${id}-${sha.slice(0, 12)}.log`;

/** What serves the head while the cases run, and how it is stopped. */
interface Served { origin: string; close(): Promise<void>; ended?(): string | null }

/** The checkout's own declarations, read from its graphyard.json and never from the process's: its `e2e.serve` read as a command application (its migration source). */
export function declaredServe(worktree: string): { serve: CommandApplication | null; applications: PreviewableApplication[]; bindings: Record<string, string>; environments: Record<string, AppEnvironment> } {
  let serve: CommandApplication | null = null, text: string | null = null;
  try { text = readFileSync(join(worktree, 'graphyard.json'), 'utf8'); } catch { /* no declaration */ }
  const environments = declaredEnvironments(text);
  try { const declared = checkoutRepositoryPolicy(worktree).e2e.serve; serve = declared ? commandApplication(declared) : null; } catch { /* a policy the head broke: no serve, the case run names it */ }
  try {
    const delivery = loadProjectDelivery({}, worktree);
    if (delivery.previews !== 'off') return { serve, applications: previewable(delivery.applications), bindings: delivery.cases, environments };
  } catch { /* a delivery the head broke: the case run refuses naming why */ }
  return { serve, applications: [], bindings: {}, environments };
}

/** The head's case `name`'s tags and environment; none and local for a case that does not parse, which runs and names why. */
async function caseDeclaration(worktree: string, name: string): Promise<{ tags: string[]; environment: string }> {
  try { return parseCase(`e2e/cases/${name}.json`, await readFile(join(worktree, 'e2e/cases', `${name}.json`), 'utf8')); } catch { return { tags: [], environment: localEnvironment }; }
}

/**
 * Every bound case of `proofs` run against the head served in `worktree`: the case file each
 * `e2e:NAME` proof names must exist on the head (`e2e/cases/NAME.json`), each case runs against the
 * application delivery.cases binds it to, and every unbound case against the head's own `e2e.serve`
 * (the only application, when no serve and one application is declared), and every case runs with the existing E2E runner. Never throws for the merge's own failures — those come back as
 * `missing` or `failingStep` — so the trial's verdict carries them as a refusal.
 */
export async function runTrialE2eCases(input: {
  worktree: string; mergeSha: string; proofs: readonly string[];
  env: Record<string, string>; scratch: string;
  /** The trial's remaining budget in milliseconds: the serve and the run stay within it. */
  budgetMs: number;
  holds: (path: string) => Promise<boolean>;
  log: (line: string) => void;
  /** GY-2997: the trial's confinement words the serve command runs under. */
  wrapper?: readonly string[];
  /** Trusted outer launcher dispatches groups into private-root containers. */
  runGroup?: typeof runTrialE2eGroup;
  /** GY-3296: case id → URL of the named app environment the batch gate provisioned for it. */
  origins?: Record<string, string>;
}): Promise<TrialE2eCase[]> {
  const cases: TrialE2eCase[] = [];
  const pending: string[] = [];
  for (const proof of input.proofs) {
    const name = proof.slice('e2e:'.length);
    if (await input.holds(`e2e/cases/${name}.json`)) pending.push(proof);
    else cases.push({ proof, case: name, executed: 0, failed: 1, missing: true });
  }
  if (!pending.length) return cases;
  const declared = declaredServe(input.worktree);
  // GY-3145: a case delivery.cases binds to an application runs against it; every other case runs
  // against `e2e.serve`, or, with no serve declared, against the only application.
  const groups = new Map<string, { target: ServedApplication; proofs: string[]; origin?: string }>();
  for (const proof of pending) {
    const name = proof.slice(4);
    // GY-3296: a case whose named environment the batch gate provisioned runs against its URL; with
    // none provisioned (a merge trial) it is left out, and an undeclared name fails naming the fix.
    const origin = input.origins?.[name];
    if (origin) {
      const group = groups.get(`environment:${origin}`) ?? { target: { id: 'environment', kind: 'command', command: 'true', url: origin, readySeconds: 1 }, proofs: [], origin };
      group.proofs.push(proof);
      groups.set(`environment:${origin}`, group);
      continue;
    }
    const declaration = await caseDeclaration(input.worktree, name);
    if (declaration.environment !== localEnvironment) {
      if (declared.environments[declaration.environment]) input.log(`left out ${proof}: it runs in environment ${declaration.environment}, which the batch gate provisions`);
      else cases.push({ proof, case: name, executed: 0, failed: 1, failingStep: `case ${name} names environment "${declaration.environment}", which graphyard.json e2e.environments does not declare: declare it with up and down commands, or remove "environment" to run on local` });
      continue;
    }
    if (!declared.serve && !declared.applications.length) {
      cases.push({ proof, case: name, executed: 0, failed: 1, failingStep: noServeRefusal });
      continue;
    }
    const bound = declared.applications.find(application => application.id === declared.bindings[name]);
    const fallback = declared.serve ? null : declared.applications.length === 1 ? declared.applications[0]! : null;
    const application = bound ?? fallback;
    const id = application ? `application:${application.id}` : declared.serve && !declared.bindings[name] ? 'serve' : null;
    const target = application ?? (id ? declared.serve : null);
    // GY-3128: an unbound case needing a Compose item preview cannot pass on e2e.serve: the trial
    // withholds Docker from the head's code (GY-2997). It is left out, named in the log, and the
    // daily run proves it on the host (GY-3193, merge-writer/served-previews.ts).
    const tags = id === 'serve' ? declaration.tags : [];
    if (tags.includes('compose')) {
      input.log(`left out ${proof}: it needs a Compose item preview, which the daily served run proves`);
      continue;
    }
    // GY-3245: a `fixture` case targets the fixture project's own application. A repository that
    // binds it to none of its applications serves it only e2e.serve, whose page is never the
    // fixture's: the case citing it runs it in the fixture project (fixture-node-home under
    // node-application-preview), so it is left out here, named in the log.
    if (tags.includes('fixture')) {
      input.log(`left out ${proof}: it targets the fixture project's application, which this repository binds it to none of`);
      continue;
    }
    // GY-3208: onboarding's placeholder serve runs none of the application, so only onboarding's own
    // first case (the head answers) may pass against it; every other case fails naming it.
    if (id === 'serve' && isPlaceholderServe(declared.serve) && name !== onboardingCaseId) {
      cases.push({ proof, case: name, executed: 0, failed: 1, failingStep: placeholderServeRefusal });
      continue;
    }
    if (!target) {
      cases.push({ proof, case: name, executed: 0, failed: 1, failingStep: `case "${name}" is bound to no declared application: bind it in delivery.cases to one of ${declared.applications.map(application => application.id).join(', ')}` });
      continue;
    }
    const group: { target: ServedApplication; proofs: string[]; origin?: string } = groups.get(id!) ?? { target, proofs: [] };
    group.proofs.push(proof);
    groups.set(id!, group);
  }
  const deadline = Date.now() + input.budgetMs;
  for (const group of groups.values()) cases.push(...await (input.runGroup ?? runTrialE2eGroup)(group.target, group.proofs, { ...input, budgetMs: Math.max(1_000, deadline - Date.now()) }, group.origin));
  return cases;
}

/** `proofs` run against `target` served from the head; every case comes back, failed naming why when it could not run. */
export async function runTrialE2eGroup(target: ServedApplication, proofs: readonly string[], input: Parameters<typeof runTrialE2eCases>[0], origin?: string): Promise<TrialE2eCase[]> {
  const cases: TrialE2eCase[] = [];
  let served: Served | null = null;
  // The cases' bearer token, handed to a serve command as GRAPHYARD_E2E_TOKEN so the head it serves can accept it.
  const token = `trial-${randomUUID()}`;
  try {
    if (origin) served = { origin, close: async () => {} };
    else {
      // The cases' token reaches the head's processes, so a serve command's application can accept it.
      const serving = serveHead(input.worktree, target, { sha: input.mergeSha, env: { ...input.env, GRAPHYARD_E2E_TOKEN: token }, budgetMs: input.budgetMs, wrapper: input.wrapper, log: input.log,
        outputFile: join(input.scratch, serveOutputName(target.id, input.mergeSha)), scratch: join(input.scratch, `compose-${target.id}`), project: composeProjectName(`trial-e2e-${target.id}`, input.mergeSha) });
      // Whatever started is closed whatever happened while it came up: `served` holds it first.
      served = { origin: '', close: serving.close, ended: serving.ended };
      served.origin = await serving.ready;
    }
    // Every present case loads before any runs; one that does not parse fails as a failing step would.
    const loaded: { proof: string; caseFile: CaseFile }[] = [];
    for (const proof of proofs) {
      const name = proof.slice(4), file = `e2e/cases/${name}.json`;
      try { loaded.push({ proof, caseFile: { file, definition: parseCase(file, await readFile(join(input.worktree, file), 'utf8')) } }); }
      catch (error) { cases.push({ proof, case: name, executed: 0, failed: 1, failingStep: error instanceof Error ? error.message : String(error) }); }
    }
    if (loaded.length) {
      let report: E2eReport | null = null;
      // GY-2997: one confined session for every step invocation — the masks and the fresh /proc held
      // across them — so an agent leg's browser, opened by one invocation of its shared `--session`,
      // outlives it; the session's namespace ends when the run does. The host carries this trial's
      // credential-free environment: it is the namespace's PID 1, whose /proc/1/environ every child
      // can read.
      const steps = confinedSession(input.wrapper ?? [], input.env);
      const suite = projectCaseSuite(input.worktree, token, {
        cases: loaded.map(entry => entry.caseFile),
        // The cases come from the head itself, so they never read the install's secrets; agent-step screenshots stay in the trial's scratch, which the trial removes.
        // GY-2997: command and agent steps run under the same confinement as the serve and static build.
        select: () => true, hostEnvironment: input.env, withholdSecrets: true, artifactsDirectory: join(input.scratch, 'e2e-artifacts'), signal: AbortSignal.timeout(Math.max(1_000, input.budgetMs)),
        processRunner: steps.run, versionPath: target.kind === 'command' ? undefined : target.versionPath,
        // GY-3246: the budget above bounds the run; a release run's shared wait budget would leave a case late in a
        // whole catalog (the batch gate's diagnostics) seconds to wait for what it waits a minute for alone.
        waitUntil: Infinity,
        report: value => { report = value; },
      });
      try { await suite.run(served.origin, null); } finally { await steps.close().catch(() => {}); }
      // A serve command that ended during the run left the endpoint to whatever answered after it, so no case counts.
      const ended = served.ended?.();
      if (ended) throw new Error(`${ended} while the cases ran`);
      const ran = report as E2eReport | null;
      for (const entry of loaded) {
        const outcome = ran?.cases.find((item: { id: string }) => item.id === entry.proof.slice(4));
        // GY-3267: the case's last screenshot rides the result whatever its verdict, so the item page shows the changed page.
        const screenshot = outcome && outcome.verdict !== 'unrun' ? await keptScreenshot(outcome) : undefined;
        if (outcome?.attemptResults?.at(-1)?.hostFailure)
          cases.push({ proof: entry.proof, case: entry.proof.slice(4), executed: 0, failed: 1, hostFailure: true, failingStep: outcome.failingStep?.reason ?? 'the case could not start' });
        else if (!outcome || outcome.verdict === 'unrun')
          cases.push({ proof: entry.proof, case: entry.proof.slice(4), executed: 0, failed: 1, failingStep: outcome?.stoppedBy ? `the run stopped at required case ${outcome.stoppedBy}` : 'the case never ran' });
        else if (outcome.verdict === 'passed')
          cases.push({ proof: entry.proof, case: entry.proof.slice(4), executed: 1, failed: 0, ...(screenshot ? { screenshot } : {}) });
        else {
          const step = outcome.failingStep;
          const output = step && outcome.attemptResults.findLast(attempt => attempt.failingStep)?.steps?.find(record => record.index === step.index)?.output;
          cases.push({ proof: entry.proof, case: entry.proof.slice(4), executed: 1, failed: 1,
            failingStep: step ? `step ${step.index + 1} ${step.name}: ${step.reason}` : 'a step failed without naming one', ...(output?.length ? { output } : {}), ...(screenshot ? { screenshot } : {}) });
        }
      }
    }
    return cases;
  } catch (error) {
    // A head that could not be served or run is the merge's to fix: every pending case fails naming why.
    const why = error instanceof Error ? error.message : String(error);
    input.log(`the E2E cases could not run against the served head: ${why}`);
    const named = new Set(cases.map(entry => entry.proof));
    // GY-3343: a serve command that never served keeps its last lines in the result; its whole output is in the trial run directory.
    const serve = error instanceof ServeCommandError ? { failingStep: `${why}; its whole output is in the trial run directory as ${serveOutputName(target.id, input.mergeSha)}`, output: error.output } : { failingStep: why };
    for (const proof of proofs) if (!named.has(proof)) cases.push({ proof, case: proof.slice(4), executed: 0, failed: 1, ...serve });
    return cases;
  } finally {
    await served?.close().catch(error => input.log(`the served head was not stopped cleanly: ${error instanceof Error ? error.message : String(error)}`));
  }
}
