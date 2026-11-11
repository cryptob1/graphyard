import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { masterConfigSchema } from '../src/master/profiles.js';
import { assertDispatchable } from '../src/master/dispatch.js';
import { daemonStatePath, readDaemonState, emptyDaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { itemLine } from '../src/cli/master-status.js';
import { sessionEnded } from '../src/model/registry-sessions.js';
import type { FleetSession } from '../src/model/registry.js';
import { workFixture } from './helpers/work-fixture.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const clock = Date.parse('2030-01-01T12:00:00Z'), at = new Date(clock).toISOString();

test('e2e:feature-skips-spec-check — new and legacy released features dispatch in the next cycle', async () => {
  const directory = await temporaryDirectory('feature-skips-spec-check');
  try {
    const credential = join(directory, 'worker.token');
    await writeFile(credential, 'worker-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const config = masterConfigSchema.parse({
      version: 1, url: 'https://graphyard.example', credentialFile: credential,
      cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)),
      repository: 'owner/project', baseBranch: 'main', hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
      workers: [1, 2, 3].map(i => ({ name: `worker-${i}`, principal: `worker-${i}`, agentName: `worker-${i}`,
        mode: 'launch', kind: 'codex', credentialFile: credential, agentArgs: [], approvals: 'auto', environment: {} })),
    });
    // Stored pre-upgrade fields are deliberately passed through, with no manufactured verdict.
    const work = [
      workFixture({ key: 'GY-1', specCheck: undefined }),
      workFixture({ key: 'GY-2', specCheck: undefined, specCheckLaunch: { id: 'old-launch', reviewer: 'checker', requester: 'master',
        tokenHash: 'f'.repeat(64), at, expiresAt: new Date(clock + 3_600_000).toISOString(), policyRevision: 1 } }),
      workFixture({ key: 'GY-3', specCheck: { verdict: 'gaps', gaps: ['Clarify export'],
        paraphrase: 'Export data', reviewer: 'checker', at, policyRevision: 1 } }),
    ];
    const before = structuredClone(work);
    const launched: string[] = [], checks: string[] = [];
    const effects: DaemonEffects & { launchSpecCheck: (item: typeof work[number]) => Promise<void> } = {
      agents: () => [], snapshot: async () => ({ work, now: at }),
      credentials: async profiles => Object.fromEntries(profiles.map(p => [p.name, { available: true, reason: null }])),
      dispatch: async item => { launched.push(item.key); },
      launchSpecCheck: async item => { checks.push(item.key); },
      closeSession: () => { assert.fail('no checker session should be adopted or closed'); },
      persist: async () => {},
    };
    const saved = emptyDaemonState(config);
    await writeFile(daemonStatePath(config), JSON.stringify({ ...saved, actions: {
      'spec-check:old': { kind: 'review', state: 'done', work: 'GY-2', cycle: 0, at, detail: 'Old launch', pane: 'gone', specCheckLaunch: 'old-launch' },
      'spec-check-ended:old': { kind: 'attention', state: 'failed', work: 'GY-2', cycle: 0, at, detail: 'Checker ended' },
    } }));
    const state = await readDaemonState(fileURLToPath(new URL('..', import.meta.url)), config);
    await runCycle(config, state, effects, () => clock);
    assert.deepEqual(launched.sort(), ['GY-1', 'GY-2', 'GY-3']);
    assert.deepEqual(checks, []);
    assert.ok(!Object.keys(state.actions).some(key => key.startsWith('spec-check')), 'retired cursor records neither reserve sessions nor wake the master');
    for (const item of work) {
      assert.doesNotThrow(() => assertDispatchable(item, work, at));
      assert.equal(itemLine(item, clock).stage, 'Not started');
      assert.equal(sessionEnded({ role: 'reviewer', selectedAt: new Date(clock - 600_000).toISOString() } as FleetSession, item, clock),
        `${item.key} has no standing review request`, 'legacy launches reserve no reviewer capacity');
    }
    assert.deepEqual(work, before, 'dispatch never fabricates spec-check verdicts or changes requirements');
    // The remaining dispatch holds still apply.
    assert.throws(() => assertDispatchable({ ...work[0]!, lease: { owner: 'other', epoch: 1, expiresAt: new Date(clock + 60_000).toISOString() } }, work, at), /active owner/);
    assert.throws(() => assertDispatchable({ ...work[0]!, submission: { epoch: 1, pr: 1 } }, work, at), /rework/);
    for (const path of ['../src/spec-check.ts', '../src/spec-check-post.ts'])
      await assert.rejects(access(new URL(path, import.meta.url)), { code: 'ENOENT' });
    for (const path of ['../web/pages/work-details.tsx', '../src/cli/master-status.ts'])
      assert.doesNotMatch(await readFile(new URL(path, import.meta.url), 'utf8'), /specCheck|Spec check|spec-check/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
