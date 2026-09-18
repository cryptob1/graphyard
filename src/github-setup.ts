import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { GitHub } from './github.js';
import { localDirectory } from './onboarding.js';

interface AppCredentials { appId: number; slug: string; privateKey: string; webhookSecret: string; repository: string; installationId?: number; reviewer?: string; botUserId?: number }
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
    // No checks or administration: a reviewer can never publish Graphyard's merge check.
    default_permissions: { metadata: 'read', contents: 'read', pull_requests: 'write', issues: 'read' },
    default_events: ['pull_request', 'issue_comment'] };
}
export function appManifest(repository: string, deployment: string, callback: string) {
  const origin = manifestOrigin(repository, deployment);
  const url = new URL(origin);
  return { name: `Graphyard ${repository.replace('/', '-')}`, url: url.origin, public: false,
    hook_attributes: { url: `${url.origin}/api/github/webhook`, active: true },
    redirect_url: `${callback}/created`, setup_url: `${callback}/installed`,
    default_permissions: { metadata: 'read', contents: 'read', pull_requests: 'write', issues: 'read', checks: 'write', administration: 'read' },
    default_events: ['pull_request', 'pull_request_review', 'issue_comment', 'check_run', 'check_suite', 'push'] };
}
export async function startGithubSetup(root: string, repository: string, deployment: string, port = 4311, dependencies: {
  convert?: (code: string) => Promise<any>;
  verify?: (app: AppCredentials, installationId: number) => Promise<void>;
  resolveBot?: (slug: string) => Promise<{ id: number; type: string }>;
} = {}, reviewer?: string) {
  if (reviewer !== undefined && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(reviewer)) throw new Error('Reviewer name must be a lowercase identifier');
  const directory = await localDirectory(root);
  const file = resolve(directory, reviewer ? `github-reviewer-${reviewer}.json` : 'github-app.json');
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
          : `<p>Register a private App for <strong>${escape(repository)}</strong>. GitHub will ask you to sign in, name the App, and choose the repository.</p><p>The App reads code and branch protection, publishes its gate check, and writes PR review requests. It cannot write source code. Credentials return directly to this machine; no key copying is needed.</p><form method="post" action="https://github.com/settings/apps/new?state=${state}"><input type="hidden" name="manifest" value="${escape(JSON.stringify(manifest))}"><button>Register Graphyard App →</button></form>`);
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
