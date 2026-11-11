import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { capacityRefusal } from '../src/fleet.js';
import { dispatchWork, setupMaster, type WorkerProfile } from '../src/master.js';
import type { Work } from '../src/model.js';
import { recordedRuns } from './helpers/headless-runs.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { registryFixture } from './helpers/registry-fixture.js';
import { workFixture } from './helpers/work-fixture.js';

// GY-273: concurrent dispatchers launch implementation work from their own snapshots. Two of them
// picking one profile used to mean two claims and two runtimes started; the registry's slot is
// taken before any claim, so only one launches.
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x');
const workerToken = 'worker-token-'.padEnd(40, 'x');

function work(key: string, overrides: Partial<Work> = {}): Work {
  const at = new Date(Date.now() - 3_600_000).toISOString();
  return workFixture({ key, createdAt: at, updatedAt: at, stageEnteredAt: at, ...overrides });
}
const launchProfile = (name: string, credentialFile: string): WorkerProfile => ({ name, principal: `${name}-principal`, agentName: `agent-${name}`, mode: 'launch', kind: 'codex', credentialFile, agentArgs: [], approvals: 'auto', environment: {} });

/** The control plane's claim, as the fake sees it: one epoch per item, a second claim of a held item refused. */
function fakeClaims(root: string) {
  const claims = new Map<string, string>(), released: string[] = [];
  const prepare = async (_root: string, key: string, profile: string) => {
    await sleep(25);
    if (claims.has(key)) throw new Error(`Dispatch blocked by active owner ${claims.get(key)}`);
    claims.set(key, profile);
    return { epoch: 1, path: join(root, `assigned-${key}`), base: 'c'.repeat(40) };
  };
  const release = async (_root: string, key: string, epoch: number) => { released.push(`${key}@${epoch}`); claims.delete(key); };
  return { claims, released, prepare, release };
}

async function installation() {
  const root = await temporaryDirectory('dispatch-collision'); const credentials = await temporaryDirectory('dispatch-collision-credentials');
  execFileSync('git', ['init', '-q', root]); execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  const credential = join(credentials, 'worker.token'); await writeFile(credential, workerToken, { mode: 0o600 });
  const coordinator = join(credentials, 'coordinator.token'); await writeFile(coordinator, coordinatorToken, { mode: 0o600 });
  await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory: credentials }, (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch);
  return { root, credential, coordinator, cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(credentials, { recursive: true, force: true }); } };
}

test('unit:profile-reserved-before-claim — two concurrent dispatchWork calls for one profile make exactly one claim and one launch, and the other is refused cleanly before any claim', async () => {
  const fixture = await installation();
  try {
    const profile = launchProfile('one', fixture.credential);
    const worker = recordedRuns({ running: true }), claims = fakeClaims(fixture.root);
    const first = work('GY-1'), second = work('GY-2');
    // GY-3030: the control-plane registry is the only slot authority. The worker role holds one
    // session, so of two dispatchers that chose the profile from the same snapshot, the registry
    // refuses the second its slot before it claims anything.
    const registry = registryFixture(hostname(), ['codex'], ['worker'], 1);
    const observedAt = new Date().toISOString();
    const results = await Promise.allSettled([first, second].map(item => dispatchWork(fixture.root, item, profile, { allWork: [first, second], prepare: claims.prepare, release: claims.release, observedAt, headless: worker.exec, startupMs: worker.startupMs, probe: registry.probe })));
    const launched = results.filter(result => result.status === 'fulfilled'), refused = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    assert.equal(launched.length, 1, 'exactly one dispatch launches');
    assert.equal(refused.length, 1, 'the other is refused');
    assert.match(capacityRefusal(refused[0].reason) ?? '', /role worker is at its concurrency limit/, `the refusal is the registry's slot refusal, not a failed launch: ${refused[0].reason?.message}`);
    assert.equal(claims.claims.size, 1, 'exactly one item was claimed');
    assert.deepEqual(claims.released, [], 'nothing was claimed and then released');
    assert.equal(worker.runs.length, 1, 'exactly one run was started');
    assert.equal(registry.sessions().filter(session => !session.endedAt).length, 1, 'the registry holds one live worker session');

    // A dispatcher that reads its snapshot before that launch dispatches while the launched session
    // still holds the slot: the registry refuses it, still before any claim.
    worker.forget();
    const late = await dispatchWork(fixture.root, work('GY-3'), profile, { allWork: [work('GY-3')], prepare: claims.prepare, release: claims.release, observedAt, headless: worker.exec, startupMs: worker.startupMs, probe: registry.probe }).then(() => null, error => error);
    assert.match(capacityRefusal(late) ?? '', /role worker is at its concurrency limit/, `a stale snapshot is refused cleanly: ${late?.message}`);
    assert.equal(claims.claims.size, 1, 'the stale dispatcher claimed nothing');
    assert.equal(worker.runs.length, 1, 'the stale dispatcher started nothing');
  } finally { await fixture.cleanup(); }
});
