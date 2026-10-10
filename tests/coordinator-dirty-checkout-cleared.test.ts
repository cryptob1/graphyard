import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Work } from '../src/model.js';
import { masterConfigSchema } from '../src/master.js';
import { emptyDaemonState, type DaemonState } from '../src/master-daemon.js';
import { coordinatorCheckoutGuard } from '../src/daemon/run.js';
import { readCoordinatorCheckout } from '../src/master/profiles.js';
// A namespace import, so on a tree without GY-1653's grammar each case fails as a case rather than the file failing to load.
import * as pi from '../integrations/pi/index.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1657: escalation:dirty-checkout stood failed on the live loop from 2026-10-10T14:35:55Z, its
// dirty set grown from web/main.tsx alone to six modified source paths at e09c849886c3 by 15:43Z
// (attempts 4), so the loop refused to restart or self-upgrade and kept serving stale code. The
// remedy: land the six edits on the base (this item's pull request), discard them from the
// checkout, and restart the loop onto the base's new HEAD. Replayed below on a real repository
// through the guard the loop runs at startup and between cycles. Each test is named for its proof.

const sixPaths = ['Dockerfile', 'integrations/pi/index.ts', 'src/daemon/acceptance.ts', 'src/runner/pi.ts', 'src/server/routes/goals.ts', 'web/main.tsx'];
const config = () => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: 'graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });

/** The coordinator checkout at the commit the loop loaded (standing in for e09c849886c3), clean. */
async function checkout() {
  const root = await temporaryDirectory('gy-1657'), git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet', '-b', 'main'); git('config', 'user.email', 'loop@example.com'); git('config', 'user.name', 'loop'); git('config', 'commit.gpgsign', 'false');
  for (const path of sixPaths) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), `${path} at the loaded commit\n`); }
  git('add', '.'); git('commit', '--quiet', '-m', 'the commit the loop loaded');
  return { root, git, loaded: git('rev-parse', 'HEAD') };
}

/** The loop's guard over that checkout, its clock advanced one cycle per read. */
function loopGuard(root: string, state: DaemonState, clock: { at: number }, lines: string[]) {
  return coordinatorCheckoutGuard({ state: () => state, read: () => readCoordinatorCheckout(root), agents: async () => [], snapshot: async () => ({ work: [] as Work[], now: new Date(clock.at).toISOString() }),
    persist: async () => {}, now: () => clock.at, log: line => lines.push(line), applies: () => true, enrichMs: 0 });
}
const skipped = async () => ({ outcome: 'skipped' as const, reason: 'no delivered item is verified deployed yet' });

test('integration:dirty-checkout-escalation-clears — once the six dirty paths are landed and discarded, the loop restarted onto the base starts with no dirty-checkout refusal and the escalation records no new failed attempt across consecutive cycles', async () => {
  const repo = await checkout(), state = emptyDaemonState(config()), clock = { at: Date.parse('2026-10-10T14:35:55.226Z') }, lines: string[] = [];
  const running = loopGuard(repo.root, state, clock, lines);
  assert.equal(await running.start(repo.loaded), null, 'the loop started clean');

  // The fault: web/main.tsx first, then all six, each growth of the dirty set one more failed attempt.
  writeFileSync(join(repo.root, 'web/main.tsx'), 'a crypto.randomUUID fallback\n');
  clock.at += 60_000;
  assert.match((await running.betweenCycles(skipped)).refusal ?? '', /refuses to start, self-upgrade or restart from the coordinator checkout/);
  for (const path of sixPaths.slice(0, 5)) writeFileSync(join(repo.root, path), `${path} edited in the coordinator checkout\n`);
  for (let cycle = 0; cycle < 3; cycle++) {
    clock.at += 60_000;
    const { refusal, upgraded } = await running.betweenCycles(skipped);
    for (const path of sixPaths) assert.ok(refusal?.includes(path), `the refusal names ${path}: ${refusal}`);
    assert.equal(upgraded, null, 'no self-upgrade from a dirty checkout');
  }
  const failed = state.actions['escalation:dirty-checkout'];
  assert.equal(failed?.state, 'failed');
  const attempts = failed!.attempts;
  assert.ok(attempts >= 2, `the growing dirty set recorded failed attempts: ${attempts}`);

  // The remedy: the edits land on main as a commit newer than the loaded one, and the checkout is discarded onto it.
  for (const path of sixPaths) writeFileSync(join(repo.root, path), `${path} as landed on main\n`);
  repo.git('commit', '--quiet', '-am', 'GY-1657: land the coordinator checkout\'s six edits');
  const landed = repo.git('rev-parse', 'HEAD');
  assert.equal(repo.git('status', '--porcelain'), '', 'the checkout reports no modified and no untracked path');
  assert.notEqual(landed, repo.loaded);

  // Restarted through its supervisor: the new loop loads the checkout's HEAD and refuses nothing.
  const restarted = loopGuard(repo.root, state, clock, lines);
  clock.at += 60_000;
  assert.equal(await restarted.start(landed), null, 'the restarted loop starts with no dirty-checkout refusal');
  assert.equal(state.actions['escalation:dirty-checkout']?.state, 'done', 'the standing escalation is settled');
  assert.match(state.actions['escalation:dirty-checkout']?.detail ?? '', /clean again/);
  assert.ok(lines.some(line => /escalation done: .* clean again/.test(line)), 'the settlement is said in the journal');
  for (let cycle = 0; cycle < 3; cycle++) {
    clock.at += 60_000;
    assert.equal((await restarted.betweenCycles(skipped)).refusal, null, `cycle ${cycle + 1} refuses nothing`);
    assert.equal(state.actions['escalation:dirty-checkout']?.state, 'done');
    assert.equal(state.actions['escalation:dirty-checkout']?.attempts, attempts, `cycle ${cycle + 1} records no new failed attempt`);
  }
});

test('integration:coordinator-serves-current-release — the restarted loop runs the checkout\'s new HEAD, not the commit it loaded, and the doctor grammar delivered while the fault stood (GY-1653) is what the integration serves', async () => {
  const repo = await checkout(), state = emptyDaemonState(config()), clock = { at: Date.parse('2026-10-10T16:00:00.000Z') }, lines: string[] = [];
  const before = loopGuard(repo.root, state, clock, lines);
  assert.equal(await before.start(repo.loaded), null);
  assert.equal(before.expected(), repo.loaded);
  for (const path of sixPaths) writeFileSync(join(repo.root, path), `${path} as landed on main\n`);
  repo.git('commit', '--quiet', '-am', 'GY-1657: land the coordinator checkout\'s six edits');
  const landed = repo.git('rev-parse', 'HEAD');
  const restarted = loopGuard(repo.root, state, clock, lines);
  assert.equal(await restarted.start(landed), null);
  assert.equal(restarted.expected(), landed, 'the restarted loop runs a commit newer than the one it loaded');
  assert.equal(repo.git('merge-base', '--is-ancestor', repo.loaded, landed) === '', true, 'and that commit descends from it');

  // This tree's integration carries GY-1653's grammar alongside the landed acceptance schema: a doctor
  // unblock whose quoted reason holds prose bigrams is accepted, and a command smuggled after it refused.
  assert.equal(typeof pi.doctorCommandVerdict, 'function', 'the integration judges the doctor\'s commands by their grammar');
  const context = { cwd: process.cwd(), cli: '/opt/graphyard/bin/graphyard.mjs', env: {} };
  const accepted = pi.doctorCommandVerdict(`node ${context.cli} master unblock GY-1652 "requirements revised (policy revision 3); most recent attempt green"`, context);
  assert.equal(accepted.allow, true, JSON.stringify(accepted));
  const refused = pi.doctorCommandVerdict(`node ${context.cli} master unblock GY-1652 "most recent"; rm -rf src`, context);
  assert.equal(refused.allow, false, 'the grammar stays enforced');
});
