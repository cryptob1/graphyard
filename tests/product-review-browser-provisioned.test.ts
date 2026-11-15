import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { AgentRegistry } from '../src/agent-registry.js';
import { proposedRuntimes } from '../src/model/registry.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { loadMasterConfig, setupMaster } from '../src/master/config.js';
import type { Principal, Work } from '../src/model.js';
import { saveReviewerProfile } from '../src/reviewer.js';
import { reconcileAutoDispatch } from '../src/model-boundary/dispatch.js';
import { standingVerdict } from '../src/daemon/rework.js';
import { headlessInventory } from '../src/session-inventory.js';
import type { HeadlessExec } from '../src/headless-session.js';
import { runDispatchTick } from '../src/dispatch/tick.js';
import { emptyDispatchCursor } from '../src/dispatch/cursor.js';
import { dispatchEffects } from '../src/dispatch/effects.js';
import { masterStatusReport } from '../src/cli/master-status.js';

// GY-3370: a host without the browser tool is set up for product reviews. When a feature item
// reaches product review and agent-browser is absent, the loop installs it once into the install's
// tool directory, the reviewer launch finds it on its PATH and the review runs; items reaching
// review together share one install. A failing installer keeps the item in review with no rework
// and raises one attention line naming the installer's error. Doctor reports it missing, then present.

const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const coordinatorToken = `${coordinator.id}-token-${'x'.repeat(32)}`;
const now = () => new Date().toISOString();
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
let store: Store, http: ReturnType<typeof server>, url: string;
let root: string, credentials: string, stubBin: string, installs: string;
let base: string, head: string;
const originalHome = process.env.HOME, originalData = process.env.XDG_DATA_HOME, originalPath = process.env.PATH;

before(async () => {
  store = await withDatabase('product-review-browser-provisioned'); await store.init();
  const engine = new Engine(store, 120, 'owner/project');
  engine.gitRunner = null;
  http = server(engine, [{ ...coordinator, token: coordinatorToken }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  root = await temporaryDirectory('browser-provisioned-root'); credentials = await temporaryDirectory('browser-provisioned-credentials');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '--initial-branch=main');
  git('remote', 'add', 'origin', 'https://github.com/owner/project.git');
  await writeFile(join(root, 'README.md'), 'Base.\n');
  git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base');
  base = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', base);
  await writeFile(join(root, 'feature.ts'), 'export const feature = 1;\n');
  git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'head');
  head = git('rev-parse', 'HEAD');
  git('checkout', '-q', base);
  await mkdir(join(process.cwd(), '.graphyard'), { recursive: true });
  await setupMaster(root, { url, token: coordinatorToken, cliPath: launcher, credentialDirectory: credentials, herdrWorkspace: 'w',
    run: { worktreeRoot: await temporaryDirectory('browser-provisioned-checkouts', join(process.cwd(), '.graphyard')), reviewerProfile: 'product-claude' } });
  const config = await loadMasterConfig(root);
  await new AgentRegistry(store).mutate(coordinator, 'apply', {
    runtimes: proposedRuntimes.filter(runtime => runtime.name === 'claude'),
    models: [{ name: 'opus', id: 'opus' }],
    accounts: [{ name: 'product-claude-account', runtime: 'claude', model: 'opus', credential: { host: config.hostId, home: null } }],
    roles: [{ name: 'reviewer', accounts: ['product-claude-account'], concurrency: 8, policy: {} }], reason: 'browser provisioned fixture' }, randomUUID());
  await saveReviewerProfile(root, { name: 'product-claude', agentName: 'product-claude-1', kind: 'claude', agentArgs: [], accounts: ['product-claude-account'], concurrency: 4 });
  // The stubbed installer: an `npm` that counts its runs and, unless told to fail, leaves an
  // executable agent-browser in the --prefix it is given. No directory of the host PATH that
  // already holds agent-browser stays: this host lacks the tool.
  stubBin = await temporaryDirectory('browser-provisioned-stub');
  installs = join(stubBin, 'installs.log');
  await writeFile(join(stubBin, 'npm'), `#!/bin/sh
echo "$@" >> ${installs}
if [ -n "$STUB_NPM_FAIL" ]; then echo "npm ERR! 404 Not Found - GET https://registry.npmjs.org/agent-browser - stub registry unreachable" >&2; exit 1; fi
while [ $# -gt 0 ]; do [ "$1" = --prefix ] && prefix="$2"; shift; done
mkdir -p "$prefix/node_modules/.bin"
printf '#!/bin/sh\\necho agent-browser 0.43.0\\n' > "$prefix/node_modules/.bin/agent-browser"
chmod 755 "$prefix/node_modules/.bin/agent-browser"
`, { mode: 0o755 });
  const hostPath = (originalPath ?? '').split(delimiter).filter(directory => directory && !existsSync(join(directory, 'agent-browser')));
  process.env.PATH = [stubBin, ...hostPath].join(delimiter);
  delete process.env.XDG_DATA_HOME;
});
after(async () => {
  process.env.PATH = originalPath; process.env.HOME = originalHome;
  if (originalData !== undefined) process.env.XDG_DATA_HOME = originalData;
  if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  if (store) await store.close();
  for (const directory of [root, credentials, stubBin]) if (directory) await rm(directory, { recursive: true, force: true });
});

const stored = async (id: string) => (await store.pool.query('SELECT document FROM work_items WHERE id=$1', [id])).rows[0].document as Work;
async function insert(key: string) {
  const candidate = { sha: head, baseSha: base, pr: 7, branch: 'graphyard/gy-7-1', author: 'graphyard-claude-1' };
  const work = { id: randomUUID(), key, title: `Item ${key}`, description: '', type: 'feature', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'The feature works for the person using it', proofs: ['e2e:product-review-browser-provisioned'] }], policy: { checks: ['test'], review: true },
    stage: 'review', revision: 3, policyRevision: 1, createdAt: now(), updatedAt: now(), stageEnteredAt: now(), ready: true, epoch: 1, lease: null,
    workspaces: [{ host: 'h', path: '/w', branch: candidate.branch, epoch: 1, owner: 'graphyard-claude-1' }], candidate, submission: { epoch: 1, pr: 7 }, reworkRequested: false,
    scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [], implementers: ['graphyard-claude-1'], pipeline: { attempts: [], submittedAt: null, resubmittedAt: null, reworkRounds: 0, interventions: { blocked: 0, requirements: 0 } },
    observation: { source: 'control-plane', at: now(), candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false,
      files: ['feature.ts'], scopeFiles: [{ path: 'feature.ts', status: 'added', sha: head, additions: 1, deletions: 0, binary: false }], baseTip: base, baseTipContained: true } } as unknown as Work;
  // The item has reached product review: the loop's reconcile opens the product request.
  reconcileAutoDispatch(work, [work], new Date());
  assert.equal(work.autoDispatch?.product?.state, 'requested', 'the feature owes a product review');
  await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1,$2)', [work.id, JSON.stringify(work)]);
  return work;
}
const approve = () => `Walked it.\n{"verdict": "APPROVE", "body": "Product reviewed head ${head} against base ${base}. AC-1 met.", "findings": []}`;
function runtime() {
  const runs: { env: Record<string, string> }[] = [];
  const exec: HeadlessExec = async (_command, _args, options) => { runs.push({ env: options.env }); return approve(); };
  return { exec, runs };
}
const run = (command: string, args: string[], options?: { cwd?: string }) => {
  if (command === 'git' || command === 'node') return execFileSync(command, args, { encoding: 'utf8', cwd: options?.cwd });
  throw new Error(`no ${command} here`);
};
/** One loop dispatch cycle over these items. */
async function cycle(items: Work[], exec: HeadlessExec) {
  const config = await loadMasterConfig(root);
  const effects = dispatchEffects(root, config, {
    snapshot: async () => ({ work: await Promise.all(items.map(item => stored(item.id))), now: now() }),
    mutate: async (path: string, body: unknown) => {
      const response = await fetch(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${coordinatorToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body) });
      const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
    },
    run, headless: exec,
  });
  effects.inventory = async () => headlessInventory();
  return runDispatchTick(config, emptyDispatchCursor(config), effects);
}
const until = async (what: string, check: () => Promise<boolean> | boolean) => {
  for (let tries = 0; tries < 400; tries++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.fail(`timed out waiting for ${what}`);
};
const doctor = async () => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GRAPHYARD_')) delete env[key];
  env.GRAPHYARD_URL = 'http://127.0.0.1:9';
  const { stdout } = await promisify(execFile)(process.execPath, [launcher, 'doctor'], { cwd: root, env });
  return JSON.parse(stdout).browserTool as { present: boolean; path: string | null; install?: string };
};
const installRuns = async () => (await readFile(installs, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;

test('e2e:product-review-browser-provisioned — on a host without the browser tool the loop installs it once and the product reviews run', async () => {
  process.env.HOME = await temporaryDirectory('browser-provisioned-home');
  const before = await doctor();
  assert.equal(before.present, false, 'doctor reports the tool missing');
  assert.match(before.install!, /npm install --prefix \S+ --no-save agent-browser@0\.43\.0 && \S+agent-browser install/, 'doctor names the one command that installs it');
  // Two feature items reach product review together.
  const [first, second] = [await insert('GY-9601'), await insert('GY-9602')];
  const fake = runtime();
  await cycle([first, second], fake.exec);
  await until('both product reviews to settle', async () => (await stored(first.id)).productReview?.verdict === 'approved' && (await stored(second.id)).productReview?.verdict === 'approved');
  assert.equal(await installRuns(), 1, 'two items reaching review together trigger one install');
  assert.equal(fake.runs.length, 2, 'both reviewers ran in the same cycle as the install');
  const toolBin = join(process.env.HOME!, '.local/share/graphyard/tools/node_modules/.bin');
  for (const child of fake.runs) assert.ok(child.env.PATH!.split(':').includes(toolBin), 'the reviewer launch finds the installed tool on its PATH');
  const after = await doctor();
  assert.equal(after.present, true, 'doctor reports the tool present');
  assert.equal(after.path, join(toolBin, 'agent-browser'));
  // Later reviews reuse it: nothing reinstalls.
  const third = await insert('GY-9603');
  await cycle([third], fake.exec);
  await until('the next review to settle', async () => (await stored(third.id)).productReview?.verdict === 'approved');
  assert.equal(await installRuns(), 1, 'the tool is installed once');
});

test('e2e:product-review-browser-provisioned — a failing installer keeps the item in review with no rework and one attention line naming its error', async () => {
  process.env.HOME = await temporaryDirectory('browser-provisioned-failing-home');
  process.env.STUB_NPM_FAIL = '1';
  try {
    const runsBefore = await installRuns();
    const item = await insert('GY-9604');
    const fake = runtime();
    await cycle([item], fake.exec);
    await until('the could-not-run record', async () => (await stored(item.id)).productReview?.verdict === 'could-not-run');
    // The next cycle does not rerun the failed install.
    await cycle([item], fake.exec);
    assert.equal(await installRuns() - runsBefore, 1, 'the failed install ran once');
    assert.equal(fake.runs.length, 0, 'no reviewer started without the tool');
    const stuck = await stored(item.id);
    assert.equal(stuck.stage, 'review', 'the item stays in review');
    assert.equal(stuck.reworkRequested, false, 'no rework');
    assert.equal(stuck.pipeline?.reworkRounds, 0);
    assert.equal(standingVerdict(stuck), null, 'nothing sends the head back to a worker');
    assert.match(stuck.productReview!.findings, /npm ERR! 404 Not Found/);
    const report = await masterStatusReport(root, await loadMasterConfig(root), async () => ({ work: [stuck], now: now() }), async () => `${base}\n`);
    const lines = report.attention.filter((entry: { text: string }) => /npm ERR! 404 Not Found/.test(entry.text));
    assert.equal(lines.length, 1, JSON.stringify(report.attention));
    assert.equal(lines[0]!.subject, item.key);
    assert.match(lines[0]!.text, /installing agent-browser@0\.43\.0 failed: npm ERR! 404 Not Found/);
  } finally { delete process.env.STUB_NPM_FAIL; }
});
