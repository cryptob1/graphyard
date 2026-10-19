import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import type { ActionRow } from '../src/model/actions.js';
import type { Work } from '../src/model.js';
import type { NextActionKind } from '../src/model/action-kinds.js';
import { classifyAttention } from '../src/model/fault-classes.js';
import { ExecutorRegistry, describeUnserved, executorReport, startExecutorFor } from '../src/model/executor-presence.js';
import { executorDeclarationFile, executorDeclarationSchema, executorUnitTemplate, installExecutorSupervision, readExecutorDeclaration, type SystemctlRunner } from '../src/repository-setup.js';
import { MERGE_PROTOCOL } from '../src/protocol-version.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
// Time-bomb allowance (GY-1694): the 2026-10-19 stamps are the instances the loop recorded on this item, replayed at those instants and as offsets from them (each row's requestedAt is its recorded wait read backwards from the recorded instant); Date.now() only bounds the spawned executor's waits, which measure elapsed time alone.

/**
 * GY-2163 names this file for its proof: manual:fault-class-configuration. The master loop filed 3
 * configuration faults in 24 hours on 19 October 2026 — `executor` instances on GY-2145
 * (request-review) and GY-2075 (dispatch, twice) — each the same sentence: rows waited 1h31m–1h47m
 * "and no executor is alive", with a start command for a hand. The host journal says what the hand
 * would have walked into: at 18:00 the fleet stood down on the release it had loaded so the unit
 * would restart it onto the merged tip, and from then until 20:03 every restart died at startup
 * with `invalid_value` at `kinds[3]` — the host's `.graphyard/executors.json` named
 * `verify-deployment`, a kind the new code no longer runs, and the slot read its kinds through the
 * stored declaration schema, which refuses a name it does not know. Restart=always restarted a
 * start that could not succeed: the whole host's fleet was dead for two hours while the queue's
 * dispatch and request-review rows went unserved and the loop filed these instances instead of
 * being able to heal the read. Even the remedy the faults name was dead the same way: the install
 * reads the same file before it writes anything.
 *
 * The shared cause: a declaration written by an earlier release could keep every later release's
 * fleet from starting. The candidate reads the kinds list as names, serves the ones this code
 * still runs (every kind when none remain), and `--install` rewrites the file clean — a restart
 * onto a release that removed a kind brings the fleet back instead of crash-looping it.
 *
 * Each instance is replayed from the item's own record: the queue as it stood at the recorded
 * instant (the subject's row at its recorded wait, the `more` rows of its kind behind it) and an
 * empty fleet. Against the base each replay files exactly the recorded configuration fault; the
 * candidate proof is the same file the fleet died on now reading clean, a real slot started from
 * the shipped script polling through — and with that presence, no instance can be filed.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const repository = 'owner/project';
const minute = 60_000;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

interface Instance { id: string; subject: string; kind: 'request-review' | 'dispatch'; at: string; waitedMinutes: number; more: number }
const instances: Instance[] = [
  { id: 'executor|GY-2145|2026-10-19T02:28:09.935Z', subject: 'GY-2145', kind: 'request-review', at: '2026-10-19T02:28:09.935Z', waitedMinutes: 91, more: 1 },
  { id: 'executor|GY-2075|2026-10-19T02:28:09.935Z', subject: 'GY-2075', kind: 'dispatch', at: '2026-10-19T02:28:09.935Z', waitedMinutes: 103, more: 5 },
  { id: 'executor|GY-2075|2026-10-19T02:45:38.854Z', subject: 'GY-2075', kind: 'dispatch', at: '2026-10-19T02:45:38.854Z', waitedMinutes: 107, more: 5 },
];

/** The declaration the install's host held through the outage, as the install's own backup beside the file records it. */
const staleDeclaration = { version: 1, count: 2, kinds: ['request-review', 'approve-scope', 'resync', 'reclaim', 'verify-deployment', 'dispatch'], intervalSeconds: 5 };
/** What the host's slots can still run of it: the named kinds this code has, in the declared order. */
const keptKinds: NextActionKind[] = ['request-review', 'approve-scope', 'resync', 'reclaim', 'dispatch'];

const row = (id: string, key: string, kind: ActionRow['kind'], requestedAt: string): ActionRow =>
  ({ id, kind, work: `work-${key}`, key, inputs: { kind } as ActionRow['inputs'], gate: 'build', refusal: null, reason: `${key} needs ${kind}`, binding: 'b',
    requestedBy: 'graphyard', requestedAt, state: 'pending', claim: null, attempts: 0, history: [] });
const item = (key: string, rows: ActionRow[]) => ({ id: `work-${key}`, key, stage: 'build', actionQueue: { actions: rows, history: [] } }) as unknown as Work;

/** The queue as the instance stood: the subject's row at its recorded wait, and the `more` rows of its kind waiting behind it. */
function queue(entry: Instance): Work[] {
  const atMs = Date.parse(entry.at), requestedAt = new Date(atMs - (entry.waitedMinutes * minute + 30_000)).toISOString();
  const behind = Array.from({ length: entry.more }, (_, index) =>
    row(`${String(index + 2).repeat(32)}`, `${entry.subject} behind ${index + 1}`, entry.kind, new Date(atMs - (entry.more - index) * minute).toISOString()));
  return [item(entry.subject, [row('a'.repeat(32), entry.subject, entry.kind, requestedAt), ...behind])];
}

/** A fleet that has heard nothing for ten minutes: silent past the liveness window, so emptiness is judged. */
const deadFleet = (entry: Instance) => new ExecutorRegistry(new Date(Date.parse(entry.at) - 10 * minute));

/** The fault the loop's own classification files for one replay: the attention the unserved report derives, through classifyAttention. */
function configurationFaults(entry: Instance, registry: ExecutorRegistry) {
  const now = new Date(Date.parse(entry.at));
  const report = executorReport(queue(entry), registry, now);
  return { report, faults: classifyAttention(describeUnserved(report).map(line => ({ subject: line.keys[0], text: line.text }))) };
}

/** A coordinator checkout: master.json, a credential, and the declaration written raw, as the host held it. */
async function coordinatorCheckout(url: string | null, declaration: object) {
  const checkout = await temporaryDirectory('config-fault-executor');
  const credentials = await temporaryDirectory('config-fault-executor-credentials');
  git(checkout, 'init', '-q'); git(checkout, 'remote', 'add', 'origin', `https://github.com/${repository}.git`);
  const credentialFile = join(credentials, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  await mkdir(join(checkout, '.graphyard'), { mode: 0o700 });
  if (url) await writeFile(join(checkout, '.graphyard/master.json'), JSON.stringify({ version: 1, url, credentialFile, cliPath: join(root, 'bin/graphyard.mjs'), repository, baseBranch: 'main', githubAppId: 1234, hostId: 'vishrog', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [], run: {} }), { mode: 0o600 });
  await writeFile(join(checkout, executorDeclarationFile), `${JSON.stringify(declaration, null, 2)}\n`);
  // The script imports its TypeScript neighbours relative to its own real path, so the shipped
  // scripts directory is linked in rather than copied: the slot runs this checkout's code.
  await symlink(join(root, 'scripts'), join(checkout, 'scripts'));
  await symlink(join(root, 'examples'), join(checkout, 'examples'));
  return { checkout, credentials, credentialFile };
}

const until = async (predicate: () => boolean, what: string, timeoutMs = 90_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) { if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`); await delay(100); }
};

for (const entry of instances) test(`manual:fault-class-configuration — ${entry.id} reproduces as filed, and cannot once the slot starts`, () => {
  // The replay, against an empty fleet: exactly the configuration fault the loop recorded, word for word.
  const filed = configurationFaults(entry, deadFleet(entry));
  assert.equal(filed.faults.length, 1, 'against the base the dead fleet is a configuration fault');
  assert.equal(filed.faults[0].kind, 'executor');
  assert.equal(filed.faults[0].faultClass, 'configuration', 'the class this item stands for');
  assert.equal(filed.faults[0].subject, entry.subject);
  const waited = `${Math.floor(entry.waitedMinutes / 60)}h${entry.waitedMinutes % 60}m`;
  assert.equal(filed.faults[0].text, `Nothing can run ${entry.kind}: ${entry.subject} has waited ${waited} and ${entry.more} more for an executor that serves it, and no executor is alive. It is not queued behind other work — ${startExecutorFor(entry.kind)}`);

  // The candidate: the slot reads the stale declaration, serves the named kinds this code runs,
  // and polls — its claim is presence. With that presence at the same instant nothing is unserved
  // and no fault is filed: the fleet the declaration could no longer kill is the fix.
  const registry = deadFleet(entry);
  registry.observe({ executor: 'graphyard-master@vishrog/1', host: 'vishrog', principal: 'graphyard-master', kinds: keptKinds }, new Date(Date.parse(entry.at)));
  const served = configurationFaults(entry, registry);
  assert.deepEqual(served.report.unserved, [], 'a kind the slot serves is never unserved');
  assert.deepEqual(served.faults, [], 'the instance does not recur');
});

test('manual:fault-class-configuration — the declaration the fleet died on reads clean, and the remedy the faults name runs again', async () => {
  // The base startup parse, whose refusal systemd restarts into: the strict stored schema rejects
  // the file whole, and the slot exited 1 before its first poll (the journal's invalid_value at
  // kinds[3]).
  const raw = JSON.stringify(staleDeclaration, null, 2);
  assert.throws(() => executorDeclarationSchema.parse(JSON.parse(raw)), /Invalid option: expected one of/, 'the stored schema is still what refuses a malformed declaration');
  const { checkout, credentials } = await coordinatorCheckout(null, staleDeclaration);
  try {
    // The candidate read: the kinds this code still runs, in the declared order; the stale name
    // dropped, not honoured and not fatal.
    const read = await readExecutorDeclaration(checkout);
    assert.deepEqual(read!.kinds, keptKinds);
    assert.equal(read!.count, 2, 'everything but the kind names validates exactly as stored');
    // A declaration whose every name is stale cannot be served literally: it serves every kind the
    // executor has a handler for, the undeclared default.
    await writeFile(join(checkout, executorDeclarationFile), `${JSON.stringify({ ...staleDeclaration, kinds: ['verify-deployment'] }, null, 2)}\n`);
    assert.equal((await readExecutorDeclaration(checkout))!.kinds, null);
    await writeFile(join(checkout, executorDeclarationFile), `${raw}\n`);
    // The remedy the faults name — the install — died on the same file at base. Now it runs and
    // rewrites the declaration without the name nothing runs.
    const unitDirectory = join(credentials, 'systemd-user');
    const run: SystemctlRunner = args => args[0] === 'is-active' ? 'active' : '';
    const installed = await installExecutorSupervision(checkout, { run, unitDirectory, template: await readFile(join(root, 'examples/master', executorUnitTemplate), 'utf8'), node: process.execPath, loop: null });
    assert.equal(installed.installed, true, JSON.stringify(installed));
    const rewritten = JSON.parse(await readFile(join(checkout, executorDeclarationFile), 'utf8'));
    assert.ok(!(rewritten.kinds ?? []).includes('verify-deployment'), 'the install heals the file it reads');
  } finally { await rm(checkout, { recursive: true, force: true }); await rm(credentials, { recursive: true, force: true }); }
});

test('manual:fault-class-configuration — a slot on that declaration starts from the shipped script, polls, and stays up', async () => {
  const polls: { executor: string; host: string; kinds: string[] }[] = [];
  const readBody = (req: IncomingMessage) => new Promise<string>(resolve => { let text = ''; req.on('data', chunk => text += chunk); req.on('end', () => resolve(text)); });
  const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const body = req.method === 'POST' ? await readBody(req) : '';
    const json = (status: number, payload: unknown) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(payload)); };
    if (req.method === 'GET' && req.url === '/api/status') return json(200, { actor: { id: 'graphyard-master', role: 'coordinator' }, repository, baseBranch: 'main', githubAppId: 1234, build: { commit: null, protocol: MERGE_PROTOCOL } });
    if (req.method === 'POST' && req.url === '/api/actions/claim') {
      try { const parsed = JSON.parse(body); polls.push({ executor: parsed.executor, host: parsed.host, kinds: parsed.kinds }); } catch { /* a poll is still presence */ }
      return json(200, { action: null, open: 1 });
    }
    return json(404, { error: `no route for ${req.method} ${req.url}` });
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const { checkout, credentials } = await coordinatorCheckout(url, staleDeclaration);
  const child = spawn(process.execPath, [join(checkout, 'scripts/graphyard-executor.mjs'), '--slot', '1', '--interval', '1'], { cwd: checkout, env: { ...process.env, GRAPHYARD_TOKEN: undefined, GRAPHYARD_TOKEN_FILE: undefined, GRAPHYARD_URL: undefined }, stdio: ['ignore', 'pipe', 'pipe'] });
  const stderr: string[] = [];
  child.stderr!.on('data', chunk => stderr.push(String(chunk)));
  try {
    // The base died here, inside the declaration read, before any poll: exit 1 within seconds.
    await until(() => polls.length >= 1 || child.exitCode !== null, `the slot to poll, or to die trying\n${stderr.join('')}`);
    assert.equal(child.exitCode, null, `the slot starts on the declaration that killed the fleet\n${stderr.join('')}`);
    await until(() => polls.length >= 2, `a second poll: a slot that stays up\n${stderr.join('')}`);
    assert.deepEqual([...polls[0].kinds].sort(), [...keptKinds].sort(), 'the slot serves the named kinds this code runs, no others');
    assert.equal(polls[0].executor, 'graphyard-master@vishrog/1', 'the slot claims under its stable name');
    assert.equal(child.exitCode, null, 'the slot is still up — no crash loop');
  } finally {
    child.kill('SIGTERM');
    await until(() => child.exitCode !== null || child.signalCode !== null, 'the slot to stop on SIGTERM', 30_000).catch(() => child.kill('SIGKILL'));
    await new Promise<void>(resolve => http.close(() => resolve()));
    await rm(checkout, { recursive: true, force: true }); await rm(credentials, { recursive: true, force: true });
  }
});
