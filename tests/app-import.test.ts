import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { controlPlanePermissions, requiredPermissions, reviewerPermissions } from '../src/github-permissions.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1451: an App created elsewhere is brought into an install without GitHub sudo.
 *
 * unit:app-import — `app import --app-id ID --key-file PEM [--role ...]` proves the key by minting an
 * App JWT GitHub accepts, saves the App 0600 in the install directory where `--reuse-app` finds it,
 * refuses a control-plane App whose webhook serves another install, and never prints the key.
 *
 * unit:app-list — `app list` reads each App whose key is saved here as itself and the organization's
 * installations with gh, never /user/installations, and says which role each App is reusable for.
 */

// Loaded per test, so on a base without this change each case fails on its own assertion.
const githubSetup = () => import('../src/github-setup.js');
const appCli = () => import('../src/install/index.js');
const installer = () => import('../src/install/index.js');

const keyPair = () => generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const control = keyPair(), reviewer = keyPair(), stranger = keyPair();
const keyBody = (pem: string) => pem.split('\n')[1];

interface FakeApp { id: number; slug: string; publicKey: string; hook: string; registered: Record<string, string>; installations: { id: number; account: string; repositories: string[] | 'all'; granted: Record<string, string> }[] }
const fakeApp = (overrides: Partial<FakeApp> & Pick<FakeApp, 'id' | 'slug' | 'publicKey'>): FakeApp => ({ hook: '', registered: requiredPermissions(controlPlanePermissions), installations: [], ...overrides });

/** GitHub's App endpoints: a request is the App only when its JWT verifies against that App's public key. */
function fakeGitHub(apps: FakeApp[], options: { orgInstallations?: unknown[] | 'forbidden'; ownerType?: string } = {}) {
  const calls: string[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const signedBy = (authorization: string) => {
    const [header, payload, signature] = authorization.replace(/^Bearer /, '').split('.');
    if (!signature) return null;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const app = apps.find(entry => String(entry.id) === claims.iss);
    return app && createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(app.publicKey, signature, 'base64url') ? app : null;
  };
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)), headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push(`GET ${url.pathname}`);
    if (url.pathname.startsWith('/users/')) {
      const slug = decodeURIComponent(url.pathname.slice('/users/'.length)).replace(/\[bot\]$/, '');
      return apps.some(app => app.slug === slug) ? json({ id: 90_000 + apps.findIndex(app => app.slug === slug), login: `${slug}[bot]`, type: 'Bot' }) : json({ message: 'Not Found' }, 404);
    }
    const app = signedBy(String(headers.Authorization ?? ''));
    if (!app) return json({ message: 'A JSON web token could not be decoded' }, 401);
    if (url.pathname === '/app') return json({ id: app.id, slug: app.slug, owner: { login: 'acme', type: 'Organization' }, permissions: app.registered });
    if (url.pathname === '/app/hook/config') return json({ url: app.hook, content_type: 'json' });
    const installation = (entry: FakeApp['installations'][number]) => ({ id: entry.id, account: { login: entry.account }, permissions: entry.granted, repository_selection: entry.repositories === 'all' ? 'all' : 'selected', suspended_at: null });
    if (url.pathname === '/app/installations') return json(app.installations.map(installation));
    const onRepository = /^\/repos\/([^/]+\/[^/]+)\/installation$/.exec(url.pathname);
    if (onRepository) {
      const found = app.installations.find(entry => entry.repositories === 'all' ? entry.account === onRepository[1].split('/')[0] : entry.repositories.includes(onRepository[1]));
      return found ? json(installation(found)) : json({ message: 'Not Found' }, 404);
    }
    return json({ message: `no route ${url.pathname}` }, 404);
  }) as typeof fetch;
  const gh = async (args: string[]) => {
    calls.push(`gh ${args.join(' ')}`);
    if (args.some(arg => arg.includes('user/installations'))) throw new Error('gh: Resource not accessible by integration (HTTP 403)');
    if (args[0] === 'api' && args[1] === 'repos/acme/shop') return JSON.stringify({ id: 9002, full_name: 'acme/shop', owner: { login: 'acme', type: options.ownerType ?? 'Organization' } });
    if (args[0] === 'api' && args[1].startsWith('orgs/acme/installations')) {
      if (options.orgInstallations === 'forbidden') throw new Error('gh api orgs/acme/installations failed: HTTP 403');
      return JSON.stringify({ total_count: (options.orgInstallations ?? []).length, installations: options.orgInstallations ?? [] });
    }
    throw new Error(`gh has no route ${args.join(' ')}`);
  };
  return { calls, fetcher, gh };
}

async function workspace(label: string) {
  const home = await temporaryDirectory(label);
  await mkdir(join(home, 'keys'));
  await writeFile(join(home, 'keys', 'control.pem'), control.privateKey, { mode: 0o600 });
  await writeFile(join(home, 'keys', 'reviewer.pem'), reviewer.privateKey, { mode: 0o600 });
  await writeFile(join(home, 'keys', 'stranger.pem'), stranger.privateKey, { mode: 0o600 });
  await writeFile(join(home, 'keys', 'not-a-key.pem'), '-----BEGIN PRIVATE KEY-----\nnot-really-a-secret-but-must-not-print\n-----END PRIVATE KEY-----\n', { mode: 0o600 });
  await mkdir(join(home, 'root'));
  return { home, configHome: join(home, 'config'), root: join(home, 'root'), key: (name: string) => join(home, 'keys', `${name}.pem`) };
}
const controlApp = (extra: Partial<FakeApp> = {}) => fakeApp({ id: 7101, slug: 'graphyard-acme-shop', publicKey: control.publicKey, ...extra });
const reviewerApp = (extra: Partial<FakeApp> = {}) => fakeApp({ id: 7102, slug: 'acme-review-claude', publicKey: reviewer.publicKey, registered: requiredPermissions(reviewerPermissions), ...extra });

test('unit:app-import — the key is proven by an App JWT GitHub accepts, and the App is saved 0600 in the install directory where --reuse-app finds it', async () => {
  const { appCommand } = await appCli();
  const { savedRegistrations, reuseExistingApp } = await githubSetup();
  const { hostRegistrations, installDirectory, installIdFor } = await installer().then(async module => ({ ...module, ...(await import('../src/install/secrets.js')) }));
  const space = await workspace('app-import-store');
  try {
    const github = fakeGitHub([controlApp({ installations: [{ id: 8101, account: 'acme', repositories: 'all', granted: requiredPermissions(controlPlanePermissions) }] }), reviewerApp()]);
    const imported = await appCommand(['import', '--repo', 'acme/shop', '--app-id', '7101', '--key-file', space.key('control')], { root: space.root, configHome: space.configHome, fetcher: github.fetcher }) as any;
    const directory = installDirectory(installIdFor('acme/shop'), space.configHome);
    assert.equal(imported.file, join(directory, 'imported-app-graphyard-acme-shop.json'));
    assert.deepEqual([imported.appId, imported.slug, imported.role, imported.mode], [7101, 'graphyard-acme-shop', 'control-plane', '0600']);
    assert.equal((await stat(imported.file)).mode & 0o777, 0o600, 'the registration is readable by its owner only');
    const saved = JSON.parse(await readFile(imported.file, 'utf8'));
    assert.equal(saved.privateKey, control.privateKey); assert.equal(saved.role, 'control-plane'); assert.match(saved.webhookSecret, /^[a-f0-9]{64}$/, 'a fresh webhook secret install sets on the App');
    assert.ok(github.calls.includes('GET /app') && github.calls.includes('GET /app/hook/config'), 'validated as the App itself');
    // A reviewer and a revert approver are recorded under their roles; a reviewer carries its bot identity.
    const asReviewer = await appCommand(['import', '--repo', 'acme/shop', '--app-id', '7102', '--key-file', space.key('reviewer'), '--role', 'reviewer'], { root: space.root, configHome: space.configHome, fetcher: github.fetcher }) as any;
    assert.equal(asReviewer.botUserId, 90_001); assert.ok(!github.calls.includes('GET /app/hook/config') || github.calls.filter(call => call === 'GET /app/hook/config').length === 1, 'a reviewer\'s webhook is not judged');
    const registrations = await savedRegistrations([directory]);
    assert.deepEqual(registrations.map(entry => [entry.app.slug, entry.role]), [['acme-review-claude', 'reviewer'], ['graphyard-acme-shop', 'control-plane']]);
    // install and up --reuse-app scan every install directory on the host: the imported App is reusable.
    const onHost = await hostRegistrations(space.root, space.configHome);
    assert.ok(onHost.some(entry => entry.app.slug === 'graphyard-acme-shop' && entry.role === 'control-plane'));
    const gh = async (args: string[]) => { if (args[1] === 'repos/acme/shop') return JSON.stringify({ id: 9002, owner: { login: 'acme' } }); throw new Error(`no route ${args.join(' ')}`); };
    const reuse = await reuseExistingApp({ slug: 'graphyard-acme-shop', role: 'control-plane', repository: 'acme/shop', registrations: onHost, gh, fetcher: github.fetcher, apply: false });
    assert.equal(reuse.app.installationId, 8101); assert.equal(reuse.selection, 'all');
    const approver = await appCommand(['import', '--repo', 'acme/shop', '--app-id', '7102', '--key-file', space.key('reviewer'), '--role', 'revert-approver'], { root: space.root, configHome: space.configHome, fetcher: github.fetcher }) as any;
    assert.equal(approver.role, 'revert-approver');
    assert.equal(JSON.parse(await readFile(approver.file, 'utf8')).role, 'revert-approver');
  } finally { await rm(space.home, { recursive: true, force: true }); }
});

test('unit:app-import — a key GitHub rejects, a file that holds no key, or a wrong App id is refused and nothing is saved', async () => {
  const { appCommand } = await appCli();
  const space = await workspace('app-import-validate');
  try {
    const github = fakeGitHub([controlApp()]);
    const run = (id: string, key: string) => appCommand(['import', '--repo', 'acme/shop', '--app-id', id, '--key-file', space.key(key)], { root: space.root, configHome: space.configHome, fetcher: github.fetcher });
    await assert.rejects(run('7101', 'stranger'), /GitHub GET \/app failed for App 7101 \(401\); GitHub rejected a JWT signed with its key/);
    await assert.rejects(run('7999', 'control'), /\(401\)/, 'an id the key does not belong to');
    await assert.rejects(run('7101', 'not-a-key'), /not-a-key\.pem holds no usable RSA private key/);
    await assert.rejects(run('abc', 'control'), /--app-id takes the numeric App ID/);
    await assert.rejects(appCommand(['import', '--repo', 'acme/shop', '--app-id', '7101', '--key-file', join(space.home, 'missing.pem')], { root: space.root, configHome: space.configHome, fetcher: github.fetcher }), /Cannot read the key file .*missing\.pem \(ENOENT\)/);
    await assert.rejects(appCommand(['import', '--repo', 'acme/shop', '--app-id', '7101', '--key-file', space.key('control'), '--role', 'owner'], { root: space.root, configHome: space.configHome, fetcher: github.fetcher }), /--role takes control-plane, reviewer, revert-approver/);
    await assert.rejects(stat(space.configHome), /ENOENT/, 'nothing was written');
  } finally { await rm(space.home, { recursive: true, force: true }); }
});

test('unit:app-import — a control-plane App whose webhook serves another install is refused for that role, and may still be imported as a reviewer', async () => {
  const { appCommand } = await appCli();
  const space = await workspace('app-import-refusal');
  try {
    const github = fakeGitHub([controlApp({ hook: 'https://graphyard.acme.example/api/github/webhook', registered: requiredPermissions(reviewerPermissions) })]);
    const run = (role: string) => appCommand(['import', '--repo', 'acme/shop', '--app-id', '7101', '--key-file', space.key('control'), '--role', role], { root: space.root, configHome: space.configHome, fetcher: github.fetcher });
    await assert.rejects(run('control-plane'), /App graphyard-acme-shop is bound to another install's control plane: its webhook delivers to https:\/\/graphyard\.acme\.example\/api\/github\/webhook\..*import it with --role reviewer or revert-approver/);
    await assert.rejects(stat(space.configHome), /ENOENT/, 'the refused App was not saved');
    assert.equal((await run('reviewer') as any).role, 'reviewer', 'a reviewer has no webhook of its own to keep');
    // This install's own webhook is no other install's: the same App re-imported for it is accepted.
    const own = fakeGitHub([controlApp({ hook: 'http://127.0.0.1:4320/api/github/webhook' })]);
    const { importApp } = await githubSetup();
    const accepted = await importApp({ appId: 7101, keyFile: space.key('control'), role: 'control-plane', repository: 'acme/shop', directory: join(space.home, 'own'), webhookUrl: 'http://127.0.0.1:4320/api/github/webhook', fetcher: own.fetcher });
    assert.equal(accepted.role, 'control-plane');
  } finally { await rm(space.home, { recursive: true, force: true }); }
});

test('unit:app-import — the private key is never printed: not in the result, the CLI output, or a refusal', async () => {
  const { appCommand } = await appCli();
  const space = await workspace('app-import-redaction');
  try {
    const github = fakeGitHub([controlApp()]);
    const result = await appCommand(['import', '--repo', 'acme/shop', '--app-id', '7101', '--key-file', space.key('control')], { root: space.root, configHome: space.configHome, fetcher: github.fetcher });
    const printed = JSON.stringify(result);
    assert.doesNotMatch(printed, /PRIVATE KEY/); assert.ok(!printed.includes(keyBody(control.privateKey)), 'no line of the key');
    assert.ok(!printed.includes(JSON.parse(await readFile((result as any).file, 'utf8')).webhookSecret), 'nor the webhook secret');
    // The command prints exactly that result.
    const { installCommands } = await import('../src/cli/install.js');
    const appCommands = installCommands.filter(entry => entry.name === 'app');
    const lines: unknown[] = [];
    const original = global.fetch;
    global.fetch = github.fetcher;
    try {
      process.env.GRAPHYARD_CONFIG_HOME = space.configHome;
      await appCommands[0].run({ id: 'import', args: ['--repo', 'acme/shop', '--app-id', '7101', '--key-file', space.key('control')], print: (value: unknown) => lines.push(value), repositoryRoot: () => space.root } as any, undefined);
    } finally { global.fetch = original; delete process.env.GRAPHYARD_CONFIG_HOME; }
    assert.equal(lines.length, 1); assert.doesNotMatch(JSON.stringify(lines), /PRIVATE KEY|not-really-a-secret/); assert.ok(!JSON.stringify(lines).includes(keyBody(control.privateKey)));
    // Refusals name the file and the cause, never its contents.
    for (const key of ['not-a-key', 'stranger']) {
      const refusal = await appCommand(['import', '--repo', 'acme/shop', '--app-id', '7101', '--key-file', space.key(key)], { root: space.root, configHome: space.configHome, fetcher: github.fetcher }).then(() => null, (error: Error) => error.message);
      assert.ok(refusal); assert.doesNotMatch(refusal!, /PRIVATE KEY|not-really-a-secret/); assert.ok(!refusal!.includes(keyBody(stranger.privateKey)));
    }
  } finally { await rm(space.home, { recursive: true, force: true }); }
});

test('unit:app-list — saved Apps are read as themselves and the organization\'s installations with gh, never /user/installations, naming each App\'s reusable roles', async () => {
  const { appCommand } = await appCli();
  const space = await workspace('app-list');
  try {
    const granted = requiredPermissions(controlPlanePermissions), reviewing = requiredPermissions(reviewerPermissions);
    const github = fakeGitHub([
      controlApp({ installations: [{ id: 8101, account: 'acme', repositories: ['acme/shop'], granted }] }),
      reviewerApp({ installations: [{ id: 8102, account: 'acme', repositories: ['acme/api'], granted: reviewing }] }),
      fakeApp({ id: 7103, slug: 'graphyard-acme-prod', publicKey: stranger.publicKey, hook: 'https://graphyard.acme.example/api/github/webhook', installations: [{ id: 8103, account: 'acme', repositories: 'all', granted }] }),
    ], { orgInstallations: [
      { id: 8101, app_id: 7101, app_slug: 'graphyard-acme-shop', repository_selection: 'selected' },
      { id: 8104, app_id: 7104, app_slug: 'acme-deploy-bot', repository_selection: 'all' },
    ] });
    const options = { root: space.root, configHome: space.configHome, fetcher: github.fetcher, gh: github.gh };
    await appCommand(['import', '--repo', 'acme/shop', '--app-id', '7101', '--key-file', space.key('control')], options);
    await appCommand(['import', '--repo', 'acme/shop', '--app-id', '7102', '--key-file', space.key('reviewer'), '--role', 'reviewer'], options);
    // The production App: its key saved by an earlier install of another repository on this host.
    await mkdir(join(space.configHome, 'acme-prod'), { recursive: true });
    await writeFile(join(space.configHome, 'acme-prod', 'github-app.json'), JSON.stringify({ appId: 7103, slug: 'graphyard-acme-prod', privateKey: stranger.privateKey, webhookSecret: 'x', repository: 'acme/prod', installationId: 8103 }), { mode: 0o600 });
    github.calls.length = 0;
    const listing = await appCommand(['list', '--repo', 'acme/shop'], options) as any;
    assert.ok(!github.calls.some(call => call.includes('/user/installations')), 'never the endpoint gh\'s login is refused');
    assert.ok(github.calls.includes('GET /repos/acme/shop/installation'), 'each App asked whether it is installed on the repository');
    assert.ok(github.calls.includes('gh api orgs/acme/installations?per_page=100'));
    assert.deepEqual([listing.account, listing.accountType, listing.accountApps.listed], ['acme', 'Organization', true]);
    const bySlug = Object.fromEntries(listing.apps.map((app: any) => [app.slug, app]));
    assert.deepEqual(Object.keys(bySlug).sort(), ['acme-deploy-bot', 'acme-review-claude', 'graphyard-acme-prod', 'graphyard-acme-shop']);
    const shop = bySlug['graphyard-acme-shop'];
    assert.deepEqual([shop.installedOnRepository, shop.installationId, shop.ownedByAccount, shop.reusableFor], [true, 8101, true, ['control-plane']]);
    assert.equal(shop.summary, 'graphyard-acme-shop: reusable as the control-plane App with --reuse-app graphyard-acme-shop');
    assert.match(shop.roles.reviewer, /does not request|beyond the reviewer declaration/, 'a control-plane App holds more than a reviewer may');
    const review = bySlug['acme-review-claude'];
    assert.deepEqual([review.installedOnRepository, review.installedOnAccount, review.installationId, review.reusableFor], [false, true, 8102, ['reviewer']]);
    assert.equal(review.roles['revert-approver'], 'saved as the reviewer App; rerun graphyard app import --role revert-approver to reuse it so');
    assert.match(review.roles['control-plane'], /^does not request .*Contents: write/);
    const prod = bySlug['graphyard-acme-prod'];
    assert.deepEqual(prod.reusableFor, []);
    assert.equal(prod.roles['control-plane'], 'its webhook serves another install\'s control plane (https://graphyard.acme.example/api/github/webhook)');
    assert.match(prod.summary, /^graphyard-acme-prod: not reusable as its control-plane App: its webhook serves another install's control plane/);
    const keyless = bySlug['acme-deploy-bot'];
    assert.deepEqual([keyless.file, keyless.installedOnAccount, keyless.reusableFor], [null, true, []]);
    assert.match(keyless.summary, /acme-deploy-bot: installed on acme, not reusable until imported: no private key for it is saved on this host; generate one at https:\/\/github\.com\/organizations\/acme\/settings\/apps\/acme-deploy-bot and run graphyard app import --app-id 7104 --key-file PEM/);
    assert.doesNotMatch(JSON.stringify(listing), /PRIVATE KEY/);
  } finally { await rm(space.home, { recursive: true, force: true }); }
});

test('unit:app-list — a personal account, or an organization gh\'s login cannot list, says so plainly and still lists the saved Apps', async () => {
  const { appCommand } = await appCli();
  const space = await workspace('app-list-account');
  try {
    for (const [ownerType, orgInstallations, detail] of [['User', [], /GitHub offers gh's login no endpoint listing acme's Apps; find them at https:\/\/github\.com\/settings\/apps and import each/], ['Organization', 'forbidden', /gh could not list acme's App installations .*HTTP 403.*admin:read/]] as const) {
      const github = fakeGitHub([controlApp({ installations: [{ id: 8101, account: 'acme', repositories: ['acme/shop'], granted: requiredPermissions(controlPlanePermissions) }] })], { ownerType, orgInstallations: orgInstallations as any });
      const options = { root: space.root, configHome: space.configHome, fetcher: github.fetcher, gh: github.gh };
      await appCommand(['import', '--repo', 'acme/shop', '--app-id', '7101', '--key-file', space.key('control')], options);
      const listing = await appCommand(['list', '--repo', 'acme/shop'], options) as any;
      assert.equal(listing.accountApps.listed, false); assert.match(listing.accountApps.detail, detail);
      assert.deepEqual(listing.apps.map((app: any) => [app.slug, app.reusableFor]), [['graphyard-acme-shop', ['control-plane']]]);
      assert.ok(!github.calls.some(call => call.includes('/user/installations')));
    }
  } finally { await rm(space.home, { recursive: true, force: true }); }
});
