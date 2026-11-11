import { test } from './helpers/loop-state.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Observation, Work } from '../src/model.js';
import { reconcileAutoDispatch } from '../src/model-boundary/dispatch.js';
import { masterConfigSchema } from '../src/master.js';
import { emptyDispatchCursor, writeDispatchCursor } from '../src/dispatch/cursor.js';
import { runDispatchTick } from '../src/dispatch/tick.js';
import { type DispatchEffects } from '../src/dispatch/effects.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { WorkerSandboxError } from '../src/worker-sandbox.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3235: Huck's loop picked the codex reviewer profile first every cycle although every launch
// failed its sandbox probe, so no review ever ran. Two failures of the same probe in a row now skip
// the profile for its role for 30 minutes in favour of the next one, and master status says so.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const B = sha40('b1'), start = Date.now(), at = new Date(start).toISOString();

function requested(key: string): Work {
  const candidate = { sha: sha40('a1'), baseSha: B, pr: 64, branch: `graphyard/${key.toLowerCase()}-1`, author: 'implementer' };
  const observation = { candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true, files: ['src/a.ts'], scopeFiles: [{ path: 'src/a.ts', status: 'modified' as const, sha: sha40('s'), additions: 1, deletions: 1, binary: false }],
    at, prState: 'open', draft: false, baseTip: B, baseTree: sha40('7b'), baseTipContained: true } as Observation;
  const item = { id: `work-${key}`, key, title: key, description: '', type: 'bug', priority: 0, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Review', proofs: ['unit:x'] }], policy: { checks: ['test'], review: true, reviewProvider: 'github' }, stage: 'review', revision: 1, policyRevision: 1,
    createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: 64 }, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation, blocker: null, gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }], violations: [] } as unknown as Work;
  reconcileAutoDispatch(item, [item], new Date(start));
  return item;
}

test('e2e:launch-probe-backoff — a reviewer profile failing its launch probe twice is skipped for the next profile on the next cycle, and master status names it with its cause', async () => {
  const root = await temporaryDirectory('launch-probe-backoff'), credentials = await temporaryDirectory('launch-probe-backoff-credentials');
  try {
    execFileSync('git', ['init', '-q', root]);
    const credentialFile = join(credentials, 'coordinator.token'); await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher, repository: 'owner/project', baseBranch: 'main', hostId: 'huck-host', masterAgentName: 'graphyard-master-project',
      run: { reviewerProfile: 'codex-reviewer' },
      reviewers: [{ name: 'codex-reviewer', agentName: 'review-codex-1', kind: 'codex' }, { name: 'claude-reviewer', agentName: 'review-claude-1', kind: 'claude' }], producers: [] });
    const item = requested('GY-1');
    const attempts: string[] = [];
    const effects: DispatchEffects = {
      snapshot: async () => ({ work: [item], now: at }),
      agents: () => [],
      credentials: async () => ({}),
      reconcileReviews: async () => ({ reviews: [] }),
      reconcileProducers: async () => ({ producers: [] }),
      launchReview: async (_item, _request, profile) => {
        attempts.push(profile.name);
        if (profile.kind === 'codex') throw new WorkerSandboxError('codex', '/srv/huck/.git', 'touch: Read-only file system', 'reviewer');
        return { agentName: profile.agentName, pane: 'pane-1' };
      },
      launchProducer: async () => {},
      persist: async cursor => writeDispatchCursor(config, cursor),
    };
    const cursor = emptyDispatchCursor(config);
    const tick = (offsetMs: number) => runDispatchTick(config, cursor, effects, () => start + offsetMs);
    const first = await tick(0), second = await tick(5_000);
    assert.deepEqual(attempts, ['codex-reviewer', 'codex-reviewer'], 'the first profile is tried on each of the first two cycles');
    assert.deepEqual([first.refused.length, second.refused.length], [0, 0], 'a probe failure is the profile\'s, never a refusal counted against the request');
    assert.equal(cursor.failures[Object.keys(cursor.failures)[0]], undefined);
    const third = await tick(10_000);
    assert.deepEqual(attempts, ['codex-reviewer', 'codex-reviewer', 'claude-reviewer'], 'the next cycle launches the next profile');
    assert.deepEqual(third.launched.map(entry => entry.profile), ['claude-reviewer']);

    const report = await masterStatusReport(root, config, async () => ({ work: [], now: new Date(start + 10_000).toISOString() }), async () => { throw new Error('no git in the fixture'); });
    const line = report.attention.find(entry => entry.subject === 'reviewer profile codex-reviewer');
    assert.ok(line, JSON.stringify(report.attention));
    assert.match(line.text, new RegExp(`^Backed off until ${new Date(start + 5_000 + 30 * 60_000).toISOString().replace(/\./g, '\\.')}`));
    assert.match(line.text, /cannot write \/srv\/huck\/\.git \(touch: Read-only file system\)/, 'the cause is named');
    // Once the backoff ends the profile is tried again.
    await tick(5_000 + 30 * 60_000 + 1);
    assert.equal(attempts.at(-1), 'codex-reviewer');
  } finally { await rm(root, { recursive: true, force: true }); await rm(credentials, { recursive: true, force: true }); }
});
