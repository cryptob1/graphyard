import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';
import { withDatabase } from './helpers/postgres.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal, Work } from '../src/model.js';
import { reviewBindingFile, type ReviewPostBinding } from '../src/review-post.js';
import { launchReview, saveReviewerProfile } from '../src/reviewer.js';
import { setupMaster } from '../src/master.js';
import { WorkerSandboxError } from '../src/worker-sandbox.js';
import { startedAtOnce } from './helpers/launch-shell.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { registryFixture } from './helpers/registry-fixture.js';

// GY-3235: on Huck's install the served repository is not the checkout the CLI release runs from.
// Reviewer launches were confined against the launcher's checkout, so the whole served repository,
// its .git included, was read-only to the sandbox probe and every codex reviewer launch failed
// "cannot write the repository .git". GY-3224 fixed the same for workers only.

const repository = 'owner/project';
const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const worker: Principal = { id: 'graphyard-claude-1', role: 'worker' };
const credentials = [coordinator, worker].map(principal => ({ ...principal, token: `${principal.id}-token-${'x'.repeat(32)}` }));
// The CLI release lives in this checkout; the served repository is a separate fixture repository.
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
let store: Store, http: ReturnType<typeof server>, url: string;
before(async () => {
  store = await withDatabase('codex-reviewer-git-write'); await store.init();
  http = server(new Engine(store, 120, repository), credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); });

test('e2e:codex-reviewer-git-write — a codex reviewer launched for a repository separate from its CLI release passes the confined sandbox probe on the served .git and records its verdict', async () => {
  const base = await temporaryDirectory('codex-reviewer-git-write');
  const credentialDirectory = await temporaryDirectory('codex-reviewer-credentials');
  try {
    const root = join(base, 'served-repository');
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    execFileSync('git', ['init', '-q', '-b', 'main', root]);
    git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.com');
    git('commit', '-q', '--allow-empty', '-m', 'base'); const baseSha = git('rev-parse', 'HEAD');
    git('commit', '-q', '--allow-empty', '-m', 'candidate'); const head = git('rev-parse', 'HEAD');
    git('remote', 'add', 'origin', `https://github.com/${repository}.git`);
    await setupMaster(root, { url, token: credentials[0].token, cliPath: launcher, credentialDirectory, herdrWorkspace: 'workspace-graphyard', run: { worktreeRoot: join(base, 'sessions') } });
    await saveReviewerProfile(root, { name: 'reviewer-codex', agentName: 'review-codex-1', kind: 'codex' });
    const now = new Date().toISOString();
    const candidate = { sha: head, baseSha, pr: 7, branch: 'graphyard/gy-7-1', author: worker.id };
    const work = { id: randomUUID(), key: 'GY-7', title: 'Fixture', description: '', type: 'feature', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }],
      policy: { checks: ['test'], review: true }, stage: 'review', revision: 3, policyRevision: 1, createdAt: now, updatedAt: now, stageEnteredAt: now, ready: true, epoch: 1, lease: null,
      workspaces: [], candidate, submission: { epoch: 1, pr: 7 }, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [], implementers: [worker.id],
      observation: { source: 'control-plane', at: now, candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false, files: ['src/a.ts'],
        scopeFiles: [{ path: 'src/a.ts', status: 'modified', sha: 'f'.repeat(40), additions: 1, deletions: 0, binary: false }], baseTip: baseSha, baseTipContained: true } } as unknown as Work;
    await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1,$2)', [work.id, JSON.stringify(work)]);

    const probed: string[][] = [], calls: string[][] = [];
    const herdr = (_command: string, args: string[]) => { calls.push(args); return startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'tab' ? { type: 'tab_created', root_pane: { pane_id: 'pane-review', tab_id: 'tab-review' }, tab: { tab_id: 'tab-review' } } : args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} }); };
    await launchReview(root, work, 'reviewer-codex', [], now, { probe: registryFixture(hostname(), ['codex'], ['reviewer']).probe, run: herdr, headless: null,
      // The probe runs for real behind the coordinator confinement; only the codex binary, absent here, is left out of it (it runs unsandboxed inside that boundary).
      sandbox: (command, args, options) => {
        assert.match(command, /bwrap$/, 'the reviewer probe runs behind the served repository\'s confinement');
        const inner = args.findIndex((arg, index) => arg === 'codex' && args[index + 1] === 'sandbox');
        assert.ok(inner >= 0, 'the codex sandbox probe runs inside the confinement');
        const shell = [...args.slice(0, inner), ...args.slice(args.indexOf('--', inner) + 1)];
        probed.push(shell);
        return execFileSync(command, shell, { ...options, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      } }).catch(error => { if (error instanceof WorkerSandboxError) assert.fail(`the probe must pass: ${error.message}`); throw error; });
    assert.equal(probed.length, 1);
    assert.ok(probed[0].includes(join(root, '.git')), 'the served repository\'s .git is a probed, writable path');

    // The session it started posts its verdict with its own launch token, and the control plane records it.
    const tab = calls.find(args => args[0] === 'tab' && args[1] === 'create')!;
    const binding = JSON.parse(await readFile(join(tab.find(value => value.startsWith('GH_CONFIG_DIR='))!.slice('GH_CONFIG_DIR='.length), reviewBindingFile), 'utf8')) as ReviewPostBinding;
    const response = await fetch(`${url}/api/work/${work.id}/review-verdict`, { method: 'POST', headers: { Authorization: `Bearer ${binding.verdictToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ event: 'APPROVE', body: 'AC-1 met.\nResolved threads: none\nFollow-up threads: none\nOverridden threads: none', sha: head, token: binding.verdictToken }) });
    assert.equal(response.status, 200, await response.text());
    const stored = (await store.pool.query('SELECT document FROM work_items WHERE id=$1', [work.id])).rows[0].document as Work;
    assert.deepEqual(stored.observation!.reviews.map(review => [review.reviewer, review.sha, review.state]), [['review-codex-1', head, 'APPROVED']]);
  } finally { await rm(base, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); }
});
