import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { applyInstall, buildPlan, coreEnv, prepareInstall } from '../src/install/index.js';
import { PRIVATE_KEY_CONTAINER_PATH, composeAdapter, type AdapterContext } from '../src/install/adapters.js';
import { fakeTransport, localTransport, sshTransport, type Transport } from '../src/install/transport.js';
import { Vault } from '../src/install/secrets.js';
import { CHECK_NAME } from '../src/install/github.js';
import type { Provider } from '../src/install/types.js';
import { harness, satisfiedProtection, GRAPHYARD_APP_ID, CI_APP_ID, RAILWAY_WORKSPACES, appKey, type Harness } from './install-harness.js';

const skipWithoutDocker = await (async () => {
  try { return (await localTransport().exec('docker', ['version', '--format', '{{.Server.Version}}'], { allowFailure: true, timeout: 30_000 })).code === 0 ? false : 'docker is not usable on this machine'; }
  catch { return 'docker is not usable on this machine'; }
})();

const inputsFor = (provider: Provider) => ({ repository: 'owner/project', provider,
  ...(provider === 'railway' || provider === 'compose' ? {} : { sshHost: '203.0.113.10', sshUser: 'root', domain: 'graphyard.example.test' }),
  ...(provider === 'hetzner' ? { sshKey: 'graphyard-key' } : {}) });

const bundle = (fixture: Harness, name: string) => {
  const stores = [fixture.transport.files, ...[...fixture.remotes.values()].map(remote => remote.files)];
  for (const store of stores) for (const [path, file] of store) if (path.endsWith(`/${name}`)) return file;
  return null;
};

async function apply(fixture: Harness, provider: Provider) {
  const session = await prepareInstall(fixture.root, inputsFor(provider), fixture.deps);
  return { session, summary: await applyInstall(session, await buildPlan(session)) };
}

test('--apply provisions Postgres and the application, sets every variable, and reaches a healthy HTTPS URL on each adapter', async () => {
  const expectedUrl: Record<Provider, string> = {
    railway: 'https://graphyard-owner-project.up.railway.app',
    hetzner: 'https://graphyard.example.test',
    'docker-host': 'https://graphyard.example.test',
    compose: 'http://127.0.0.1:4310',
  };
  for (const provider of ['railway', 'hetzner', 'docker-host', 'compose'] as Provider[]) {
    const fixture = await harness({ provider });
    try {
      const { session, summary } = await apply(fixture, provider);
      assert.equal(summary.url, expectedUrl[provider], `${provider} URL`);
      assert.equal(summary.health, true);
      assert.equal(summary.webhookUrl, `${expectedUrl[provider]}/api/github/webhook`);
      assert.equal(summary.status.role, 'admin');
      assert.equal(summary.status.repository, 'owner/project');
      assert.equal(summary.github?.appId, GRAPHYARD_APP_ID);
      assert.deepEqual(summary.github?.ciAppIds, [CI_APP_ID]);
      assert.equal(summary.webhook.delivered, true, `${provider} webhook: ${summary.webhook.detail}`);

      const lines = fixture.allCommandLines();
      if (provider === 'railway') {
        assert.ok(lines.some(line => line.includes('railway add --database postgres')), 'Postgres was not provisioned');
        assert.ok(lines.some(line => line.includes('railway up --service')), 'the application was not deployed');
        assert.ok(lines.some(line => line.includes('railway domain --service')), 'no HTTPS domain was obtained');
      } else {
        const compose = bundle(fixture, 'compose.yaml')!;
        assert.ok(compose, `${provider} wrote no Compose bundle`);
        assert.match(compose.content, /image: postgres:17-alpine/);
        // Hetzner keeps the ledger on the attached volume; the others use a named volume.
        assert.ok(compose.content.includes(provider === 'hetzner' ? '"/mnt/graphyard/postgres:/var/lib/postgresql/data"' : '"graphyard-data:/var/lib/postgresql/data"'), `${provider} Postgres storage is not durable`);
        assert.ok(lines.some(line => line.includes('up -d --remove-orphans')), `${provider} did not start the stack`);
        const environment = bundle(fixture, 'server.env')!;
        assert.equal(environment.mode, 0o600);
        assert.equal(bundle(fixture, 'db.env')!.mode, 0o600);
        for (const name of ['HOST', 'PORT', 'DATABASE_URL', 'GRAPHYARD_PRINCIPALS', 'GITHUB_REPOSITORY', 'GITHUB_BASE_BRANCH', 'GITHUB_APP_ID', 'GITHUB_INSTALLATION_ID', 'GITHUB_PRIVATE_KEY_FILE', 'GITHUB_WEBHOOK_SECRET', 'GITHUB_CI_APP_IDS']) {
          assert.ok(environment.content.includes(`${name}=`), `${provider} did not set ${name}`);
        }
        if (provider !== 'compose') assert.match(bundle(fixture, 'Caddyfile')!.content, /graphyard\.example\.test \{/);
      }

      const record = JSON.parse(await readFile(join(session.directory, 'install.json'), 'utf8'));
      assert.equal(record.url, expectedUrl[provider]);
      assert.equal(record.github.appId, GRAPHYARD_APP_ID);
      assert.equal(record.principals.length, session.principals.length);
    } finally { await fixture.cleanup(); }
  }
});

test('re-applying an existing installation is idempotent: nothing is provisioned twice and no credential rotates', async () => {
  for (const provider of ['railway', 'hetzner', 'docker-host', 'compose'] as Provider[]) {
    const first = await harness({ provider });
    let second: Harness | undefined;
    try {
      const initial = await apply(first, provider);
      const envFile = provider === 'railway'
        ? JSON.stringify(Object.fromEntries(coreEnv(initial.session).map(value => [value.name, value.value])))
        : `${coreEnv(initial.session).map(value => `${value.name}=${value.value}`).join('\n')}\n`;
      second = await harness({ provider, installed: true, envFile, protection: satisfiedProtection(null), root: first.root, configHome: first.configHome });
      const again = await apply(second, provider);

      assert.equal(again.summary.url, initial.summary.url);
      const lines = second.allCommandLines();
      for (const creation of ['railway init', 'railway add --database', 'railway add --service', 'hcloud server create', 'hcloud volume create']) {
        assert.ok(!lines.some(line => line.includes(creation)), `${provider} re-ran ${creation}`);
      }
      // Tokens are the installation's identity: a second apply must not invalidate live workers.
      for (const principal of initial.session.principals) {
        assert.equal(again.session.tokens.get(principal.id), initial.session.tokens.get(principal.id), `${provider} rotated ${principal.id}`);
      }
      assert.equal(again.session.context.databasePassword, initial.session.context.databasePassword);
      const record = JSON.parse(await readFile(join(initial.session.directory, 'install.json'), 'utf8'));
      assert.equal(record.createdAt, JSON.parse(await readFile(join(again.session.directory, 'install.json'), 'utf8')).createdAt);
    } finally { await first.cleanup(); if (second) await second.cleanup(); }
  }
});

test('adding a worker to an existing installation mints only the new credential', async () => {
  const first = await harness({ provider: 'compose' });
  let second: Harness | undefined;
  try {
    const initial = await apply(first, 'compose');
    const envFile = `${coreEnv(initial.session).map(value => `${value.name}=${value.value}`).join('\n')}\n`;
    second = await harness({ provider: 'compose', installed: true, envFile, protection: satisfiedProtection(null), root: first.root, configHome: first.configHome });

    // Only part of the credential set exists, so preparing cannot claim real fingerprints.
    const session = await prepareInstall(second.root, { ...inputsFor('compose'), workers: 2 }, second.deps);
    assert.equal(session.materialized, false);
    assert.equal(session.tokens.size, initial.session.principals.length);

    await applyInstall(session, await buildPlan(session));
    assert.equal(session.materialized, true);
    for (const principal of initial.session.principals) {
      assert.equal(session.tokens.get(principal.id), initial.session.tokens.get(principal.id), `${principal.id} rotated`);
    }
    assert.equal(session.context.databasePassword, initial.session.context.databasePassword);
    assert.equal(session.principals.filter(principal => principal.role === 'worker').length, 2);
    assert.ok(session.tokens.get('owner-project-worker-2'), 'the added worker received no credential');
  } finally { await first.cleanup(); if (second) await second.cleanup(); }
});

test('Railway secrets are sent over standard input and never appear in a process argument', async () => {
  const fixture = await harness({ provider: 'railway' });
  try {
    const { session } = await apply(fixture, 'railway');
    const secrets = ['GRAPHYARD_PRINCIPALS', 'GITHUB_PRIVATE_KEY', 'GITHUB_WEBHOOK_SECRET'];
    for (const name of secrets) {
      const command = fixture.transport.commands.find(entry => entry.args.includes('--stdin') && entry.args.includes(name));
      assert.ok(command, `${name} was not sent over stdin`);
      assert.ok(command!.input && command!.input.length > 0);
    }
    for (const command of fixture.transport.commands) {
      for (const token of session.tokens.values()) assert.ok(!command.args.some(argument => argument.includes(token)), 'a credential reached a process argument');
    }
    // Plain values still go through --set, so a re-run can compare them without decryption.
    assert.ok(fixture.commandLines().some(line => line.includes('--set HOST=0.0.0.0')));
  } finally { await fixture.cleanup(); }
});

test('the App-bound merge check is required only once Graphyard has published it', async () => {
  const fresh = await harness({ provider: 'compose' });
  try {
    const { summary } = await apply(fresh, 'compose');
    const put = fresh.transport.commands.find(command => command.args.includes('--method') && command.args.includes('PUT'))!;
    const payload = JSON.parse(put.input!);
    assert.ok(!payload.required_status_checks.checks.some((check: any) => check.context === CHECK_NAME), 'a check that does not exist yet must not be required');
    // The merge queue lands a candidate that is deliberately behind the base branch.
    assert.equal(payload.required_status_checks.strict, false);
    assert.equal(payload.enforce_admins, true);
    assert.equal(payload.required_conversation_resolution, true);
    assert.equal(payload.required_pull_request_reviews.required_approving_review_count, 1);
    assert.ok(summary.nextSteps.some(step => step.includes(CHECK_NAME)), 'the operator must be told to rerun once the check exists');
  } finally { await fresh.cleanup(); }

  const published = await harness({ provider: 'compose', protection: { required_status_checks: { strict: false, checks: [{ context: CHECK_NAME, app_id: null }] }, enforce_admins: { enabled: false }, required_pull_request_reviews: { required_approving_review_count: 0 } } });
  try {
    const { summary } = await apply(published, 'compose');
    const put = published.transport.commands.filter(command => command.args.includes('--method') && command.args.includes('PUT')).at(-1)!;
    const payload = JSON.parse(put.input!);
    const merge = payload.required_status_checks.checks.find((check: any) => check.context === CHECK_NAME);
    assert.equal(merge.app_id, GRAPHYARD_APP_ID, 'the merge check must be bound to the Graphyard App');
    assert.ok(!summary.nextSteps.some(step => step.includes(CHECK_NAME)));
  } finally { await published.cleanup(); }
});

test('the multi-line App private key is written beside the bundle and mounted, never into the env file', async () => {
  const fixture = await harness({ provider: 'compose' });
  try {
    await apply(fixture, 'compose');
    const environment = bundle(fixture, 'server.env')!;
    // docker compose reads an env file as one NAME=value per line and refuses anything else;
    // feeding the rendered file through a real parser is what a deploy would do with it.
    for (const line of environment.content.split('\n').filter(Boolean)) {
      assert.match(line, /^[A-Za-z_][A-Za-z0-9_]*=/, `env-file line is not a variable assignment: ${line.slice(0, 30)}`);
    }
    const parsed = parseEnv(environment.content);
    assert.ok(!environment.content.includes('PRIVATE KEY'), 'the raw PEM reached the env file');
    assert.equal(parsed.GITHUB_PRIVATE_KEY, undefined);
    assert.equal(parsed.GITHUB_PRIVATE_KEY_FILE, PRIVATE_KEY_CONTAINER_PATH);
    assert.equal(parsed.HOST, '0.0.0.0');
    assert.ok(parsed.DATABASE_URL?.startsWith('postgres://'), 'the parsed env file lost the core variables');

    const key = bundle(fixture, 'github-private-key.pem')!;
    assert.ok(key, 'the private key sidecar file was not written');
    assert.equal(key.mode, 0o600);
    // The image runs USER node (uid 1000) and a bind mount keeps host ownership, so the key
    // must be given to the container user at write time: anything else crash-loops the server.
    assert.equal(key.owner, '1000:1000');
    assert.equal(key.content, appKey);
    assert.match(bundle(fixture, 'compose.yaml')!.content, new RegExp(`volumes: \\["\\./github-private-key\\.pem:${PRIVATE_KEY_CONTAINER_PATH}:ro"\\]`));
  } finally { await fixture.cleanup(); }
});

test('the SSH transport ends the key write with chown and refuses a remote user that cannot give it to the container', async () => {
  const recorded: { args: string[] }[] = [];
  const base: Transport = {
    description: 'base',
    exec: async (_program: string, args: string[]) => { recorded.push({ args }); return { stdout: '', stderr: '', code: 0 }; },
    putFile: async () => {},
  };
  await sshTransport('203.0.113.10', 'root', base).putFile('/opt/graphyard/owner-project/github-private-key.pem', 'PEM', 0o600, '1000:1000');
  // ssh joins the arguments into one remote command, so the script arrives double-quoted;
  // the escaped quotes are collapsed before the content is matched.
  const script = recorded[0].args.at(-1)!.replaceAll(`'\\''`, "'");
  assert.match(script, /chmod 0600/);
  assert.match(script, /chown '1000:1000' '\/opt\/graphyard\/owner-project\/github-private-key\.pem'/, 'the key was not given to the container user');

  // A non-root remote user cannot chown to uid 1000; the deploy must stop here, with the fix,
  // instead of restarting the server forever on EACCES.
  const refusing: Transport = {
    description: 'base',
    exec: async () => ({ stdout: '', stderr: "chown: changing ownership of '/opt/graphyard/owner-project/github-private-key.pem': Operation not permitted", code: 1 }),
    putFile: async () => {},
  };
  await assert.rejects(
    sshTransport('203.0.113.10', 'deploy', refusing).putFile('/opt/graphyard/owner-project/github-private-key.pem', 'PEM', 0o600, '1000:1000'),
    (error: Error) => { assert.match(error.message, /must be able to read .*--ssh-user root|chown '1000:1000'/); return true; },
  );
});

test('a uid-1000 container reads the key a real transport wrote, through a real bind mount', { skip: skipWithoutDocker }, async () => {
  const docker = localTransport();
  const workdir = await mkdtemp(join(tmpdir(), 'graphyard-key-mount-'));
  try {
    const context: AdapterContext = {
      provider: 'compose', repository: 'owner/project', installId: 'key-mount', service: 'graphyard-key-mount',
      domain: null, image: 'alpine:3', workdir, sourceRoot: workdir, sshHost: null, sshUser: 'root',
      sshKey: null, workspace: null, serverType: '', location: '', databasePassword: 'database-password-for-the-key-mount-test',
      port: 4310, dataPath: null, wait: async () => {}, transport: docker, ssh: () => docker, fetch, vault: new Vault(),
    };
    await composeAdapter.setEnv(context, [{ name: 'GITHUB_PRIVATE_KEY', value: appKey, secret: true }]);
    // `--user 1000:1000` mirrors the image's USER node. Whatever the local writer's uid is,
    // the transports hand the key to 1000:1000; a root-owned 0600 file fails exactly here.
    const read = await docker.exec('docker', ['compose', '--project-directory', workdir, '-f', join(workdir, 'compose.yaml'), 'run', '--rm', '--no-deps', '--user', '1000:1000', 'server', 'sh', '-c', 'ls -ln /run/graphyard/github-private-key.pem && cat /run/graphyard/github-private-key.pem'], { timeout: 600_000 });
    assert.equal(read.code, 0, `the container user could not read the key: ${read.stderr.trim().slice(-400)}`);
    const listing = read.stdout.trim().split('\n')[0];
    assert.match(listing, /^-\S+\s+1\s+1000\s+1000\s/, `the mounted key was not owned by the container user: ${listing}`);
    assert.ok(read.stdout.includes(appKey), 'the container read something other than the key');
  } finally { await rm(workdir, { recursive: true, force: true }); }
});

test('the agent review policy sets zero native approvals without relaxing any other protection', async () => {
  const fixture = await harness({ provider: 'compose' });
  try {
    const session = await prepareInstall(fixture.root, { repository: 'owner/project', provider: 'compose', reviewPolicy: 'agent', reviewer: 'claude' }, fixture.deps);
    const summary = await applyInstall(session, await buildPlan(session));
    const payload = JSON.parse(fixture.transport.commands.find(command => command.args.includes('PUT'))!.input!);
    assert.equal(payload.required_pull_request_reviews.required_approving_review_count, 0);
    assert.equal(payload.enforce_admins, true);
    assert.equal(payload.required_status_checks.strict, false);
    assert.deepEqual(summary.reviewers, [{ name: 'claude', appId: GRAPHYARD_APP_ID + 1, botUserId: 900_001 }]);
    const environment = bundle(fixture, 'server.env')!;
    assert.match(environment.content, /GRAPHYARD_REVIEWER_APPS=\[\{"id":"claude"/);
  } finally { await fixture.cleanup(); }
});

test('apply refuses to change anything when preflight is incomplete', async () => {
  const fixture = await harness({ provider: 'railway' });
  try {
    const broken = { ...fixture.deps, transport: { ...fixture.transport, exec: async (program: string, args: string[], options: any = {}) => {
      if (program === 'railway' && args[0] === 'whoami') { if (!options.allowFailure) throw new Error('railway exited with 1'); return { stdout: '', stderr: 'Unauthorized', code: 1 }; }
      return fixture.transport.exec(program, args, options);
    } } };
    const session = await prepareInstall(fixture.root, inputsFor('railway'), broken as any);
    const plan = await buildPlan(session);
    await assert.rejects(applyInstall(session, plan), /Preflight is incomplete[\s\S]*railway login/);
    assert.ok(!fixture.commandLines().some(line => line.includes('railway init')));

    // "Changed nothing" is literal: a refused apply mints no credential and no database
    // password, so an operator who stops here has nothing on disk to clean up or rotate.
    await assert.rejects(stat(session.directory), { code: 'ENOENT' }, 'a refused apply created the installation directory');
    assert.equal(session.materialized, false);
    assert.equal(session.tokens.size, 0);
    assert.equal(session.vault.size, 0, 'a refused apply generated a secret');
  } finally { await fixture.cleanup(); }
});

test('the Hetzner server keeps Postgres on its attached volume and waits for cloud-init', async () => {
  const fixture = await harness({ provider: 'hetzner' });
  try {
    const { session } = await apply(fixture, 'hetzner');
    const lines = fixture.commandLines();
    assert.ok(lines.some(line => line.includes('hcloud volume create --name graphyard-owner-project-data')));
    assert.ok(lines.some(line => line.includes('hcloud volume attach graphyard-owner-project-data')));

    const create = fixture.transport.commands.find(command => command.program === 'hcloud' && command.args[0] === 'server' && command.args[1] === 'create')!;
    assert.ok(create.input, 'cloud-init was not supplied over stdin');
    assert.ok(create.args.includes('--ssh-key') && create.args.includes('graphyard-key'), 'the server was created without an SSH key');
    assert.match(create.input!, /docker-compose-plugin/);
    assert.match(create.input!, /scsi-0HC_Volume_/);
    assert.match(create.input!, /\/mnt\/graphyard ext4/);
    assert.ok(!create.input!.includes(session.context.databasePassword), 'cloud-init must not carry a credential');

    // The bundle is only written after the remote Docker daemon answers.
    const remote = [...fixture.remotes.values()][0];
    const dockerReady = remote.commands.findIndex(command => command.program === 'docker' && command.args[0] === 'version');
    assert.ok(dockerReady >= 0, 'provisioning did not wait for Docker');
    assert.ok([...remote.files.keys()].some(path => path.endsWith('/compose.yaml')));
  } finally { await fixture.cleanup(); }
});

test('a server whose Docker never appears fails the install with the server named', async () => {
  const fixture = await harness({ provider: 'hetzner' });
  try {
    const unreachable = fakeTransport({ responses: [{ match: 'docker version', result: { stdout: '', stderr: 'connection refused', code: 1 } }] });
    const session = await prepareInstall(fixture.root, inputsFor('hetzner'), { ...fixture.deps, ssh: () => unreachable as Transport });
    await assert.rejects(applyInstall(session, await buildPlan(session)), /Docker did not become available on graphyard-owner-project/);
  } finally { await fixture.cleanup(); }
});

test('Railway project creation names the resolved workspace, and a provider failure carries the CLI diagnostic', async () => {
  const fixture = await harness({ provider: 'railway', workspaces: RAILWAY_WORKSPACES });
  try {
    const session = await prepareInstall(fixture.root, { ...inputsFor('railway'), workspace: "Installer's Projects" }, fixture.deps);
    await applyInstall(session, await buildPlan(session));
    const init = fixture.transport.commands.find(command => command.program === 'railway' && command.args[0] === 'init')!;
    assert.deepEqual(init.args, ['init', '--name', 'graphyard-owner-project', '--workspace', 'ws-personal-0002']);
  } finally { await fixture.cleanup(); }

  // The bare exit code sent the live proof to the provider's documentation; the diagnostic
  // behind it is what the runbook's failure table acts on.
  const refused = await harness({ provider: 'railway' });
  try {
    const transport = { ...refused.transport, exec: async (program: string, args: string[], options: any = {}) =>
      program === 'railway' && args[0] === 'init'
        ? fakeTransport({ responses: [{ match: 'railway init', result: { stdout: '', stderr: '--workspace required in non-interactive mode (multiple workspaces available)\n', code: 1 } }] }).exec(program, args, options)
        : refused.transport.exec(program, args, options) };
    const session = await prepareInstall(refused.root, inputsFor('railway'), { ...refused.deps, transport: transport as Transport });
    await assert.rejects(applyInstall(session, await buildPlan(session)), { message: 'railway exited with 1: --workspace required in non-interactive mode (multiple workspaces available)' });
  } finally { await refused.cleanup(); }
});

test('a failed provider command surfaces its stderr, scrubbed of every generated secret', async () => {
  const fixture = await harness({ provider: 'railway' });
  try {
    // Apply has minted the credentials by the time a variable is set; the provider quotes one
    // back in its diagnostic. The fake transport builds the failure exactly as execFile does.
    let session: Awaited<ReturnType<typeof prepareInstall>>;
    const wired = { ...fixture.transport, exec: async (program: string, args: string[], options: any = {}) => {
      if (program === 'railway' && args[0] === 'variable') {
        const token = session.tokens.get(`${session.installId}-operator`)!;
        return fakeTransport({ responses: [{ match: 'railway variable set', result: { stdout: '', stderr: `error: invalid value for ${args.at(-1)}: ${token} ${session.context.databasePassword}\n`, code: 2 } }] }).exec(program, args, options);
      }
      return fixture.transport.exec(program, args, options);
    } };
    session = await prepareInstall(fixture.root, inputsFor('railway'), { ...fixture.deps, transport: wired as Transport });
    await assert.rejects(applyInstall(session, await buildPlan(session)), (error: Error) => {
      assert.match(error.message, /^railway exited with 2: error: invalid value for GRAPHYARD_PRINCIPALS: \[redacted\] \[redacted\]$/);
      assert.ok(!session.vault.exposes(error.message), 'a provider diagnostic leaked a generated credential');
      return true;
    });
  } finally { await fixture.cleanup(); }
});

test('a failing local command reports its exit code and the tail of its stderr', async () => {
  const transport = localTransport();
  await assert.rejects(transport.exec('sh', ['-c', 'echo noise; echo "--workspace required in non-interactive mode" >&2; exit 3']), { message: 'sh exited with 3: --workspace required in non-interactive mode' });
  const tolerated = await transport.exec('sh', ['-c', 'echo failed >&2; exit 4'], { allowFailure: true });
  assert.deepEqual({ code: tolerated.code, stderr: tolerated.stderr.trim() }, { code: 4, stderr: 'failed' });
});
