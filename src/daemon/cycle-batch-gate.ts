import { featureMapCaseId } from '../app-feature-check.js';
// Concern: the loop's batch gate on main (GY-3119): one gate at a time beside the cycle, the
// scheduled diagnostics beside it, both over the merge writer's trial container and git.
import type { Work } from '../model.js';
import { bootstrapGate, gateLimitMs, type DiagnosePort, gateOutcomeReason, gateRecordPath, mergeFilings, readGateRecord, runDiagnostics, runGate, writeGateRecord, type GatePorts, type GateRecord } from '../batch-gate.js';
import { graphyardRepository } from '../scenarios.js';
import { releaseNotesPath, releaseNote, appendReleaseNote } from '../release-notes.js';
import { deployRecordPath, readDeployRecord } from '../deploy-watch.js';
import { notCovered, servedPreviewCases } from '../merge-writer/served-previews.js';
import { relandItemFor, revertMergeCommit, serveLandings, serveRangeCommits, trialAndPushRevert } from '../merge-writer/serve-revert.js';
import { gateTrialKey, trialStartOwner, trialStartWaiting } from '../merge-writer/trial-load.js';
import { heavyTrial, trialShareAllowance, type MergeWriterReads } from './cycle-merge-writer.js';
import { criterionProofs, e2eProofsOf, openFlakyItem } from '../merge-writer/executor.js';
import type { Cycle } from './cycle.js';
import { actionLine } from './run.js';
import { actionDetailMax, message, storeAction } from './state.js';
import { batchGateFlights as flights, busyTrialSlots } from './trial-slots.js';
import { faultItem } from './control-plane.js';
import { currentEvidence } from '../model/evidence.js';
import { EnvironmentFault, declaredEnvironments, environmentSecretsFile, environmentStatePath, localEnvironment, loopLifecycle, trustedCheckout, type AppEnvironment } from '../app-environments.js';
import { installSecretsDirectory } from '../e2e/steps.js';
import { declarationSlot, heavyJobsDirectory, heldSlots } from '../master/verification-slots.js';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

/** The gate's own item key in the trial (a proofless pseudo-item, like a revert's). */
const gateKey = gateTrialKey;
/** How many lines of a failure's output its diagnostic filing carries (GY-3265). */
const outputLines = 80;
const lines = (out: string) => out.split('\n').map(line => line.trim()).filter(Boolean);

/**
 * GY-3336: the cursor key of the standing fetch-refusal line. A remote that refuses the base
 * branch's fetch — a SAML organization that has not authorised the merge writer's SSH key — is the
 * owner's to fix, so the loop raises one attention line quoting the remote's refusal and the fix
 * (an ssh configuration file ssh itself refuses is named as that host fault instead, GY-3470),
 * and retries the fetch with a growing backoff instead of failing every cycle.
 */
export const fetchRefusalKey = 'fetch-refusal';
/** How long the loop waits before refetching after the refusal's `attempts`-th failure: one minute doubling, capped at fifteen. */
export const fetchRetryBackoffMs = (attempts: number) => Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 15 * 60_000);
/** git's generic trailer for every refused remote read; the remote's own words come above it. */
const genericFetchFailure = /^fatal: (?:Could not read from remote repository|could not read from remote repository)/;
/** The remote's refusal, as one line quoting it: the first non-generic line of git's stderr, else the error's own words. */
export function fetchRefusalLine(repository: string, baseBranch: string, error: unknown): string {
  const failed = error as { stderr?: unknown };
  const quoted = `${typeof failed?.stderr === 'string' ? failed.stderr : ''}\n${message(error)}`.split('\n')
    .map(line => line.trim()).filter(line => line && !genericFetchFailure.test(line));
  const refusal = (quoted[0] ?? message(error).split('\n')[0] ?? 'the fetch failed').slice(0, 300);
  // GY-3470: ssh refusing one of its own configuration files never reached the remote — a host fault, not the owner's authorization.
  const sshConfig = /Bad owner or permissions on (\S+)/.exec(refusal);
  if (sshConfig) return `The fetch of ${baseBranch} for ${repository} never reached the remote: ssh refuses its configuration file ${sshConfig[1]} ("${refusal}"). This is the host's SSH configuration, not the repository's authorization: make that file owned by root or by the loop's user and writable only by its owner, and the loop retries with backoff until then.`.slice(0, actionDetailMax);
  // GY-3464: only GitHub's SAML SSO refusal earns the authorisation advice; any other failure is reported in its own words.
  if (!/SAML SSO/i.test(refusal)) return `The fetch of ${baseBranch} for ${repository} fails: "${refusal}". Fix what it names, and the loop retries with backoff until then.`.slice(0, actionDetailMax);
  return `The remote refuses the fetch of ${baseBranch} for ${repository}: "${refusal}". The owner must authorise the merge writer's access — authorise the SSH key for the SAML organization on GitHub (Settings → SSH and GPG keys → Configure SSO → Authorize), or reinstall with --push-auth gh so the merge writer fetches over https with the gh login — and the loop retries with backoff until then.`.slice(0, actionDetailMax);
}

/**
 * What one trial run of `checks` on `commit` failed, as gate check ids, with each failing case's
 * failing-step text as the trial supplied it (GY-3264) and the last lines of its output (GY-3265:
 * the failing step's for a case, the trial log's for the build or a test file); the trial is bounded
 * by `timeoutMs`, the gate's own clock, never the merge-trial deadline (GY-3142).
 */
async function trialFailures(reads: MergeWriterReads, commit: string, checks: readonly string[], files: readonly string[], timeoutMs: number, trusted: () => string | null = () => null, skipFaults = false, signal?: AbortSignal): Promise<{ failed: string[]; details: Record<string, string>; outputs: Record<string, string[]> }> {
  const cases = checks.filter(check => check.startsWith('e2e:'));
  const tests = checks.includes('affected') ? files : checks.filter(check => check.startsWith('test:')).map(check => check.slice(5));
  const environments = await gateEnvironments(reads, commit, cases, trusted());
  const runCases = cases.filter(proof => !(proof in environments.unknown) && !environments.untrusted.includes(proof));
  const trial = (origins: Record<string, string>, skipped: readonly string[]) => {
    const proofs = runCases.filter(proof => !skipped.includes(proof));
    return reads.trial(commit, tests, { key: gateKey, criteria: proofs.length ? [{ id: 'AC-1', text: 'The batch gate cases pass', proofs }] as Work['criteria'] : [], ...(Object.keys(origins).length ? { environments: origins } : {}) }, undefined, undefined, undefined, undefined, undefined, signal, timeoutMs);
  };
  // GY-3296: each named environment is provisioned around the one trial, its URL handed to its cases.
  // An environment wait or fault throws for the gate, which retries; the diagnostics (`skipFaults`)
  // leave that environment's cases out and run the rest, so an outage never reruns the whole suite.
  const named = [...environments.named];
  const nest = async (index: number, origins: Record<string, string>, skipped: readonly string[]): ReturnType<typeof trial> => {
    if (index === named.length) return trial(origins, skipped);
    const [name, proofs] = named[index]!;
    try {
      return await environments.lifecycle!.use(name, environments.definitions[name]!, commit, environments.cwd!,
        url => nest(index + 1, { ...origins, ...Object.fromEntries(proofs.map(proof => [proof.slice(4), url])) }, skipped),
        run => !(run.e2e ?? []).some(entry => proofs.includes(entry.proof) && (entry.failed > 0 || entry.executed === 0)));
    } catch (error) {
      if (!skipFaults || !(error instanceof EnvironmentFault) || error.environment !== name) throw error;
      return nest(index + 1, origins, [...skipped, ...proofs]);
    }
  };
  const run = await nest(0, {}, []);
  const failed = [...Object.keys(environments.unknown), ...(run.build === 'fail' ? ['build'] : []),
    ...(run.e2e ?? []).filter(entry => entry.failed > 0 || entry.missing || entry.executed === 0).map(entry => entry.proof),
    ...run.tests.failed.map(file => `test:${file}`)];
  // GY-3305: a failing test check keeps its own identity in the record's detail — the browser
  // suite's failing spec, test and error from the trial's verdict — and one whose run named no
  // failing test says so explicitly: teardown warnings can neither crowd it out of the tail nor
  // pass for a diagnosis that was never made.
  const testDetail = run.failingCase ?? (run.tests.failed.length ? 'the run named no failing test or error: nothing in its output establishes a cause' : null);
  const details = Object.fromEntries([
    ...Object.entries(environments.unknown),
    ...(run.e2e ?? []).filter(entry => entry.failingStep).map(entry => [entry.proof, entry.failingStep!]),
    ...(testDetail ? run.tests.failed.slice(0, 1).map(file => [`test:${file}`, testDetail]) : []),
  ]);
  const logTail = (run.logTail ?? '').split('\n').filter(line => line.trim()).slice(-outputLines);
  const outputs = Object.fromEntries([...(run.e2e ?? []).filter(entry => entry.output?.length).map(entry => [entry.proof, entry.output!.slice(-outputLines)]),
    ...failed.filter(check => !check.startsWith('e2e:') && logTail.length).map(check => [check, logTail])]);
  return { failed: failed.filter(check => checks.includes(check) || (check.startsWith('test:') && checks.includes('affected'))), details, outputs };
}
const trialChecks = async (...args: Parameters<typeof trialFailures>) => (await trialFailures(...args)).failed;

/**
 * GY-3296: the named environments the gate's `cases` need at `commit`, defined by graphyard.json at
 * the trusted base — the last verified commit — and run from its checkout. A case naming an
 * environment the commit declares but the base does not yet waits for that declaration to be
 * verified; one naming an environment neither declares fails with the configuration to fix.
 */
async function gateEnvironments(reads: MergeWriterReads, commit: string, cases: readonly string[], base: string | null) {
  const none = { named: new Map<string, string[]>(), unknown: {} as Record<string, string>, untrusted: [] as string[], definitions: {} as Record<string, AppEnvironment>, cwd: null as string | null, lifecycle: null as ReturnType<typeof loopLifecycle> | null };
  const git = reads.git, gate = reads.gate;
  if (!git || !gate || !cases.length) return none;
  // One grep names the few case files that declare any environment; only those are read.
  const declaring = lines(await git(['grep', '-l', '"environment"', commit, '--', 'e2e/cases/']).catch(() => ''))
    .map(line => line.slice(line.indexOf(':') + 1)).filter(path => cases.includes(`e2e:${path.slice('e2e/cases/'.length, -'.json'.length)}`));
  const wanted = new Map<string, string[]>();
  for (const path of declaring) {
    let name = localEnvironment;
    try { name = JSON.parse(await git(['show', `${commit}:${path}`])).environment ?? localEnvironment; } catch { /* the trial names a case that does not parse */ }
    if (name !== localEnvironment) wanted.set(name, [...wanted.get(name) ?? [], `e2e:${path.slice('e2e/cases/'.length, -'.json'.length)}`]);
  }
  if (!wanted.size) return none;
  const show = (at: string) => git(['show', `${at}:graphyard.json`]).catch(() => null);
  const definitions = base ? declaredEnvironments(await show(base)) : {};
  const atCommit = declaredEnvironments(await show(commit));
  const result = { ...none, named: new Map<string, string[]>(), definitions };
  for (const [name, proofs] of wanted) {
    if (definitions[name]) result.named.set(name, proofs);
    else if (atCommit[name]) result.untrusted.push(...proofs);
    else for (const proof of proofs) result.unknown[proof] = `case ${proof.slice(4)} names environment "${name}", which graphyard.json e2e.environments does not declare: declare it with up and down commands, or remove "environment" to run on local`;
  }
  if (result.named.size) {
    result.cwd = await trustedCheckout(git, gate.root, base!);
    result.lifecycle = gate.environments ?? loopLifecycle(environmentStatePath(gate.root), () => join(installSecretsDirectory(gate.root), environmentSecretsFile));
  }
  return result;
}

/** The pinning-test proof a gate filing binds, named from its check: `known-red:test:tests/a-b.test.ts` → `unit:a-b-pinned`. */
export const pinningProof = (key: string) =>
  `unit:${key.slice(key.indexOf(':') + 1).toLowerCase().replace(/^test:tests\//, '').replace(/\.test\.ts$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}-pinned`;

/** The proof a gate filing owes once the batch gate passes again; the loop records it itself (GY-3443). */
export const repairedProof = 'manual:batch-gate-repaired';

/** A batch gate filing's item: its pinning test is named from its check. */
export const gateFiledItem = (input: { title: string; description: string; key: string }, baseBranch: string) =>
  faultItem({ title: input.title, description: input.description, proof: pinningProof(input.key), repaired: { text: 'The batch gate passes again', proof: repairedProof }, reason: `Filed by the batch gate on ${baseBranch}` });

/**
 * GY-3443: while the gate's last outcome is verified, every open item owing `manual:batch-gate-repaired`
 * whose candidate head has no current evidence for it gets a trusted pass citing the verified tip.
 * A held, reverted or failed last outcome records nothing; a head already recorded is skipped, so a
 * cycle writes at most once per item head.
 */
async function recordRepaired(record: GateRecord, work: readonly Work[], attest: NonNullable<MergeWriterReads['attest']>, now: number, note: (key: string, state: 'done' | 'failed', detail: string) => void) {
  const last = record.lastOutcome;
  if (last?.outcome !== 'verified' || !last.tip) return;
  const owing = work.filter(item => item.stage !== 'done' && item.candidate && item.criteria?.some(criterion => criterion.proofs.includes(repairedProof))
    && !currentEvidence(item, repairedProof, new Date(now)));
  for (const item of owing) {
    const head = item.candidate!.sha;
    try {
      await attest(item, repairedProof, `The batch gate verified ${last.tip} at ${last.finishedAt}`, `batch-gate-repaired:${item.id}:${head}:${item.policyRevision}:${last.tip}`);
      note(`batch-gate-repaired:${item.key}`, 'done', `Recorded ${repairedProof} on ${item.key} head ${head.slice(0, 12)}: the batch gate verified ${last.tip.slice(0, 12)}`);
    } catch (error) { note(`batch-gate-repaired:${item.key}`, 'failed', `Could not record ${repairedProof} on ${item.key}: ${message(error)}`); }
  }
}

/** The gate's ports over the merge writer's reads. */
export function batchGatePorts(reads: MergeWriterReads & { git: NonNullable<MergeWriterReads['git']> }, work: readonly Work[], trusted: () => string | null = () => null): GatePorts & { diagnose: DiagnosePort } {
  const git = reads.git;
  const file = async (input: { title: string; description: string; key: string }) => {
    const created = await reads.createWork?.(gateFiledItem(input, reads.baseBranch), input.key);
    return { item: created?.key ?? null };
  };
  const catalog = async (commit: string) => {
    // GY-3336: a repository with no e2e/cases directory — a fresh install of a repository Graphyard
    // has never gated — answers an empty catalog, not a failing gate: `ls-tree COMMIT:e2e/cases`
    // errors "Not a valid object name" on a path the commit does not hold.
    try { return lines(await git(['ls-tree', '--name-only', `${commit}:e2e/cases`])).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)); }
    catch { return []; }
  };
  return {
    now: reads.now,
    fetch: reads.fetch,
    // GY-3199: only the install gating Graphyard itself publishes the verified ref; every other install's gate verifies another repository, whose verified commits no control plane follows.
    ...(reads.gate?.repository.toLowerCase() === graphyardRepository && reads.pushVerified ? { publish: (commit: string) => reads.pushVerified!(commit) } : {}),
    landings: async (from, to) => serveLandings(await serveRangeCommits(git, from, to), work),
    files: async (from, to) => lines(await git(['diff', '--name-only', from, to])),
    catalog,
    core: async commit => {
      try { return [...new Set([featureMapCaseId, ...(JSON.parse(await git(['show', `${commit}:graphyard.json`])).gate?.core ?? [])])]; } catch { return [featureMapCaseId]; }
    },
    run: (commit, checks, files, timeoutMs, signal) => trialChecks(reads, commit, checks, files, timeoutMs, trusted, false, signal),
    revert: async (landing, gated, check) => {
      // Merges may have landed while the gate ran: the revert goes onto main as it stands now.
      const tip = (await reads.fetch()).toLowerCase();
      const revert = await revertMergeCommit(git, { mergeSha: landing.sha, before: landing.before, baseTip: tip, subject: landing.subject });
      if ('conflict' in revert) return { held: `the revert of ${landing.item.key}'s merge ${landing.sha.slice(0, 12)} does not apply cleanly on ${tip.slice(0, 12)}: ${revert.conflict.slice(0, 20).join(', ')}` };
      const files = lines(await git(['diff', '--name-only', tip, revert.revertSha]));
      const pushed = await trialAndPushRevert(reads, { revertSha: revert.revertSha, files, baseTip: tip, culpritKey: landing.item.key, mergeSha: landing.sha });
      if ('held' in pushed) return { held: pushed.held };
      if ('retry' in pushed) return { retry: pushed.retry };
      const failingCase = check.startsWith('e2e:') ? check.slice(4) : null;
      const reland = relandItemFor(landing.item, { serve: gated, failingCase: failingCase ?? check, failingStep: null, failingReason: `the batch gate's check ${check} failed`, mergeSha: landing.sha, baseBranch: reads.baseBranch });
      // A build or test failure names no case: the re-land carries the original criteria alone.
      await reads.createWork?.(failingCase ? reland : { ...reland, criteria: landing.item.criteria.map(({ id, text, proofs }) => ({ id, text, proofs: [...proofs] })) }, `gate-reland:${landing.sha}`).catch(() => null);
      return { revertSha: revert.revertSha };
    },
    file,
    flaky: check => openFlakyItem(work, check)?.key ?? null,
    // The full suite (a package.json change selects every test) and the whole catalog, each its own trial so the catalog's time is its own; then the preview cases, in a repository that holds them.
    diagnose: async commit => {
      const suite = await trialFailures(reads, commit, ['build', 'affected'], ['package.json'], gateLimitMs, trusted);
      const held = await catalog(commit), cases = held.map(id => `e2e:${id}`), started = reads.now();
      const { failed, details, outputs } = cases.length ? await trialFailures(reads, commit, cases, [], gateLimitMs, trusted, true) : { failed: [], details: {}, outputs: {} }, catalogMs = reads.now() - started;
      const previews = reads.gate?.previews;
      const previewCases = !servedPreviewCases.some(id => held.includes(id)) ? []
        : previews ? await previews(commit) : notCovered(commit, new Date(reads.now()).toISOString(), 'this loop runs no served preview cases');
      // GY-3305: the suite trial's details ride with the catalog's — a failing test check (the browser
      // suite among them) keeps its identity whichever trial named it.
      return { failed: [...new Set([...suite.failed, ...failed])], catalogMs, previewCases, details: { ...suite.details, ...details }, outputs: { ...suite.outputs, ...outputs } };
    },
  };
}

const stopped = new WeakSet<object>(), gateRuns = new WeakMap<object, AbortController>();
/** GY-3450: when the gate flight began and whether one of its checks has started (holds its host heavy-job slot). */
const gateStarts = new WeakMap<object, { since: number; started: boolean }>();
/** GY-3450: a gate in flight this long with no check started raises the stall alarm, naming the slot holders. */
export const gateStartStallMs = 5 * 60_000;
export const gateStallKey = 'batch-gate:stalled';
/** Who holds the host's heavy-job slots, as the alarm names them. */
const slotHolders = () => heldSlots(heavyJobsDirectory()).filter(entry => entry.slot < declarationSlot)
  .map(entry => entry.owner ? `${entry.owner.label}${entry.owner.project ? ` (${entry.owner.project})` : ''} [pid ${entry.owner.pid}]` : `slot-${entry.slot}`).join('; ') || 'nothing';

/** GY-3450: raise the stall alarm while the gate in flight has started no check for five minutes; clear it otherwise. */
async function gateStartAlarm(cycle: Pick<Cycle, 'state' | 'effects' | 'now' | 'log'>, file: string) {
  const watch = gateStarts.get(cycle.state), standing = cycle.state.actions[gateStallKey];
  if (watch && !watch.started && cycle.now() - watch.since >= gateStartStallMs) {
    if (standing?.state === 'failed') return;
    const tip = readGateRecord(file)?.inFlight?.tip;
    const entry = storeAction(cycle.state, gateStallKey, { kind: 'attention', work: null, principal: null, state: 'failed', attempts: 1, epoch: null, cycle: cycle.state.cycle, at: new Date(cycle.now()).toISOString(),
      detail: `The batch gate${tip ? ` on ${tip.slice(0, 12)}` : ''} has started no check in ${Math.round((cycle.now() - watch.since) / 60_000)} minutes; the host heavy-job slots are held by ${slotHolders()}`.slice(0, actionDetailMax) });
    cycle.log(actionLine(cycle.state.cycle, entry));
    await cycle.effects.persist?.(cycle.state);
  } else if (standing) {
    delete cycle.state.actions[gateStallKey];
    await cycle.effects.persist?.(cycle.state);
  }
}
/**
 * The loop is stopping: a gate that fails from here on was interrupted, and its record stays as last
 * checkpointed for the next loop (GY-3161). Its host heavy-job slot is freed now (GY-3449); its
 * detached run keeps going for the next loop to adopt.
 */
export const noteBatchGateStopping = (state: object) => { stopped.add(state); gateRuns.get(state)?.abort(); };

/**
 * One record writer at a time per file: the gate's mid-flight checkpoints and the diagnostics'
 * settled write each merge onto the latest state on disk, and two unserialized read-modify-writes
 * interleave — the later write carrying a stale snapshot erases what the earlier one recorded, a
 * batch's finished steps included. Each merge reads inside the chain, after the last write landed.
 */
const recordWrites = new Map<string, Promise<unknown>>();
function mergeGateRecord(file: string, merge: (latest: GateRecord | null) => GateRecord): Promise<void> {
  const chained = (recordWrites.get(file) ?? Promise.resolve()).then(() => writeGateRecord(file, merge(readGateRecord(file))));
  recordWrites.set(file, chained.catch(() => undefined));
  return chained;
}

/** What a gate's write keeps of the diagnostics' own fields (GY-3147, GY-3193): they recorded them meanwhile. */
const diagnosticFields = (latest: GateRecord | null, current: GateRecord) => ({ releaseTagged: latest?.releaseTagged ?? current.releaseTagged, catalogMs: latest?.catalogMs ?? current.catalogMs, diagnosticsAt: latest?.diagnosticsAt ?? current.diagnosticsAt, diagnosticFailures: latest?.diagnosticFailures ?? current.diagnosticFailures, previewCases: latest?.previewCases ?? current.previewCases, ...mergeFilings(latest, current) });

/** The commit served at rollout, which becomes the first verified commit: the deploy record's when it names this repository, else main's tip. */
async function rolloutCommit(root: string, repository: string, reads: MergeWriterReads) {
  const deployed = readDeployRecord(deployRecordPath(root));
  return deployed?.tip && deployed.repository?.toLowerCase() === repository.toLowerCase() ? deployed.tip : (await reads.fetch()).toLowerCase();
}

/**
 * Cycle step beside the merge writer: with no gate in flight, one gate starts on main's tip beside
 * the cycle; the scheduled diagnostics run beside it when due. Neither blocks the cycle or a merge.
 */
export async function batchGateStep(cycle: Pick<Cycle, 'state' | 'effects' | 'snapshot' | 'now' | 'log'>) {
  const reads = cycle.effects.mergeWriter, gate = reads?.gate;
  // GY-3450: a drain never stops the gate — it is the deploy path; the diagnostics wait it out (GY-3304).
  if (!reads?.git || !gate) return null;
  const file = gateRecordPath(gate.root);
  const git = reads.git;
  // GY-3336: while the fetch-refusal backoff stands, neither the gate nor its bootstrap fetches —
  // the refusal is the owner's to fix, and the loop has already said so in one standing line.
  const standing = cycle.state.actions[fetchRefusalKey];
  if (standing?.state === 'failed' && cycle.now() - Date.parse(standing.at) < fetchRetryBackoffMs(standing.attempts)) return null;
  const reading: MergeWriterReads = { ...reads, fetch: async () => {
    try {
      const tip = await reads.fetch();
      if (cycle.state.actions[fetchRefusalKey]) { delete cycle.state.actions[fetchRefusalKey]; await cycle.effects.persist?.(cycle.state); }
      return tip;
    } catch (error) {
      // GY-3464: a fetch the stopping loop interrupted says nothing about the remote.
      if (stopped.has(cycle.state)) throw error;
      const entry = storeAction(cycle.state, fetchRefusalKey, { kind: 'attention', work: null, principal: null, state: 'failed',
        detail: fetchRefusalLine(gate.repository, reads.baseBranch, error), attempts: (cycle.state.actions[fetchRefusalKey]?.attempts ?? 0) + 1, epoch: null, cycle: cycle.state.cycle, at: new Date(cycle.now()).toISOString() });
      cycle.log(actionLine(cycle.state.cycle, entry));
      await cycle.effects.persist?.(cycle.state);
      throw error;
    }
  } };
  const live = flights.get(cycle.state) ?? { gate: null, diagnostics: null };
  flights.set(cycle.state, live);
  let record: GateRecord | null = readGateRecord(file);
  if (!record || record.repository?.toLowerCase() !== gate.repository.toLowerCase()) {
    record = bootstrapGate(gate.repository, await rolloutCommit(gate.root, gate.repository, reading));
    await writeGateRecord(file, record);
  }
  const gated = record;
  // GY-3444: the gate's checks run as detached trial runs, as merge trials do (GY-3159): the run's
  // directory rides the record, so a loop restart — a CLI upgrade among them — adopts the run in
  // place of orphaning it. The diagnostics, and a check with named environments, trial in process.
  // Like every trial it is one heavy job of the host (GY-3290); its wait for that slot is a wait, not its own time.
  let heavyWait = false;
  // GY-3449: the gate flight's lifetime; its end — any outcome, a throw, or the loop stopping — frees the slot its checks hold.
  const ended = new AbortController();
  const trial: MergeWriterReads['trial'] = async (sha, files, item, base, step, timing, heads, _share, signal, timeout) => {
    const share = Math.max(1, busyTrialSlots(cycle.state)), flight = gated.inFlight, proofs = criterionProofs(item);
    const input = createHash('sha256').update(JSON.stringify([proofs, files])).digest('hex');
    // The diagnostics trial another commit and take an ordinary slot; the gate's own check takes the reserved one (GY-3450).
    if (flight?.tip !== sha) return reads.trial(sha, files, item, base, step, timing, heads, share, signal, timeout);
    // GY-3474: what the check is doing now — its wait, then its run's own steps — rides the record for status.
    const progress = (line: string) => {
      step?.(line);
      if (gated.inFlight?.tip !== sha) return;
      gated.inFlight = { ...gated.inFlight, progress: line.slice(0, 200) };
      void mergeGateRecord(file, latest => ({ ...gated, ...diagnosticFields(latest, gated) })).catch(() => undefined);
    };
    // The wait is this call's own: it ends when the check starts and, however the call ends, with it.
    const heavy = <T>(job: () => Promise<T>) => heavyTrial(gateKey, line => { heavyWait = true; progress(line); }, signal, () => {
      heavyWait = false;
      const watch = gateStarts.get(cycle.state);
      if (watch) watch.started = true;
      progress('starting its check');
      return job();
    }, ended.signal, true).finally(() => { heavyWait = false; });
    if (!reads.launchTrialRun || !reads.adoptTrialRun || item.environments) return heavy(() => reads.trial(sha, files, item, base, progress, timing, heads, share, signal, timeout));
    const launch = reads.launchTrialRun, adopt = reads.adoptTrialRun;
    const run = flight.run?.commit === sha && flight.run.input === input ? flight.run : null;
    return heavy(async () => {
      const adopted = run ? await adopt({ key: gateKey, head: sha, mergeSha: sha, directory: run.directory }) : null;
      if (adopted) return adopted.trial(progress, timing, signal);
      await reads.ensureTrialImage?.();
      const launched = launch({ key: gateKey, head: sha, mergeSha: sha, baseTip: null, changedFiles: [...files], proofs, e2eProofs: e2eProofsOf(item),
        reproduce: item.type !== 'chore', cores: null, ...trialShareAllowance(share, timeout, reads.cores) });
      gated.inFlight = { ...gated.inFlight!, run: { commit: sha, input, directory: launched.directory } };
      await mergeGateRecord(file, latest => ({ ...gated, ...diagnosticFields(latest, gated) })).catch(() => undefined);
      return launched.trial(progress, timing, signal);
    });
  };
  const ports = batchGatePorts({ ...reading, git, trial }, cycle.snapshot.work, () => readGateRecord(file)?.verified ?? null);
  // GY-3444: the gate's bound leaves out the time its checks wait for a slot. GY-3474: only its own
  // check's wait — the host heavy-job slot, or its own container start held by the cap, heat or the
  // disk floor. The loop's CPU hold on other launches and another install's gate are not its waits,
  // so a stalled check still meets its bound on a hot or busy host.
  ports.waiting = () => heavyWait || (!!gated.inFlight && trialStartWaiting('gate', gate.slots, trialStartOwner(gate.root, gated.inFlight.tip)));
  const note = (key: string, state: 'done' | 'failed', detail: string) => {
    const entry = storeAction(cycle.state, key,
      { kind: 'merge', work: null, principal: null, state, detail: detail.slice(0, 1900), attempts: 1, epoch: null, cycle: cycle.state.cycle, at: new Date(cycle.now()).toISOString() });
    // The gate settles beside the cycle, so its outcome line reaches the journal here and only here —
    // never through the cycle's own actions, whose logging already passed (GY-3141).
    cycle.log(actionLine(cycle.state.cycle, entry));
  };
  // GY-3199: a verified commit the record never published — a gate whose publish failed, or a
  // record adopted from before the ref existed — is caught up here, before the gate flight adopts
  // the record. A no-op push is one round trip; a failure is one journal line and runs again.
  if (ports.publish && record.verified && record.published !== record.verified) {
    try {
      await ports.publish(record.verified);
      record.published = record.verified;
      await mergeGateRecord(file, latest => ({ ...(latest ?? record!), published: record!.published }));
    } catch (error) {
      note('batch-gate:verified-ref', 'failed', `Could not publish the verified commit ${record!.verified!.slice(0, 12)} at refs/graphyard/verified: ${message(error)}`);
    }
  }
  if (reads.attest) await recordRepaired(record, cycle.snapshot.work, reads.attest, cycle.now(), note);
  // The deploy watch writes this after health, CLI publication and pinning. Re-read every cycle,
  // including after restart; a kept/failed deployment is not a successful release. The deploy
  // record retains verification even when the gate has already advanced to a newer commit.
  // Retire the standing blocker left by the former host publisher.
  delete cycle.state.actions['publish-verified:blocker'];
  const deployed = readDeployRecord(deployRecordPath(gate.root));
  if (reads.pushReleaseTag && gate.repository.toLowerCase() === graphyardRepository &&
      deployed?.repository?.toLowerCase() === graphyardRepository && (deployed.verified || deployed.tip === record.verified) &&
      deployed.tip && !deployed.reason && !deployed.failed && !deployed.restore && record.releaseTagged !== deployed.tip) {
    try {
      const tag = await reads.pushReleaseTag(deployed.tip);
      record.releaseTagged = deployed.tip;
      await mergeGateRecord(file, latest => ({ ...(latest ?? record!), releaseTagged: deployed.tip }));
      note('publish-tag', 'done', `Pushed ${tag}; GitHub Actions publishes the package and images`);
    } catch (error) { note('publish-tag', 'failed', `Could not push the release tag: ${message(error)}`); }
  }
  // GY-3444: the gate has first claim on trial slots — it starts without waiting for a free merge
  // slot, and its trial containers start before queued merge trials (trialStartOrder).
  if (!live.gate) {
    const current = record;
    gateRuns.set(cycle.state, ended);
    gateStarts.set(cycle.state, { since: cycle.now(), started: false });
    live.gate = (async () => {
      try {
        // A timed-out run starts again at once: runGate cleared its batch, so the retry is cut from
        // main's newest tip; a second timeout holds (GY-3383), which ends the loop.
        for (;;) {
          // Each mid-flight write keeps the diagnostics' fields and both writers' filings (GY-3147),
          // as the settled gate's own write does: the batch it carries — tip, files, checks, finished
          // steps — is what the next loop adopts after a restart (GY-3135).
          const before = current.verified;
          const write = () => mergeGateRecord(file, latest => ({ ...current, ...diagnosticFields(latest, current) }));
          const outcome = await runGate({ ...ports, checkpoint: write }, current);
          // The diagnostics' fields and filings are theirs: a gate's write keeps what they recorded meanwhile.
          await write();
          if (outcome.outcome === 'verified' && before) {
            const landings = await ports.landings(before, outcome.tip);
            const reverted = new Set(current.merges.filter(merge => merge.reverted).map(merge => merge.sha));
            await appendReleaseNote(releaseNotesPath(gate.root), releaseNote(outcome.tip, current.verifiedAt ?? new Date(cycle.now()).toISOString(), landings, reverted));
          }
          if (outcome.outcome !== 'idle') {
            const reason = gateOutcomeReason(outcome);
            note(`batch-gate:${outcome.tip}`, outcome.outcome === 'held' ? 'failed' : 'done', `Batch gate on ${outcome.tip.slice(0, 12)}: ${outcome.outcome}${reason !== null ? `: ${reason}` : ''}${outcome.outcome === 'timeout' ? '; retrying now on the newest main' : ''}`);
          }
          if (outcome.outcome !== 'timeout' || stopped.has(cycle.state)) break;
        }
      } catch (error) {
        // The stop killed the gate's children, so the failure is no outcome: nothing is written or logged.
        if (stopped.has(cycle.state)) return;
        // The failed run's outcome is the record's last (GY-3141): write it beside the batch left standing for the next loop.
        await mergeGateRecord(file, latest => ({ ...current, ...diagnosticFields(latest, current) })).catch(() => undefined);
        note('batch-gate', 'failed', `The batch gate failed and runs again next cycle: ${message(error)}`);
      }
      finally { live.gate = null; ended.abort(); gateRuns.delete(cycle.state); gateStarts.delete(cycle.state); }
    })();
  }
  await gateStartAlarm(cycle, file);
  // Diagnostics start without waiting for a slot — the daily check must not starve — but count as a busy
  // trial slot (trial-slots.ts): the merge flights and the gate size around them, and their own trial
  // takes its share of the lanes.
  if (!live.diagnostics && !reads.drain?.()) {
    live.diagnostics = (async () => {
      try {
        const fresh = readGateRecord(file) ?? record;
        const failed = await runDiagnostics(ports, fresh);
        if (failed) {
          // Re-read so the diagnostics' fields never overwrite what a gate recorded meanwhile; the
          // filings of both writers merge (GY-3147).
          await mergeGateRecord(file, latest => ({ ...(latest ?? fresh), catalogMs: fresh.catalogMs, diagnosticsAt: fresh.diagnosticsAt, diagnosticFailures: fresh.diagnosticFailures, previewCases: fresh.previewCases, ...mergeFilings(latest, fresh) }));
          note('batch-gate:diagnostics', 'done', `Diagnostics on ${fresh.verified?.slice(0, 12)}: ${failed.length} failure(s) filed`);
        }
      } catch (error) { note('batch-gate:diagnostics', 'failed', `The diagnostics failed and run again next cycle: ${message(error)}`); }
      finally { live.diagnostics = null; }
    })();
  }
  return { gate: live.gate, diagnostics: live.diagnostics };
}
