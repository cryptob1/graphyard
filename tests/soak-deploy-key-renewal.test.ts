import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { lastLoopSelfProvision, loopProvisionDelay, loopSelfProvision, setupRenewingDeployKey, type masterSetup } from '../src/cli/master-setup.js';
import { DEPLOY_KEY_FILE, ensureDeployKey, publicKeyFingerprint } from '../src/install/deploy-key.js';
import type { GitHubCli } from '../src/install/github.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1978. Every loop setup run now renews the merge writer's deploy key beside `master setup`
 * (setupRenewingDeployKey, composed exactly as src/daemon/effects-production.ts composes it), so
 * two simulated days of the real loop — a cycle a minute — run it against a scripted repository
 * whose deploy keys gh lists and adds. The first run generates the key and registers it; then gh's
 * list fails for three hours, an administrator deletes the key, the key is deleted again while gh
 * refuses to add one, and the setup itself fails for two hours. After every cycle and at the end: the
 * step runs once an hour while healthy and backs off from ten minutes after a failed run
 * (`loopProvisionDelay`), never every cycle; a run fails exactly while a fault stands, and the cycle
 * after it records the setup step's one isolated config action; gh lists once per run and adds only
 * when the key is missing, so the repository never holds the key twice and holds it again on the
 * first run after each fault lifts; the key is generated once; no private key material reaches
 * anything the loop keeps; and every system invariant the loop checks holds.
 */
const minute = 60_000, hour = 60 * minute;
const start = Date.parse('2026-10-12T06:00:00.000Z');
const repository = 'owner/project';
const PRIVATE = '-----BEGIN OPENSSH PRIVATE KEY-----\nSENTINEL-PRIVATE-KEY-MATERIAL\n-----END OPENSSH PRIVATE KEY-----\n';
const PUBLIC_BODY = 'AAAAC3NzaC1lZDI1NTE5AAAAIFzs4bbnB6bJVeLLB+C7aK2b6qJ9fcQ0Y6hVwLrjQJvQ';
/** The windows, in minutes from the start, each fault stands in. */
const windows = { listFails: { from: 10 * 60, to: 13 * 60 }, deletedOutOfBand: 20 * 60, deletedWhileAddRefused: { from: 30 * 60, to: 32 * 60 }, setupFails: { from: 40 * 60, to: 42 * 60 } };
const within = (at: number, window: { from: number; to: number }) => at >= window.from && at < window.to;

const config = (root: string): MasterConfig => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: join(root, '.graphyard-credentials/master/token'), cliPath: join(root, 'bin/graphyard.mjs'),
  repository, baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { intervalSeconds: 60 } });

test('unit:soak-deploy-key-renewal — over two simulated days the loop renews the deploy key on every setup run: listed once per run, registered only when missing and never twice, a failed list, a deleted key, a refused add and a failed setup each fail the run, back off from ten minutes and recover on the first run after they lift, the key is generated once, no private key leaks, and every system invariant holds', { timeout: 300_000 }, async () => {
  const root = await temporaryDirectory('soak-deploy-key-renewal'), keyDirectory = join(root, 'install');
  try {
    const master = config(root);
    let now = start, at = 0;
    // ---- The repository's deploy keys, as gh lists and adds them.
    const github = { keys: [] as { id: number; key: string; title: string }[], lists: [] as number[], adds: [] as { at: number; added: boolean }[], listFails: false, addRefused: false };
    const gh: GitHubCli = async args => {
      assert.equal(args.join(' ').includes('SENTINEL'), false, 'the private key never reaches gh');
      if (args[2] === 'list') {
        github.lists.push(at);
        if (github.listFails) throw new Error('gh repo deploy-key list failed: HTTP 502: Bad Gateway');
        return { stdout: JSON.stringify(github.keys), stderr: '', code: 0 };
      }
      assert.deepEqual(args.slice(0, 3), ['repo', 'deploy-key', 'add'], `an unexpected gh call: ${args.join(' ')}`);
      github.adds.push({ at, added: !github.addRefused });
      if (github.addRefused) throw new Error('gh repo deploy-key add failed: HTTP 403: Resource not accessible by integration');
      github.keys.push({ id: github.keys.length + 1, key: (await readFile(args[3]!, 'utf8')).trim(), title: args[args.indexOf('--title') + 1]! });
      return { stdout: '✓ Deploy key added\n', stderr: '', code: 0 };
    };
    const keygens: number[] = [];
    const keygen = async (args: string[]) => {
      keygens.push(at);
      const file = args[args.indexOf('-f') + 1]!;
      await writeFile(file, PRIVATE, { mode: 0o600 });
      await writeFile(`${file}.pub`, `ssh-ed25519 ${PUBLIC_BODY} ${args[args.indexOf('-C') + 1]}\n`, { mode: 0o600 });
      return { stdout: '', stderr: '', code: 0 };
    };
    // ---- The setup run the loop wraps: it derives nothing here, and fails while its window stands.
    let setupFails = false;
    const setup = (async () => {
      if (setupFails) throw new Error('the provider refused the redeploy');
      return { set: [], redeployed: [], next: null };
    }) as unknown as typeof masterSetup;
    const effects = {
      agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
      snapshot: async () => ({ work: [], now: new Date(now).toISOString() }),
      closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, persist: async () => {},
      observeDeployment: async () => ({ source: 'endpoint', sha: 'd'.repeat(40), at: new Date(now).toISOString(), reason: null, deployed: [], pending: [] }), recordDeployment: async () => {}, requestSmoke: () => {},
      selfProvision: async () => loopSelfProvision(root, master, { now, setup: setupRenewingDeployKey(() => ensureDeployKey(keyDirectory, repository, gh, { keygen, hostname: 'machine-a' }), setup) }),
    } as unknown as DaemonEffects;

    const state = emptyDaemonState(master);
    const violations: string[] = [], runs: { at: number; failed: boolean; outcome: string }[] = [], recordedFailures: number[] = [];
    const registered = () => github.keys.filter(entry => publicKeyFingerprint(entry.key) === publicKeyFingerprint(`ssh-ed25519 ${PUBLIC_BODY}`)).length;
    for (let cycle = 0; now < start + 48 * hour; cycle++, now += minute) {
      at = (now - start) / minute;
      // The world as this minute finds it.
      if (at === windows.deletedOutOfBand || at === windows.deletedWhileAddRefused.from) github.keys = [];
      github.listFails = within(at, windows.listFails);
      github.addRefused = within(at, windows.deletedWhileAddRefused);
      setupFails = within(at, windows.setupFails);

      const result = await runCycle(master, state, effects, () => now);
      // The step runs beside the cycle; its outcome lands before the next minute, as a real minute lets it.
      while ((await lastLoopSelfProvision(root))?.outcome === 'running') await new Promise(resolve => setTimeout(resolve, 1));
      const last = (await lastLoopSelfProvision(root))!;
      if (last.at === new Date(now).toISOString()) runs.push({ at, failed: last.failed, outcome: last.outcome });
      for (const check of state.invariants.report) if (!check.holds) violations.push(`cycle ${cycle} (+${at} min): ${check.invariant} — ${check.reading}`);
      const isolated = Object.keys(state.actions).filter(name => name.startsWith('isolated:'));
      assert.ok(isolated.every(name => name === 'isolated:config:setup self-provision'), `cycle ${cycle} (+${at} min): a failure other than the setup step's reached an isolation record: ${isolated.join(', ')}`);
      const failedStep = result.actions.filter(action => action.kind === 'config' && /self-provision/.test(action.detail));
      assert.ok(failedStep.length <= 1, `cycle ${cycle} (+${at} min): one setup action at most`);
      if (failedStep.length) recordedFailures.push(at);
      assert.ok(registered() <= 1, `cycle ${cycle} (+${at} min): the repository never holds the key twice`);
      assert.ok(!`${last.outcome} ${JSON.stringify(result.actions)}`.includes('SENTINEL'), `cycle ${cycle} (+${at} min): private key material reached the loop's record`);
    }
    assert.deepEqual(violations, [], 'every system invariant holds after every cycle');

    // Bounded: once an hour while healthy; after failures in a row, loopProvisionDelay of them — ten minutes, doubling — never every cycle.
    let failures = 0;
    for (const [index, run] of runs.entries()) {
      if (index) assert.equal((run.at - runs[index - 1]!.at) * minute, loopProvisionDelay(failures), `+${run.at} min: the wait after ${failures} failure(s) in a row`);
      failures = run.failed ? failures + 1 : 0;
    }
    assert.ok(runs.length >= 40 && runs.length <= 60, `about one run an hour over two days: ${runs.length}`);
    // A run fails exactly while a fault stands: the deleted key only while gh refuses to add it back.
    const faulted = (minute: number) => within(minute, windows.listFails) || within(minute, windows.deletedWhileAddRefused) || within(minute, windows.setupFails);
    assert.deepEqual(runs.filter(run => run.failed).map(run => run.at), runs.filter(run => faulted(run.at)).map(run => run.at), 'a run fails exactly while a fault stands');
    for (const window of [windows.listFails, windows.deletedWhileAddRefused, windows.setupFails]) {
      const failed = runs.filter(run => within(run.at, window));
      assert.ok(failed.length >= 2 && failed.every(run => run.failed), `each fault fails its runs and is retried with backoff: ${failed.map(run => run.at).join(', ')}`);
      assert.equal(runs.find(run => run.at >= window.to)!.failed, false, 'the first run after the fault lifts recovers');
    }
    for (const run of runs.filter(run => within(run.at, windows.listFails))) assert.match(run.outcome, /^failed: gh repo deploy-key list failed: HTTP 502/);
    for (const run of runs.filter(run => within(run.at, windows.deletedWhileAddRefused))) assert.match(run.outcome, /^failed: gh repo deploy-key add failed: HTTP 403/);
    for (const run of runs.filter(run => within(run.at, windows.setupFails))) assert.match(run.outcome, /^failed: the provider refused the redeploy/);
    assert.deepEqual(recordedFailures, runs.filter(run => run.failed).map(run => run.at + 1), 'the cycle after each failed run records the setup step\'s failed action, and no other cycle does');

    // The key: generated once, listed once per run, registered on the first run, on the first run after the out-of-band deletion,
    // and on the first run gh accepts after the second deletion; nothing is added while the key is listed.
    assert.deepEqual(keygens, [0], 'the key pair is generated once');
    assert.deepEqual(github.lists, runs.map(run => run.at), 'one list per run, settled within it, never per cycle');
    const firstRunFrom = (minute: number) => runs.find(run => run.at >= minute)!.at;
    const refusedAdds = runs.filter(run => within(run.at, windows.deletedWhileAddRefused)).map(run => ({ at: run.at, added: false }));
    assert.deepEqual(github.adds, [{ at: 0, added: true }, { at: firstRunFrom(windows.deletedOutOfBand), added: true }, ...refusedAdds, { at: firstRunFrom(windows.deletedWhileAddRefused.to), added: true }], 'an add only while the key is missing, one per run');
    assert.equal(registered(), 1, 'the two days end with the key registered once');
    assert.deepEqual(github.keys.map(entry => entry.title), ['graphyard-merge-writer-machine-a']);
    assert.equal(await readFile(join(keyDirectory, DEPLOY_KEY_FILE), 'utf8'), PRIVATE, 'the key is the one generated on the first run');
    const status = await readFile(join(root, '.graphyard', 'setup-self-provision.json'), 'utf8');
    assert.ok(!status.includes('SENTINEL'), 'no private key material reaches the kept status file');
    assert.equal(runs.at(-1)!.failed, false, 'the two days end healthy');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
