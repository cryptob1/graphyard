// Concern: GY-2965 — the merge trial serves the head and runs its bound E2E cases (AC-2).
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseCase, type CaseFile } from '../e2e/case.js';
import { projectCaseSuite, buildStaticSite } from '../release-project.js';
import type { E2eReport } from '../e2e/runner.js';
import { serveStaticSite } from './preview.js';
import { composeBounds, composeProjectName, composeStack, dockerEnvironment } from '../compose-preview.js';
import { checkoutRepositoryPolicy, type E2eServe } from '../model/repository-policy.js';
import { loadProjectDelivery, type Application } from '../project-applications.js';

/** How one bound case came out of the trial's run against the served head. */
export interface TrialE2eCase {
  proof: string; case: string;
  /** 1 when the case ran, 0 when it never did (a missing case file, or the run stopped before it). */
  executed: number; failed: number;
  /** Set when the head holds no case at the proof's bound path. */
  missing?: boolean;
  /** The step that failed, as the runner names it, or why the case could not run. */
  failingStep?: string | null;
}

/** Why a case cannot run and the trial refuses the head: the declaration to add. */
export const noServeRefusal = 'no way to serve the head: declare "e2e": { "serve": { "command", "url", "readySeconds" } } in graphyard.json, or declare a previewable application in delivery.applications';

/** How long a stopped serve command has to end before its group is killed. */
const closeGraceMs = 20_000;

/** What serves the head while the cases run, and how it is stopped. */
interface Served { origin: string; close(): Promise<void>; ended?(): string | null }

/** The checkout's own declarations, read from its graphyard.json and never from the process's. */
function declaredServe(worktree: string): { serve: E2eServe | null; applications: Application[]; bindings: Record<string, string> } {
  let serve: E2eServe | null = null;
  try { serve = checkoutRepositoryPolicy(worktree).e2e.serve; } catch { /* a policy the head broke: no serve, the case run names it */ }
  try {
    const delivery = loadProjectDelivery({}, worktree);
    if (delivery.previews !== 'off') return { serve, applications: delivery.applications, bindings: delivery.cases };
  } catch { /* a delivery the head broke: the case run refuses naming why */ }
  return { serve, applications: [], bindings: {} };
}

/**
 * A head served by its own `e2e.serve` declaration: `command` run in the trial checkout (the trial
 * environment, no credential) until `url` answers, waited for at most `readySeconds` and the
 * budget's remainder; never past it. The group is killed on close.
 */
async function serveByCommand(serve: E2eServe, worktree: string, env: Record<string, string>, budgetMs: number, log: (line: string) => void): Promise<Served> {
  const startedAt = Date.now(), deadline = startedAt + Math.min(serve.readySeconds * 1000, budgetMs);
  // An endpoint that answers before the command starts is another application's: its answers would not be the head's.
  const occupied = await fetch(serve.url, { signal: AbortSignal.timeout(2_000) }).then(() => true, () => false);
  if (occupied) throw new Error(`${serve.url} already answers before the serve command starts; another application holds it, so the head cannot be served there`);
  const child = spawn('sh', ['-c', serve.command], { cwd: worktree, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => { if (chunks.length < 200) chunks.push(chunk); });
  child.stderr.on('data', (chunk: Buffer) => { if (chunks.length < 200) chunks.push(chunk); });
  let exited: string | null = null;
  child.on('error', error => { exited = error.message; });
  child.on('close', (code, signal) => { exited = `the serve command ended (${signal ? `signal ${signal}` : `status ${code}`})`; });
  // stdout/stderr stay open while any descendant that inherited them still runs (the shell may exit first under dash).
  const whenClosed = (stream: NodeJS.ReadableStream | null) =>
    !stream || (stream as NodeJS.ReadableStream & { closed?: boolean }).closed
      ? Promise.resolve()
      : new Promise<void>(accept => stream.once('close', () => accept()));
  const descendantsGone = Promise.all([whenClosed(child.stdout), whenClosed(child.stderr)]);
  // SIGTERM the group so the serve command can stop what it started and remove its files; wait for
  // descendants (not the shell alone) to finish that cleanup before SIGKILL past the grace.
  const close = async () => {
    try { process.kill(-child.pid!, 'SIGTERM'); await Promise.race([descendantsGone, new Promise(accept => setTimeout(accept, closeGraceMs))]); } catch { /* already gone */ }
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
  };
  for (;;) {
    if (exited) { await close(); throw new Error(`${exited}: ${Buffer.concat(chunks).toString('utf8').trim().split('\n').slice(-5).join(' | ').slice(0, 500)}`); }
    // Only a success answers: a server still starting up (503) is not yet the head served.
    const answered = await fetch(serve.url, { signal: AbortSignal.timeout(2_000) }).then(response => response.ok, () => false);
    if (answered) return { origin: new URL(serve.url).origin, close, ended: () => exited };
    if (Date.now() >= deadline) {
      await close();
      const tail = Buffer.concat(chunks).toString('utf8').trim().split('\n').slice(-5).join(' | ').slice(0, 500);
      log(`the serve command did not answer ${serve.url} within ${serve.readySeconds}s${tail ? `: ${tail}` : ''}`);
      throw new Error(`the serve command did not answer ${serve.url} within ${serve.readySeconds}s`);
    }
    await new Promise(accept => setTimeout(accept, 500));
  }
}

/**
 * Every bound case of `proofs` run against the head served in `worktree`: the case file each
 * `e2e:NAME` proof names must exist on the head (`e2e/cases/NAME.json`), the head is served by its
 * own `e2e.serve` declaration, or else each case against the application delivery.cases binds it to
 * (the only one, when one is declared), and every case runs with the existing E2E runner. Never throws for the merge's own failures — those come back as
 * `missing` or `failingStep` — so the trial's verdict carries them as a refusal.
 */
export async function runTrialE2eCases(input: {
  worktree: string; mergeSha: string; proofs: readonly string[];
  env: Record<string, string>; scratch: string;
  /** The trial's remaining budget in milliseconds: the serve and the run stay within it. */
  budgetMs: number;
  holds: (path: string) => Promise<boolean>;
  log: (line: string) => void;
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
  if (!declared.serve && !declared.applications.length) {
    for (const proof of pending) cases.push({ proof, case: proof.slice(4), executed: 0, failed: 1, failingStep: noServeRefusal });
    return cases;
  }
  // `e2e.serve` serves the whole head; otherwise each case runs against the application delivery.cases binds it to.
  const groups = new Map<string, { target: E2eServe | Application; proofs: string[] }>();
  for (const proof of pending) {
    const name = proof.slice(4);
    const id = declared.serve ? 'serve' : declared.bindings[name] ?? (declared.applications.length === 1 ? declared.applications[0]!.id : null);
    const target = declared.serve ?? declared.applications.find(application => application.id === id);
    if (!target) {
      cases.push({ proof, case: name, executed: 0, failed: 1, failingStep: `case "${name}" is bound to no declared application: bind it in delivery.cases to one of ${declared.applications.map(application => application.id).join(', ')}` });
      continue;
    }
    const group = groups.get(id!) ?? { target, proofs: [] };
    group.proofs.push(proof);
    groups.set(id!, group);
  }
  const deadline = Date.now() + input.budgetMs;
  for (const group of groups.values()) cases.push(...await runGroup(group.target, group.proofs, { ...input, budgetMs: Math.max(1_000, deadline - Date.now()) }));
  return cases;
}

/** `proofs` run against `target` served from the head; every case comes back, failed naming why when it could not run. */
async function runGroup(target: E2eServe | Application, proofs: readonly string[], input: Parameters<typeof runTrialE2eCases>[0]): Promise<TrialE2eCase[]> {
  const cases: TrialE2eCase[] = [];
  let served: Served | null = null;
  // The cases' bearer token, handed to a serve command as GRAPHYARD_E2E_TOKEN so the head it serves can accept it.
  const token = `trial-${randomUUID()}`;
  try {
    if (!('kind' in target)) served = await serveByCommand(target, input.worktree, { ...input.env, GRAPHYARD_E2E_TOKEN: token }, input.budgetMs, input.log);
    else if (target.kind === 'static') {
      const build = target.build ? await buildStaticSite(target.build, input.worktree, input.budgetMs, undefined, undefined, input.env) : null;
      if (build) throw new Error(build);
      const static_ = await serveStaticSite(join(input.worktree, target.directory), input.mergeSha);
      served = { origin: static_.url, close: () => static_.close() };
    } else {
      const stack = composeStack({
        checkout: input.worktree, file: target.file, service: target.service, port: target.port,
        project: composeProjectName(`trial-e2e-${target.id}`, input.mergeSha), environment: dockerEnvironment(input.env), variables: {},
        bounds: composeBounds(), scratch: await mkdtemp(join(input.scratch, 'compose-')),
      });
      // The project is closed whatever happened while it came up: `served` holds it before it starts.
      served = { origin: '', close: () => stack.close() };
      served.origin = await stack.start(AbortSignal.timeout(input.budgetMs), input.budgetMs);
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
      const suite = projectCaseSuite(input.worktree, token, {
        cases: loaded.map(entry => entry.caseFile),
        // The cases come from the head itself, so they never read the install's secrets; agent-step screenshots stay in the trial's scratch, which the trial removes.
        select: () => true, hostEnvironment: input.env, withholdSecrets: true, artifactsDirectory: join(input.scratch, 'e2e-artifacts'), signal: AbortSignal.timeout(Math.max(1_000, input.budgetMs)),
        report: value => { report = value; },
      });
      await suite.run(served.origin, null);
      // A serve command that ended during the run left the endpoint to whatever answered after it, so no case counts.
      const ended = served.ended?.();
      if (ended) throw new Error(`${ended} while the cases ran`);
      const ran = report as E2eReport | null;
      for (const entry of loaded) {
        const outcome = ran?.cases.find((item: { id: string }) => item.id === entry.proof.slice(4));
        if (!outcome || outcome.verdict === 'unrun')
          cases.push({ proof: entry.proof, case: entry.proof.slice(4), executed: 0, failed: 1, failingStep: outcome?.stoppedBy ? `the run stopped at required case ${outcome.stoppedBy}` : 'the case never ran' });
        else if (outcome.verdict === 'passed')
          cases.push({ proof: entry.proof, case: entry.proof.slice(4), executed: 1, failed: 0 });
        else {
          const step = outcome.failingStep;
          cases.push({ proof: entry.proof, case: entry.proof.slice(4), executed: 1, failed: 1,
            failingStep: step ? `step ${step.index + 1} ${step.name}: ${step.reason}` : 'a step failed without naming one' });
        }
      }
    }
    return cases;
  } catch (error) {
    // A head that could not be served or run is the merge's to fix: every pending case fails naming why.
    const why = error instanceof Error ? error.message : String(error);
    input.log(`the E2E cases could not run against the served head: ${why}`);
    const named = new Set(cases.map(entry => entry.proof));
    for (const proof of proofs) if (!named.has(proof)) cases.push({ proof, case: proof.slice(4), executed: 0, failed: 1, failingStep: why });
    return cases;
  } finally {
    await served?.close().catch(error => input.log(`the served head was not stopped cleanly: ${error instanceof Error ? error.message : String(error)}`));
  }
}
