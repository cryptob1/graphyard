import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { GitHub, appJwt, installationSettingsUrl } from './github.js';
import { localDirectory } from './onboarding.js';
import { controlPlaneEvents, controlPlanePermissions, describePermission, permissionShortfalls, requiredPermissions, reviewerEvents, reviewerPermissions, type PermissionLevel, type PermissionShortfall } from './github-permissions.js';

interface AppCredentials { appId: number; slug: string; privateKey: string; webhookSecret: string; repository: string; installationId?: number; reviewer?: string; botUserId?: number }
const credentialFile = (root: string, reviewer?: string) => resolve(root, '.graphyard', reviewer ? `github-reviewer-${reviewer}.json` : 'github-app.json');
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
function manifestOrigin(repository: string, deployment: string) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Expected owner/repository');
  const url = new URL(deployment);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Use the deployed HTTPS origin, without credentials or a path');
  return url.origin;
}
/**
 * A reviewer App is a separate identity with no control-plane authority: it reads code and
 * writes pull request comments, and never publishes Graphyard's own gate check.
 */
export function reviewerAppManifest(reviewer: string, repository: string, deployment: string, callback: string) {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(reviewer)) throw new Error('Reviewer name must be a lowercase identifier');
  const origin = manifestOrigin(repository, deployment);
  const name = `${repository.replace('/', '-')} review ${reviewer}`;
  if (name.length > 34) throw new Error(`GitHub App names are limited to 34 characters; "${name}" is too long, so choose a shorter reviewer name`);
  return { name, url: origin, public: false,
    redirect_url: `${callback}/created`, setup_url: `${callback}/installed`,
    // The reviewer declaration carries no checks, administration, or contents: write: a
    // reviewer can never publish Graphyard's merge check or write code.
    default_permissions: requiredPermissions(reviewerPermissions),
    default_events: [...reviewerEvents] };
}
export function appManifest(repository: string, deployment: string, callback: string) {
  const origin = manifestOrigin(repository, deployment);
  const url = new URL(origin);
  return { name: `Graphyard ${repository.replace('/', '-')}`, url: url.origin, public: false,
    hook_attributes: { url: `${url.origin}/api/github/webhook`, active: true },
    redirect_url: `${callback}/created`, setup_url: `${callback}/installed`,
    // Exactly the declared control-plane set; the merge queue's Contents: write lives there.
    default_permissions: requiredPermissions(controlPlanePermissions),
    default_events: [...controlPlaneEvents] };
}
export interface AppPermissionInspection {
  role: 'control-plane' | 'reviewer'; reviewer: string | null; appId: number; slug: string; installationId: number | null;
  required: Record<string, PermissionLevel>; registered: Record<string, string>; granted: Record<string, string> | null;
  /** The App's own configuration lacks these; GitHub only changes that in the browser. */
  appShortfalls: PermissionShortfall[];
  /** The App requests these, but the installation has not accepted the pending request. */
  installationShortfalls: PermissionShortfall[];
  /** Permissions beyond the declaration. For a reviewer this is a boundary violation. */
  excess: { permission: string; granted: string; declared: PermissionLevel | null }[];
  settingsUrl: string; installationUrl: string; steps: string[]; verified: boolean;
}
const levelRank = (level: unknown) => ['read', 'write', 'admin'].indexOf(String(level));
/**
 * Compares a registered App with the declaration for its role. GitHub exposes no API for
 * changing a registered App's permissions, so the App-level change is a browser step and the
 * installation-level acceptance another; both are named exactly, and acceptance is verified
 * by reading the installation back rather than assumed from the click.
 */
export async function inspectAppPermissions(root: string, options: { reviewer?: string; fetcher?: typeof fetch } = {}): Promise<AppPermissionInspection> {
  const reviewer = options.reviewer;
  if (reviewer !== undefined && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(reviewer)) throw new Error('Reviewer name must be a lowercase identifier');
  let app: AppCredentials;
  try { app = JSON.parse(await readFile(credentialFile(root, reviewer), 'utf8')); }
  catch (error: any) { if (error.code === 'ENOENT') throw new Error(`No saved ${reviewer ? `reviewer App "${reviewer}"` : 'Graphyard App'}; register it first with graphyard github-setup HTTPS_URL${reviewer ? ` --reviewer ${reviewer}` : ''}`); throw error; }
  if (!Number.isSafeInteger(app.appId) || typeof app.privateKey !== 'string' || !app.privateKey) throw new Error('Saved App credentials are incomplete; rerun github-setup');
  if ((app.reviewer ?? undefined) !== reviewer) throw new Error('Saved App belongs to a different Graphyard role');
  const set = reviewer ? reviewerPermissions : controlPlanePermissions;
  const required = requiredPermissions(set);
  const fetcher = options.fetcher ?? fetch;
  const read = async (path: string) => {
    const response = await fetcher(`https://api.github.com${path}`, { headers: { Authorization: `Bearer ${appJwt(app.appId, app.privateKey)}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`GitHub GET ${path} failed (${response.status}); ${response.status === 401 ? 'the saved App key was rejected' : response.status === 404 ? 'the App or installation no longer exists' : 'retry later'}`);
    return response.json();
  };
  const registration: any = await read('/app');
  if (!Number.isSafeInteger(registration?.id) || registration.id !== app.appId) throw new Error('GitHub returned a different App for the saved key');
  const registered: Record<string, string> = registration.permissions && typeof registration.permissions === 'object' ? Object.fromEntries(Object.entries(registration.permissions).filter(([, level]) => typeof level === 'string')) as Record<string, string> : {};
  const slug = typeof registration.slug === 'string' && registration.slug ? registration.slug : app.slug;
  const owner = registration.owner;
  const settingsUrl = owner?.type === 'Organization' && typeof owner.login === 'string' ? `https://github.com/organizations/${encodeURIComponent(owner.login)}/settings/apps/${encodeURIComponent(slug)}/permissions` : `https://github.com/settings/apps/${encodeURIComponent(slug)}/permissions`;
  const installationId = Number.isSafeInteger(app.installationId) && app.installationId! > 0 ? app.installationId! : null;
  let granted: Record<string, string> | null = null;
  let installationUrl = installationId ? installationSettingsUrl(installationId) : `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`;
  if (installationId) {
    const installation: any = await read(`/app/installations/${installationId}`);
    granted = installation?.permissions && typeof installation.permissions === 'object' ? Object.fromEntries(Object.entries(installation.permissions).filter(([, level]) => typeof level === 'string')) as Record<string, string> : {};
    if (typeof installation?.html_url === 'string' && /^https:\/\/github\.com\//.test(installation.html_url)) installationUrl = installation.html_url;
  }
  const appShortfalls = permissionShortfalls(registered, set);
  const installationShortfalls = installationId ? permissionShortfalls(granted, set) : [];
  const excess = Object.entries(granted ?? registered).filter(([permission, level]) => levelRank(level) > levelRank(required[permission] ?? null))
    .map(([permission, level]) => ({ permission, granted: level, declared: required[permission] ?? null })).sort((a, b) => a.permission < b.permission ? -1 : 1);
  const list = (shortfalls: PermissionShortfall[]) => shortfalls.map(shortfall => describePermission(shortfall.permission, shortfall.required)).join(', ');
  const steps: string[] = [];
  if (appShortfalls.length) steps.push(`Open ${settingsUrl}, set ${list(appShortfalls)} under Repository permissions, and save. GitHub has no API for changing a registered App's permissions, so this is a browser step.`);
  if (!installationId) steps.push(`Install the App on ${app.repository} at ${installationUrl}, then rerun github-setup so the installation is recorded.`);
  else if (appShortfalls.length || installationShortfalls.length) steps.push(`Open ${installationUrl} and accept the pending permission request for ${list(installationShortfalls.length ? installationShortfalls : appShortfalls)}. GitHub only applies an App permission change to an installation after its owner accepts it there.`);
  if (excess.length && reviewer) steps.push(`Reduce ${excess.map(entry => `${describePermission(entry.permission, entry.granted as PermissionLevel)}`).join(', ')} at ${settingsUrl}: a reviewer App must never hold more than its declaration, and never Contents: write.`);
  if (steps.length) steps.push('Rerun graphyard github-setup --update-permissions (add --wait SECONDS to poll) to verify acceptance; the server preflight releases held jobs on its own once the installation reports the permission.');
  const verified = !!installationId && !appShortfalls.length && !installationShortfalls.length && !(reviewer && excess.length);
  return { role: reviewer ? 'reviewer' : 'control-plane', reviewer: reviewer ?? null, appId: app.appId, slug, installationId, required, registered, granted, appShortfalls, installationShortfalls, excess, settingsUrl, installationUrl, steps, verified };
}
/**
 * The migration command behind `github-setup --update-permissions`: inspect, print the exact
 * steps, and optionally wait for the installation to report the accepted permissions.
 */
export async function updateAppPermissions(root: string, options: { reviewer?: string; fetcher?: typeof fetch; waitMs?: number; pollMs?: number; announce?: (message: string) => void; wait?: (ms: number) => Promise<void> } = {}) {
  const announce = options.announce ?? (message => console.error(message));
  const wait = options.wait ?? ((ms: number) => new Promise<void>(accept => setTimeout(accept, ms)));
  const deadline = Date.now() + (options.waitMs ?? 0);
  let announced = '';
  for (;;) {
    const inspection = await inspectAppPermissions(root, options);
    if (inspection.verified) return { ...inspection, waited: false };
    const message = inspection.steps.map((step, index) => `${index + 1}. ${step}`).join('\n');
    if (message !== announced) { announce(message); announced = message; }
    if (Date.now() >= deadline) return { ...inspection, waited: (options.waitMs ?? 0) > 0 };
    await wait(options.pollMs ?? 5_000);
  }
}
export async function startGithubSetup(root: string, repository: string, deployment: string, port = 4311, dependencies: {
  convert?: (code: string) => Promise<any>;
  verify?: (app: AppCredentials, installationId: number) => Promise<void>;
  resolveBot?: (slug: string) => Promise<{ id: number; type: string }>;
} = {}, reviewer?: string) {
  if (reviewer !== undefined && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(reviewer)) throw new Error('Reviewer name must be a lowercase identifier');
  await localDirectory(root);
  const file = credentialFile(root, reviewer);
  let app: AppCredentials | undefined;
  try { app = JSON.parse(await readFile(file, 'utf8')); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  if (app && app.repository !== repository) throw new Error('Saved App belongs to a different repository');
  if (app && (app.reviewer ?? undefined) !== reviewer) throw new Error('Saved App belongs to a different Graphyard role');
  const state = randomBytes(32).toString('hex');
  let exchanging = false;
  const convert = dependencies.convert ?? (async (code: string) => {
    const response = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, { method: 'POST', headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`GitHub App conversion failed (${response.status}); restart setup if the code expired`);
    return response.json();
  });
  // The bot user ID is the identity Graphyard matches on; display names are never authority.
  const resolveBot = dependencies.resolveBot ?? (async (slug: string) => {
    const response = await fetch(`https://api.github.com/users/${encodeURIComponent(`${slug}[bot]`)}`, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`GitHub could not resolve the reviewer bot identity (${response.status})`);
    return response.json();
  });
  const verify = dependencies.verify ?? (async (credential: AppCredentials, installationId: number) => {
    const github = new GitHub({ repository, base: 'main', appId: credential.appId, installationId, privateKey: credential.privateKey });
    const repo = await github.request('');
    if (repo.full_name?.toLowerCase() !== repository.toLowerCase()) throw new Error('Installation cannot access the expected repository');
  });
  async function persist(value: AppCredentials, initial = false) {
    if (initial) await writeFile(file, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
    else {
      const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
      await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
      await rename(temporary, file);
    }
  }
  const http = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'self'; form-action https://github.com; frame-ancestors 'none'; base-uri 'none'");
    const html = (code: number, text: string) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Graphyard setup</title><link rel="stylesheet" href="/style.css"></head><body><main><div class="brand">g / graphyard</div><small>REPOSITORY SETUP</small><h1>Connect your work<br>to its proof.</h1><h2>Connect Graphyard to GitHub</h2>${text}<footer>Graphyard coordinates the work. Your agents write the code.</footer></main></body></html>`); };
    try {
      const address = `127.0.0.1:${(http.address() as any).port}`;
      if (req.headers.host !== address || req.method !== 'GET') return html(400, '<p>Use the exact local setup URL.</p>');
      const url = new URL(req.url!, `http://${address}`);
      if (url.pathname === '/style.css') {
        res.writeHead(200, { 'Content-Type': 'text/css' });
        return res.end('html{color-scheme:dark;background:#101714;color:#e4eee7;font:17px/1.65 system-ui,sans-serif}body{margin:0}main{max-width:660px;margin:8vh auto;padding:32px}.brand{font-size:25px;font-weight:700;margin-bottom:64px;color:#a9d8bb}small{letter-spacing:.15em;color:#9eaea3}h1{font-size:clamp(38px,7vw,58px);line-height:1.08;letter-spacing:-.045em;font-weight:550;margin:20px 0 42px}h2{font-size:22px}p{color:#b5c6ba}a{color:#acd9bc}button{background:#b9e7c8;color:#132319;border:0;border-radius:8px;padding:14px 24px;font:600 16px system-ui;cursor:pointer;margin:18px 0}button:focus-visible,a:focus-visible{outline:3px solid #fff;outline-offset:4px}footer{border-top:1px solid #304337;padding-top:24px;margin-top:56px;color:#91a198;font-size:13px}');
      }
      if (url.pathname === '/') {
        if (app?.installationId) return html(200, reviewer
          ? `<p>Reviewer App registered and installation verified. Add this entry to the server's <code>GRAPHYARD_REVIEWER_APPS</code> registry, then name <code>${escape(reviewer)}</code> from a reviewer profile:</p><pre>${escape(JSON.stringify({ id: reviewer, runtime: reviewer, appId: app.appId, botUserId: app.botUserId }, null, 2))}</pre><p>Set <code>runtime</code> to the agent runtime that will post the verdicts. The private key stays in this machine's credential file and is never needed by Graphyard.</p>`
          : '<p>App registered and installation verified. Credentials are saved locally with restricted file permissions. You may close setup and configure Railway.</p>');
        if (app) return html(200, `<p>App registered. Install it only on ${escape(repository)}.</p><a href="https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new">Install GitHub App</a>`);
        const manifest = reviewer ? reviewerAppManifest(reviewer, repository, deployment, `http://${address}`) : appManifest(repository, deployment, `http://${address}`);
        return html(200, reviewer
          ? `<p>Register a private reviewer App named <strong>${escape(reviewer)}</strong> for <strong>${escape(repository)}</strong>. Its runtime signs in as this App to post review verdicts.</p><p>The reviewer App reads code and writes pull request comments. It cannot publish Graphyard's gate check, change branch protection, or write source code. Use a GitHub account that is not the pull request author.</p><form method="post" action="https://github.com/settings/apps/new?state=${state}"><input type="hidden" name="manifest" value="${escape(JSON.stringify(manifest))}"><button>Register reviewer App →</button></form>`
          : `<p>Register a private App for <strong>${escape(repository)}</strong>. GitHub will ask you to sign in, name the App, and choose the repository.</p><p>The App reads code and branch protection, publishes its gate check, writes PR review requests, and publishes merge-queue tips, which is why it holds Contents: read and write. It never writes an agent's code: the only commits it creates are merges of already-validated candidates onto the base they were validated against. Credentials return directly to this machine; no key copying is needed.</p><form method="post" action="https://github.com/settings/apps/new?state=${state}"><input type="hidden" name="manifest" value="${escape(JSON.stringify(manifest))}"><button>Register Graphyard App →</button></form>`);
      }
      if (url.pathname === '/created') {
        const received = Buffer.from(url.searchParams.get('state') ?? ''), expected = Buffer.from(state);
        if (received.length !== expected.length || !timingSafeEqual(received, expected) || exchanging || app) return html(409, '<p>Invalid or already used setup session.</p>');
        const code = url.searchParams.get('code');
        if (!code || !/^[a-zA-Z0-9_-]{1,200}$/.test(code)) return html(400, '<p>Missing GitHub registration code.</p>');
        exchanging = true;
        const result = await convert(code);
        if (!Number.isSafeInteger(result.id) || !result.slug || !result.pem || !(reviewer || result.webhook_secret)) throw new Error('GitHub returned incomplete App credentials');
        const next: AppCredentials = { appId: result.id, slug: result.slug, privateKey: result.pem, webhookSecret: result.webhook_secret ?? '', repository };
        if (reviewer) {
          const bot = await resolveBot(result.slug);
          if (!Number.isSafeInteger(bot?.id) || bot.id <= 0 || bot.type !== 'Bot') throw new Error('GitHub did not return a usable reviewer bot identity');
          next.reviewer = reviewer; next.botUserId = bot.id;
        }
        await persist(next, true); app = next;
        res.writeHead(303, { Location: '/' }); return res.end();
      }
      if (url.pathname === '/installed') {
        const installationId = Number(url.searchParams.get('installation_id'));
        if (!app || !Number.isSafeInteger(installationId) || installationId <= 0) return html(400, '<p>Register the App and select the managed repository first.</p>');
        await verify(app, installationId);
        const next = { ...app, installationId }; await persist(next); app = next;
        res.writeHead(303, { Location: '/' }); return res.end();
      }
      html(404, '<p>Page not found.</p>');
    } catch { html(502, '<p>Setup could not complete. Credentials are never included in this page or its logs. Check the App installation and restart setup to resume from saved credentials.</p>'); }
  });
  // Validate before binding; port 0 is useful for isolated tests.
  if (reviewer) reviewerAppManifest(reviewer, repository, deployment, 'http://127.0.0.1'); else appManifest(repository, deployment, 'http://127.0.0.1');
  await new Promise<void>((accept, reject) => { http.once('error', reject); http.listen(port, '127.0.0.1', accept); });
  return { http, url: `http://127.0.0.1:${(http.address() as any).port}`, file };
}
