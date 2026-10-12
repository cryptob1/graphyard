import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// The chart exercise (deploy/helm/exercise.sh) runs on a real cluster only in release-candidate
// validation. Release candidate 38218787546 failed its chart job because kubectl could not bind the
// exercise's fixed local port 14310, and 38213256650 lost the forward mid-run (GY-1729). Here its
// forward, its re-establishment and its request helper are cut out of the script by name and run
// against a fake kubectl whose port-forward really binds a local port and proxies to a local "pod".
const exercise = readFileSync(resolve('deploy/helm/exercise.sh'), 'utf8');
const shellFunction = (name: string) => {
  const start = exercise.indexOf(`\n${name}() {`);
  assert.ok(start >= 0, `${name}() is defined in the exercise`);
  return exercise.slice(start + 1, exercise.indexOf('\n}\n', start) + 3);
};
const curl = spawnSync('curl', ['--version'], { encoding: 'utf8' }).status === 0;

/** A port-forward the fake kubectl performs: refuse to bind, or bind a port of its own choosing, drop its first `drop` connections, proxy to the pod (or the decoy), and exit once `dieAfter` connections have been proxied. */
type Forward = { refuse?: true; drop?: number; dieAfter?: number; to?: 'pod' | 'decoy' };

const fakeKubectl = `#!/usr/bin/env node
const fs = require('node:fs'), net = require('node:net');
const args = process.argv.slice(2).filter((arg, i, all) => arg !== '--namespace' && all[i - 1] !== '--namespace');
const env = process.env;
if (args[0] === 'rollout') {
  const rollouts = env.FAKE_DIR + '/rollouts', n = Number(fs.existsSync(rollouts) ? fs.readFileSync(rollouts, 'utf8') : 0);
  fs.writeFileSync(rollouts, String(n + 1));
  if (n < Number(env.FAKE_ROLLOUT_FAILURES ?? 0)) { console.error('error: timed out waiting for the condition'); process.exit(1); }
  console.log('deployment "gy-graphyard" successfully rolled out'); process.exit(0);
}
if (args[0] === 'get' && args[1] === 'rs,pods') { process.stdout.write(env.FAKE_ROLLOUT); process.exit(0); }
if (args[0] === 'get') { console.log('pod/gy-graphyard-new-bbbbb 1/1 Running'); process.exit(0); }
if (args[0] === 'logs') { console.log('server log line'); process.exit(0); }
if (args[0] !== 'port-forward') { console.error('unexpected kubectl ' + args.join(' ')); process.exit(2); }
const plan = JSON.parse(env.FAKE_PLAN);
const counter = env.FAKE_DIR + '/count';
const n = Number(fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8') : 0);
fs.writeFileSync(counter, String(n + 1));
const step = plan[Math.min(n, plan.length - 1)];
const [local, remote] = args.at(-1).split(':');
fs.appendFileSync(env.FAKE_DIR + '/invocations', JSON.stringify({ args, pid: process.pid }) + '\\n');
const unable = () => { console.error('Unable to listen on port ' + (local || '14310') + ': Listeners failed to create with the following errors: [unable to create listener: Error listen tcp4 127.0.0.1:' + (local || '14310') + ': bind: address already in use]'); console.error('error: unable to listen on any of the requested ports: [{' + (local || '14310') + ' ' + remote + '}]'); process.exit(1); };
if (step.refuse) unable();
let seen = 0, proxied = 0;
const target = Number(step.to === 'decoy' ? env.FAKE_DECOY_PORT : env.FAKE_POD_PORT);
const server = net.createServer(client => {
  if (seen++ < (step.drop ?? 0)) { console.error('E1012 portforward.go: "Unhandled Error" err="an error occurred forwarding ' + local + ' -> ' + remote + ': dial tcp4 127.0.0.1:' + remote + ': connect: connection refused"'); client.destroy(); return; }
  const upstream = net.connect(target, '127.0.0.1');
  client.pipe(upstream).pipe(client);
  const done = () => { client.destroy(); upstream.destroy(); };
  client.on('error', done); upstream.on('error', done);
  if (step.dieAfter !== undefined && ++proxied >= step.dieAfter) { server.close(); client.on('close', () => { console.error('lost connection to pod'); process.exit(1); }); }
});
server.on('error', unable);
server.listen(local ? Number(local) : 0, '127.0.0.1', () => console.log('Forwarding from 127.0.0.1:' + server.address().port + ' -> ' + remote));
`;

const rollout = JSON.stringify({ kind: 'List', items: [
  { kind: 'ReplicaSet', metadata: { name: 'gy-graphyard-new', labels: { 'pod-template-hash': 'new2' } }, spec: { replicas: 1 } },
  { kind: 'Pod', metadata: { name: 'gy-graphyard-new-bbbbb', labels: { 'pod-template-hash': 'new2' } }, spec: { containers: [{ ports: [{ name: 'http', containerPort: 4310 }] }] }, status: { conditions: [{ type: 'Ready', status: 'True' }] } },
] });

/** An HTTP server standing in for a release: /healthz reports `version`, a heartbeat answers `heartbeat` with `refusal` (409 with the engine's superseded-lease error refuses it), anything else answers `work`. */
async function release(version: string, work: string, port = 0) {
  const hits: string[] = [];
  const state = { heartbeat: 409, refusal: '{"error":"Lease missing, expired, or superseded; claim the task again"}' };
  const server: Server = createServer((request, response) => {
    hits.push(request.url!);
    const heartbeat = request.url!.endsWith('/heartbeat');
    response.writeHead(heartbeat ? state.heartbeat : 200, { 'Content-Type': 'application/json' });
    response.end(request.url === '/healthz' ? JSON.stringify({ version }) : heartbeat ? state.refusal : work);
  });
  const listening = await new Promise<boolean>(done => { server.once('error', () => done(false)); server.listen(port, '127.0.0.1', () => done(true)); });
  return { hits, state, listening, port: listening ? (server.address() as AddressInfo).port : port, close: () => new Promise<void>(done => listening ? server.close(() => done()) : done()) };
}

/** The exercise's forward and request helpers, cut out when a run needs them. */
const functions = () => ['select_pod', 'stop_forward', 'forward', 'ensure_forward', 'api', 'rejects'].map(shellFunction).join('\n');

/** Runs `body` with the exercise's forward and request helpers against the fake kubectl and `plan`. */
async function run(plan: Forward[], body: string, ports: { pod: number; decoy: number }, rolloutFailures = 0, budget = 180) {
  const dir = await temporaryDirectory('chart-exercise-forward');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'kubectl'), fakeKubectl); chmodSync(join(bin, 'kubectl'), 0o755);
  const forwardDir = join(dir, 'forward'); mkdirSync(forwardDir);
  const script = `set -euo pipefail
RELEASE=gy; NAMESPACE=exercise; TAG=1.2.3; HELM_TIMEOUT=5m; LOCAL_PORT=""; FORWARD_PID=""
k() { kubectl --namespace "$NAMESPACE" "$@"; }
diagnose() { echo "--- port-forward output, every attempt" >&2; cat "$FORWARD_DIR"/forward-*.log >&2 2>/dev/null || true; echo "--- pods" >&2; k get pods,svc,endpoints >&2; }
${functions()}
# As the exercise's own cleanup trap does: a run that exits on a failure still stops its forward.
trap stop_forward EXIT
${body}`;
  const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(done => {
    const child = spawn('bash', ['-c', script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FORWARD_DIR: forwardDir, FAKE_DIR: dir, FAKE_PLAN: JSON.stringify(plan), FAKE_ROLLOUT: rollout, FAKE_ROLLOUT_FAILURES: String(rolloutFailures), FAKE_POD_PORT: String(ports.pod), FAKE_DECOY_PORT: String(ports.decoy), FORWARD_ATTEMPTS: '3', FORWARD_RETRY_WAIT: '0', FORWARD_BUDGET: String(budget), API_ATTEMPTS: '6', API_RETRY_WAIT: '0', API_TIMEOUT: '2' } });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('close', status => done({ status, stdout, stderr }));
  });
  let invocations: { args: string[]; pid: number }[] = [];
  try { invocations = readFileSync(join(dir, 'invocations'), 'utf8').trim().split('\n').map(line => JSON.parse(line)); } catch { /* no forward was started */ }
  // A stopped forward is given two seconds to exit; an exited one reparented to a non-reaping init stays a zombie.
  const alive = (pid: number) => { try { return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { try { process.kill(pid, 0); return true; } catch { return false; } } };
  for (let waited = 0; waited < 2000 && invocations.some(({ pid }) => alive(pid)); waited += 50) await new Promise(done => setTimeout(done, 50));
  const leftover = invocations.filter(({ pid }) => alive(pid));
  for (const { pid } of leftover) process.kill(pid, 'SIGKILL');
  return { ...result, invocations, leftover };
}

test('integration:chart-exercise-port-forward — the chart exercise forwards a free local port kubectl binds itself, never the fixed 14310 a leftover or concurrent listener holds, uses a forward only once /healthz through it reports this release, and re-establishes a forward that exits or a pod not yet listening within a bounded number of attempts before exercising the API; a persistent loss fails with the forward\'s own output and a last line naming it', { skip: curl ? false : 'curl is not installed' }, async () => {
  assert.ok(!exercise.includes('14310'), 'no fixed local port remains in the exercise');
  assert.match(exercise, /^LOCAL_PORT=""$/m, 'the local port starts empty, so kubectl chooses a free one');
  assert.match(exercise, /^FORWARD_ATTEMPTS="\$\{FORWARD_ATTEMPTS:-(\d+)\}"; FORWARD_RETRY_WAIT="\$\{FORWARD_RETRY_WAIT:-(\d+)\}"$/m, 'the forward\'s retry bound is stated and overridable');
  const [, attempts, wait] = /^FORWARD_ATTEMPTS="\$\{FORWARD_ATTEMPTS:-(\d+)\}"; FORWARD_RETRY_WAIT="\$\{FORWARD_RETRY_WAIT:-(\d+)\}"$/m.exec(exercise)!;
  const budget = Number(/^FORWARD_BUDGET="\$\{FORWARD_BUDGET:-(\d+)\}"$/m.exec(exercise)?.[1]);
  // The budget is wall clock across rollout waits, probes, probe timeouts and retry waits, so it alone bounds
  // a forward() well inside the chart job's 30 minutes, whatever API_TIMEOUT is; it still fits every attempt.
  assert.ok(Number(attempts) >= 2 && budget <= 300 && Number(attempts) * (30 + Number(wait)) <= budget, `the forward is retried a bounded while: ${attempts} × (30 + ${wait})s within ${budget}s`);
  assert.ok(exercise.includes(`rejects POST "work/$WORK_ID/heartbeat" "$WORKER_TOKEN" '{"epoch":2}' 409 'superseded'`), 'the superseded-epoch check requires the heartbeat\'s own 409 superseded-lease refusal, so a lost forward or an unrelated 4xx cannot pass it vacuously');
  assert.ok(!/rollout status[^\n]*\|\| true/.test(exercise), 'a failed rollout is never discarded');

  const pod = await release('1.2.3', '[{"id":"w1","key":"GY-1"}]');
  const decoy = await release('0.0.1-leftover', '[{"id":"decoy"}]', 14310);
  const ports = { pod: pod.port, decoy: decoy.port };
  try {
    // Ownership: 14310 is held by a leftover listener answering as another service. The forward
    // binds a port of kubectl's choosing, and a forward that reaches the wrong service is not used.
    const owned = await run([{ to: 'decoy' }, {}], 'forward\necho "port=$LOCAL_PORT"\napi GET work secret-token\necho\nensure_forward\necho "same=$LOCAL_PORT"\nstop_forward', ports);
    assert.equal(owned.status, 0, owned.stderr);
    const port = /^port=(\d+)$/m.exec(owned.stdout)![1];
    assert.notEqual(port, '14310', 'the forward never binds the fixed port');
    assert.equal(/^same=(\d+)$/m.exec(owned.stdout)![1], port, 'a live forward is kept and its port used consistently');
    assert.ok(owned.stdout.includes('[{"id":"w1","key":"GY-1"}]'), 'the API answer comes from the release');
    assert.ok(!owned.stdout.includes('decoy'));
    assert.equal(owned.invocations.length, 2, 'the forward reaching the wrong service is replaced once');
    for (const { args } of owned.invocations) assert.deepEqual(args.slice(-4), ['--address', '127.0.0.1', 'pod/gy-graphyard-new-bbbbb', ':4310'], 'kubectl is asked for a free local port');
    assert.match(owned.stderr, /attempt 1 of 3 to pod\/gy-graphyard-new-bbbbb did not answer \/healthz as release 1\.2\.3 \(local port \d+, healthz version 0\.0\.1-leftover\)/);
    if (decoy.listening) assert.deepEqual(decoy.hits, ['/healthz'], 'the listener on 14310 is never reached; only the rejected forward\'s health check reached the decoy');
    assert.deepEqual(owned.leftover, [], 'stop_forward ends the forward');

    // Transient loss: a refused bind, a pod not yet listening, then a forward that dies after one
    // request. The exercise recovers each within its bounds and every request reaches the release.
    pod.hits.length = 0;
    const recovered = await run([{ refuse: true }, { drop: 2, dieAfter: 2 }, {}], 'forward\nfor i in 1 2 3; do api GET work secret-token; echo; done\nstop_forward', ports);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.deepEqual(recovered.stdout.trim().split('\n'), Array(3).fill('[{"id":"w1","key":"GY-1"}]'));
    assert.equal(recovered.invocations.length, 3, 'one forward per attempt: refused, lost, kept');
    assert.match(recovered.stderr, /attempt 1 of 3 .*: error: unable to listen on any of the requested ports/, 'the refused bind is named');
    assert.match(recovered.stderr, /the port-forward \(pid \d+\) is gone; re-establishing it/, 'the lost forward is re-established');
    assert.equal(pod.hits.filter(url => url === '/api/work').length, 3, 'every request reached the release');
    assert.deepEqual(recovered.leftover, []);

    // Persistent loss: every forward is refused. The forward fails after its bound with the
    // forward's own output, the pods, and a last line naming it, and so does a request that
    // needs the forward re-established.
    const lost = await run([{ refuse: true }], 'forward', ports);
    assert.equal(lost.status, 1, lost.stderr);
    assert.equal(lost.invocations.length, 3, lost.stderr);
    const lines = lost.stderr.trim().split('\n');
    assert.equal(lines.at(-1), 'port-forward to release gy never became reachable after 3 attempts within 180s');
    assert.ok(lost.stderr.includes('--- port-forward output, every attempt') && lost.stderr.includes('bind: address already in use') && lost.stderr.includes('--- pods'), 'the diagnosis carries the forward\'s output and the pods');
    const dropped = await run([{ dieAfter: 1 }, { refuse: true }], 'forward\napi GET work secret-token', ports);
    assert.equal(dropped.status, 1, dropped.stderr); assert.equal(dropped.stdout, '', 'no body reaches a projection');
    assert.equal(dropped.stderr.trim().split('\n').at(-1), 'port-forward to release gy never became reachable after 3 attempts within 180s');
    assert.deepEqual(dropped.leftover, []);

    // Stall: a pod that accepts every connection and never answers /healthz. Each probe is a full curl
    // timeout, so only the budget's wall clock bounds the forward: it fails within FORWARD_BUDGET, not after
    // attempts × 30 probes × API_TIMEOUT, with the same diagnosis and last line.
    const silent = createServer(() => { /* never answers */ });
    await new Promise<void>(done => silent.listen(0, '127.0.0.1', () => done()));
    try {
      const started = Date.now();
      const stalled = await run([{ to: 'decoy' }], 'forward', { pod: pod.port, decoy: (silent.address() as AddressInfo).port }, 0, 5);
      const elapsed = (Date.now() - started) / 1000;
      assert.equal(stalled.status, 1, stalled.stderr);
      assert.ok(elapsed < 15, `the stalled forward fails within its 5 s budget, not after ${elapsed}s`);
      assert.match(stalled.stderr, /attempt 1 of 3 to pod\/gy-graphyard-new-bbbbb did not answer \/healthz as release 1\.2\.3 \(local port \d+, healthz version none\)/);
      assert.match(stalled.stderr.trim().split('\n').at(-1)!, /^port-forward to release gy never became reachable after [12] attempts within 5s$/);
      assert.deepEqual(stalled.leftover, []);
    } finally { silent.closeAllConnections(); await new Promise(done => silent.close(done)); }

    // Rollout: a rollout that fails or times out is never forwarded, since the previous ReplicaSet's
    // Ready pod would pass /healthz under the same tag. A transient failure is retried; a persistent
    // one fails the gate without any forward.
    const rolled = await run([{}], 'forward\napi GET work secret-token\nstop_forward', ports, 1);
    assert.equal(rolled.status, 0, rolled.stderr);
    assert.match(rolled.stderr, /attempt 1 of 3: the rollout of deploy\/gy-graphyard has not completed, so no pod is forwarded/);
    assert.equal(rolled.invocations.length, 1, 'no forward is started before the rollout completes');
    const stuck = await run([{}], 'forward', ports, 99);
    assert.equal(stuck.status, 1);
    assert.equal(stuck.invocations.length, 0, 'an incomplete rollout is never forwarded');
    assert.equal(stuck.stderr.trim().split('\n').at(-1), 'port-forward to release gy never became reachable after 3 attempts within 180s');

    // Refusal: the superseded-epoch check passes only on the heartbeat's own 409 naming the superseded
    // lease. A forward lost around the request is a retried transport failure, never the refusal; an
    // acceptance fails the gate, and so does a forward that never comes back or an unrelated 4xx.
    const reject = 'forward\nrejects POST work/w1/heartbeat secret-token \'{"epoch":2}\' 409 superseded\necho refused\nstop_forward';
    pod.hits.length = 0;
    const refused = await run([{ dieAfter: 1 }, {}], reject, ports);
    assert.equal(refused.status, 0, refused.stderr);
    assert.equal(refused.stdout.trim(), 'refused');
    assert.match(refused.stderr, /api POST \/api\/work\/w1\/heartbeat refused with status 409 \(Lease missing, expired, or superseded; claim the task again\), as it must be/);
    assert.equal(refused.invocations.length, 2, 'the lost forward is re-established before the refusal is read');
    assert.ok(pod.hits.includes('/api/work/w1/heartbeat'), 'the refusal came from the release');
    assert.deepEqual(refused.leftover, []);
    const unanswered = await run([{ dieAfter: 1 }, { refuse: true }], reject, ports);
    assert.equal(unanswered.status, 1, unanswered.stderr); assert.equal(unanswered.stdout, '', 'a lost forward never passes the check');
    assert.equal(unanswered.stderr.trim().split('\n').at(-1), 'port-forward to release gy never became reachable after 3 attempts within 180s');
    pod.state.heartbeat = 200;
    const accepted = await run([{}], reject, ports);
    assert.equal(accepted.status, 1); assert.equal(accepted.stdout, '');
    assert.equal(accepted.stderr.trim().split('\n').at(-1), 'api POST /api/work/w1/heartbeat was accepted with status 200; the release must refuse it');
    // Unrelated refusals: broken credentials, a missing route, or a 409 for another reason never stand in
    // for the stale-epoch refusal; each ends the exercise at once, naming the status and body it got.
    for (const [status, refusal] of [[401, '{"error":"Invalid token"}'], [403, '{"error":"Operator permission required"}'], [404, '{"error":"Not found"}'], [409, '{"error":"Work item is not in progress"}'], [409, 'superseded, but not JSON']] as const) {
      pod.state.heartbeat = status; pod.state.refusal = refusal; pod.hits.length = 0;
      const unrelated = await run([{}], reject, ports);
      assert.equal(unrelated.status, 1, `${status} ${refusal} must fail the check`); assert.equal(unrelated.stdout, '', `${status} ${refusal} never passes the check`);
      assert.equal(unrelated.stderr.trim().split('\n').at(-1), `api POST /api/work/w1/heartbeat was refused with status ${status}, body: ${refusal}; the release must refuse it with 409 naming 'superseded'`);
      assert.equal(pod.hits.filter(hit => hit.endsWith('/heartbeat')).length, 1, 'an unrelated refusal is an answer, not retried');
    }
    pod.state.heartbeat = 409; pod.state.refusal = '{"error":"Lease missing, expired, or superseded; claim the task again"}';
  } finally { await pod.close(); await decoy.close(); }
});
