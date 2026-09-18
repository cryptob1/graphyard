import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, constants, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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
  const ci = read('.github/workflows/ci.yml');
  assert.ok(ci.includes('scripts/verify-image-release.mjs'), 'every candidate image is held to the release contract');
  assert.ok(read('.github/workflows/helm.yml').includes('deploy/helm/exercise.sh'), 'the chart exercise runs in CI');
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
