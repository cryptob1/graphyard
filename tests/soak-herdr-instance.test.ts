import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { herdrSubcommand, installHerdrInstance, isHerdrCommand, herdrTarget, listHerdrAgents, targetHerdr, type HerdrAgent, type HerdrInstance } from '../src/master/herdr.js';
import { atomicPrivateWrite, liveMasterConfig, loadMasterConfig, recordHerdrInstance } from '../src/master/config.js';
import { loopHerdrReport } from '../src/cli/master/loop.js';
import { LoopRegistry, loopHerdr } from '../src/model/executor-presence.js';
import { hour, minute } from './helpers/soak-world.js';
import { FailoverWorld, failoverInstalled, soakControlPlanes } from './helpers/soak-plane.js';
import { simulateDay } from './helpers/soak-simulation.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * An install with its own Herdr instance (GY-1511) through a real loop day: every dispatch goes
 * through the real `dispatchWork`, its launches, inventory reads, prompt deliveries and pane closes
 * running as herdr commands, which a host with two Herdr servers answers by the instance each one
 * names. The host's default server holds another install's session under the same agent name and
 * workspace, so a single call that reached it would refuse or close the wrong pane. One concern of
 * the release-candidate soak (GY-404), split per concern (GY-1363), and every invariant holds after
 * every cycle.
 */
soakControlPlanes('soak-herdr-instance', 413);

/** A host's two Herdr servers: the install's own instance (the failover world) and the default, another install's. */
class InstanceHost extends FailoverWorld {
  /** Calls the own instance served, and every call that named anything else. */
  served = 0;
  strays: string[] = [];
  /** The other install's session on the default server: same profile name, same workspace id. */
  readonly foreign: HerdrAgent = { name: 'soak-worker-failover', pane_id: 'w1:p900', workspace_id: 'w1', agent: 'claude', agent_status: 'working', cwd: '/home/op/code/other' };
  constructor(readonly instance: HerdrInstance) {
    super(new Set());
    const serve = this.run;
    this.run = (command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
      const session = args[0] === '--session' ? args[1] : null;
      if (!isHerdrCommand(command) || session !== instance.session || options?.env?.XDG_CONFIG_HOME !== instance.configHome || options.env.HERDR_SOCKET_PATH !== undefined) {
        this.strays.push(`${command} ${args.join(' ')} (XDG_CONFIG_HOME=${options?.env?.XDG_CONFIG_HOME ?? 'unset'})`);
        // The default server answers as it would: with the other install's session.
        return JSON.stringify({ result: { agents: [this.foreign], panes: [{ pane_id: this.foreign.pane_id }] } });
      }
      this.served++;
      return serve('herdr', herdrSubcommand(args));
    };
  }
}

test('unit:soak-invariants-hold — an install with its own Herdr instance runs a day of real dispatches, config reloads and presence reads against that instance only: the default server holding another install\'s same-named session is never read, launched into or closed, every pane it opened is cleaned up, its presence stays one bounded record, and every invariant holds', { timeout: 600_000 }, async () => {
  // A herdr reached by any path other than the shared helper's runner would run this binary, which records it.
  const bin = await temporaryDirectory('soak-herdr-bin'), spawned = join(bin, 'spawned.log');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'herdr'), `#!/bin/sh\necho "$*" >> ${JSON.stringify(spawned)}\nexit 1\n`);
  await chmod(join(bin, 'herdr'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${path}`;
  try {
    const { root, master: base } = await failoverInstalled();
    const instance = installHerdrInstance('owner-project', await temporaryDirectory('soak-herdr-home'));
    assert.equal(await recordHerdrInstance(root, instance, 'w1'), true);
    const master = await loadMasterConfig(root);
    assert.deepEqual(master.herdrInstance, instance, 'master.json records the instance');
    assert.deepEqual(herdrTarget(), instance, 'loading it targets every herdr call of this process there');
    assert.equal(base.herdrWorkspace, master.herdrWorkspace);

    const world = new InstanceHost(instance);
    const { final, violations, failures, lost, reportedDispatches, sessions, failover } = await simulateDay({
      hours: 3, failover: { root, master, world, dispatches: [], samples: [] },
      plan: { items: 5, releaseEveryMs: 5 * minute, leftovers: 2, slowRecompute: 0, workMs: 15 * minute, rework: new Set(), deaths: new Set(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), spentProducer: 0, lostRuns: 0, outOfQueue: { item: 5, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 5 } },
    });
    assert.ok(failover, 'the day ran the real dispatch path');
    assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'all five items are delivered');
    assert.deepEqual(violations, [], 'every system invariant holds');
    assert.deepEqual(failures, [], 'no cycle failed');
    assert.deepEqual(lost, [], 'no worker lost its lease');
    assert.equal(reportedDispatches, sessions.length);
    assert.equal(world.launched, 5, 'every item was launched in the instance');
    assert.ok(world.served >= 5 * 4, `every launch's herdr calls reached the instance: ${world.served}`);
    assert.deepEqual(world.strays, [], 'no herdr call reached the default server or ran without the instance');
    assert.equal(await readFile(spawned, 'utf8').catch(() => ''), '', 'no herdr was spawned past the shared helper');
    // Every dispatch reloaded master.json (dispatchWork loads it) and kept the target.
    assert.deepEqual(herdrTarget(), instance);
    // Cleanup: the instance holds no pane the day's launches left open beyond the sessions it delivered.
    const open = world.herdr.list().filter(agent => agent.agent_status === 'working');
    assert.deepEqual(open.map(agent => agent.pane_id), [], 'no launched session is left working');
    assert.equal(world.foreign.agent_status, 'working', 'the other install\'s session is untouched');

    // The loop's reloads across a running day: an unbound change is adopted with the instance kept; a
    // bound change and an unreadable file are refused, and the target the loop runs under is put back.
    const live = liveMasterConfig(root, master);
    const stored = JSON.parse(await readFile(join(root, '.graphyard/master.json'), 'utf8'));
    const registry = new LoopRegistry(), headers = new Set<string>();
    for (let cycle = 0; cycle < 96; cycle++) {
      const edit = cycle % 4;
      if (edit === 0) await atomicPrivateWrite(join(root, '.graphyard/master.json'), { ...stored, run: { ...stored.run, intervalSeconds: 20 + (cycle % 8) } });
      if (edit === 1) await atomicPrivateWrite(join(root, '.graphyard/master.json'), { ...stored, hostId: `moved-${cycle}` });
      if (edit === 2) await writeFile(join(root, '.graphyard/master.json'), '{ not json', { mode: 0o600 });
      if (edit === 3) await atomicPrivateWrite(join(root, '.graphyard/master.json'), stored);
      // Another component pointing this process elsewhere between reloads is undone by the next one.
      if (cycle % 12 === 5) targetHerdr(null);
      const reload = await live.reload();
      assert.equal(reload.refused === null, edit === 0 || edit === 3, `cycle ${cycle}: ${reload.refused}`);
      assert.deepEqual(herdrTarget(), instance, `cycle ${cycle}: the loop's herdr calls still target the instance`);
      // Each cycle's inventory read, and the presence the loop names on its next read.
      const reachable = cycle % 24 !== 23;
      const agents = await listHerdrAgents(reachable ? world.run : (() => { throw new Error('Herdr server is not running'); }), 'w1').catch(() => null);
      assert.equal(agents === null, !reachable);
      if (agents) assert.ok(!agents.some(agent => agent.pane_id === world.foreign.pane_id), 'the inventory is the instance\'s own');
      const header = loopHerdrReport(live.current.hostId);
      headers.add(header);
      assert.ok(header.length < 2_000, 'one bounded header');
      registry.observe({ principal: 'master', intervalSeconds: 20, herdr: loopHerdr(header) }, new Date(Date.UTC(2026, 9, 8) + cycle * 20_000));
      assert.deepEqual(registry.live(new Date(Date.UTC(2026, 9, 8) + cycle * 20_000))?.herdr, { configHome: instance.configHome, session: instance.session, host: master.hostId, running: reachable });
    }
    assert.equal(headers.size, 2, `the presence is one of two values, running or not, never growing: ${[...headers].join(' | ')}`);
    assert.deepEqual(world.strays, [], 'no reload or read reached the default server');
  } finally { process.env.PATH = path; targetHerdr(null); }
});
