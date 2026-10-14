import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as restoreAct from '../src/cli/master-checkout-restore.js';
import * as loopRun from '../src/daemon/run.js';
import { fileCheckoutRestoreRequest, readCheckoutRestoreRequest, restoreInProcess, serveCheckoutRestore, checkoutRestoreRefPrefix } from '../src/cli/master-checkout-restore.js';
import { coordinatorCheckoutGuard } from '../src/daemon/run.js';
import { doctorPrompt, routineRemedies } from '../src/daemon/doctor.js';
import { emptyDaemonState, type DaemonEffects } from '../src/master-daemon.js';
import { emptyHeldDecisions } from '../src/daemon/decision-reads.js';
import { Launcher, type Cycle } from '../src/daemon/cycle.js';
import { Timings } from '../src/master/timings.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { readCoordinatorCheckout } from '../src/master/profiles.js';
import { installUnitsFile, perInstallUnits } from '../src/install/units.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// Namespace imports: a run without this change still loads the file, and its cases fail instead of the import.
// Time-bomb allowance (GY-1745): the 2030-01-01 clock is handed to the guard and the cycle explicitly; Date is never read here.
// GY-1745: a coordinator checkout whose detached HEAD carries commits that are not on the base branch
// had no automatic remedy — the loop stayed behind for two days and four items parked asking the
// operator to move their own commits. The restore act saves such a HEAD under a ref and detaches the
// checkout at the serving release; the doctor files the request itself; and a loop running under a
// supervisor unit records .graphyard/units.json from that unit.

const clock = Date.parse('2030-01-01T00:00:00Z');
const noQuiesce = async () => ({ thaw: () => {} });

/** A repository whose origin/main is M, with a commit L the loop loaded and a commit D neither on main nor above L. */
async function fixture(label: string) {
  const root = await temporaryDirectory(`${label}-`, tmpdir());
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@localhost', ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  const commit = (name: string, parent: string) => { git('checkout', '-q', '--detach', parent); writeFileSync(join(root, `${name}.txt`), `${name}\n`); git('add', '-A'); git('commit', '-q', '-m', name); return git('rev-parse', 'HEAD'); };
  writeFileSync(join(root, 'a.txt'), 'a\n'); git('add', '-A'); git('commit', '-q', '-m', 'a');
  const a = git('rev-parse', 'HEAD'), merged = commit('merged', a), loaded = commit('loaded', a), diverged = commit('diverged', a), forward = commit('forward', loaded);
  git('update-ref', 'refs/remotes/origin/main', merged);
  git('checkout', '-q', '--detach', diverged);
  return { root, git, a, merged, loaded, diverged, forward, inputs: { base: 'refs/remotes/origin/main', loaded, serving: merged } };
}

test('unit:diverged-checkout-saved-and-moved — a clean detached HEAD neither on the base branch nor above the loaded commit is saved under refs/graphyard/checkout-restore/diverged-* and the checkout is detached at the serving release, and the loop adopts it and asks the restart; an ancestor of the base tip, or a descendant of the loaded commit, takes the existing paths unchanged', async () => {
  const { root, git, a, merged, loaded, diverged, forward, inputs } = await fixture('diverged-restore');
  const at = new Date(clock);
  // Judged: only the diverged HEAD is.
  assert.equal(await restoreAct.divergedHead(root, inputs), diverged);
  git('checkout', '-q', '--detach', a); assert.equal(await restoreAct.divergedHead(root, inputs), null, 'an ancestor of the base tip is merged code');
  git('checkout', '-q', '--detach', merged); assert.equal(await restoreAct.divergedHead(root, inputs), null, 'the base tip itself');
  git('checkout', '-q', '--detach', forward); assert.equal(await restoreAct.divergedHead(root, inputs), null, 'a descendant of the loaded commit moved forward');
  git('checkout', '-q', 'main'); assert.equal(await restoreAct.divergedHead(root, inputs), null, 'a branch checkout is not detached');

  // The existing paths are unchanged for an ancestor and a forward HEAD: the act moves nothing.
  for (const head of [a, forward]) {
    git('checkout', '-q', '--detach', head);
    const outcome = await restoreInProcess(undefined, noQuiesce, null, async () => inputs)(root, 'reason', at, { file: 'f', id: 'i' });
    assert.deepEqual({ restored: outcome.restored, diverged: outcome.diverged ?? null, head: outcome.head }, { restored: null, diverged: null, head });
  }
  assert.equal(git('for-each-ref', checkoutRestoreRefPrefix), '', 'nothing was saved');

  // The diverged HEAD: saved under a ref, the checkout detached at the serving release, clean.
  git('checkout', '-q', '--detach', diverged);
  const outcome = await restoreInProcess(undefined, noQuiesce, null, async () => inputs)(root, 'escalation:dirty-checkout', at, { file: 'f', id: 'i' });
  assert.equal(outcome.restored, null);
  assert.ok(outcome.diverged?.ref.startsWith(`${checkoutRestoreRefPrefix}diverged-20300101T000000Z-${diverged.slice(0, 12)}`), outcome.diverged?.ref);
  assert.equal(git('rev-parse', outcome.diverged!.ref), diverged, 'the old HEAD is reachable from the ref');
  assert.equal(git('rev-parse', 'HEAD'), merged); assert.equal(outcome.head, merged);
  assert.equal(await restoreAct.divergedHead(root, inputs), null, 'the checkout stands detached at the serving release, no longer diverged');
  assert.equal(git('status', '--porcelain'), '');

  // The loop's side: the outcome is an adoption of the release it moved onto, with the restart asked.
  git('checkout', '-q', '--detach', diverged);
  const base = await temporaryDirectory('diverged-state-', tmpdir()), file = join(base, 'request.json');
  await fileCheckoutRestoreRequest(file, 'escalation:dirty-checkout', 'graphyard-doctor');
  const settled: (string | null)[] = []; let restarts = 0;
  const served = await serveCheckoutRestore(file, root, {
    pid: 100, restart: async () => { restarts++; }, settle: async adopt => { settled.push(adopt); }, loaded: () => loaded,
    restore: async (checkout, reason, when) => ({ ...(await restoreInProcess(undefined, noQuiesce, null, async () => inputs)(checkout, reason, when, { file, id: 'i' })), served: 'served from the test' }),
  });
  assert.equal(served?.state, 'adopted', served?.detail);
  assert.equal(served!.commit, merged); assert.ok(served!.ref?.includes('diverged-'), served!.ref ?? 'no ref');
  assert.match(served!.detail, /neither on the base branch nor a descendant of the commit the loop runs/);
  assert.deepEqual(settled, [merged]); assert.equal(restarts, 1);
  assert.equal((await readCheckoutRestoreRequest(file))?.outcome?.restart?.state, 'requested');
  assert.equal(git('rev-parse', served!.ref!), diverged);
});

test('unit:diverged-checkout-doctor-files-request — the escalation for a diverged HEAD names the restore the installation runs itself, with no human answer, and the doctor\'s dirty-checkout remedy names and files that request', async () => {
  const { root, diverged, loaded, inputs } = await fixture('diverged-escalation');
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: join(root, '.cred', 'master.token'), cliPath: join(root, 'bin', 'graphyard.mjs'),
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
  const state = emptyDaemonState(config);
  const guard = coordinatorCheckoutGuard({ state: () => state, read: () => readCoordinatorCheckout(root), agents: async () => [], snapshot: async () => ({ work: [], now: new Date(clock).toISOString() }), persist: async () => {}, now: () => clock, log: () => {}, applies: () => true,
    diverged: async (checkout, from) => (await restoreAct.divergedHead(checkout.root, { base: inputs.base, loaded: from })) === checkout.commit });
  execFileSync('git', ['-C', root, 'checkout', '-q', '--detach', loaded]);
  assert.equal(await guard.start(loaded), null);
  execFileSync('git', ['-C', root, 'checkout', '-q', '--detach', diverged]);
  const refusal = (await guard.betweenCycles()).refusal;
  assert.ok(refusal?.includes(`its HEAD moved from ${loaded.slice(0, 12)} to ${diverged.slice(0, 12)}`), refusal ?? 'no refusal');
  assert.ok(refusal!.endsWith(loopRun.checkoutRestoreDivergedRemedy), 'the escalation names the diverged remedy');
  assert.match(loopRun.checkoutRestoreDivergedRemedy, /needs no human answer and no worker parks it/);
  assert.match(loopRun.checkoutRestoreDivergedRemedy, /refs\/graphyard\/checkout-restore\/diverged-/);

  // A merged-code move keeps the existing escalation: no diverged remedy.
  execFileSync('git', ['-C', root, 'checkout', '-q', '--detach', inputs.serving]);
  const merged = (await guard.betweenCycles()).refusal;
  assert.ok(merged && !merged.includes('This HEAD is diverged'), merged ?? 'no refusal');

  // The doctor is told to file the request for it.
  const prompt = doctorPrompt({ repository: 'owner/project', cliPath: '/cli/graphyard.mjs' }, { items: [], faults: [] });
  assert.match(prompt, /master checkout-restore with a quoted reason/);
  assert.match(prompt, /escalation naming a diverged HEAD \(neither on the base branch nor a descendant of the commit the loop runs\)/);
  assert.match(prompt, /refs\/graphyard\/checkout-restore\/diverged-\*/);
});

test('unit:units-file-recorded-from-running-unit — with .graphyard/units.json absent and the loop running under a supervisor unit that runs the checkout, the loop records the file from that unit; with no unit it records the waiting row as today', async () => {
  const root = await temporaryDirectory('diverged-units-', tmpdir()), units = await temporaryDirectory('diverged-units-dir-', tmpdir());
  execFileSync('git', ['init', '-q', root]);
  const config: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: join(root, '.cred', 'master.token'), cliPath: join(root, 'bin/graphyard.mjs'),
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
  const master = perInstallUnits('owner/project').master;
  writeFileSync(join(units, master), `[Unit]\nDescription=Graphyard master\n\n[Service]\nWorkingDirectory=${root}\nExecStart=/usr/bin/node ${root}/bin/graphyard.mjs master run\n`);
  const cycle = (harness: NonNullable<DaemonEffects['harness']>): Cycle => {
    const observedAt = new Date(clock).toISOString();
    const effects = { agents: () => [], credentials: async () => ({}), snapshot: async () => ({ work: [], now: observedAt }), persist: async () => {}, harness } as unknown as DaemonEffects;
    return { config, state: emptyDaemonState(config), effects, now: () => clock, snapshot: { work: [], now: observedAt }, clock, clockOffset: { min: 0, max: 0 },
      performed: [], agents: [], credentials: {}, open: [], owns: () => false, heldBy: () => null, timings: new Timings(() => clock),
      launcher: new Launcher(Number.POSITIVE_INFINITY), launch: () => false, detached: false, heldDecisions: emptyHeldDecisions(), closedPanes: new Set(),
      isolate: async (_kind, _item, _name, body) => await body(), baseFailed: new Map(), exhaustedProofs: async () => [] } as Cycle;
  };
  // No unit: the waiting row, as today, and nothing recorded.
  const waiting = cycle({ unitDirectory: units });
  await routineRemedies(waiting);
  const row = waiting.state.actions['remedy:harness:claude']!;
  assert.equal(row.state, 'waiting', row.detail);
  assert.ok(row.detail.includes(`records no units (${installUnitsFile} is absent)`), row.detail);
  assert.equal(existsSync(join(root, installUnitsFile)), false);
  // The loop runs under the unit that runs the checkout, though a leftover legacy-named unit runs it too (which makes the proposal the legacy alias): the file is recorded from the serving unit.
  writeFileSync(join(units, 'graphyard-master.service'), readFileSync(join(units, master), 'utf8'));
  const running = cycle({ unitDirectory: units, servingUnit: master });
  await routineRemedies(running);
  const recorded = running.state.actions['remedy:harness:claude']!;
  assert.equal(recorded.state, 'done', recorded.detail);
  assert.ok(recorded.detail.startsWith(`Recorded this install's units (${master}, `), recorded.detail);
  assert.deepEqual(JSON.parse(readFileSync(join(root, installUnitsFile), 'utf8')), perInstallUnits('owner/project'));
});
