import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { emptyDaemonState, failoverKey, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { inspectProfileAccounts, masterConfigSchema, observedExhaustions, preservePartialWork, recordObservedExhaustion, selectAccount, type MasterConfig } from '../src/master.js';
import { idleLeaseKey } from '../src/daemon/cycle-resume.js';
import type { Principal, Work } from '../src/model.js';
import type { InvariantCheck } from '../src/model/invariants.js';
import { clock, hour, minute } from './helpers/soak-world.js';
import { api, engine, id, launcher, principals, repository, soakControlPlanes, store, url } from './helpers/soak-plane.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1817 soak: two simulated days of the real loop on a host whose two pi workers launch on Z.AI
 * accounts pi-a (preferred) and pi-b. pi-a is spent until a reset 30 hours in; every session launched
 * on it in that window gives up on pi's `Error: 429: {"code":"1310","message":"Weekly/Monthly Limit
 * Exhausted. Your limit will reset at …"}` — a zone-less wall clock, in UTC — and Herdr reads it
 * idle. Sessions on a healthy account end another way 40 minutes in, so the items relaunch all day.
 * The loop host sits in Asia/Kolkata. Every 1310 session is failed over on the next reconcile pass,
 * never re-prompted or waited out as idle; pi-a is held to the provider's UTC instant, not the host's
 * reading of it; no launch lands on pi-a while that hold stands; pi-a takes launches again once it
 * lapses; and every system invariant holds after every cycle.
 */
soakControlPlanes('soak-pi-provider-limit', 1817);

const step = minute, noticeMs = 10 * minute, workMs = 40 * minute, spentMs = 30 * hour, days = 2;
const settlementToken = 'e'.repeat(64);
/** The provider's reset as pi prints it: the UTC wall clock with no zone. */
const zoneless = (instant: number) => new Date(instant).toISOString().slice(0, 19).replace('T', ' ');
const piPane = (reset: number) => `● Reading the item before editing.
  ⎿ Read 40 lines

Error: 429: {"code":"1310","message":"Weekly/Monthly Limit Exhausted. Your limit will reset at ${zoneless(reset)}"}
Retry failed after 3 attempts
`;

test('unit:soak-invariants-hold — over two days, every pi session on a spent Z.AI account that gives up on 429 code 1310 is failed over on the next reconcile pass with its account held to the provider\'s UTC reset, no launch lands on the held account until it lapses, the account takes launches again after, and every invariant holds after every cycle', { timeout: 600_000 }, async () => {
  const zone = process.env.TZ;
  // The loop host is not in the provider's zone: a reset read in the host's zone would hold pi-a 5½ hours short.
  process.env.TZ = 'Asia/Kolkata';
  try {
    const dayStart = clock.now(), resetAt = Math.ceil((dayStart + spentMs) / 1000) * 1000, dayEnd = dayStart + days * 24 * hour;
    const home = await temporaryDirectory('soak-pi-limit-home');
    for (const account of ['pi-a', 'pi-b']) {
      await mkdir(join(home, account, 'opencode'), { recursive: true });
      await writeFile(join(home, account, 'opencode/auth.json'), JSON.stringify({ 'zai-coding-plan': { key: 'not-a-real-key' } }));
    }
    const profiles = ['one', 'two'];
    const worker = (name: string): Principal => ({ id: `worker-${name}`, role: 'worker' });
    const config = masterConfigSchema.parse({
      version: 1, url, credentialFile: join(home, 'coordinator.token'), cliPath: launcher, repository, baseBranch: 'main', githubAppId: 1234, hostId: 'soak-pi-host', masterAgentName: 'graphyard-master-pi-soak',
      workers: profiles.map(name => ({ name, principal: `worker-${name}`, agentName: `pi-${name}`, mode: 'launch', kind: 'pi', credentialFile: join(home, `${name}.token`), accounts: ['pi-a', 'pi-b'] })),
      environments: [{ name: 'pi-a', kind: 'opencode', home: join(home, 'pi-a') }, { name: 'pi-b', kind: 'opencode', home: join(home, 'pi-b') }],
    }) as MasterConfig;

    interface Launch { key: string; id: string; epoch: number; profile: string; account: string | null; pane: string; path: string; at: number; ended?: 'notice' | 'other' }
    let agents: { name: string; pane_id: string; agent_status: string }[] = [];
    const output = new Map<string, string>(), launches: Launch[] = [], prompted: string[] = [], stopped: string[] = [];
    const effects: DaemonEffects = {
      agents: () => agents,
      herdr: () => ({ agents, available: true }),
      credentials: () => inspectProfileAccounts(config, 'worker', config.workers, Object.fromEntries(config.workers.map(profile => [profile.name, { available: true, reason: null as string | null }])), { quota: false, cacheMs: 0 }),
      snapshot: async () => { const snapshot = await api(principals.coordinator, 'GET', 'work-snapshot'); return { work: snapshot.work as Work[], now: snapshot.now }; },
      closeSession: pane => { agents = agents.filter(agent => agent.pane_id !== pane); },
      dispatch: async (work, profile) => {
        // The real selection: the first of the profile's accounts that is logged in and not held.
        const selected = await selectAccount(config, 'worker', profile, { quota: false, cacheMs: 0, work: work.key });
        const claimed = await api(worker(profile.name), 'POST', `work/${work.id}/claim`, {}) as Work;
        const path = await temporaryDirectory(`soak-pi-${work.key}-${claimed.epoch}`);
        execFileSync('git', ['-C', path, 'init', '-q', '-b', `graphyard/${work.key.toLowerCase()}-${claimed.epoch}`]);
        await writeFile(join(path, 'README.md'), 'base\n');
        execFileSync('git', ['-C', path, 'add', '-A']);
        execFileSync('git', ['-C', path, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base']);
        await api(worker(profile.name), 'POST', `work/${work.id}/workspace`, { epoch: claimed.epoch, host: 'soak-pi-host', path, branch: `graphyard/${work.key.toLowerCase()}-${claimed.epoch}` });
        // The supervisor records its containment before the agent starts, exactly as `watch` does.
        await api(worker(profile.name), 'POST', `work/${work.id}/quarantine`, { epoch: claimed.epoch, settlementHash: createHash('sha256').update(settlementToken).digest('hex'), scope: { unit: `graphyard-watch-4242-${id()}.scope`, pid: 4242 } });
        const pane = `pane-${launches.length}`;
        agents = [...agents.filter(agent => agent.name !== profile.agentName), { name: profile.agentName, pane_id: pane, agent_status: 'working' }];
        launches.push({ key: work.key, id: work.id, epoch: claimed.epoch!, profile: profile.name, account: selected.account?.name ?? null, pane, path, at: Date.now() });
      },
      requestProof: () => {},
      observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date().toISOString(), reason: 'no deployment endpoint in this test', deployed: [], pending: [] }),
      recordDeployment: async () => {},
      requestSmoke: () => {},
      persist: async () => {},
      sessionOutput: agent => output.get(agent.pane_id ?? '') ?? `● Working as ${agent.name}…\n`,
      reportCapacity: (work, event) => api(principals.coordinator, 'POST', `work/${work.id}/capacity`, event) as Promise<Work>,
      // The account the attempt's own launch record names, as the production wiring reads it: two dispatches in one pass never share a selection.
      selectedAccount: async (_role, profile, session) => {
        const launch = launches.find(entry => entry.profile === profile && entry.key === session?.work && entry.epoch === session?.epoch);
        return launch ? { environment: launch.account, kind: 'pi' } : null;
      },
      holdAccount: (account, observed) => recordObservedExhaustion(config, account, observed),
      preserveWork: async (work, epoch) => preservePartialWork(work.workspaces.find(entry => entry.epoch === epoch)!.path, `${work.key} attempt ${epoch} interrupted by provider quota exhaustion`),
      promptSession: async agent => { prompted.push(agent.name ?? ''); },
      stopSupervisor: async orphan => {
        stopped.push(`${orphan.key}:${orphan.epoch}`);
        agents = agents.filter(agent => agent.name !== orphan.agentName);
        await api(worker(config.workers.find(profile => profile.agentName === orphan.agentName)!.name), 'POST', `work/${orphan.id}/settle`, { epoch: orphan.epoch, settlementToken });
      },
    };
    for (const n of [1, 2]) {
      const work = await api(principals.operator, 'POST', 'work', { title: `pi soak item ${n}`, plannedFiles: [`src/pi-soak-${n}.ts`], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:wait'] }] }) as Work;
      await api(principals.operator, 'POST', `work/${work.id}/ready`, {});
    }

    const state = emptyDaemonState(config);
    const violations: string[] = [], observed = new Set<string>(), holds: { at: number; until: string }[] = [];
    for (let now = clock.now(); now < dayEnd; now = clock.now()) {
      for (const launch of launches.filter(entry => !entry.ended && !stopped.includes(`${entry.key}:${entry.epoch}`))) {
        const work = (await store.list()).find(entry => entry.id === launch.id)!;
        if (work.lease?.epoch !== launch.epoch) continue;
        await engine.execute(worker(launch.profile), 'heartbeat', work.id, { epoch: launch.epoch }, id());
        if (launch.account === 'pi-a' && launch.at < resetAt && now - launch.at >= noticeMs) {
          // pi gave up on the spent account: the provider's 1310 answer, and Herdr reads the session idle.
          launch.ended = 'notice';
          await writeFile(join(launch.path, 'progress.md'), 'half-finished change\n');
          output.set(launch.pane, piPane(resetAt));
          agents = agents.map(agent => agent.pane_id === launch.pane ? { ...agent, agent_status: 'idle' } : agent);
        } else if (now - launch.at >= workMs) {
          // A session on a working account ends another way: its supervisor settles and the worker releases.
          launch.ended = 'other';
          await api(worker(launch.profile), 'POST', `work/${work.id}/settle`, { epoch: launch.epoch, settlementToken });
          await api(worker(launch.profile), 'POST', `work/${work.id}/release`, { epoch: launch.epoch });
          agents = agents.filter(agent => agent.pane_id !== launch.pane);
        }
      }
      await runCycle(config, state, effects);
      for (const check of state.invariants.report as InvariantCheck[]) {
        if (check.observed) observed.add(check.invariant);
        if (!check.holds) violations.push(`+${Math.round((now - dayStart) / minute)} min ${check.line}`);
      }
      { const read = Date.now(); const held = (await observedExhaustions(config, read))['pi-a']; if (held) holds.push({ at: read, until: held.until }); }
      clock.advance(step); await store.pool.query('UPDATE simulated_clock SET offset_ms=$1', [clock.offsetMs]);
    }

    assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
    assert.ok(observed.size > 0, 'the loop evaluated its invariants');
    const noticed = launches.filter(entry => entry.ended === 'notice');
    assert.ok(noticed.length >= 2, `both items met the spent account: ${launches.map(entry => `${entry.key}:${entry.epoch}@${entry.account}`).join(', ')}`);
    const reset = new Date(resetAt).toISOString();
    for (const launch of noticed) {
      const failover = state.actions[failoverKey('worker', { key: launch.key, id: launch.id } as Work, launch.epoch)];
      assert.equal(failover?.state, 'done', `${launch.key}:${launch.epoch} was failed over: ${failover?.detail}`);
      assert.ok(failover.detail.includes(`resets ${reset}`), failover.detail);
      assert.equal(state.actions[idleLeaseKey({ key: launch.key, id: launch.id } as Work, launch.epoch)], undefined, `${launch.key}:${launch.epoch} was never recorded idle-with-lease`);
      assert.ok(stopped.includes(`${launch.key}:${launch.epoch}`), 'its supervisor was stopped');
    }
    assert.deepEqual(prompted, [], 'no session on the 1310 notice was re-prompted');
    const final = await store.list();
    for (const launch of noticed) {
      const exhaustion = final.find(entry => entry.id === launch.id)!.capacity!.exhaustions.find(entry => entry.epoch === launch.epoch)!;
      assert.equal(exhaustion.account, 'pi-a', 'the launch account is charged');
      assert.equal(exhaustion.resetsAt, reset, 'the zone-less reset is the provider\'s UTC instant, not the host\'s wall clock');
      assert.equal(exhaustion.partialWork.state, 'committed', 'the attempt kept its work on its branch');
    }
    // The hold is the provider's reset, exactly, for as long as it stands, and nothing launches on pi-a under it.
    assert.ok(holds.length > 0);
    assert.deepEqual(holds.filter(entry => entry.until !== reset), [], 'pi-a is held to the UTC reset and nothing else');
    assert.deepEqual(holds.filter(entry => entry.at >= resetAt), [], 'the hold lapses at the reset');
    const firstNotice = Math.min(...noticed.map(entry => entry.at));
    assert.deepEqual(launches.filter(entry => entry.account === 'pi-a' && entry.at > firstNotice + noticeMs && entry.at < resetAt).map(entry => `${entry.key}:${entry.epoch}`), [], 'no launch lands on pi-a while it is held');
    assert.ok(launches.some(entry => entry.account === 'pi-b' && entry.at < resetAt), 'the items work on pi-b while pi-a is spent');
    assert.ok(launches.some(entry => entry.account === 'pi-a' && entry.at >= resetAt && entry.ended !== 'notice'), 'pi-a takes launches again once its reset has passed');
    assert.deepEqual(await observedExhaustions(config), {}, 'no hold stands at the end');
  } finally { if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; }
});
