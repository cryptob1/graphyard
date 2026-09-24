import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Observation, Work } from '../src/model.js';
import { reconcileAutoDispatch } from '../src/model/dispatch.js';
import { agentStartCeilingMs, agentStartTimeoutMs, awaitRuntimeStart, buildMasterStatus, launchCommand, launchCommandLimit, launchDelivery, loadMasterConfig, paneLastLine, saveProducerProfile, SessionStartError, setupMaster, startAgentSession, writeLaunchFiles, type HerdrAgent } from '../src/master.js';
import { launchAuthorization } from '../src/repository-setup.js';
import { summarizeReviews } from '../src/reviewer.js';
import { launchProducer, producerPrompt, readProducerLedger, summarizeProducers } from '../src/producer.js';
import { emptyDispatchCursor, runDispatchTick, type DispatchEffects } from '../src/auto-dispatch.js';
import { readMasterGuide } from './helpers/master-guide.js';

// GY-121: a session launch types a short, constant-size command line that references the
// request and role files in the session's own checkout; the start bound reads the pane and tells
// a runtime that is starting from one that never started; a refused start is recorded with the
// pane's last line. One case per proof: unit:launch-command-bounded,
// unit:start-bound-reads-the-pane, integration:launch-refusal-names-the-screen,
// manual:launch-delivery-docs-review.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const H = sha40('a1'), B = sha40('b1');
const at = '2026-09-22T05:27:00.000Z';
const clock = Date.parse(at);
const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
/** The error a call throws, for assertions on its fields. */
async function caught<T extends Error>(pending: Promise<unknown>, type: new (...args: any[]) => T): Promise<T> {
  try { await pending; } catch (error) { assert.ok(error instanceof type, `threw ${String(error)}`); return error as T; }
  assert.fail('nothing was thrown');
}
const producerVerify = async () => ({ actor: { id: 'proof-runner', role: 'producer', proofs: ['unit:*', 'integration:*'] } });
const producerArgs = ['--permission-mode', 'bypassPermissions', '--setting-sources', 'user', '--settings', '/home/operator/code/project/.graphyard/harness/producer-claude-producer.json'];

function observation(candidate: { sha: string; baseSha: string }): Observation {
  return { candidate: { ...candidate, pr: 121, branch: 'graphyard/gy-121-1', author: 'implementer' }, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true,
    files: ['src/a.ts'], scopeFiles: [], at: new Date().toISOString(), prState: 'open', draft: false, baseTip: candidate.baseSha, baseTree: sha40('7b'), baseTipContained: true };
}
function work(overrides: Partial<Work> = {}): Work {
  const candidate = { sha: H, baseSha: B, pr: 121, branch: 'graphyard/gy-121-1', author: 'implementer' };
  return { id: 'work-121', key: 'GY-121', title: 'Producers die at the start bound', description: '', type: 'bug', priority: 0, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Bounded', proofs: ['unit:launch-command-bounded', 'integration:launch-refusal-names-the-screen'] }],
    policy: { checks: ['test'], review: true, reviewProvider: 'github' }, stage: 'review', revision: 7, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1,
    lease: null, workspaces: [{ host: 'h', path: '/w/gy-121', branch: 'graphyard/gy-121-1', epoch: 1, owner: 'implementer' }], candidate, submission: { epoch: 1, pr: 121 }, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: observation(candidate), blocker: null, gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }], violations: [], ...overrides } as Work;
}
const requested = () => { const item = work(); reconcileAutoDispatch(item, [item], new Date(clock)); return item; };

/** A master installed in a throwaway repository with one Claude producer profile, its credential outside it. */
async function installed() {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-launch-delivery-')), credentials = await mkdtemp(join(tmpdir(), 'graphyard-launch-delivery-credentials-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory: credentials, herdrWorkspace: 'wE' }, coordinatorStatus as typeof fetch);
  const credential = join(credentials, 'producer.token'); await writeFile(credential, 'producer-token-'.padEnd(40, 'x'), { mode: 0o600 });
  await saveProducerProfile(root, { name: 'claude-producer', principal: 'proof-runner', agentName: 'produce-a', kind: 'claude', credentialFile: credential }, producerVerify);
  return { root, cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(credentials, { recursive: true, force: true }); } };
}

/**
 * What the pane's shell makes of the typed line: the stem binding, then words — bare or
 * single-quoted — with `"$GY.role"` and `"$(cat "$GY.request")"` expanded from the files, exactly
 * as bash or zsh would before the runtime starts.
 */
function expandTypedCommand(command: string) {
  const bound = /^GY=(\S+); (.*)$/s.exec(command);
  const stem = bound ? bound[1].replace(/^'(.*)'$/s, '$1').replaceAll("'\\''", "'") : null;
  const words: string[] = [];
  for (const match of (bound ? bound[2] : command).matchAll(/'((?:[^']|'\\'')*)'|("\$GY\.role")|("\$\(cat "\$GY\.request"\)")|(\S+)/g)) {
    if (match[1] !== undefined) words.push(match[1].replaceAll("'\\''", "'"));
    else if (match[2]) words.push(`${stem}.role`);
    else if (match[3]) words.push(execFileSync('cat', [`${stem}.request`], { encoding: 'utf8' }));
    else words.push(match[4]);
  }
  return { stem, words };
}
/** The positional prompt Claude Code would read from its arguments. */
function positionalOf(words: string[]) {
  const valued = new Set(['--permission-mode', '--setting-sources', '--settings', '--append-system-prompt', '--append-system-prompt-file', '--ask-for-approval', '--sandbox', '-c', '--add-dir', '--model']);
  for (let index = 0; index < words.length; index++) {
    if (valued.has(words[index])) { index++; continue; }
    if (!words[index].startsWith('-')) return words[index];
  }
  return null;
}

/**
 * A Herdr pane on a virtual clock: `pane run` records the typed line, `agent get` answers from a
 * timeline of what Herdr would report at each moment, `pane read` returns the terminal text, and
 * the launcher's wait advances the clock instead of sleeping.
 */
class FakePane {
  calls: string[][] = [];
  now = clock;
  typed: string | null = null;
  renamed: string | null = null;
  constructor(private timeline: (elapsedMs: number) => { agent?: Partial<HerdrAgent> | null; screen?: string }) {}
  wait = (ms: number) => { this.now += ms; };
  run = (_command: string, args: string[]): string => {
    this.calls.push(args);
    const json = (result: unknown) => JSON.stringify({ result });
    const shown = this.timeline(this.now - clock);
    if (args[0] === 'pane' && args[1] === 'run') { this.typed = args[3]; return ''; }
    if (args[0] === 'pane' && args[1] === 'read') return shown.screen ?? '';
    if (args[0] === 'agent' && args[1] === 'get') return shown.agent ? json({ agent: { pane_id: args[2], ...shown.agent } }) : JSON.stringify({ error: { code: 'agent_not_found', message: `agent target ${args[2]} not found` } });
    if (args[0] === 'agent' && args[1] === 'rename') { this.renamed = args[3]; return json({ agent: shown.agent }); }
    if (args[0] === 'tab' && args[1] === 'create') return json({ root_pane: { pane_id: 'w1V:pR6', tab_id: 'w1V:tR5' } });
    if (args[0] === 'pane' && args[1] === 'list') return json({ panes: [] });
    return json({});
  };
  bounds() { return { clock: () => this.now, wait: this.wait }; }
}
const readyAtOnce = () => ({ agent: { agent: 'claude', agent_status: 'idle' }, screen: ' ▐▛███▛█   Claude Code v2.1.278\n❯ \n' });
const echoLine = 'vish@host ~/code/project ❯ GY=/home/vish/code/project/.graphyard/launch/produce-a; claude --permission-mode bypassPermissions --setting-sources user --settings /home/vish/co';

test('unit:launch-command-bounded — the typed launch command line is short and constant-size: the request and the role authorization are files in the session checkout (mode 0600) that the line references, so a 20 KB request types at most 512 bytes and reaches the runtime exactly', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-launch-checkout-'));
  try {
    // A 20 KB request with every character the shell could trip on: quotes, dollars, backticks, newlines.
    const request = `Produce trusted evidence for GY-121 at ${H}. It's "quoted", costs $5, runs \`tests\`, and says: don't stop.\n${'The proof group is integration; run every case, skip none, and submit pass or fail. '.repeat(250)}`;
    assert.ok(Buffer.byteLength(request) > 20_000, `the request is ${Buffer.byteLength(request)} bytes`);
    const role = launchAuthorization.replace(/\s+/g, ' ');
    const pane = new FakePane(readyAtOnce);
    const started = await startAgentSession('produce-a', 'claude', 'w1V:pR6', producerArgs, request, pane.run, { directory, role, ...pane.bounds() });
    assert.equal(started.delivery, 'request');
    assert.equal(pane.renamed, 'produce-a', 'the started runtime takes the session name in Herdr');
    const typed = pane.typed!;
    assert.ok(Buffer.byteLength(typed) <= launchCommandLimit, `the typed command is ${Buffer.byteLength(typed)} bytes, within ${launchCommandLimit}`);
    assert.equal(typed, started.command);
    assert.equal(typed.includes('Produce trusted evidence'), false, 'the request text is not typed'); assert.equal(typed.includes(role.slice(0, 40)), false, 'the authorization is not typed');
    assert.equal(pane.calls.some(call => call[0] === 'agent' && call[1] === 'start'), false, 'nothing rides herdr agent start as an argument');
    assert.equal(pane.calls.some(call => call[0] === 'agent' && call[1] === 'prompt'), false, 'nothing is pasted');
    // The files: the exact text, private, inside the checkout, and the line binds their stem once.
    assert.deepEqual(started.files, { stem: join(directory, '.graphyard/launch/produce-a'), role: join(directory, '.graphyard/launch/produce-a.role'), request: join(directory, '.graphyard/launch/produce-a.request') });
    assert.equal(await readFile(started.files.request!, 'utf8'), request, 'the request file holds the exact text');
    assert.equal(await readFile(started.files.role!, 'utf8'), role);
    for (const file of [started.files.request!, started.files.role!]) assert.equal((await stat(file)).mode & 0o777, 0o600, `${file} is private`);
    assert.equal((await stat(join(directory, '.graphyard/launch'))).mode & 0o777, 0o700);
    assert.match(typed, /^GY='?[^;]+'?; claude --permission-mode bypassPermissions --setting-sources user --settings \S+ --append-system-prompt-file "\$GY\.role" "\$\(cat "\$GY\.request"\)"$/);
    // What the shell hands the runtime: the role file path behind its flag, the request as the positional prompt, verbatim.
    const expanded = expandTypedCommand(typed);
    assert.equal(expanded.stem, started.files.stem);
    assert.deepEqual(expanded.words.slice(0, 7), ['claude', ...producerArgs]);
    assert.equal(expanded.words[expanded.words.indexOf('--append-system-prompt-file') + 1], started.files.role);
    assert.equal(positionalOf(expanded.words.slice(1)), request, 'the runtime reads the exact request as its own first argument');
    // Constant size: a request forty times longer types the same line.
    const longer = new FakePane(readyAtOnce);
    await startAgentSession('produce-a', 'claude', 'w1V:pR6', producerArgs, request.repeat(40), longer.run, { directory, role, ...longer.bounds() });
    assert.equal(longer.typed, typed);
    assert.equal(await readFile(started.files.request!, 'utf8'), request.repeat(40), 'a launch under the same name replaces the file');

    // The other contracts reference the same file: OpenCode through --prompt, Codex and Cursor positionally; a runtime without a contract is pasted and has no request file.
    for (const [kind, expected] of [['opencode', '--prompt "$(cat "$GY.request")"'], ['codex', '"$(cat "$GY.request")"'], ['cursor', '"$(cat "$GY.request")"']] as const) {
      const other = new FakePane(() => ({ agent: { agent: kind, agent_status: 'working' } }));
      const result = await startAgentSession(`${kind}-1`, kind, 'w1V:pR6', ['--flag'], request, other.run, { directory, ...other.bounds() });
      assert.ok(other.typed!.endsWith(` ${kind} --flag ${expected}`), `${kind}: ${other.typed}`); assert.equal(result.delivery, 'request'); assert.equal(result.files.role, null);
    }
    assert.equal(launchDelivery('muse'), 'paste'); assert.equal(launchDelivery(undefined), 'paste');
    const pasted = new FakePane(() => ({ agent: { agent: 'muse', agent_status: 'idle' } }));
    const paste = await startAgentSession('muse-1', 'muse', 'w1V:pR6', [], request, pasted.run, { directory, ...pasted.bounds(), attempts: 1 });
    assert.equal(paste.delivery, 'paste'); assert.equal(pasted.typed, 'muse'); assert.deepEqual(paste.files, { stem: join(directory, '.graphyard/launch/muse-1'), role: null, request: null });
    assert.ok(pasted.calls.some(call => call[0] === 'agent' && call[1] === 'prompt' && call[3] === request), 'a runtime without a contract is prompted after it starts, as before');

    // A supervised worker: the same references after `node CLI watch KEY EPOCH -- KIND`; still bounded with the longest runtime path seen in practice.
    const worker = launchCommand('claude', producerArgs, writeLaunchFiles(directory, 'claude-primary', { role, request }), ['/home/operator/.local/share/mise/installs/cursor-agent/2026.09.18-9a7762b/dist-package/node', '/home/operator/code/project/bin/graphyard.mjs', 'watch', 'GY-121', '1', '--']);
    assert.ok(Buffer.byteLength(worker) <= launchCommandLimit, `${Buffer.byteLength(worker)} bytes`);
    assert.match(worker, / watch GY-121 1 -- claude /);
    assert.equal(positionalOf(expandTypedCommand(worker).words.slice(expandTypedCommand(worker).words.indexOf('--') + 2)), request);
    // A line that would exceed the bound is refused before anything is typed, naming its length.
    const deep = join(directory, 'a'.repeat(300));
    assert.throws(() => launchCommand('claude', producerArgs, { stem: join(deep, '.graphyard/launch/produce-a'), role: 'x', request: 'y' }), /the launch command line is \d+ bytes, over the 512-byte bound/);
    // Words are quoted only when the shell needs it; a quote inside is escaped the POSIX way.
    assert.equal(launchCommand('codex', ['--model', 'o3', '-c', 'writable_roots=["/tmp/a b"]', "it's"], { stem: '/s', role: null, request: null }), `codex --model o3 -c 'writable_roots=["/tmp/a b"]' 'it'\\''s'`);

    // The real producer launcher types the same bounded line from the session's own checkout.
    const { root, cleanup } = await installed();
    try {
      const config = await loadMasterConfig(root);
      const item = requested(), dispatch = item.autoDispatch!.producers[0];
      const live = new FakePane(readyAtOnce);
      const launched = await launchProducer(root, item, dispatch, config.producers[0], [], new Date().toISOString(), { run: live.run, start: live.bounds() });
      assert.ok(Buffer.byteLength(live.typed!) <= launchCommandLimit, `the producer launch typed ${Buffer.byteLength(live.typed!)} bytes`);
      const file = join(launched.checkout, '.graphyard/launch/produce-a.request');
      assert.equal(await readFile(file, 'utf8'), producerPrompt(config, { key: 'GY-121', pr: 121, sha: H, baseSha: B, policyRevision: 1, group: dispatch.group!, proofs: dispatch.proofs!, checkout: launched.checkout }, { principal: 'proof-runner' }), 'the request file inside the session checkout holds the producer\'s exact request');
      assert.equal(positionalOf(expandTypedCommand(live.typed!).words.slice(1)), await readFile(file, 'utf8'));
      assert.equal((await readProducerLedger(root)).producers[0].delivery, 'request');
    } finally { await cleanup(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unit:start-bound-reads-the-pane — before a start is declared failed the launcher reads the pane: a runtime starting at the bound is given until the ceiling and reported started at 45 s, one that never starts is refused with the pane\'s last line', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-launch-start-'));
  try {
    assert.equal(agentStartTimeoutMs, 30_000); assert.equal(agentStartCeilingMs, 120_000);
    // Ready at 45 s: the process exists under the pane from 2 s (Herdr reports the kind, state unknown) with nothing of it drawn yet, interactive at 45 s.
    const slow = new FakePane(elapsed => elapsed < 2_000 ? { screen: `${echoLine}\n` } : elapsed < 45_000 ? { agent: { agent: 'claude', agent_status: 'unknown' }, screen: `${echoLine}\n` } : readyAtOnce());
    const started = await startAgentSession('produce-a', 'claude', 'w1V:pR6', producerArgs, 'Produce evidence', slow.run, { directory, ...slow.bounds() });
    assert.ok(started.started.waitedMs >= 45_000 && started.started.waitedMs < 46_000, `reported started after ${started.started.waitedMs} ms`);
    assert.equal(started.started.extended, 'the claude runtime process exists under the pane, Herdr reports it unknown at 30 s; waiting up to 120 s', 'the launch says why it waited past the bound');
    assert.equal(started.started.detail, 'Herdr reports the claude runtime idle'); assert.equal(slow.renamed, 'produce-a');
    // The case the producers died in: Claude Code is on screen, its spinner over the request it is
    // already working on, while Herdr reports the pane's runtime `unknown` — a live session, adopted
    // at once rather than closed at the bound.
    const spinning = new FakePane(() => ({ agent: { agent: 'claude', agent_status: 'unknown' }, screen: `${echoLine}\n\n❯ Produce trusted evidence for GY-121\n\n∙ Crunching… (esc to interrupt)\n` }));
    const adopted = await startAgentSession('produce-a', 'claude', 'w1V:pR6', producerArgs, 'Produce trusted evidence for GY-121', spinning.run, { directory, ...spinning.bounds() });
    assert.equal(adopted.started.detail, 'the claude runtime is on screen while Herdr reports it unknown'); assert.equal(adopted.started.waitedMs, 0); assert.equal(spinning.renamed, 'produce-a');
    // A runtime still to be prompted is ready only when Herdr reports it idle: its screen alone keeps it starting.
    const pasteKind = new FakePane(elapsed => ({ agent: { agent: 'muse', agent_status: elapsed < 40_000 ? 'unknown' : 'idle' }, screen: 'muse ready\n' }));
    assert.match((await awaitRuntimeStart('w1V:pR6', 'muse', 'muse', pasteKind.run, { ...pasteKind.bounds(), readyStates: ['idle', 'done'] })).extended!, /^the muse runtime process exists under the pane, Herdr reports it unknown at 30 s/);
    // The banner alone, before Herdr classifies the pane, is a runtime starting too.
    const banner = new FakePane(elapsed => elapsed < 40_000 ? { screen: ' ▐▛███▛█   Claude Code v2.1.278\n▝▜██████▀  Fable 5.1 · Claude Max\n' } : readyAtOnce());
    assert.match((await awaitRuntimeStart('w1V:pR6', 'claude', 'GY=/s; claude', banner.run, banner.bounds())).extended!, /^the claude banner is on screen at 30 s/);
    // A runtime at work on its request has started: no wait past the first sighting. One blocked
    // before it is ready sits at a dialog no launcher answers, and is refused at once with the dialog.
    for (const status of ['working', 'done', 'idle']) {
      const quick = new FakePane(() => ({ agent: { agent: 'claude', agent_status: status } }));
      assert.equal((await awaitRuntimeStart('w1V:pR6', 'claude', 'GY=/s; claude', quick.run, quick.bounds())).waitedMs, 0, status);
    }
    const dialog = new FakePane(() => ({ agent: { agent: 'claude', agent_status: 'blocked' }, screen: ' ❯ No, exit\n   Yes, I trust this folder\n' }));
    const blocked = await caught(awaitRuntimeStart('w1V:pR6', 'claude', 'GY=/s; claude', dialog.run, dialog.bounds()), SessionStartError);
    assert.equal(blocked.startCase, 'blocked'); assert.equal(blocked.message, 'the claude runtime is blocked before it is ready in pane w1V:pR6 (Herdr reports it blocked); the pane last showed: "Yes, I trust this folder"'); assert.equal(blocked.waitedMs, 0);

    // Never starts: the command is still echoing at 30 s. The refusal names the case and the pane's last line, not Herdr's agent_not_found.
    const echoing = new FakePane(() => ({ screen: `Last login: Mon Sep 22 05:27:00 2026\n${echoLine}\n` }));
    const refusal = await caught(startAgentSession('produce-a', 'claude', 'w1V:pR6', producerArgs, 'Produce evidence', echoing.run, { directory, ...echoing.bounds() }), SessionStartError);
    assert.equal(refusal.startCase, 'never started'); assert.equal(refusal.pane, 'w1V:pR6'); assert.equal(refusal.screen, echoLine);
    assert.equal(refusal.message, `the claude runtime never started within 30 s in pane w1V:pR6 (command still echoing); the pane last showed: "${echoLine}"`);
    assert.equal(refusal.message.includes('not found'), false);
    assert.ok(echoing.now - clock >= 30_000 && echoing.now - clock < 31_000, `refused at ${echoing.now - clock} ms, not later`);
    assert.equal(echoing.renamed, null, 'a refused start takes no name');
    // The runtime's own error is the last line; the line is bounded.
    const missing = new FakePane(() => ({ screen: `${echoLine}\nzsh: command not found: claude\n\nvish@host ~/code/project ❯ \n` }));
    await assert.rejects(awaitRuntimeStart('w1V:pR6', 'claude', 'GY=/s; claude', missing.run, missing.bounds()), { message: 'the claude runtime never started within 30 s in pane w1V:pR6 (no runtime under the pane); the pane last showed: "vish@host ~/code/project ❯"' });
    assert.equal(paneLastLine(`x\n${'y'.repeat(300)}\n\n`).length, 201); assert.equal(paneLastLine(null), '');
    const stranger = new FakePane(() => ({ agent: { agent: 'codex', agent_status: 'idle' }, screen: 'OpenAI Codex\n' }));
    await assert.rejects(awaitRuntimeStart('w1V:pR6', 'claude', 'GY=/s; claude', stranger.run, stranger.bounds()), /never started within 30 s in pane w1V:pR6 \(the pane holds codex, not claude\)/);
    // Starting at the bound but never ready: refused at the ceiling as still starting, with the last line.
    const stuck = new FakePane(() => ({ agent: { agent: 'claude', agent_status: 'unknown' }, screen: `${echoLine}\n` }));
    const ceiling = await caught(awaitRuntimeStart('w1V:pR6', 'claude', 'GY=/s; claude', stuck.run, stuck.bounds()), SessionStartError);
    assert.equal(ceiling.startCase, 'still starting'); assert.equal(ceiling.message, `the claude runtime was still starting after 120 s in pane w1V:pR6 (the claude runtime process exists under the pane, Herdr reports it unknown); the pane last showed: "${echoLine}"`);
    assert.ok(stuck.now - clock >= 120_000 && stuck.now - clock < 121_000);
    // A shorter bound for a caller that asks for one; the ceiling never falls below it.
    const brief = new FakePane(() => ({ screen: '' }));
    await assert.rejects(awaitRuntimeStart('w1V:pR6', 'claude', 'GY=/s; claude', brief.run, { ...brief.bounds(), timeoutMs: 5_000, ceilingMs: 1_000 }), /never started within 5 s in pane w1V:pR6 \(no runtime under the pane\); the pane showed nothing/);
    assert.ok(brief.now - clock >= 5_000 && brief.now - clock < 6_000);
    assert.ok(echoing.calls.some(call => call[0] === 'pane' && call[1] === 'read' && call[2] === 'w1V:pR6' && call.includes('recent-unwrapped')), 'the pane is read, unwrapped');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('integration:launch-refusal-names-the-screen — a producer launch refused at start is recorded by the dispatcher, the item\'s attention text and master status with the pane\'s last non-empty line, not the CLI\'s JSON error', async () => {
  const { root, cleanup } = await installed();
  try {
    const config = await loadMasterConfig(root);
    const item = requested();
    const pane = new FakePane(() => ({ screen: `Last login: Mon Sep 22 05:27:00 2026\n${echoLine}\n` }));
    const closed: string[] = [];
    const run = (command: string, args: string[]) => { if (args[0] === 'pane' && args[1] === 'close') closed.push(args[2]); return pane.run(command, args); };
    const effects: DispatchEffects = {
      snapshot: async () => ({ work: [item], now: new Date().toISOString() }), agents: () => [], credentials: async () => ({ 'claude-producer': { available: true, reason: null } }),
      reconcileReviews: async () => ({ reviews: [] }), reconcileProducers: async () => ({ producers: (await readProducerLedger(root)).producers }),
      launchReview: async () => { throw new Error('no reviewer in this test'); },
      launchProducer: (work, request, profile, agents, observedAt) => launchProducer(root, work, request, profile, agents, observedAt, { run, start: pane.bounds() }),
      persist: async () => {},
    };
    const cursor = emptyDispatchCursor(config);
    const tick = await runDispatchTick(config, cursor, effects, () => pane.now);
    const refused = tick.refused.filter(entry => entry.kind === 'producer');
    assert.ok(refused.length >= 1, 'the producer launch was refused');
    for (const failure of refused) {
      assert.equal(failure.reason, `the claude runtime never started within 30 s in pane w1V:pR6 (command still echoing); the pane last showed: "${echoLine}"`);
      assert.equal(failure.reason.includes('not found'), false, 'Herdr\'s agent_not_found never reaches the record');
      assert.deepEqual(cursor.failures[failure.requestId].reason, failure.reason, 'the dispatcher\'s failure record carries the same reason');
    }
    assert.ok(closed.includes('w1V:pR6'), 'the tab of a refused start is closed');
    assert.equal((await readProducerLedger(root)).producers.length, 0, 'no session was recorded');
    // The item's attention text and master status carry the pane's line.
    const failures = Object.entries(cursor.failures).map(([requestId, failure]) => ({ requestId, kind: failure.kind, attempts: failure.attempts, reason: failure.reason, at: failure.at, nextAt: failure.nextAt }));
    const status = buildMasterStatus({ work: [item], now: new Date().toISOString() }, [], [], {}, {}, summarizeReviews([]), 'main', undefined, { producers: summarizeProducers((await readProducerLedger(root)).producers), failures });
    const row = status.work[0];
    assert.match(row.attention!, /^Automatic producer launch for GY-121 refused 1 time\(s\): the claude runtime never started within 30 s in pane w1V:pR6 \(command still echoing\); the pane last showed: "vish@host ~\/code\/project ❯ GY=/);
    assert.ok(row.attention!.includes(echoLine), 'the attention text carries the pane\'s last line');
    assert.equal(row.attentionOwner?.role, 'master');
    const producer = row.dispatch!.producers.find(entry => entry.failure)!;
    assert.ok(producer.failure!.reason.includes(echoLine), 'master status shows the pane\'s last line on the request');
    assert.equal(JSON.stringify(status).includes('agent target'), false);
  } finally { await cleanup(); }
});

test('manual:launch-delivery-docs-review — docs/master-agent.md states how a request reaches its runtime, the start bound and its extension, and what a start refusal means', async () => {
  const guide = await readMasterGuide();
  for (const fragment of ['#### How the request reaches the runtime', '.graphyard/launch/NAME.request', 'mode 0600', 'removed with the checkout', '--append-system-prompt-file "$GY.role"', '"$(cat "$GY.request")"', 'bounded at **512 bytes** whatever the request is',
    '#### The start bound reads the pane', '**30 seconds**', '**120 seconds**', 'started.extended', 'the claude runtime is on screen while Herdr reports it unknown', 'is blocked before it is ready', 'command still echoing', 'pane\'s last non-empty line', 'never Herdr\'s own `agent_not_found`', 'the claude runtime never started within 30 s', 'was still starting after 120 s', 'Automatic producer launch for GY-N refused']) {
    assert.ok(guide.includes(fragment), `docs/master-agent.md states ${fragment}`);
  }
});
