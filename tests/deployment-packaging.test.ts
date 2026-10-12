import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, constants, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { packageVersion, releaseInfo, schemaVersion } from '../src/release.js';

const read = (path: string) => readFileSync(resolve(path), 'utf8');
const helm = (() => { const probe = spawnSync('helm', ['version', '--short'], { encoding: 'utf8' }); return probe.status === 0 ? 'helm' : null; })();

test('the packaged release names one version everywhere it is stamped', () => {
  assert.match(packageVersion, /^\d+\.\d+\.\d+$/);
  const chart = read('deploy/helm/graphyard/Chart.yaml');
  assert.match(chart, new RegExp(`^appVersion: "${packageVersion.replace(/\./g, '\\.')}"$`, 'm'), 'chart appVersion follows package.json');
  const compose = read('compose.yaml');
  assert.ok(compose.includes(`ghcr.io/cryptob1/graphyard:${packageVersion}`), 'compose defaults to the versioned release image');
  assert.ok(compose.includes('GRAPHYARD_VERSION: ${GRAPHYARD_VERSION:-' + packageVersion + '}'), 'compose builds stamp the same version');
  const dockerfile = read('Dockerfile');
  for (const marker of ['ARG GRAPHYARD_VERSION', 'ARG GRAPHYARD_BUILD_REVISION', 'ENV GRAPHYARD_VERSION=${GRAPHYARD_VERSION}', 'org.opencontainers.image.version="${GRAPHYARD_VERSION}"', 'org.opencontainers.image.revision="${GRAPHYARD_BUILD_REVISION}"']) assert.ok(dockerfile.includes(marker), marker);
  const release = read('.github/workflows/release.yml');
  assert.ok(release.includes("tags: ['v*.*.*']") && release.includes('scripts/verify-image-release.mjs') && release.includes('docker push'), 'tagged releases verify the image contract before publishing');
  const candidate = read('.github/workflows/release-candidate.yml');
  assert.ok(candidate.includes('scripts/verify-image-release.mjs'), 'every release-candidate image is held to the release contract');
  assert.ok(candidate.includes('deploy/helm/exercise.sh'), 'the chart exercise runs in release-candidate validation');
  accessSync(resolve('deploy/helm/exercise.sh'), constants.X_OK);
  // The running process reports the package version unless the image stamped one.
  assert.equal(releaseInfo().version, process.env.GRAPHYARD_VERSION || packageVersion);
  assert.ok(Number.isInteger(schemaVersion) && schemaVersion >= 1);
});

// The workloads in a rendered chart whose labels a Service's selector matches, by kind.
// `kubectl port-forward svc/…` picks any pod the selector matches, so for the control-plane
// Service the answer has to be the Deployment alone: not the database, a Job or the test pod.
const selectedBy = (rendered: string, service: string) => {
  const docs = rendered.split(/^---$/m);
  const unquote = (value: string) => value.trim().replace(/^"(.*)"$/, '$1');
  const blocks = (doc: string, key: string) => [...doc.matchAll(new RegExp(`^( *)${key}:\\n((?:\\1 +\\S.*\\n)+)`, 'gm'))]
    .map(m => Object.fromEntries(m[2].trim().split('\n').map(line => { const [k, ...v] = line.trim().split(':'); return [k, unquote(v.join(':'))]; })));
  const serviceDoc = docs.find(doc => /^kind: Service$/m.test(doc) && doc.includes(`name: ${service}\n`));
  assert.ok(serviceDoc, `the chart renders Service ${service}`);
  const [selector] = blocks(serviceDoc!, 'selector');
  assert.ok(selector && Object.keys(selector).length > 0, 'the Service has a selector');
  const workloads = ['Deployment', 'StatefulSet', 'Job', 'CronJob', 'Pod'];
  return docs.map(doc => ({ doc, kind: /^kind: (\S+)$/m.exec(doc)?.[1] ?? '' })).filter(({ kind }) => workloads.includes(kind))
    .filter(({ doc }) => blocks(doc, 'labels').some(labels => Object.entries(selector).every(([k, v]) => labels[k] === v)))
    .map(({ kind }) => kind).sort();
};

test('the chart refuses to render without credentials and renders the documented topology with them', { skip: helm ? false : 'helm is not installed' }, () => {
  const chart = resolve('deploy/helm/graphyard');
  const lint = spawnSync(helm!, ['lint', chart, '--strict', '--set', 'secrets.existingSecret=graphyard-credentials'], { encoding: 'utf8' });
  assert.equal(lint.status, 0, lint.stdout + lint.stderr);
  const bare = spawnSync(helm!, ['template', 'gy', chart], { encoding: 'utf8' });
  assert.notEqual(bare.status, 0); assert.match(bare.stderr, /secrets\.existingSecret/);
  const external = spawnSync(helm!, ['template', 'gy', chart, '--set', 'secrets.existingSecret=graphyard-credentials', '--set', 'ingress.enabled=true', '--set', 'ingress.hosts[0].host=gy.example.com', '--set', 'backup.enabled=true'], { encoding: 'utf8' });
  assert.equal(external.status, 0, external.stderr);
  const kinds = [...external.stdout.matchAll(/^kind: (\S+)$/gm)].map(m => m[1]).sort();
  assert.deepEqual(kinds, ['ConfigMap', 'CronJob', 'Deployment', 'Ingress', 'Job', 'PersistentVolumeClaim', 'Pod', 'Service']);
  assert.ok(!external.stdout.includes('kind: Secret'), 'an external Secret is referenced, never rendered');
  assert.ok(external.stdout.includes('helm.sh/hook: pre-install,pre-upgrade'), 'migrations run before pods roll against an external database');
  assert.ok(external.stdout.includes(`ghcr.io/cryptob1/graphyard:${packageVersion}`));
  assert.ok(external.stdout.includes('readOnlyRootFilesystem: true') && external.stdout.includes('runAsNonRoot: true'));
  assert.ok(external.stdout.includes('"db", "migrate"') && external.stdout.includes('db backup') && external.stdout.includes('db verify'));
  assert.deepEqual(selectedBy(external.stdout, 'gy-graphyard'), ['Deployment'], 'the Service selects the control-plane pods and nothing else');
  const testPod = external.stdout.split(/^---$/m).find(doc => doc.includes('helm.sh/hook: test'));
  assert.ok(testPod, 'the chart carries a helm test');
  assert.match(testPod, /helm\.sh\/hook-delete-policy: before-hook-creation$/m, 'the test pod survives success so `helm test --logs` can read it');
  const bundled = spawnSync(helm!, ['template', 'gy', chart, '--set', 'secrets.create=true', '--set', 'postgresql.enabled=true', '--set', 'postgresql.password=evaluation-only', '--set-string', 'secrets.principals=[]'], { encoding: 'utf8' });
  assert.equal(bundled.status, 0, bundled.stderr);
  assert.ok(bundled.stdout.includes('kind: StatefulSet') && bundled.stdout.includes('volumeClaimTemplates'), 'the evaluation database persists on a claim');
  assert.ok(bundled.stdout.includes('helm.sh/hook: pre-upgrade\n'), 'with the bundled database the hook waits for upgrades');
  assert.ok(bundled.stdout.includes('DATABASE_URL: "postgres://graphyard:evaluation-only@gy-graphyard-postgresql:5432/graphyard"'));
  assert.deepEqual(selectedBy(bundled.stdout, 'gy-graphyard'), ['Deployment'], 'the Service never selects the evaluation database, the migration Job or the test pod');
  assert.deepEqual(selectedBy(bundled.stdout, 'gy-graphyard-postgresql'), ['StatefulSet']);
  for (const missing of [['secrets.create=true'], ['secrets.create=true', 'secrets.principals=x'], ['postgresql.enabled=true', 'secrets.existingSecret=creds']]) {
    const refused = spawnSync(helm!, ['template', 'gy', chart, ...missing.flatMap(v => ['--set', v])], { encoding: 'utf8' });
    assert.notEqual(refused.status, 0, missing.join(' '));
  }
});

// The chart exercise (deploy/helm/exercise.sh) runs on a real cluster only in release-candidate
// validation, so its request helper and its pod selection are proved here on their own: the shell
// functions are cut out of the script by name and run against a local server or a fixture, and the
// script's order of operations is read from its text, as the rest of this file reads the workflows.
const exercise = read('deploy/helm/exercise.sh');
/** One of the exercise's shell functions, `name() {` through its closing brace at the margin. */
const shellFunction = (name: string) => {
  const start = exercise.indexOf(`\n${name}() {`);
  assert.ok(start >= 0, `${name}() is defined in the exercise`);
  return exercise.slice(start + 1, exercise.indexOf('\n}\n', start) + 3);
};
/** Runs a shell script to completion without blocking the event loop the local server answers on. */
const bash = (script: string, env: Record<string, string>) => new Promise<{ status: number | null; stdout: string; stderr: string }>(done => {
  const child = spawn('bash', ['-c', script], { env: { ...process.env, ...env } });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  child.on('close', status => done({ status, stdout, stderr }));
});
const curl = spawnSync('curl', ['--version'], { encoding: 'utf8' }).status === 0;
/** The settings lines of the exercise: how many times one request is retried, how long between, and how long one attempt may take. */
const retryBounds = () => {
  const settings = /^API_ATTEMPTS="\$\{API_ATTEMPTS:-(\d+)\}"; API_RETRY_WAIT="\$\{API_RETRY_WAIT:-(\d+)\}"\nAPI_TIMEOUT="\$\{API_TIMEOUT:-(\d+)\}"$/m.exec(exercise);
  assert.ok(settings, 'the exercise sets API_ATTEMPTS and API_RETRY_WAIT on one line and API_TIMEOUT on the next, overridable from the environment');
  return { attempts: Number(settings![1]), wait: Number(settings![2]), timeout: Number(settings![3]) };
};

/** A server whose replies follow a script: 'empty' closes the socket, 'reset' resets it, 'stall' accepts the request and never answers, 'blank' is a 200 with a zero-byte body, a number is that status with a body. */
async function scriptedServer(replies: (string | number)[]) {
  const seen: { method: string; url: string; key: string | undefined }[] = [];
  const stalled = new Set<import('node:net').Socket>();
  const server: Server = createServer((request, response) => {
    seen.push({ method: request.method!, url: request.url!, key: request.headers['idempotency-key'] as string | undefined });
    const reply = replies.length > 1 ? replies.shift()! : replies[0];
    if (reply === 'empty') request.socket.destroy();
    else if (reply === 'reset') request.socket.resetAndDestroy();
    else if (reply === 'stall') stalled.add(request.socket);
    else if (reply === 'blank') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(); }
    else { response.writeHead(reply as number, { 'Content-Type': 'application/json' }); response.end(reply === 200 ? '[{"id":"w1","key":"GY-1"}]' : 'rolling'); }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  return { seen, port: (server.address() as AddressInfo).port, close: () => new Promise<void>(done => { for (const socket of stalled) socket.destroy(); server.close(() => done()); }) };
}

test('unit:exercise-api-retries-and-names-failure — the exercise\'s api helper retries an empty reply, a reset connection, a stalled transfer, a non-2xx status and a 2xx carrying no body under one Idempotency-Key a bounded number of times, each attempt bounded, hands a 2xx body on unchanged, and when the bound is exhausted ends on a last line naming the request, the status and the body it received instead of feeding a JSON projection', { skip: curl ? false : 'curl is not installed' }, async () => {
  const api = shellFunction('api');
  assert.ok(!api.includes('curl -fsS'), 'the helper reads the status itself instead of letting -f discard the reply');
  assert.match(api, /-w '%\{http_code\}'/, 'the status is read from curl');
  assert.match(api, /2\[0-9\]\[0-9\]\) if \[ -s "\$reply" \]; then cat "\$reply"/, 'a 2xx reply is handed on only when it carries a body; a zero-byte 2xx is a failed attempt');
  assert.match(api, /for attempt in \$\(seq 1 "\$API_ATTEMPTS"\)/, 'attempts are bounded by API_ATTEMPTS');
  assert.match(api, /sleep "\$API_RETRY_WAIT"/, 'failed attempts wait API_RETRY_WAIT seconds');
  assert.match(api, /curl -sS --max-time "\$API_TIMEOUT" -o "\$reply"/, 'every attempt is bounded by API_TIMEOUT, so a connection the forward accepts but never answers cannot stall the loop past its bound');
  assert.ok(api.indexOf('diagnose') < api.indexOf('failed after $API_ATTEMPTS attempts'), 'the diagnosis precedes the failure line, which is the last thing printed');
  const { attempts, wait, timeout } = retryBounds();
  assert.ok(attempts >= 5 && attempts <= 60 && wait >= 1 && wait <= 5 && attempts * wait <= 120, `a request keeps retrying for a bounded while a rollout settles in: ${attempts} × ${wait}s`);
  assert.ok(timeout >= 5 && timeout <= 30 && attempts * (wait + timeout) <= 600, `one request, every attempt stalled, still fails well inside the chart job's 30-minute timeout: ${attempts} × (${wait} + ${timeout})s`);
  // No call site pipes the helper straight into a projection: an exhausted request ends the exercise on api's own last line.
  assert.ok(!/\$\(api [^\n)]*\| (projection|node)/.test(exercise), 'every projected reply is read into a variable first');
  assert.match(exercise, /^ledger\(\) \{ local body; body="\$\(api GET work "\$OPERATOR_TOKEN"\)" \|\| return 1; printf '%s' "\$body" \| projection; \}$/m);
  const run = async (replies: (string | number)[], attemptsEnv: string) => {
    const server = await scriptedServer(replies);
    try {
      const result = await bash(`set -euo pipefail\ndiagnose() { echo '--- diagnosis' >&2; }\n${api}\napi GET work secret-token`, { LOCAL_PORT: String(server.port), API_ATTEMPTS: attemptsEnv, API_RETRY_WAIT: '0', API_TIMEOUT: '1' });
      return { ...result, seen: server.seen };
    } finally { await server.close(); }
  };
  const recovered = await run(['empty', 'reset', 503, 'blank', 'stall', 200], '7');
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(recovered.stdout, '[{"id":"w1","key":"GY-1"}]', 'the 2xx body is printed unchanged');
  assert.equal(recovered.seen.length, 6, 'one request per attempt until a 2xx with a body');
  assert.ok(recovered.seen.every(r => r.method === 'GET' && r.url === '/api/work' && r.key && r.key === recovered.seen[0].key), 'retries repeat the request under one Idempotency-Key');
  assert.deepEqual(recovered.stderr.trim().split('\n').map(line => line.replace(/got status .*/, 'got status …')), ['api GET /api/work: attempt 1 of 7 got status …', 'api GET /api/work: attempt 2 of 7 got status …', 'api GET /api/work: attempt 3 of 7 got status …', 'api GET /api/work: attempt 4 of 7 got status …', 'api GET /api/work: attempt 5 of 7 got status …']);
  assert.match(recovered.stderr, /attempt 1 of 7 got status 000, curl: \(52\) Empty reply from server/);
  assert.match(recovered.stderr, /attempt 2 of 7 got status 000, curl: \(56\)/);
  assert.match(recovered.stderr, /attempt 3 of 7 got status 503$/m);
  assert.match(recovered.stderr, /attempt 4 of 7 got status 200 with an empty body$/m, 'an HTTP 200 with a zero-byte body is a failed attempt, named as such');
  assert.match(recovered.stderr, /attempt 5 of 7 got status 000, curl: \(28\) Operation timed out after 1\d{3} milliseconds with 0 bytes received/, 'a connection that is accepted but never answered is given up after API_TIMEOUT and retried');
  const unreachable = await run(['empty'], '3');
  assert.equal(unreachable.status, 1); assert.equal(unreachable.stdout, '', 'no body reaches stdout when the bound is exhausted');
  assert.equal(unreachable.seen.length, 3, 'the bound holds');
  const lines = unreachable.stderr.trim().split('\n');
  assert.equal(lines.at(-1), 'api GET /api/work failed after 3 attempts: status 000, curl: (52) Empty reply from server, body: (empty)', 'the last line names the request, the status and the body');
  assert.equal(lines.at(-2), '--- diagnosis', 'the diagnosis comes before it');
  const refused = await run([503], '2');
  assert.equal(refused.status, 1);
  assert.equal(refused.stderr.trim().split('\n').at(-1), 'api GET /api/work failed after 2 attempts: status 503, body: rolling');
  // The reply this item was filed on: the upgraded release answering 200 with nothing in it. It never reaches stdout, so nothing downstream parses it.
  const blank = await run(['blank'], '2');
  assert.equal(blank.status, 1); assert.equal(blank.stdout, '', 'an empty 2xx body never reaches a projection');
  assert.equal(blank.seen.length, 2, 'a persistently empty 2xx exhausts the same bound');
  assert.equal(blank.stderr.trim().split('\n').at(-1), 'api GET /api/work failed after 2 attempts: status 200 with an empty body, body: (empty)');
  // A release that accepts every connection and answers none: without a per-attempt bound this loop never advanced and the chart job ran into its own 30-minute timeout with no diagnosis.
  const stalled = await run(['stall'], '2');
  assert.equal(stalled.status, 1); assert.equal(stalled.stdout, '');
  assert.equal(stalled.seen.length, 2, 'each stalled attempt is given up and the bound holds');
  assert.match(stalled.stderr.trim().split('\n').at(-1)!, /^api GET \/api\/work failed after 2 attempts: status 000, curl: \(28\) Operation timed out after 1\d{3} milliseconds with 0 bytes received, body: \(empty\)$/);
});

/** A `kubectl get rs,pods -o json` list: an old ReplicaSet scaled to zero whose long-ready pod is terminating, and the upgraded one. */
const rollout = (newPodReady: boolean) => JSON.stringify({ kind: 'List', items: [
  { kind: 'ReplicaSet', metadata: { name: 'gy-graphyard-old', labels: { 'pod-template-hash': 'old1' } }, spec: { replicas: 0 } },
  { kind: 'ReplicaSet', metadata: { name: 'gy-graphyard-new', labels: { 'pod-template-hash': 'new2' } }, spec: { replicas: 1 } },
  { kind: 'Pod', metadata: { name: 'gy-graphyard-old-aaaaa', labels: { 'pod-template-hash': 'old1' }, deletionTimestamp: '2026-10-11T03:27:00Z' }, spec: { containers: [{ ports: [{ name: 'http', containerPort: 4310 }] }] }, status: { conditions: [{ type: 'Ready', status: 'True' }] } },
  { kind: 'Pod', metadata: { name: 'gy-graphyard-new-bbbbb', labels: { 'pod-template-hash': 'new2' } }, spec: { containers: [{ ports: [{ name: 'http', containerPort: 4310 }] }] }, status: { conditions: [{ type: 'Ready', status: newPodReady ? 'True' : 'False' }] } },
] });

test('unit:exercise-forward-after-rollout — after step 3\'s upgrade the exercise waits for the deployment\'s rollout, forwards to a Ready, non-terminating pod of the ReplicaSet still scaled up and waits for its /healthz before step 4\'s first request; the pod selection never picks the old ReplicaSet\'s terminating pod and the forward\'s and the API\'s retry bounds are stated', () => {
  const forward = shellFunction('forward');
  const at = (text: string, needle: string, from = 0) => { const index = text.indexOf(needle, from); assert.ok(index >= 0, `${JSON.stringify(needle)} appears`); return index; };
  // Inside forward(): rollout status, then the pod of the current ReplicaSet, then the forward to that pod, then /healthz.
  const rolled = at(forward, 'k rollout status "deploy/$RELEASE-graphyard" --timeout="${remaining}s"');
  const selected = at(forward, 'k get rs,pods -l "app.kubernetes.io/instance=$RELEASE,app.kubernetes.io/component=server" -o json | select_pod', rolled);
  const forwarded = at(forward, 'k port-forward --address 127.0.0.1 "pod/${target% *}" "$LOCAL_PORT:${target#* }"', selected);
  const healthy = at(forward, 'curl -fsS "http://127.0.0.1:$LOCAL_PORT/healthz"', forwarded);
  assert.ok(forward.slice(forwarded, healthy).includes('probe_end=$(( $(date +%s) + 30 ))'), 'the forward waits up to 30 s for /healthz, within its FORWARD_BUDGET');
  assert.ok(!exercise.includes('port-forward --address 127.0.0.1 "svc/'), 'the forward never targets the Service, whose pod ranking prefers the longest-ready pod');
  // In the script: the upgrade, then the forward, then step 4's first request.
  const upgrade = at(exercise, 'install_args upgrade "$NEXT_REPOSITORY"');
  const reforward = at(exercise, '\nforward\n', upgrade);
  const step4 = at(exercise, 'step "4. Taking a logical backup', reforward);
  assert.ok(!exercise.slice(upgrade, reforward).includes('api '), 'no request is made between the upgrade and the re-established forward');
  assert.equal(exercise.slice(step4).split('\n')[1], 'BEFORE_BACKUP="$(ledger)"', 'step 4 opens with the projected ledger read through the retrying helper');
  retryBounds();
  // The selection itself, on the ReplicaSets and pods kubectl lists mid-handover.
  const select = shellFunction('select_pod');
  const picked = spawnSync('bash', ['-c', `set -euo pipefail\n${select}\nselect_pod`], { encoding: 'utf8', input: rollout(true) });
  assert.equal(picked.status, 0, picked.stderr);
  assert.equal(picked.stdout.trim(), 'gy-graphyard-new-bbbbb 4310', 'the upgraded ReplicaSet\'s Ready pod and its http port, never the terminating pod of the old one');
  const waiting = spawnSync('bash', ['-c', `set -euo pipefail\n${select}\nselect_pod`], { encoding: 'utf8', input: rollout(false) });
  assert.notEqual(waiting.status, 0, 'with no Ready pod of the current ReplicaSet the forward fails rather than falling back to the terminating pod');
  assert.match(waiting.stderr, /no Ready pod of a scaled-up ReplicaSet among: ReplicaSet\/gy-graphyard-old, ReplicaSet\/gy-graphyard-new, Pod\/gy-graphyard-old-aaaaa, Pod\/gy-graphyard-new-bbbbb/);
});
