import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { masterConfigSchema, reclaimIdleMs, reclaimWorktrees, removeReclaimableWorktrees, worktreesDirectory, writeWorktreeInventoryCache, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { cycleFaults, docsHeadroomStatus } from '../src/daemon/faults.js';
import { worktreeRefusalRetryMs } from '../src/master/worktrees.js';
import { runChild } from '../src/child-runner.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1515 (manual:fault-class-resources). The two causes of the recurring resources faults, over
 * three simulated days of the real loop's cycles: the reclaim pass meeting one tree Git refuses
 * (a fresh failed pass, and a resources fault, on every retry) and the documentation set sitting
 * inside its headroom band (a resource-bound fault on every saturation). After every cycle the
 * system invariants hold; across the retry boundary a standing refusal is reported once and not
 * again, the docs line is attention only, and the refusal is retried each day but never removed.
 */
const hour = 3_600_000, minute = 60_000, days = 3, cycleMs = 20 * minute;

test('unit:soak-invariants-hold — over three days a standing worktree refusal is one resources fault and is retried once a day, and the docs set inside its band is never a fault', { timeout: 300_000 }, async () => {
  const root = await temporaryDirectory('soak-reclaim'), credentials = await temporaryDirectory('soak-reclaim-credentials');
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', root]);
    for (const [key, value] of [['user.email', 'soak@example.com'], ['user.name', 'Soak'], ['commit.gpgsign', 'false']]) execFileSync('git', ['config', key, value], { cwd: root });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
    await writeFile(join(root, '.gitignore'), 'node_modules/\n.graphyard/\n'); await writeFile(join(root, 'source.ts'), 'export const value = 1;\n');
    execFileSync('git', ['add', '-A'], { cwd: root }); execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
    await mkdir(worktreesDirectory(root), { recursive: true });
    const token = join(credentials, 'coordinator.token'); await writeFile(token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const master: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: token, cliPath: 'graphyard', repository: 'owner/project',
      baseBranch: 'main', githubAppId: 1234, hostId: 'vishrog', masterAgentName: 'graphyard-master-project', workers: [], run: { intervalSeconds: 20, worktreeRemovalLimit: 1 } });

    const start = Date.now(), trees = ['GY-300', 'GY-301', 'GY-302'].map(key => {
      const path = join(worktreesDirectory(root), `${key}-1`), branch = `graphyard/${key.toLowerCase()}-1`;
      execFileSync('git', ['worktree', 'add', '-q', '-b', branch, path, 'main'], { cwd: root });
      return { key, path, branch };
    });
    const idle = new Date(start - 8 * hour);
    for (const tree of trees) for (const name of ['.gitignore', 'source.ts', '.git', '.']) await utimes(name === '.' ? tree.path : join(tree.path, name), idle, idle).catch(() => {});
    const items = trees.map((tree, index) => ({ id: `id-${tree.key}`, key: tree.key, title: tree.key, description: '', type: 'bug', priority: 1, dependencies: [], criteria: [], policy: { checks: ['test'], review: true }, plannedFiles: [],
      stage: 'done', revision: 1, policyRevision: 1, createdAt: '', updatedAt: '', stageEnteredAt: new Date(start - (10 - index) * hour).toISOString(), ready: false, epoch: 1, lease: null,
      workspaces: [{ host: 'vishrog', path: tree.path, branch: tree.branch, epoch: 1, owner: 'worker' }], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [] }) as unknown as Work);

    const refused = trees[0], asked: number[] = [];
    let now = start;
    const run = (command: string, args: string[]) => {
      if (args.includes('rev-list') && args[1] === refused.path) { asked.push(now); throw new Error(`Command failed: git -C ${refused.path} rev-list -n 1 HEAD --not --remotes refs/heads/main`); }
      return runChild(command, args);
    };
    const reports: Awaited<ReturnType<typeof removeReclaimableWorktrees>>[] = [];
    const reclaim = async (snapshot: Work[]) => {
      const removal = await removeReclaimableWorktrees(root, snapshot, { idleMs: reclaimIdleMs(master), run, baseBranch: 'main', limit: 1, now });
      reports.push(removal);
      await writeWorktreeInventoryCache(root, { at: removal.at, entries: removal.entries, held: removal.held });
      return { ...await reclaimWorktrees(root, snapshot, { idleMs: reclaimIdleMs(master), entries: removal.entries }), trees: removal };
    };
    const effects = { agents: () => [], credentials: async () => ({}), snapshot: async () => ({ work: items, now: new Date(now).toISOString() }), closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
      observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date(now).toISOString(), reason: 'not configured', deployed: [], pending: [] }), recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
      reclaim } as unknown as DaemonEffects;

    // The documentation set on origin/main stays inside its band (15,639 of 16,000 words) for the whole run.
    const docs = await docsHeadroomStatus('/repository', 'main', () => ({ budget: { total: 16_000, perPage: 1_200, documentation: ['README.md', 'docs/'], paths: ['README.md', 'docs/'] }, pages: { 'README.md': 15_639 } }));
    assert.equal(docs.attention.length, 1, 'the master sees the docs line');

    const state = emptyDaemonState(master), violations: string[] = [], docsFaults: string[] = [];
    for (let cycle = 0; now < start + days * 24 * hour; cycle++, now += cycleMs) {
      await runCycle(master, state, effects, () => now);
      for (const check of state.invariants.report) if (!check.holds) violations.push(`cycle ${cycle}: ${check.invariant} — ${check.reading}`);
      docsFaults.push(...cycleFaults(state, [], now, { config: master, reported: docs.attention }).filter(fault => fault.faultClass === 'resources' && fault.subject === 'docs').map(fault => fault.kind));
    }
    assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
    assert.deepEqual(docsFaults, [], 'the docs set inside its band is attention, never a resources fault');
    // The refusal: reported by exactly one pass, retried about once a day, never removed, and the other trees drained meanwhile.
    assert.deepEqual(reports.filter(report => report.errors.length).length, 1, `the standing refusal is reported once: ${reports.flatMap(report => report.errors)}`);
    assert.ok(asked.length >= 3 && asked.length <= days + 1, `retried about once a day, not every cycle: ${asked.length}`);
    for (const [index, at] of asked.slice(1).entries()) assert.ok(at - asked[index] >= worktreeRefusalRetryMs, 'two retries are at least the bound apart');
    assert.deepEqual(reports.flatMap(report => report.removed.map(entry => entry.key)).sort(), ['GY-301', 'GY-302']);
    assert.equal(state.faults.instances.filter(entry => entry.faultClass === 'resources').length, 1, 'one resources fault in three days');
  } finally { await rm(root, { recursive: true, force: true }); await rm(credentials, { recursive: true, force: true }); }
});
