import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defaultChildRun } from '../src/child-runner.js';
import { publishTokenFiles, publishVerified } from '../src/publish-verified.js';
import { databaseUrl } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3214: a host that holds no Graphyard checkout goes from `npx graphyard up` to a working
// install. The npm registry and the image registry are local ones standing in for npm and GHCR,
// Graphyard's upstream is a local repository Git is pointed at, and docker, gh and the dependency
// install are stand-ins on PATH (a trial has no Docker daemon, GitHub or network); everything
// else — npm publish, npx, the launcher, the clone, `up` and the control plane — is the real thing,
// run as subprocesses of a fresh home that never names a Graphyard path.

const source = fileURLToPath(new URL('..', import.meta.url));
const servers: Server[] = [];
after(() => { for (const server of servers) server.close(); });
const body = async (request: IncomingMessage) => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk as Buffer); return Buffer.concat(chunks); };
const listen = (server: Server) => new Promise<string>(accept => { servers.push(server); server.listen(0, '127.0.0.1', () => accept(`127.0.0.1:${(server.address() as { port: number }).port}`)); });

/** A local npm registry: what `npm publish` puts is what `npx` gets. */
async function npmRegistry() {
  const packages = new Map<string, any>(), tarballs = new Map<string, Buffer>();
  const host = await listen(createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url!, 'http://registry').pathname);
    if (request.method === 'PUT') {
      const put = JSON.parse((await body(request)).toString());
      const held = packages.get(put.name) ?? { name: put.name, 'dist-tags': {}, versions: {} };
      Object.assign(held.versions, put.versions); Object.assign(held['dist-tags'], put['dist-tags']);
      for (const [file, attachment] of Object.entries<any>(put._attachments ?? {})) tarballs.set(`/${put.name}/-/${file}`, Buffer.from(attachment.data, 'base64'));
      packages.set(put.name, held);
      return response.writeHead(201, { 'content-type': 'application/json' }).end('{}');
    }
    if (tarballs.has(path)) return response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(tarballs.get(path));
    const held = packages.get(path.slice(1));
    response.writeHead(held ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(held ?? {}));
  }));
  return { url: `http://${host}/`, packages };
}

/** A local image registry: the tags pushed to it are the tags a pull finds. */
async function imageRegistry() {
  const tags = new Map<string, string>(), pulls: string[] = [];
  const host = await listen(createServer(async (request, response) => {
    const [, name, tag] = /^\/v2\/(.+)\/manifests\/(.+)$/.exec(request.url!) ?? [];
    if (request.method === 'PUT') tags.set(`${name}:${tag}`, (await body(request)).toString()); else pulls.push(`${name}:${tag}`);
    response.writeHead(request.method === 'PUT' || tags.has(`${name}:${tag}`) ? 200 : 404).end(tags.get(`${name}:${tag}`) ?? '');
  }));
  return { host, tags, pulls };
}

/** docker, gh, npm, ssh, herdr and systemctl as a trial can have them: docker talks to the image registry and keeps its images in a file; `npm ci` links this checkout's installed dependencies. */
async function standIns(directory: string, origin: string, tree: string, database: string) {
  const loader = pathToFileURL(createRequire(join(source, 'package.json')).resolve('tsx')).href;
  const modules = dirname(dirname(createRequire(join(source, 'package.json')).resolve('tsx/package.json')));
  const tools = dirname(process.execPath);
  await writeFile(join(directory, 'docker'), `#!${process.execPath}
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const state = ${JSON.stringify(join(directory, 'docker-images.json'))}, words = process.argv.slice(2).join(' ');
appendFileSync(${JSON.stringify(join(directory, 'docker.log'))}, words + '\\n');
// docker image pull|push|rm REF is docker pull|push|rmi REF.
const args = process.argv[2] === 'image' ? process.argv.slice(3) : process.argv.slice(2);
// Each image is the commit it was built from: the stamp a real image carries.
const images = existsSync(state) ? JSON.parse(readFileSync(state, 'utf8')) : {};
const save = () => writeFileSync(state, JSON.stringify(images));
const fail = text => { console.error(text); process.exit(1); };
const manifest = ref => { const slash = ref.indexOf('/'), colon = ref.lastIndexOf(':'); return 'http://' + ref.slice(0, slash) + '/v2/' + ref.slice(slash + 1, colon) + '/manifests/' + ref.slice(colon + 1); };
const push = async ref => { if (!images[ref]) fail('no such image ' + ref); await fetch(manifest(ref), { method: 'PUT', body: images[ref] }); };
const tagged = () => args.flatMap((arg, index) => args[index - 1] === '--tag' ? [arg] : []);
if (args[0] === 'version') console.log('27.0.0');
else if (words.startsWith('compose version')) console.log('2.29.0');
else if (args[0] === 'build' || words.startsWith('buildx build')) {
  const stamp = args.find(arg => arg.startsWith('GRAPHYARD_BUILD_SHA='))?.slice(20) ?? 'unstamped';
  for (const tag of tagged()) images[tag] = stamp;
  save();
  if (args.includes('--push')) for (const tag of tagged()) await push(tag);
}
else if (args[0] === 'push') await push(args[1]);
else if (args[0] === 'pull') { const found = await fetch(manifest(args[1])); if (!found.ok) fail('manifest unknown: ' + args[1]); images[args[1]] = await found.text(); save(); }
else if (args[0] === 'tag') { images[args[2]] = images[args[1]] ?? fail('no such image ' + args[1]); save(); }
else if (args[0] === 'rm') { delete images[args[1]]; save(); }
else if (args[0] === 'compose') {
  // The server container: the image's own command, run from the tree its commit was built from, on the published port.
  const project = args[args.indexOf('--project-directory') + 1], pid = join(project, 'server.pid');
  const running = () => { try { process.kill(Number(readFileSync(pid, 'utf8')), 0); return true; } catch { return false; } };
  if (args.includes('ps')) { if (running()) console.log(JSON.stringify([{ Service: 'db', State: 'running' }, { Service: 'server', State: 'running' }])); }
  else if (args.includes('logs')) console.log(existsSync(join(project, 'server.log')) ? readFileSync(join(project, 'server.log'), 'utf8') : '');
  else if (args.includes('up')) {
    if (running()) { process.kill(Number(readFileSync(pid, 'utf8'))); while (running()) await new Promise(accept => setTimeout(accept, 50)); }
    const bundle = readFileSync(join(project, 'compose.yaml'), 'utf8');
    const image = /image: (graphyard-local\\S*)/.exec(bundle)[1];
    if (!images[image]) fail('pull access denied for ' + image);
    const env = Object.fromEntries(readFileSync(join(project, 'server.env'), 'utf8').split('\\n').filter(Boolean).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    const log = openSync(join(project, 'server.log'), 'a');
    const server = spawn(process.execPath, ['--import', ${JSON.stringify(loader)}, 'src/server.ts'], { cwd: ${JSON.stringify(tree)}, detached: true, stdio: ['ignore', log, log],
      env: { PATH: process.env.PATH, ...env, HOST: '127.0.0.1', PORT: /127\\.0\\.0\\.1:(\\d+):4310/.exec(bundle)[1], DATABASE_URL: ${JSON.stringify(database)}, GRAPHYARD_REPOSITORY_ROOT: /"([^"]+):\\/repo"/.exec(bundle)[1], GRAPHYARD_BUILD_SHA: images[image] } });
    writeFileSync(pid, String(server.pid));
    server.unref();
  }
}
`);
  await writeFile(join(directory, 'gh'), `#!/bin/sh
echo "$*" >> ${JSON.stringify(join(directory, 'gh.log'))}
keys=${JSON.stringify(join(directory, 'deploy-key'))}
case "$*" in
  "repo view"*) echo '{"name":"scratch"}';;
  "repo deploy-key list"*) if [ -f "$keys" ]; then printf '[{"id":1,"title":"merge writer","key":"%s"}]\\n' "$(cat "$keys")"; else echo '[]'; fi;;
  "repo deploy-key add"*) cp "$4" "$keys";;
  "config get user"*) echo fresh;;
  "auth status"*) echo 'Logged in to github.com account fresh';;
esac
`);
  await writeFile(join(directory, 'npm'), `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args[0] === 'ci') {
  const target = join(args[args.indexOf('--prefix') + 1], 'node_modules');
  mkdirSync(target);
  for (const name of readdirSync(${JSON.stringify(modules)})) symlinkSync(join(${JSON.stringify(modules)}, name), join(target, name));
} else process.exit(spawnSync(${JSON.stringify(join(tools, 'npm'))}, args, { stdio: 'inherit' }).status ?? 1);
`);
  // GitHub over SSH: the scratch repository's bare origin, whatever key is presented.
  await writeFile(join(directory, 'ssh'), `#!/bin/sh\nfor last; do :; done\nexec \${last%% *} ${JSON.stringify(origin)}\n`);
  // A trial has no systemd user manager, so Herdr's server cannot be kept running: setup leaves Herdr out and says so.
  await writeFile(join(directory, 'herdr'), '#!/bin/sh\n[ "$1" = --version ] && echo herdr 0.0.0 && exit 0\necho "no Herdr server on this host" >&2; exit 1\n');
  await writeFile(join(directory, 'systemctl'), '#!/bin/sh\necho "no systemd user manager on this host" >&2; exit 1\n');
  for (const name of ['docker', 'gh', 'npm', 'ssh', 'herdr', 'systemctl']) chmodSync(join(directory, name), 0o755);
  return { path: `${directory}:${tools}:/usr/bin:/bin`, log: (name: string) => existsSync(join(directory, `${name}.log`)) ? readFileSync(join(directory, `${name}.log`), 'utf8').split('\n').filter(Boolean) : [],
    images: () => JSON.parse(readFileSync(join(directory, 'docker-images.json'), 'utf8')) as Record<string, string> };
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

/** A child as the fresh account runs it: its output, and its exit code. */
function run(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
  return new Promise<{ code: number; stdout: string; stderr: string }>(accept => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => accept({ code: code ?? 1, stdout, stderr }));
  });
}

test('e2e:clean-host-npx-up — a fresh account runs npx graphyard up against a published commit and gets a served control plane from a Git release tree and pulled images', { timeout: 900_000 }, async () => {
  // Beside the checkout, not under the temporary directory: setup refuses a repository checked out where a reboot removes it.
  const base = realpathSync(await temporaryDirectory('.npx-up', source));
  const upstream = join(base, 'upstream'), home = join(base, 'home'), stubs = join(base, 'bin'), repository = join(base, 'scratch'), origin = join(base, 'origin.git');
  for (const directory of [upstream, home, stubs, repository]) await mkdir(directory);

  // Graphyard's upstream: this checkout's tracked files as one commit, which is the commit the gate verified.
  for (const file of execFileSync('git', ['-C', source, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean)) {
    if (existsSync(join(source, file))) await cp(join(source, file), join(upstream, file), { recursive: true, verbatimSymlinks: true });
  }
  git(upstream, 'init', '-q', '-b', 'main'); git(upstream, 'add', '-A'); git(upstream, 'commit', '-q', '-m', 'verified');
  const commit = git(upstream, 'rev-parse', 'HEAD');
  // What the image build adds to that tree: the built dashboard (ignored by Git, so the tree stays the commit's).
  execFileSync(process.execPath, [join(dirname(createRequire(join(source, 'package.json')).resolve('vite/package.json')), 'bin', 'vite.js'), 'build', '--configLoader', 'runner'], { cwd: upstream, stdio: 'ignore' });

  // The Graphyard host publishes the verified commit: both images and the npm package, with the operator's tokens.
  const npm = await npmRegistry(), images = await imageRegistry(), tools = await standIns(stubs, origin, upstream, await databaseUrl('npx_up'));
  const published = { npm_config_registry: npm.url, GRAPHYARD_IMAGE_REGISTRY: `${images.host}/cryptob1` };
  const publisher = join(base, 'publisher');
  await mkdir(publisher);
  await writeFile(publishTokenFiles(publisher).npm, 'npm-token\n', { mode: 0o600 });
  await writeFile(publishTokenFiles(publisher).ghcr, 'ghcr-token\n', { mode: 0o600 });
  const outcome = await publishVerified(commit, { root: upstream, directory: publisher, run: defaultChildRun, env: { ...process.env, ...published, PATH: tools.path } });
  assert.ok('version' in outcome, JSON.stringify(outcome));
  assert.deepEqual([...images.tags.keys()].sort(), [`cryptob1/graphyard-trial:${commit}`, 'cryptob1/graphyard-trial:verified', `cryptob1/graphyard:${commit}`, 'cryptob1/graphyard:verified']);
  assert.equal(npm.packages.get('graphyard')['dist-tags'].latest, outcome.version);

  // A fresh account: an empty home, Git pointed at the local upstream, and a scratch repository.
  await writeFile(join(home, '.gitconfig'), `[url "${upstream}"]\n\tinsteadOf = https://github.com/cryptob1/graphyard\n[user]\n\tname = Fresh\n\temail = fresh@example.com\n`);
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(repository, 'init', '-q', '-b', 'main');
  await writeFile(join(repository, 'package.json'), JSON.stringify({ name: 'scratch', scripts: { test: 'node --eval 0' } }));
  git(repository, 'add', '.'); git(repository, 'commit', '-q', '-m', 'first'); git(repository, 'push', '-q', origin, 'main'); git(repository, 'remote', 'add', 'origin', 'git@github.com:owner/scratch.git');
  const env = { HOME: home, PATH: tools.path, LANG: 'C.UTF-8', TMPDIR: process.env.TMPDIR ?? '/tmp', ...published };

  const graphyard = (...args: string[]) => run('npx', ['--yes', 'graphyard', ...args], { cwd: repository, env });
  after(() => { for (const pid of [join(home, '.config', 'graphyard', 'owner-scratch', 'compose', 'server.pid')]) { try { process.kill(Number(readFileSync(pid, 'utf8'))); } catch { /* never started */ } } });

  // The README's one command, with the agent flags a session without a terminal passes.
  const up = await graphyard('up', '--repo', 'owner/scratch', '--agent', '--wait', '1');
  const result = JSON.parse(up.stdout.slice(up.stdout.indexOf('{')));
  const events = up.stderr.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  assert.deepEqual(result.completed, ['preflight', 'control-plane', 'host-supervisor', 'deploy-key', 'master-autonomy', 'onboarding'], `${up.stderr.slice(-4000)}\n${result.next}`);
  // A fresh account has signed in to no AI coding account yet: that is the one step left to its person, at the Setup link.
  assert.equal(up.code, 3, result.next);
  assert.match(result.next, /Still waiting on An agent account that writes code/);

  // The code it runs is a Git clone of the upstream at the published commit, under the install — so the loop, upgrade and the deploy watch move it with Git.
  const release = join(home, '.config', 'graphyard', 'owner-scratch', 'deploy', 'build', '.graphyard', 'cli-releases', commit);
  assert.deepEqual(readdirSync(dirname(release)), [commit]);
  assert.equal(git(release, 'rev-parse', 'HEAD'), commit);
  assert.equal(git(release, 'config', '--get', 'remote.origin.url'), 'https://github.com/cryptob1/graphyard');
  assert.equal(JSON.parse(readFileSync(join(repository, '.graphyard', 'master.json'), 'utf8')).cliPath, join(release, 'bin', 'graphyard.mjs'), 'the loop is recorded to run from the release tree, not from the npm cache');

  // Both images were pulled by that commit from the registry; nothing was built on this host.
  assert.ok(images.pulls.includes(`cryptob1/graphyard:${commit}`) && images.pulls.includes(`cryptob1/graphyard-trial:${commit}`), images.pulls.join(', '));
  const installing = tools.log('docker').slice(tools.log('docker').findIndex(line => line.startsWith('image pull ')));
  assert.deepEqual(installing.filter(line => /^(build|buildx) /.test(line)), [], 'the install builds no image');
  assert.equal(tools.images()['graphyard-local:owner-scratch'], commit, 'the control plane runs the pulled image');
  assert.equal(readFileSync(join(release, '.graphyard', 'trial-image'), 'utf8').trim(), `${images.host}/cryptob1/graphyard-trial:${commit}`, 'merge trials run the pulled trial image');

  // The dashboard is served, by the published commit.
  const server = new URL(result.setupUrl).origin;
  const health = await (await fetch(`${server}/healthz`)).json() as { ok: boolean; commit: string };
  assert.deepEqual([health.ok, health.commit], [true, commit]);
  const dashboard = await fetch(server);
  assert.equal(dashboard.status, 200);
  assert.match(await dashboard.text(), /<title>[^<]*Graphyard/i);

  // Setup filed the onboarding change as the install's first work item, and a later `npx graphyard` runs the installed release.
  const onboarding = events.find(event => event.step === 'onboarding' && event.state === 'done');
  assert.match(onboarding.detail, /filed as GY-1 for the loop to review and merge/);
  const status = await graphyard('status', 'GY-1');
  assert.equal(status.code, 0, status.stderr);
  const item = JSON.parse(status.stdout);
  assert.deepEqual([item.key, item.stage !== 'done', !!item.submission], ['GY-1', true, true], 'the onboarding change is submitted and waits for review');
  assert.ok(!status.stderr.includes('Fetching Graphyard'), 'the release is fetched once');
  // The README's next commands work the same way, and upgrading stays a Git move of that tree.
  const master = await graphyard('master', 'status');
  assert.equal(JSON.parse(master.stdout).controlPlane.reachable, true, master.stderr);
  const plan = await graphyard('upgrade', '--plan');
  assert.equal(plan.code, 0, plan.stderr);
  assert.ok(plan.stdout.includes(`git -C "${release}/" checkout --detach`), plan.stdout);
});
