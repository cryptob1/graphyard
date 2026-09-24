import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Observation, Work } from '../src/model.js';
import { reconcileAutoDispatch } from '../src/model/dispatch.js';
import { acknowledgeLaunch, acknowledgementMs, atomicPrivateWrite, buildMasterStatus, defaultAcknowledgementSeconds, dispatchWork, launchApprover, launchDelivery, loadMasterConfig, masterOwnedRunFields, neverStarted, prepareSessionHarness, saveMasterSettings, saveProducerProfile, sessionWords, settlementDue, setupMaster, SessionStartError, startAgentSession, sustainedActivityMs, type HerdrAgent, type WorkerProfile } from '../src/master.js';
import { launchAuthorization, managedInstructions } from '../src/repository-setup.js';
import { bindReviewer, launchReview, readReviewLedger, reconcileReviews, reviewIdleGraceMs, reviewRetryPrompt, saveReviewerProfile, summarizeReviews } from '../src/reviewer.js';
import { launchProducer, producerIdleGraceMs, producerPrompt, readProducerLedger, reconcileProducers, sessionRetries, sessionRetry, sessionRetryBaseMs, sessionRetryLimit, summarizeProducers, unstartedRetryLimit, type ProducerRecord } from '../src/producer.js';
import { emptyDispatchCursor, runDispatchTick, type DispatchEffects } from '../src/auto-dispatch.js';
import { expandTypedCommand, requestOf, roleOf, startedAtOnce } from './helpers/launch-shell.js';
import { readMasterGuide } from './helpers/master-guide.js';

// GY-93: a launched session receives its instruction as its own first request, never as pasted
// content; the loop tells a session that never started from one that did the work and failed;
// a quiet session is re-prompted once and shown as awaiting acknowledgement; and repository
// setup writes the authorization the runtimes need. One case per proof:
// integration:launch-prompt-is-a-request, integration:never-started-vs-failed,
// integration:unacknowledged-session-recovery, manual:launch-authorization-onboarding-review.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const H = sha40('a1'), B = sha40('b1');
const at = '2026-09-20T10:00:00.000Z';
const clock = Date.parse(at);
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x');
const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const mint = async () => ({ token: 'ghs_review_session_token', expiresAt: new Date(Date.now() + 3_500_000).toISOString() });
const producerVerify = (principal: string) => async () => ({ actor: { id: principal, role: 'producer', proofs: ['unit:*', 'integration:*'] } });

function observation(candidate: { sha: string; baseSha: string }): Observation {
  return { candidate: { ...candidate, pr: 93, branch: 'graphyard/gy-93-1', author: 'implementer' }, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true,
    files: ['src/a.ts'], scopeFiles: [], at: new Date().toISOString(), prState: 'open', draft: false, baseTip: candidate.baseSha, baseTree: sha40('7b'), baseTipContained: true };
}
function work(overrides: Partial<Work> = {}): Work {
  const candidate = { sha: H, baseSha: B, pr: 93, branch: 'graphyard/gy-93-1', author: 'implementer' };
  return { id: 'work-93', key: 'GY-93', title: 'Launched sessions refuse their own prompt', description: '', type: 'bug', priority: 0, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Request', proofs: ['integration:launch-prompt-is-a-request'] }],
    policy: { checks: ['test'], review: true, reviewProvider: 'github' }, stage: 'review', revision: 7, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1,
    lease: null, workspaces: [{ host: 'h', path: '/w/gy-93', branch: 'graphyard/gy-93-1', epoch: 1, owner: 'implementer' }], candidate, submission: { epoch: 1, pr: 93 }, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: observation(candidate), blocker: null, gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }], violations: [], ...overrides } as Work;
}
const requested = (overrides: Partial<Work> = {}) => { const item = work(overrides); reconcileAutoDispatch(item, [item], new Date(clock)); return item; };
const ready = () => work({ stage: 'ready', lease: null, submission: null, candidate: null, observation: null, gates: [{ name: 'ready', passed: true, reasons: [] }] });

async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-launch-request-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  return root;
}
/** A master installed in a throwaway repository, its credentials outside it, with a reviewer, a producer and an approver identity. */
async function installed() {
  const root = await repository(), credentials = await mkdtemp(join(tmpdir(), 'graphyard-launch-request-credentials-'));
  await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory: credentials, herdrWorkspace: 'wE' }, coordinatorStatus as typeof fetch);
  await bindReviewer(root, { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', privateKey, credentialDirectory: join(credentials, 'reviewers') }, async () => ({ repository: 'owner/project', permissions: { metadata: 'read', contents: 'read', pull_requests: 'write' } }));
  const token = async (name: string) => { const file = join(credentials, `${name}.token`); await writeFile(file, `${name}-token-`.padEnd(40, 'x'), { mode: 0o600 }); return file; };
  const config = await loadMasterConfig(root);
  await atomicPrivateWrite(join(root, '.graphyard/master.json'), { ...config, approver: { id: 'graphyard-approver-project', credentialFile: await token('approver') } });
  return { root, credentials, token, cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(credentials, { recursive: true, force: true }); } };
}

/**
 * A Herdr whose runtimes behave like the real ones (GY-93): a session starts its first tool call
 * only when its instruction arrives as its own request — on the command line, under the runtime's
 * contract — and refuses anything typed in as a paste, which is what `agent prompt` delivers.
 * The pane's shell expands the launch line the launcher types (GY-121): the request and the role
 * authorization come from the files it references, never from the line itself.
 */
class FakeHerdr {
  calls: string[][] = [];
  sessions = new Map<string, { name: string | null; kind: string; request: string | null; role: string | null; args: string[]; toolCalls: string[]; pasted: string[]; status: string; screen: string }>();
  private panes = 0;
  constructor(private options: { occupant?: (kind: string) => string | null } = {}) {}
  private start(pane: string, kind: string, args: string[], name: string | null) {
    const request = requestOf(kind, args);
    const session = { name, kind: this.options.occupant?.(kind) ?? kind, request, role: roleOf(args), args, toolCalls: [] as string[], pasted: [] as string[], status: request ? 'working' : 'idle', screen: `${kind} ready\n` };
    // The runtime acts on its own request at once: its first tool call, before any further input.
    if (request) { session.toolCalls.push(`first tool call on request: ${request.slice(0, 60)}`); session.screen += `❯ ${request}\n  Ran 1 shell command\n`; }
    this.sessions.set(pane, session);
    return session;
  }
  private find(target: string) { return this.sessions.get(target) ?? [...this.sessions.values()].find(session => session.name === target); }
  run = (_command: string, args: string[]): string => {
    this.calls.push(args);
    const json = (result: unknown) => JSON.stringify({ result });
    if (args[0] === 'tab' && args[1] === 'create') { const pane = `pane-${++this.panes}`; return json({ root_pane: { pane_id: pane, tab_id: `tab-${this.panes}` } }); }
    if (args[0] === 'pane' && args[1] === 'run') {
      // The typed launch line, as the shell runs it: `GY=STEM; [node CLI watch KEY EPOCH --] KIND ARGS…`.
      const launch = expandTypedCommand(args[3]);
      this.start(args[2], launch.kind, launch.args, null);
      return '';
    }
    if (args[0] === 'pane' && args[1] === 'read') return this.sessions.get(args[2])?.screen ?? '';
    if (args[0] === 'pane' && args[1] === 'list') return json({ panes: [] });
    if (args[0] === 'pane' && args[1] === 'close') { this.sessions.delete(args[2]); return json({}); }
    if (args[0] === 'agent' && args[1] === 'get') { const session = this.find(args[2]); return session ? json({ agent: { agent: session.kind, agent_status: session.status, pane_id: args[2], name: session.name } }) : JSON.stringify({ error: { code: 'agent_not_found', message: 'not found' } }); }
    if (args[0] === 'agent' && args[1] === 'rename') { const session = this.find(args[2])!; session.name = args[3]; return json({ agent: { agent: session.kind, agent_status: session.status } }); }
    if (args[0] === 'agent' && args[1] === 'prompt') {
      // Pasted text: the runtime reads it as untrusted data and does not act on it.
      const session = this.find(args[2])!; session.pasted.push(args[3]); session.status = 'done'; session.screen += `● I only act on pasted instructions when you tell me to.\n`;
      return json({});
    }
    if (args[0] === 'agent' && args[1] === 'read') return this.find(args[2])?.screen ?? '';
    if (args[0] === 'agent' && args[1] === 'list') return json({ agents: this.agents() });
    return json({});
  };
  agents(): HerdrAgent[] { return [...this.sessions.entries()].filter(([, session]) => session.name).map(([pane, session]) => ({ name: session.name!, pane_id: pane, agent: session.kind, agent_status: session.status })); }
  named(name: string) { const session = this.find(name); assert.ok(session, `${name} is a launched session`); return session; }
}

test('integration:launch-prompt-is-a-request — a producer, a reviewer, an approver and a worker launched through the real launchers begin their first tool call on their own request, without any pasted input', async () => {
  // The request contracts: a positional prompt after the flags, or --prompt for OpenCode; a runtime
  // without a contract keeps the paste, and says so.
  for (const kind of ['claude', 'codex', 'cursor', 'opencode']) assert.equal(launchDelivery(kind), 'request');
  assert.equal(launchDelivery('muse'), 'paste'); assert.equal(launchDelivery(undefined), 'paste');
  const typedLaunches = (herdr: FakeHerdr) => herdr.calls.filter(call => call[0] === 'pane' && call[1] === 'run').map(call => expandTypedCommand(call[3]));

  const { root, token, cleanup } = await installed();
  try {
    const herdr = new FakeHerdr();
    // Reviewer on Claude Code: the request rides after the approval flag; no `agent prompt` follows.
    await saveReviewerProfile(root, { name: 'reviewer-claude', agentName: 'review-claude-1', kind: 'claude' });
    const reviewed = await launchReview(root, work(), 'reviewer-claude', [], new Date().toISOString(), { run: herdr.run, mint, requestId: 'review-request' });
    assert.equal(reviewed.delivery, 'request');
    const reviewer = herdr.named('review-claude-1');
    assert.match(reviewer.request!, /pull request #93 at head a1f+ against base b1f+/);
    assert.equal(reviewer.toolCalls.length, 1, 'the reviewer began its first tool call on its request');
    assert.deepEqual(reviewer.pasted, [], 'nothing was pasted into the reviewer');
    const reviewStart = typedLaunches(herdr)[0];
    assert.equal(reviewStart.kind, 'claude');
    assert.deepEqual(reviewStart.args.slice(0, 2), ['--permission-mode', 'bypassPermissions'], 'the non-interactive contract still leads the arguments');
    assert.equal(reviewStart.args.at(-1), reviewer.request, 'the request is the last argument, the positional prompt, read from the request file');
    assert.equal((await readReviewLedger(root)).reviews[0].delivery, 'request');

    // Producer on Codex: the request comes after the sandbox flags and their values.
    const producerCredential = await token('producer');
    await saveProducerProfile(root, { name: 'producer-codex', principal: 'proof-runner', agentName: 'produce-codex', kind: 'codex', credentialFile: producerCredential }, producerVerify('proof-runner'));
    const config = await loadMasterConfig(root);
    const item = requested();
    const request = item.autoDispatch!.producers[0];
    const produced = await launchProducer(root, item, request, config.producers[0], [], new Date().toISOString(), { run: herdr.run });
    assert.equal(produced.delivery, 'request');
    const producer = herdr.named('produce-codex');
    // GY-88: the request names the session directory the launch allocated under the managed worktree root.
    assert.equal(producer.request, producerPrompt(config, { key: 'GY-93', pr: 93, sha: H, baseSha: B, policyRevision: 1, group: request.group!, proofs: request.proofs!, checkout: produced.checkout }, { principal: 'proof-runner' }));
    assert.equal(producer.toolCalls.length, 1); assert.deepEqual(producer.pasted, []);
    const produceStart = typedLaunches(herdr).at(-1)!;
    assert.ok(produceStart.args.includes('--ask-for-approval') && produceStart.args.includes('--add-dir'), 'the Codex sandbox flags are kept');
    assert.equal((await readProducerLedger(root)).producers[0].delivery, 'request');

    // Approver on Cursor: the same, for the decision it judges.
    const approved = await launchApprover(root, work(), 'decision-1', 'cursor', [], herdr.run);
    assert.equal(approved.delivery, 'request');
    // Looked up under the name the launcher reports: how an approver session is named is the
    // launcher's to decide, and what this asserts is how that session received its request.
    assert.match(approved.agentName, /^graphyard-approver-gy-93/);
    const approver = herdr.named(approved.agentName);
    assert.match(approver.request!, /Judge decision decision-1 on GY-93/);
    assert.equal(approver.toolCalls.length, 1); assert.deepEqual(approver.pasted, []);

    // Worker on OpenCode, under the supervisor: --prompt on the watched command line.
    const workerCredential = await token('worker');
    const profile: WorkerProfile = { name: 'worker-oc', principal: 'worker-a', agentName: 'eng-oc', mode: 'launch', kind: 'opencode', credentialFile: workerCredential, agentArgs: [], approvals: 'auto', environment: {} };
    const dispatched = await dispatchWork(root, ready(), profile, [], herdr.run, [ready()], async () => ({ epoch: 4, path: join(root, 'assigned'), base: 'c'.repeat(40) }), async () => {}, 5_000);
    assert.equal(dispatched.delivery, 'request');
    const worker = herdr.named('eng-oc');
    assert.match(worker.request!, /^Implement GY-93:/);
    assert.equal(worker.toolCalls.length, 1); assert.deepEqual(worker.pasted, []);
    assert.equal(herdr.calls.filter(call => call[0] === 'agent' && call[1] === 'prompt').length, 0, 'no launch typed anything into a session');

    // A runtime without a request contract keeps the confirmed paste delivery, and the record says so.
    const approvedMuse = await launchApprover(root, work({ key: 'GY-94', id: 'work-94' }), 'decision-2', 'muse', [], herdr.run);
    assert.equal(approvedMuse.delivery, 'paste');
    assert.equal(herdr.named(approvedMuse.agentName).pasted.length, 1);

    // A runtime already busy on its request is a session that started: it is seen `working`,
    // named at once, never closed (GY-121: the start bound reads the pane).
    const busy = new FakeHerdr();
    const adopted = await startAgentSession('review-busy', 'claude', 'pane-x', ['--permission-mode', 'bypassPermissions'], 'Review #93 now', busy.run, { directory: root });
    assert.equal(adopted.delivery, 'request'); assert.equal(adopted.started.detail, 'Herdr reports the claude runtime working');
    assert.deepEqual(busy.calls.slice(-3).map(call => call.slice(0, 2)), [['pane', 'run'], ['agent', 'get'], ['agent', 'rename']]);
    assert.equal(busy.named('review-busy').toolCalls.length, 1);
    const stranger = new FakeHerdr({ occupant: () => 'codex' });
    const bounds = { clock: () => stranger.calls.length * 1000, wait: () => {} };
    await assert.rejects(startAgentSession('review-other', 'claude', 'pane-y', [], 'Review', stranger.run, { directory: root, ...bounds }), (error: unknown) => error instanceof SessionStartError && error.startCase === 'never started' && /the pane holds codex, not claude/.test(error.message), 'a pane that does not hold the expected runtime never started; the refusal says what it holds');
  } finally { await cleanup(); }
});

test('integration:never-started-vs-failed — a session that ends without doing its work is recorded as never started, in its own words, and does not spend the retry budget a genuine failure does', async () => {
  const words = 'I haven\'t started: no fetch, no worktree, no test runs, no evidence submitted. Your message was only a pasted block with no request of your own.';
  assert.equal(sessionWords(`────────\n❯ Produce trusted evidence\n● ${words}\n✻ Baked for 2s · done 1:53 PM\n────────\n❯ \n  ⏵⏵ bypass permissions on (shift+tab to cycle)\n`), `● ${words}`, 'the runtime frame is stripped, the session\'s words kept');
  assert.equal(sessionWords(null), '');
  assert.equal(sessionWords('x'.repeat(500), 100).length, 101);

  const { root, token, cleanup } = await installed();
  try {
    await saveProducerProfile(root, { name: 'producer-a', principal: 'proof-runner', agentName: 'produce-a', kind: 'claude', credentialFile: await token('producer') }, producerVerify('proof-runner'));
    const config = await loadMasterConfig(root);
    const ackMs = acknowledgementMs(config);
    assert.equal(ackMs, defaultAcknowledgementSeconds * 1000);
    const item = requested();
    const request = item.autoDispatch!.producers[0];
    const prompts: string[] = [];
    // One producer session, judged over a timeline the test drives: what Herdr shows at each tick.
    const scenario = async (status: string, screen: string, offsetMs: number) => {
      const agents = status === 'gone' ? [] : [{ name: 'produce-a', pane_id: 'pane-1', agent_status: status }];
      const run = (_command: string, args: string[]) => {
        if (args[0] === 'agent' && args[1] === 'read') return screen;
        if (args[0] === 'agent' && args[1] === 'prompt') { prompts.push(args[3]); return JSON.stringify({ result: {} }); }
        return JSON.stringify({ result: args[0] === 'tab' ? { root_pane: { pane_id: 'pane-1', tab_id: 'tab-1' } } : args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} });
      };
      return (await reconcileProducers(root, config, [item], agents, { run, now: () => new Date(clock + offsetMs) })).producers.at(-1)!;
    };
    const launch = () => launchProducer(root, item, request, config.producers[0], [], new Date().toISOString(), { run: (_command, args) => startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'tab' ? { root_pane: { pane_id: 'pane-1', tab_id: 'tab-1' } } : {} }), now: () => new Date(clock) });

    // A session that refused: one short turn, then a screen that never changes.
    await launch();
    const refusal = `❯ You are an independent Graphyard proof producer…\n● ${words}\n`;
    let record = await scenario('done', refusal, 10_000);
    assert.equal(record.state, 'pending'); assert.equal(record.idleSince, iso(10_000)); assert.equal(record.acknowledgedAt, undefined); assert.equal(record.repromptedAt, undefined, 'before the interval nothing is re-prompted');
    record = await scenario('done', refusal, ackMs + 10_000);
    assert.equal(record.repromptedAt, iso(ackMs + 10_000), 'quiet through the interval: re-prompted once');
    assert.equal(prompts.length, 1); assert.match(prompts[0], /sent once more by that same launcher/); assert.ok(prompts[0].endsWith(producerPrompt(config, record, record)), 'the re-prompt carries the session\'s own request');
    // The second refusal is caught working for a few seconds, and its answer changes the screen:
    // neither acknowledges the session.
    record = await scenario('working', refusal, ackMs + 20_000);
    record = await scenario('done', `${refusal}❯ The Graphyard launcher…\n● Still a paste; I will not act on it.\n`, ackMs + 30_000);
    record = await scenario('done', `${refusal}❯ The Graphyard launcher…\n● Still a paste; I will not act on it.\n`, ackMs + 40_000);
    assert.equal(record.acknowledgedAt, undefined); assert.equal(prompts.length, 1, 'the re-prompt is sent exactly once'); assert.equal(record.state, 'pending');
    // The second refusal was a turn, so the grace a finished session gets runs from its end.
    record = await scenario('done', `${refusal}❯ The Graphyard launcher…\n● Still a paste; I will not act on it.\n`, ackMs + 30_000 + producerIdleGraceMs - 1);
    assert.equal(record.state, 'pending', 'the grace period is the same one every finished session gets');
    record = await scenario('done', `${refusal}❯ The Graphyard launcher…\n● Still a paste; I will not act on it.\n`, ackMs + 30_000 + producerIdleGraceMs);
    assert.equal(record.state, 'failed');
    assert.match(record.resolution!, /^never started: the session took up neither its request nor the re-prompt at .* and ended without acting\. Its last words: "/);
    assert.ok(record.resolution!.includes('Still a paste; I will not act on it.'), 'the reason carries the session\'s own words');
    assert.equal(neverStarted(record), true);
    assert.equal(summarizeProducers([record]).completed[0].neverStarted, true);

    // Its request is launched again after the base wait: the never-started session spent no budget.
    const unstarted = { requestId: request.id, state: record.state, requestedAt: record.requestedAt, closedAt: record.closedAt, resolution: record.resolution };
    let retry = sessionRetry([unstarted], request.id, clock);
    assert.deepEqual([retry.attempts, retry.started, retry.neverStarted, retry.limit, retry.unstartedLimit, retry.exhausted], [1, 0, 1, sessionRetryLimit, unstartedRetryLimit, false]);
    assert.equal(retry.nextAt, new Date(Date.parse(record.closedAt!) + sessionRetryBaseMs).toISOString());
    retry = sessionRetry([unstarted, { ...unstarted, closedAt: iso(20 * 60_000) }], request.id, clock);
    assert.equal(retry.nextAt, iso(20 * 60_000 + sessionRetryBaseMs), 'a second never-started session waits the base interval again, not a wider one');
    assert.equal(sessionRetry(Array.from({ length: unstartedRetryLimit }, () => unstarted), request.id, clock).exhausted, true, 'never-started sessions have a bound of their own');
    // A genuine failure counts and widens the wait: two of them, then a never-started one.
    const failedAt = (minutes: number) => ({ requestId: request.id, state: 'failed', requestedAt: iso(minutes * 60_000 - 30_000), closedAt: iso(minutes * 60_000), resolution: 'the session finished (done) without trusted evidence for integration:x (missing). Its last words: "npm test failed"' });
    assert.equal(sessionRetry([failedAt(0), failedAt(10)], request.id, clock).nextAt, iso(10 * 60_000 + 4 * sessionRetryBaseMs));
    retry = sessionRetry([failedAt(0), failedAt(10), { ...unstarted, closedAt: iso(20 * 60_000) }], request.id, clock);
    assert.deepEqual([retry.attempts, retry.started, retry.neverStarted, retry.nextAt], [3, 2, 1, iso(20 * 60_000 + sessionRetryBaseMs)]);
    assert.equal(sessionRetry([failedAt(0), failedAt(10), failedAt(40), failedAt(80)], request.id, clock).exhausted, true, 'four genuine failures still exhaust the request');
    assert.equal(sessionRetries([failedAt(0), { ...unstarted, closedAt: iso(20 * 60_000) }], clock)[0].neverStarted, 1);

    // A session that did the work and failed: sustained activity, then done without evidence.
    const ledger = await readProducerLedger(root);
    ledger.producers = ledger.producers.filter(entry => entry.state !== 'failed');
    await atomicPrivateWrite(join(root, '.graphyard/producers.json'), ledger);
    await launch();
    prompts.length = 0;
    record = await scenario('working', '', 10_000);
    assert.equal(record.acknowledgedAt, undefined, 'one sighting proves nothing'); assert.equal(record.activeSince, iso(10_000));
    record = await scenario('idle', '❯ …\n  Running npm test (12s)\n', 30_000);
    assert.equal(record.activeSince, undefined, 'the first screen read is a baseline, not activity: the window a working sighting opened is closed');
    record = await scenario('idle', '❯ …\n  Running npm test (22s)\n', 40_000);
    assert.equal(record.activeSince, iso(40_000)); assert.equal(record.acknowledgedAt, undefined);
    record = await scenario('idle', '❯ …\n  Running npm test (42s)\n', 60_000);
    record = await scenario('idle', '❯ …\n  Running npm test (52s)\n', 70_000);
    assert.equal(record.acknowledgedAt, iso(70_000), 'a screen that keeps changing while a long command runs is activity, sustained across thirty seconds');
    assert.equal(summarizeProducers([record]).pending[0].activity, 'running');
    record = await scenario('done', '● The integration suite failed on two cases; I did not submit evidence.\n', 200_000);
    assert.equal(record.idleSince, iso(30_000), 'the grace runs from the first finished sighting, as before'); assert.equal(prompts.length, 0, 'an acknowledged session is never re-prompted');
    record = await scenario('done', '● The integration suite failed on two cases; I did not submit evidence.\n', 30_000 + producerIdleGraceMs);
    assert.equal(record.state, 'failed'); assert.equal(neverStarted(record), false);
    assert.match(record.resolution!, /^the session finished \(done\) without trusted evidence for .*\. Its last words: "● The integration suite failed on two cases; I did not submit evidence\."$/);

    // A session gone from Herdr before it was ever acknowledged never started either; its words are unreadable.
    const gone = await readProducerLedger(root);
    gone.producers = gone.producers.filter(entry => entry.state !== 'failed');
    await atomicPrivateWrite(join(root, '.graphyard/producers.json'), gone);
    await launch();
    record = await scenario('gone', '', 10_000);
    record = await scenario('gone', '', 10_000 + producerIdleGraceMs);
    assert.equal(record.state, 'failed'); assert.equal(record.resolution, 'never started: the session left Herdr without acting on its request');

    // The reviewer ledger judges the same way: its one reminder carries the request, and a
    // session that never took it up settles as never started.
    await saveReviewerProfile(root, { name: 'reviewer-claude', agentName: 'review-claude-1', kind: 'claude' });
    await launchReview(root, work(), 'reviewer-claude', [], new Date().toISOString(), { run: (_command, args) => startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'tab' ? { root_pane: { pane_id: 'pane-r', tab_id: 'tab-r' } } : {} }), mint, requestId: 'review-request', now: () => new Date(clock) });
    const reviewPrompts: string[] = [];
    const review = async (status: string, screen: string, offsetMs: number) => (await reconcileReviews(root, config, { run: (_command, args) => args[0] === 'agent' && args[1] === 'read' ? screen : JSON.stringify({ result: args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} }), observe: () => null, work: [work()], agents: [{ name: 'review-claude-1', pane_id: 'pane-r', agent_status: status }], now: () => new Date(clock + offsetMs), retry: (_record, message) => { reviewPrompts.push(message); } })).reviews[0];
    let reviewRecord = await review('done', `● ${words}\n`, 10_000);
    assert.equal(reviewRecord.repromptedAt, iso(10_000)); assert.equal(reviewPrompts.length, 1);
    assert.ok(reviewPrompts[0].startsWith('You stopped before posting')); assert.match(reviewPrompts[0], /If you have not reviewed it at all, this message comes from the Graphyard launcher/); assert.match(reviewPrompts[0], /Review pull request #93 at head/);
    assert.equal(summarizeReviews([reviewRecord]).pending[0].activity, 'awaiting acknowledgement');
    reviewRecord = await review('done', `● ${words}\n`, 10_000 + reviewIdleGraceMs);
    assert.equal(reviewRecord.state, 'failed'); assert.equal(neverStarted(reviewRecord), true);
    assert.ok(reviewRecord.resolution!.includes(words));
    assert.match(reviewRetryPrompt('owner/project', { key: 'GY-93', pr: 93, sha: H }), /Do not ask for confirmation/);
    assert.equal(/If you have not reviewed it at all/.test(reviewRetryPrompt('owner/project', { key: 'GY-93', pr: 93, sha: H })), false, 'without the binding the reminder cannot repeat the request, and does not pretend to');

    // An interval longer than the finished-session grace: the grace does not settle an
    // unacknowledged session that is still in Herdr before its re-prompt and the interval after
    // it, so the whole configured range records a refusal as never started, never as a failure.
    await saveMasterSettings(root, { acknowledgementSeconds: 600 });
    const slow = await loadMasterConfig(root);
    const slowMs = acknowledgementMs(slow);
    assert.ok(slowMs > producerIdleGraceMs && slowMs > reviewIdleGraceMs, 'the case is above both graces');
    const slowLedger = await readProducerLedger(root);
    slowLedger.producers = slowLedger.producers.filter(entry => entry.state !== 'failed');
    await atomicPrivateWrite(join(root, '.graphyard/producers.json'), slowLedger);
    await launch();
    prompts.length = 0;
    const slowly = async (status: string, screen: string, offsetMs: number) => {
      const agents = status === 'gone' ? [] : [{ name: 'produce-a', pane_id: 'pane-1', agent_status: status }];
      const run = (_command: string, args: string[]) => {
        if (args[0] === 'agent' && args[1] === 'read') return screen;
        if (args[0] === 'agent' && args[1] === 'prompt') { prompts.push(args[3]); return JSON.stringify({ result: {} }); }
        return JSON.stringify({ result: args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} });
      };
      return (await reconcileProducers(root, slow, [item], agents, { run, now: () => new Date(clock + offsetMs) })).producers.at(-1)!;
    };
    record = await slowly('done', refusal, 10_000);
    assert.equal(record.idleSince, iso(10_000));
    record = await slowly('done', refusal, 10_000 + producerIdleGraceMs);
    assert.equal(record.state, 'pending', 'the grace has run out, but the session has not yet been re-prompted: it is not settled');
    assert.equal(record.repromptedAt, undefined); assert.equal(prompts.length, 0);
    record = await slowly('done', refusal, slowMs);
    assert.equal(record.repromptedAt, iso(slowMs), 're-prompted at the configured interval'); assert.equal(prompts.length, 1); assert.match(prompts[0], /seen no activity from it for 600 seconds/);
    assert.equal(record.state, 'pending');
    record = await slowly('done', refusal, slowMs + producerIdleGraceMs);
    assert.equal(record.state, 'pending', 'a grace after the re-prompt is not enough either: the interval after it is what counts');
    record = await slowly('done', refusal, 2 * slowMs - 1);
    assert.equal(record.state, 'pending');
    record = await slowly('done', refusal, 2 * slowMs);
    assert.equal(record.state, 'failed'); assert.equal(neverStarted(record), true);
    assert.match(record.resolution!, /^never started: the session took up neither its request nor the re-prompt at .* and ended without acting\./);
    assert.equal(prompts.length, 1, 'still exactly one re-prompt');
    // The gate itself: a session gone from Herdr, or acknowledged, is settled by the grace alone.
    assert.equal(settlementDue({ requestedAt: iso(0) }, undefined, { now: clock + 1, ackMs: slowMs }), true);
    assert.equal(settlementDue({ requestedAt: iso(0), acknowledgedAt: iso(40_000) }, { agent_status: 'done' }, { now: clock + 50_000, ackMs: slowMs }), true);
    assert.equal(settlementDue({ requestedAt: iso(0) }, { agent_status: 'done' }, { now: clock + 10 * slowMs, ackMs: slowMs }), false, 'never re-prompted: never settled while it is still in Herdr');
    assert.equal(settlementDue({ requestedAt: iso(0), repromptedAt: iso(slowMs) }, { agent_status: 'done' }, { now: clock + 2 * slowMs - 1, ackMs: slowMs }), false);
    assert.equal(settlementDue({ requestedAt: iso(0), repromptedAt: iso(slowMs) }, { agent_status: 'done' }, { now: clock + 2 * slowMs, ackMs: slowMs }), true);

    // The reviewer at the same interval: its reminder goes at the first finished sighting, and the
    // session is settled an interval after that, not when the grace ends.
    const slowReviews = await readReviewLedger(root);
    slowReviews.reviews = slowReviews.reviews.filter(entry => entry.state !== 'failed');
    await atomicPrivateWrite(join(root, '.graphyard/reviews.json'), slowReviews);
    await launchReview(root, work(), 'reviewer-claude', [], new Date().toISOString(), { run: (_command, args) => startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'tab' ? { root_pane: { pane_id: 'pane-r', tab_id: 'tab-r' } } : {} }), mint, requestId: 'review-request-slow', now: () => new Date(clock) });
    reviewPrompts.length = 0;
    const slowReview = async (status: string, screen: string, offsetMs: number) => (await reconcileReviews(root, slow, { run: (_command, args) => args[0] === 'agent' && args[1] === 'read' ? screen : JSON.stringify({ result: args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} }), observe: () => null, work: [work()], agents: [{ name: 'review-claude-1', pane_id: 'pane-r', agent_status: status }], now: () => new Date(clock + offsetMs), retry: (_record, message) => { reviewPrompts.push(message); } })).reviews.at(-1)!;
    reviewRecord = await slowReview('done', `● ${words}\n`, 10_000);
    assert.equal(reviewRecord.repromptedAt, iso(10_000)); assert.equal(reviewPrompts.length, 1);
    reviewRecord = await slowReview('done', `● ${words}\n`, 10_000 + reviewIdleGraceMs);
    assert.equal(reviewRecord.state, 'pending', 'the grace alone does not settle an unacknowledged reviewer session');
    reviewRecord = await slowReview('done', `● ${words}\n`, 10_000 + slowMs - 1);
    assert.equal(reviewRecord.state, 'pending');
    reviewRecord = await slowReview('done', `● ${words}\n`, 10_000 + slowMs);
    assert.equal(reviewRecord.state, 'failed'); assert.equal(neverStarted(reviewRecord), true); assert.equal(reviewPrompts.length, 1);
    // An acknowledged reviewer session that stops without a verdict is still settled by the grace.
    const acknowledgedReviews = await readReviewLedger(root);
    acknowledgedReviews.reviews = acknowledgedReviews.reviews.filter(entry => entry.state !== 'failed');
    await atomicPrivateWrite(join(root, '.graphyard/reviews.json'), acknowledgedReviews);
    await launchReview(root, work(), 'reviewer-claude', [], new Date().toISOString(), { run: (_command, args) => startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'tab' ? { root_pane: { pane_id: 'pane-r', tab_id: 'tab-r' } } : {} }), mint, requestId: 'review-request-worked', now: () => new Date(clock) });
    reviewRecord = await slowReview('working', '', 5_000);
    reviewRecord = await slowReview('working', '', 5_000 + sustainedActivityMs);
    assert.equal(reviewRecord.acknowledgedAt, iso(5_000 + sustainedActivityMs));
    reviewRecord = await slowReview('done', '● I judged it but the post was refused.\n', 60_000);
    reviewRecord = await slowReview('done', '● I judged it but the post was refused.\n', 60_000 + reviewIdleGraceMs);
    assert.equal(reviewRecord.state, 'failed'); assert.equal(neverStarted(reviewRecord), false);
    assert.match(reviewRecord.resolution!, /^the reviewer session finished \(done\) without posting a verdict/);
  } finally { await cleanup(); }
});

test('integration:unacknowledged-session-recovery — the loop detects a launched session with no activity within the configured interval, re-prompts it once and records that it did, and master status shows it awaiting acknowledgement rather than running', async () => {
  // The judgement itself, on a record: quiet through the interval means one re-prompt; sustained
  // activity, or a result, means acknowledged; a second refusal after the re-prompt means neither.
  const record = { requestedAt: iso(0) } as { requestedAt: string; acknowledgedAt?: string; repromptedAt?: string; activeSince?: string; screen?: string };
  const screen = (text: string) => () => text;
  assert.deepEqual(await acknowledgeLaunch(record, { agent_status: 'done' }, { now: clock + 10_000, ackMs: 90_000, result: false, screen: screen('a') }), { changed: true, reprompt: false });
  assert.deepEqual(await acknowledgeLaunch(record, { agent_status: 'done' }, { now: clock + 90_000, ackMs: 90_000, result: false, screen: screen('a') }), { changed: false, reprompt: true });
  assert.deepEqual(await acknowledgeLaunch(record, undefined, { now: clock + 90_000, ackMs: 90_000, result: false, screen: screen('a') }), { changed: false, reprompt: false }, 'a session gone from Herdr cannot be re-prompted');
  assert.deepEqual((await acknowledgeLaunch({ ...record }, { agent_status: 'done' }, { now: clock + 90_000, ackMs: 90_000, result: true, screen: screen('a') })).changed, true, 'a result acknowledges at once');
  const active = { requestedAt: iso(0) } as typeof record;
  await acknowledgeLaunch(active, { agent_status: 'working' }, { now: clock + 5_000, ackMs: 90_000, result: false, screen: screen('') });
  assert.equal(active.activeSince, iso(5_000)); assert.equal(active.acknowledgedAt, undefined);
  await acknowledgeLaunch(active, { agent_status: 'working' }, { now: clock + 5_000 + sustainedActivityMs - 1, ackMs: 90_000, result: false, screen: screen('') });
  assert.equal(active.acknowledgedAt, undefined);
  await acknowledgeLaunch(active, { agent_status: 'blocked' }, { now: clock + 5_000 + sustainedActivityMs, ackMs: 90_000, result: false, screen: screen('') });
  assert.equal(active.acknowledgedAt, iso(5_000 + sustainedActivityMs));
  // A refusal caught working, then quiet, then one late screen change: two active sightings far
  // apart are not activity sustained across thirty seconds, because the quiet sighting between
  // them closed the window.
  const flicker = { requestedAt: iso(0) } as typeof record;
  await acknowledgeLaunch(flicker, { agent_status: 'working' }, { now: clock + 5_000, ackMs: 90_000, result: false, screen: screen('a') });
  assert.equal(flicker.activeSince, iso(5_000));
  assert.deepEqual(await acknowledgeLaunch(flicker, { agent_status: 'done' }, { now: clock + 35_000, ackMs: 90_000, result: false, screen: screen('a') }), { changed: true, reprompt: false });
  assert.equal(flicker.activeSince, undefined, 'a sighting that is not active closes the activity window, the first screen read among them');
  await acknowledgeLaunch(flicker, { agent_status: 'done' }, { now: clock + 65_000, ackMs: 90_000, result: false, screen: screen('b') });
  assert.equal(flicker.acknowledgedAt, undefined, 'one later screen change starts a window, it does not complete one');
  assert.equal(flicker.activeSince, iso(65_000));
  assert.deepEqual(await acknowledgeLaunch(flicker, { agent_status: 'done' }, { now: clock + 95_000, ackMs: 90_000, result: false, screen: screen('b') }), { changed: true, reprompt: true });
  assert.equal(flicker.activeSince, undefined, 'quiet again: the window closes and the re-prompt is due');

  const { root, token, cleanup } = await installed();
  try {
    await saveProducerProfile(root, { name: 'producer-a', principal: 'proof-runner', agentName: 'produce-a', kind: 'claude', credentialFile: await token('producer') }, producerVerify('proof-runner'));
    // The interval is the master's own setting, adopted like every other owned run field.
    assert.ok((masterOwnedRunFields as readonly string[]).includes('acknowledgementSeconds'));
    await saveMasterSettings(root, { acknowledgementSeconds: 120 });
    const config = await loadMasterConfig(root);
    assert.equal(acknowledgementMs(config), 120_000);
    const item = requested();
    const request = item.autoDispatch!.producers[0];
    const herdr = new FakeHerdr();
    await launchProducer(root, item, request, config.producers[0], [], new Date().toISOString(), { run: herdr.run, now: () => new Date(clock) });
    const session = herdr.named('produce-a');
    // The runtime took the request but then stopped: one turn, then a still screen.
    session.status = 'done'; session.screen = '● I could not find the proof; stopping.\n';
    let now = clock;
    const effects: DispatchEffects = {
      snapshot: async () => ({ work: [item], now: new Date(now).toISOString() }), agents: () => herdr.agents(),
      credentials: async profiles => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])),
      reconcileReviews: async () => ({ reviews: [] }),
      reconcileProducers: (work, agents) => reconcileProducers(root, config, work, agents, { run: herdr.run, now: () => new Date(now) }),
      launchReview: async () => { throw new Error('not launched'); }, launchProducer: async () => { throw new Error('one session per request'); }, persist: async () => {},
    };
    const cursor = emptyDispatchCursor(config);
    const prompted = () => herdr.calls.filter(call => call[0] === 'agent' && call[1] === 'prompt');
    const status = async () => {
      const records = (await readProducerLedger(root)).producers;
      return buildMasterStatus({ work: [item], now: new Date(now).toISOString() }, [], herdr.agents(), {}, {}, summarizeReviews([]), 'main', undefined, { producers: summarizeProducers(records), failures: [], retries: sessionRetries(records, now) });
    };
    now = clock + 10_000; await runDispatchTick(config, cursor, effects, () => now);
    assert.equal(prompted().length, 0, 'within the interval the loop waits');
    let report = await status();
    assert.equal(report.work[0].dispatch!.producers[0].session!.activity, 'awaiting acknowledgement');
    assert.equal(report.counts.dispatchAwaiting, 1); assert.equal(report.counts.dispatchRunning, 0);
    assert.equal(report.work[0].attention, null, 'no attention until the loop has re-prompted');
    now = clock + 100_000; await runDispatchTick(config, cursor, effects, () => now);
    assert.equal(prompted().length, 0, 'the configured interval, not the default, is what the loop waits for');
    now = clock + 121_000; const tick = await runDispatchTick(config, cursor, effects, () => now);
    assert.equal(tick.skipped, 1, 'the request keeps its one session');
    assert.equal(prompted().length, 1, 'the loop re-prompted the session once');
    assert.equal(prompted()[0][2], 'produce-a'); assert.match(prompted()[0][3], /seen no activity from it for 120 seconds/);
    let pending = (await readProducerLedger(root)).producers[0];
    assert.equal(pending.repromptedAt, iso(121_000), 'the record says when');
    report = await status();
    const row = report.work[0];
    assert.equal(row.dispatch!.producers[0].session!.activity, 'awaiting acknowledgement');
    assert.equal(row.dispatch!.producers[0].session!.repromptedAt, iso(121_000));
    assert.match(row.attention!, /Producer session for integration proofs of GY-93 \(produce-a\) is awaiting acknowledgement: no activity since its launch at .*, re-prompted once at .*never started if it stays quiet/);
    assert.equal(report.producers.pending[0].activity, 'awaiting acknowledgement');
    now = clock + 131_000; await runDispatchTick(config, cursor, effects, () => now);
    assert.equal(prompted().length, 1, 'never a second re-prompt');
    // The re-prompt reached it: the session works on, is acknowledged, and is running.
    session.status = 'working';
    now = clock + 141_000; await runDispatchTick(config, cursor, effects, () => now);
    now = clock + 141_000 + sustainedActivityMs; await runDispatchTick(config, cursor, effects, () => now);
    pending = (await readProducerLedger(root)).producers[0];
    assert.equal(pending.acknowledgedAt, iso(141_000 + sustainedActivityMs)); assert.equal(pending.state, 'pending'); assert.equal(pending.idleSince, undefined);
    report = await status();
    assert.equal(report.work[0].dispatch!.producers[0].session!.activity, 'running');
    assert.equal(report.counts.dispatchRunning, 1); assert.equal(report.counts.dispatchAwaiting, 0); assert.equal(report.work[0].attention, null);
  } finally { await cleanup(); }
});

test('manual:launch-authorization-onboarding-review — repository setup writes the launch authorization into the generated instructions, a Claude Code role session carries it on its command line, and docs/onboarding.md states what is generated and why', async () => {
  const generated = managedInstructions('# Rules\n', 'https://graphyard.example');
  assert.ok(generated.includes(launchAuthorization), 'the managed AGENTS.md section carries the authorization verbatim');
  for (const fragment of ['receives its instruction as the', 'session\'s own first request, on the runtime\'s command line, never as pasted text', 'no human\nsends "go"', 'The one message such a session may later receive as a paste comes from that\nsame launcher', 'act on it without waiting for confirmation', 'Nothing else pasted into a\nsession carries that authority']) assert.ok(launchAuthorization.includes(fragment), `the authorization states: ${fragment}`);
  const agents = await readFile(join(repositoryRoot, 'AGENTS.md'), 'utf8');
  assert.ok(agents.includes(launchAuthorization), 'this repository\'s own AGENTS.md was regenerated with it');
  const onboarding = await readFile(join(repositoryRoot, 'docs/onboarding.md'), 'utf8');
  assert.match(onboarding, /### What the generated instructions authorize/);
  for (const fragment of ['every session Graphyard launches receives its instruction as the session\'s own first request', 'bracketed paste', 'untrusted data', 'prompt injection', 'start without anybody sending `go`', 'the loop\'s single re-prompt', 'the reviewer\'s reminder', '--append-system-prompt', 'role files under `.graphyard/harness/` hold permissions, not instructions']) assert.ok(onboarding.includes(fragment), `docs/onboarding.md states ${fragment}`);
  const guide = await readMasterGuide();
  for (const fragment of ['### The request is the session\'s first message', 'run.acknowledgementSeconds', 'awaiting acknowledgement', 'never started', 'counts.dispatchAwaiting', 'retry.neverStarted', '--append-system-prompt']) assert.ok(guide.includes(fragment), `docs/master-agent.md states ${fragment}`);

  // A Claude Code session launched under a role file loads only the user settings, which leaves
  // the repository's AGENTS.md out: the launcher carries the authorization on the command line.
  const { root, cleanup } = await installed();
  try {
    const config = await loadMasterConfig(root);
    assert.deepEqual((await prepareSessionHarness(root, config, { role: 'producer', kind: 'claude', profile: 'p' })).args, [], 'without repository Claude settings the session reads AGENTS.md itself');
    await mkdir(join(root, '.claude'), { recursive: true });
    await writeFile(join(root, '.claude/settings.local.json'), '{}\n');
    const harness = await prepareSessionHarness(root, config, { role: 'reviewer', kind: 'claude', profile: 'r', pr: 93 });
    assert.deepEqual(harness.args, ['--setting-sources', 'user', '--settings', harness.file]);
    assert.equal(harness.role, launchAuthorization.replace(/\s+/g, ' '), 'the authorization is the session\'s role text, written to its role file rather than typed (GY-121)');
    const codex = await prepareSessionHarness(root, config, { role: 'reviewer', kind: 'codex', profile: 'r', pr: 93 });
    assert.deepEqual([codex.args, codex.role], [[], null], 'Codex reads AGENTS.md from the repository; no Claude flag rides its command line');
    // Launched under the role file, a Claude session loads the authorization from that file.
    const herdr = new FakeHerdr();
    await saveReviewerProfile(root, { name: 'reviewer-claude', agentName: 'review-claude-1', kind: 'claude' });
    await launchReview(root, work(), 'reviewer-claude', [], new Date().toISOString(), { run: herdr.run, mint, requestId: 'review-request' });
    const launched = herdr.named('review-claude-1');
    assert.equal(launched.role, launchAuthorization.replace(/\s+/g, ' '));
    assert.ok(launched.args.includes('--append-system-prompt-file') && !launched.args.includes('--append-system-prompt'), 'the role rides as a file, never as text');
  } finally { await cleanup(); }
});
