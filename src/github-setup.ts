import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, writeFile, rename, link, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { GitHub, appJwt, installationSettingsUrl } from './github.js';
import { localDirectory } from './onboarding.js';
import { controlPlaneEvents, controlPlanePermissions, describePermission, featureLabels, permissionShortfalls, requiredPermissions, reviewerEvents, reviewerPermissions, type PermissionLevel, type PermissionShortfall } from './github-permissions.js';

export interface AppCredentials { appId: number; slug: string; privateKey: string; webhookSecret: string; repository: string; installationId?: number; reviewer?: string; botUserId?: number }
const credentialFile = (root: string, reviewer?: string) => resolve(root, '.graphyard', reviewer ? `github-reviewer-${reviewer}.json` : 'github-app.json');
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
function manifestOrigin(repository: string, deployment: string) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Expected owner/repository');
  const url = new URL(deployment);
  // A local Compose install serves plain HTTP on loopback (GY-1352): GitHub never reaches it, so its
  // App is registered with the webhook off and the control plane polls instead.
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(url))) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Use the deployed HTTPS origin (or http:// on loopback for a local Compose install), without credentials or a path');
  return url.origin;
}
const loopback = (url: URL) => ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
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
    hook_attributes: { url: `${url.origin}/api/github/webhook`, active: !loopback(url) },
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
/** Permissions in LEVELS beyond the REQUIRED declaration; for a reviewer any is a boundary violation. */
const excessPermissions = (levels: Record<string, string>, required: Record<string, PermissionLevel>) => Object.entries(levels).filter(([permission, level]) => levelRank(level) > levelRank(required[permission] ?? null))
  .map(([permission, level]) => ({ permission, granted: level, declared: required[permission] ?? null })).sort((a, b) => a.permission < b.permission ? -1 : 1);
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
  const excess = excessPermissions(granted ?? registered, required);
  const list = (shortfalls: PermissionShortfall[]) => shortfalls.map(shortfall => describePermission(shortfall.permission, shortfall.required)).join(', ');
  // The acceptance step names what each missing grant blocks, so an Actions: write gap reads as
  // the failed CI reruns it stops before a rerun is ever attempted (GY-1328).
  const blocking = (shortfalls: PermissionShortfall[]) => shortfalls.map(shortfall => `${describePermission(shortfall.permission, shortfall.required)} (${shortfall.features.map(feature => featureLabels[feature]).join(', ')})`).join(', ');
  const steps: string[] = [];
  if (appShortfalls.length) steps.push(`Open ${settingsUrl}, set ${list(appShortfalls)} under Repository permissions, and save. GitHub has no API for changing a registered App's permissions, so this is a browser step.`);
  if (!installationId) steps.push(`Install the App on ${app.repository} at ${installationUrl}, then rerun github-setup so the installation is recorded.`);
  else if (appShortfalls.length || installationShortfalls.length) steps.push(`Open ${installationUrl} and accept the pending permission request for ${blocking(installationShortfalls.length ? installationShortfalls : appShortfalls)}. GitHub only applies an App permission change to an installation after its owner accepts it there.`);
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
// ---- Reusing an App already installed on the account (GY-1442) -------------------------------

/** The roles a reused App can serve; a revert approver (GY-1352) approves the main guard's exact-inverse reverts. */
export const appRoles = ['control-plane', 'reviewer', 'revert-approver'] as const;
export type AppRole = typeof appRoles[number];
/** An App registration saved on this host, with the private key an earlier install, github-setup or `app import` kept. */
export interface SavedRegistration { file: string; role: AppRole; app: AppCredentials & { role?: AppRole } }
const registrationName = /^(github-app|github-revert-approver|github-reviewer-[a-z0-9][a-z0-9._-]{0,63}|imported-app-[a-z0-9][a-z0-9-]{0,99})\.json$/;
/** The role a saved registration serves: the one `app import` recorded, else a reviewer by its name, else the control plane. */
const registrationRole = (app: { role?: unknown; reviewer?: unknown }): AppRole => appRoles.includes(app.role as AppRole) ? app.role as AppRole : app.reviewer ? 'reviewer' : 'control-plane';
/** The permission declaration ROLE is held to: a revert approver approves pull requests, exactly as a reviewer may. */
const rolePermissions = (role: AppRole) => role === 'control-plane' ? controlPlanePermissions : reviewerPermissions;
/**
 * Every App registration saved in DIRECTORIES (each install directory under the config home, and
 * the checkout's .graphyard), first one per App. Only an App whose private key is saved on this host
 * can be reused: GitHub never returns a key again, so a slug alone cannot sign as the App.
 */
export async function savedRegistrations(directories: readonly string[]): Promise<SavedRegistration[]> {
  const found: SavedRegistration[] = [];
  for (const directory of directories) {
    let names: string[];
    try { names = (await readdir(directory)).filter(name => registrationName.test(name)).sort(); } catch { continue; }
    for (const name of names) {
      const file = resolve(directory, name);
      let app: SavedRegistration['app'];
      try { app = JSON.parse(await readFile(file, 'utf8')); } catch { continue; }
      if (!Number.isSafeInteger(app?.appId) || typeof app.slug !== 'string' || !app.slug || typeof app.privateKey !== 'string' || !app.privateKey) continue;
      if (found.some(entry => entry.app.appId === app.appId)) continue;
      found.push({ file, role: registrationRole(app), app });
    }
  }
  return found;
}
export interface AppReuseRequest {
  slug: string; repository: string; role: AppRole; registrations: readonly SavedRegistration[];
  /** This install's own webhook URL once known: an App whose webhook delivers anywhere else belongs to another control plane. */
  webhookUrl?: string | null;
  /** `gh` with the host's login: resolves stdout, rejects on a non-zero exit. */
  gh: (args: string[]) => Promise<string>;
  fetcher?: typeof fetch;
  /** Without apply only reads; with it adds the repository to the App's installation and verifies the App reaches it. */
  apply: boolean;
}
export interface AppReuse { file: string; app: AppCredentials & { installationId: number }; account: string; selection: 'all' | 'selected'; added: boolean }
/**
 * `--reuse-app SLUG` (and the App page's "Reuse an App"): skip App creation and use an App already
 * installed on the repository's account. The App must request, and its installation grant, every
 * permission the role's declaration needs; a control-plane App whose webhook delivers to another
 * install's control plane is refused, naming it, since one App has one webhook. On apply the
 * repository is added to that installation with the host's gh login (GitHub's
 * `PUT /user/installations/{id}/repositories/{repository_id}`) and reached with the App's own token.
 */
export async function reuseExistingApp(request: AppReuseRequest): Promise<AppReuse> {
  const { slug, role } = request;
  const saved = request.registrations.find(entry => entry.app.slug.toLowerCase() === slug.toLowerCase());
  if (!saved) throw new Error(`No registration for App ${slug} is saved on this host, so it cannot sign as that App (GitHub returns an App's private key only once, to the machine that created it). Reuse an App an earlier install or github-setup saved here${request.registrations.length ? ` (${request.registrations.map(entry => entry.app.slug).join(', ')})` : ''}, or omit --reuse-app to register a new one.`);
  if (saved.role !== role) throw new Error(`App ${saved.app.slug} is registered as a ${saved.role} App and cannot serve as the ${role} App`);
  const app = saved.app, fetcher = request.fetcher ?? fetch;
  const call = async (path: string, init: { method?: string; token?: string } = {}) => {
    const response = await fetcher(`https://api.github.com${path}`, { method: init.method ?? 'GET', headers: { Authorization: `Bearer ${init.token ?? appJwt(app.appId, app.privateKey)}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`GitHub ${init.method ?? 'GET'} ${path} failed for App ${app.slug} (${response.status})${response.status === 401 ? '; its saved private key was rejected' : ''}`);
    return response.json() as Promise<any>;
  };
  const levels = (value: unknown) => value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, level]) => typeof level === 'string')) as Record<string, string> : {};
  const set = rolePermissions(role);
  const list = (shortfalls: PermissionShortfall[]) => shortfalls.map(shortfall => describePermission(shortfall.permission, shortfall.required)).join(', ');
  const registration = await call('/app');
  if (registration?.id !== app.appId) throw new Error(`GitHub returned a different App for the key saved in ${saved.file}`);
  const requested = permissionShortfalls(levels(registration.permissions), set);
  if (requested.length) throw new Error(`App ${app.slug} does not request ${list(requested)}, which the ${role} role needs; raise it at https://github.com/settings/apps/${encodeURIComponent(app.slug)}/permissions, or choose another App`);
  // A reviewer never holds more than its declaration (never Contents: write or Checks), the same rule
  // inspectAppPermissions applies: an App that does could write code or publish Graphyard's gate check.
  const beyond = (levels: Record<string, string>, where: string) => {
    const excess = role !== 'control-plane' ? excessPermissions(levels, requiredPermissions(reviewerPermissions)) : [];
    if (excess.length) throw new Error(`App ${app.slug}${where} holds ${excess.map(entry => describePermission(entry.permission, entry.granted as PermissionLevel)).join(', ')}, beyond the reviewer declaration; a reviewer App must never hold more than its declaration, so reduce it at https://github.com/settings/apps/${encodeURIComponent(app.slug)}/permissions, or choose another App`);
  };
  beyond(levels(registration.permissions), '');
  if (role === 'control-plane') {
    const hook = await call('/app/hook/config');
    const bound = typeof hook?.url === 'string' ? hook.url.trim() : '';
    if (bound && bound !== (request.webhookUrl ?? '')) throw new Error(`App ${app.slug} is bound to another install's control plane: its webhook delivers to ${bound}. One App has one webhook, so reusing it as this install's control-plane App would take that control plane's events; reuse another App, or omit --reuse-app to register a new one.`);
  }
  const repository = JSON.parse(await request.gh(['api', `repos/${request.repository}`]));
  const account = String(repository?.owner?.login ?? ''), repositoryId = Number(repository?.id);
  if (!account || !Number.isSafeInteger(repositoryId)) throw new Error(`gh could not read ${request.repository}`);
  const installations: any[] = await call('/app/installations?per_page=100');
  const installation = (Array.isArray(installations) ? installations : []).find(entry => String(entry?.account?.login ?? '').toLowerCase() === account.toLowerCase());
  if (!installation || !Number.isSafeInteger(installation.id)) throw new Error(`App ${app.slug} is not installed on ${account}; install it there at https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new, or omit --reuse-app`);
  if (installation.suspended_at) throw new Error(`App ${app.slug}'s installation on ${account} is suspended; restore it at ${installationSettingsUrl(installation.id)}`);
  const granted = permissionShortfalls(levels(installation.permissions), set);
  if (granted.length) throw new Error(`App ${app.slug}'s installation on ${account} does not grant ${list(granted)}; accept the pending permission request at ${installationSettingsUrl(installation.id)}, then rerun`);
  beyond(levels(installation.permissions), `'s installation on ${account}`);
  const selection = installation.repository_selection === 'all' ? 'all' : 'selected';
  let added = false;
  if (request.apply) {
    if (selection === 'selected') { await request.gh(['api', '--method', 'PUT', `/user/installations/${installation.id}/repositories/${repositoryId}`]); added = true; }
    const { token } = await call(`/app/installations/${installation.id}/access_tokens`, { method: 'POST' });
    const reached = await call(`/repos/${request.repository}`, { token });
    if (String(reached?.full_name ?? '').toLowerCase() !== request.repository.toLowerCase()) throw new Error(`App ${app.slug}'s installation cannot reach ${request.repository} after it was added`);
  }
  return { file: saved.file, app: { ...app, repository: request.repository, installationId: installation.id }, account, selection, added };
}

// ---- Importing an App's id and key, and listing the Apps reuse can choose from (GY-1451) ------

/** The JWT-authenticated GitHub call an App makes as itself: null on 404, a named error otherwise. */
function appCall(appId: number, privateKey: string, label: string, fetcher: typeof fetch) {
  return async (path: string, init: { auth?: boolean } = {}) => {
    const response = await fetcher(`https://api.github.com${path}`, { headers: { ...(init.auth === false ? {} : { Authorization: `Bearer ${appJwt(appId, privateKey)}` }), Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(20_000) });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub GET ${path} failed for ${label} (${response.status})${response.status === 401 ? '; GitHub rejected a JWT signed with its key: the key belongs to another App, was deleted, or the App id is wrong' : ''}`);
    return response.json() as Promise<any>;
  };
}
/** The webhook a control-plane App may keep: none, or this install's own. Anything else is another control plane's. */
const otherControlPlane = (hook: any, webhookUrl: string | null | undefined) => {
  const bound = typeof hook?.url === 'string' ? hook.url.trim() : '';
  return bound && bound !== (webhookUrl ?? '') ? bound : null;
};
export interface AppImportRequest {
  appId: number; keyFile: string; role: AppRole; repository: string;
  /** The install directory (`~/.config/graphyard/<install>`), where the registration is kept outside every checkout. */
  directory: string;
  /** This install's own webhook URL once it has one: a control-plane App whose webhook delivers anywhere else is refused. */
  webhookUrl?: string | null;
  fetcher?: typeof fetch; now?: () => number;
}
export interface AppImport { appId: number; slug: string; role: AppRole; repository: string; file: string; mode: '0600'; botUserId?: number; next: string }
/**
 * `graphyard app import`: bring an App created elsewhere (its id, and a private key generated on its
 * settings page) into this install, so `up --reuse-app` and `install --reuse-app` can reuse it with
 * no browser and no GitHub sudo. The key is proven by minting an App JWT GitHub accepts for that id;
 * a control-plane App whose webhook serves another install is refused. The registration is written
 * 0600 to the install directory as imported-app-SLUG.json, and the key is never printed.
 */
export async function importApp(request: AppImportRequest): Promise<AppImport> {
  const { appId, role, keyFile } = request, fetcher = request.fetcher ?? fetch;
  if (!Number.isSafeInteger(appId) || appId <= 0) throw new Error('--app-id takes the numeric App ID shown on the App\'s settings page');
  if (!appRoles.includes(role)) throw new Error(`--role takes ${appRoles.join(', ')}`);
  let privateKey: string;
  try { privateKey = await readFile(keyFile, 'utf8'); } catch (error: any) { throw new Error(`Cannot read the key file ${keyFile} (${error.code ?? 'unreadable'})`); }
  // The signing error is replaced, never passed on, so no part of the file reaches output.
  try { appJwt(appId, privateKey); } catch { throw new Error(`${keyFile} holds no usable RSA private key; generate one under Private keys on the App's settings page and pass the downloaded .pem`); }
  const call = appCall(appId, privateKey, `App ${appId}`, fetcher);
  const registration = await call('/app');
  if (!registration || registration.id !== appId) throw new Error(`GitHub returned no App ${appId} for the key in ${keyFile}`);
  const slug = String(registration.slug ?? '');
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/i.test(slug)) throw new Error(`GitHub returned an unusable slug for App ${appId}`);
  if (role === 'control-plane') {
    const bound = otherControlPlane(await call('/app/hook/config'), request.webhookUrl);
    if (bound) throw new Error(`App ${slug} is bound to another install's control plane: its webhook delivers to ${bound}. One App has one webhook, so it is refused as this install's control-plane App; import it with --role reviewer or revert-approver, or let install register a new control-plane App.`);
  }
  let botUserId: number | undefined;
  if (role === 'reviewer') {
    const bot = await call(`/users/${encodeURIComponent(`${slug}[bot]`)}`, { auth: false });
    if (!Number.isSafeInteger(bot?.id) || bot.id <= 0 || bot.type !== 'Bot') throw new Error(`GitHub did not return the bot identity of App ${slug}, which a reviewer App posts its verdicts as`);
    botUserId = bot.id;
  }
  await mkdir(request.directory, { recursive: true, mode: 0o700 });
  const file = resolve(request.directory, `imported-app-${slug.toLowerCase()}.json`);
  // A control-plane App gets a fresh webhook secret: install sets it on the App with the App's own JWT.
  const saved = { appId, slug, privateKey, webhookSecret: role === 'control-plane' ? randomBytes(32).toString('hex') : '', repository: request.repository, role,
    ...(botUserId ? { botUserId } : {}), importedAt: new Date(request.now?.() ?? Date.now()).toISOString() };
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temporary, JSON.stringify(saved, null, 2), { mode: 0o600, flag: 'wx' });
  await rename(temporary, file); await chmod(file, 0o600);
  return { appId, slug, role, repository: request.repository, file, mode: '0600', ...(botUserId ? { botUserId } : {}),
    next: `graphyard up --repo ${request.repository} --reuse-app ${slug} (or install --reuse-app ${slug}) reuses it with no browser step` };
}

export interface ListedApp {
  slug: string; appId: number;
  /** The saved registration holding its key, or null when no key for it is on this host. */
  file: string | null; savedRole: AppRole | null;
  owner: string | null; ownedByAccount: boolean | null;
  /** Installed on the repository (GET /repos/OWNER/NAME/installation as the App), or on its account. */
  installedOnRepository: boolean | null; installedOnAccount: boolean | null; installationId: number | null;
  /** Per role: null when the App can serve it, else why not. */
  roles: Record<AppRole, string | null>;
  reusableFor: AppRole[];
  summary: string;
}
export interface AppListing { repository: string; account: string; accountType: string; apps: ListedApp[]; accountApps: { listed: boolean; detail: string } }
export interface AppListRequest {
  repository: string; registrations: readonly SavedRegistration[];
  webhookUrl?: string | null;
  /** `gh` with the host's login: resolves stdout, rejects on a non-zero exit. */
  gh: (args: string[]) => Promise<string>;
  fetcher?: typeof fetch;
}
/**
 * `graphyard app list`: the Apps reuse can choose from, read without `/user/installations` (which
 * gh's OAuth token is refused). Each App whose key is saved on this host is read as itself (its App
 * JWT: GET /app, /repos/OWNER/NAME/installation, /app/installations, its webhook); an organization's
 * installations are read with gh where its login may. Each App says which roles it is reusable for,
 * or why not, and an App without a key here names the `app import` that makes it reusable.
 */
export async function listApps(request: AppListRequest): Promise<AppListing> {
  const fetcher = request.fetcher ?? fetch;
  const repository = JSON.parse(await request.gh(['api', `repos/${request.repository}`]));
  const account = String(repository?.owner?.login ?? ''), accountType = String(repository?.owner?.type ?? 'User');
  if (!account) throw new Error(`gh could not read ${request.repository}`);
  const levels = (value: unknown) => value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, level]) => typeof level === 'string')) as Record<string, string> : {};
  const apps: ListedApp[] = [];
  for (const saved of request.registrations) {
    const { app } = saved, call = appCall(app.appId, app.privateKey, `App ${app.slug}`, fetcher);
    const entry: ListedApp = { slug: app.slug, appId: app.appId, file: saved.file, savedRole: saved.role, owner: null, ownedByAccount: null, installedOnRepository: null, installedOnAccount: null, installationId: null,
      roles: Object.fromEntries(appRoles.map(role => [role, 'not read'])) as Record<AppRole, string | null>, reusableFor: [], summary: '' };
    try {
      const registration = await call('/app');
      if (registration?.id !== app.appId) throw new Error(`GitHub returned a different App for the key saved in ${saved.file}`);
      entry.owner = registration.owner?.login ?? null; entry.ownedByAccount = String(entry.owner ?? '').toLowerCase() === account.toLowerCase();
      const onRepository = await call(`/repos/${request.repository}/installation`);
      const installations: any[] = onRepository ? [onRepository] : await call('/app/installations?per_page=100') ?? [];
      const installation = installations.find(item => String(item?.account?.login ?? '').toLowerCase() === account.toLowerCase()) ?? null;
      entry.installedOnRepository = !!onRepository; entry.installedOnAccount = !!installation; entry.installationId = installation?.id ?? null;
      const hook = await call('/app/hook/config');
      for (const role of appRoles) {
        const set = requiredPermissions(rolePermissions(role));
        const missing = permissionShortfalls(levels(registration.permissions), rolePermissions(role)), excess = role === 'control-plane' ? [] : excessPermissions(levels(registration.permissions), set);
        const bound = role === 'control-plane' ? otherControlPlane(hook, request.webhookUrl) : null;
        entry.roles[role] = missing.length ? `does not request ${missing.map(shortfall => describePermission(shortfall.permission, shortfall.required)).join(', ')}`
          : excess.length ? `holds ${excess.map(item => describePermission(item.permission, item.granted as PermissionLevel)).join(', ')}, beyond the reviewer declaration`
          : bound ? `its webhook serves another install's control plane (${bound})`
          : !installation ? `not installed on ${account}; install it at https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new`
          : installation.suspended_at ? `its installation on ${account} is suspended`
          : permissionShortfalls(levels(installation.permissions), rolePermissions(role)).length ? `its installation on ${account} does not grant ${permissionShortfalls(levels(installation.permissions), rolePermissions(role)).map(shortfall => describePermission(shortfall.permission, shortfall.required)).join(', ')}`
          : role !== saved.role ? `saved as the ${saved.role} App; rerun graphyard app import --role ${role} to reuse it so`
          : null;
      }
    } catch (error) { for (const role of appRoles) entry.roles[role] = error instanceof Error ? error.message : String(error); }
    entry.reusableFor = appRoles.filter(role => entry.roles[role] === null);
    entry.summary = entry.reusableFor.length ? `${app.slug}: reusable as the ${entry.reusableFor.join(' and ')} App with --reuse-app ${app.slug}` : `${app.slug}: not reusable as its ${saved.role} App: ${entry.roles[saved.role]}`;
    apps.push(entry);
  }
  // The account's own listing: an organization's installations, where gh's login may read them; a
  // personal account has no endpoint gh's OAuth token may list its Apps with.
  let accountApps: AppListing['accountApps'];
  if (accountType !== 'Organization') accountApps = { listed: false, detail: `GitHub offers gh's login no endpoint listing ${account}'s Apps; find them at https://github.com/settings/apps and import each with graphyard app import --app-id ID --key-file PEM` };
  else {
    try {
      const listed = JSON.parse(await request.gh(['api', `orgs/${account}/installations?per_page=100`]));
      const installations: any[] = Array.isArray(listed?.installations) ? listed.installations : [];
      for (const installation of installations) {
        const appId = Number(installation?.app_id), slug = String(installation?.app_slug ?? '');
        if (!Number.isSafeInteger(appId) || !slug || apps.some(entry => entry.appId === appId)) continue;
        const why = `no private key for it is saved on this host; generate one at https://github.com/organizations/${account}/settings/apps/${encodeURIComponent(slug)} and run graphyard app import --app-id ${appId} --key-file PEM`;
        apps.push({ slug, appId, file: null, savedRole: null, owner: null, ownedByAccount: null, installedOnRepository: installation.repository_selection === 'all' ? true : null, installedOnAccount: true, installationId: Number.isSafeInteger(installation.id) ? installation.id : null,
          roles: Object.fromEntries(appRoles.map(role => [role, why])) as Record<AppRole, string | null>, reusableFor: [], summary: `${slug}: installed on ${account}, not reusable until imported: ${why}` });
      }
      accountApps = { listed: true, detail: `${installations.length} App installation${installations.length === 1 ? '' : 's'} on ${account}, read with gh` };
    } catch (error) { accountApps = { listed: false, detail: `gh could not list ${account}'s App installations (${error instanceof Error ? error.message : String(error)}); an organization owner's login with admin:read lists them` }; }
  }
  return { repository: request.repository, account, accountType, apps, accountApps };
}

/**
 * Another App setup page already listens on the port: a `graphyard install --apply` waiting at its
 * App step, or a `github-setup` or `init` left open (GY-1413). Named instead of a raw EADDRINUSE,
 * with the page that is already serving, so the human finishes that one rather than a second.
 */
export function appPageBusy(port: number) {
  return Object.assign(new Error(`Port ${port} already serves a GitHub App setup page, most likely a graphyard install --apply waiting at its App step (docs/setup-from-zero.md step 4). Finish the App on http://127.0.0.1:${port} or stop that process, then rerun; no second App page was opened.`), { code: 'GRAPHYARD_APP_PAGE_BUSY' });
}

/** Whether a local App setup page could be served on the port now; checked before any write that would precede one. */
export async function appPagePortFree(port = 4311) {
  const probe = createServer();
  return new Promise<boolean>(accept => {
    probe.once('error', () => accept(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => accept(true)));
  });
}

/**
 * GY-1450: where an operator hands `graphyard up --agent`'s drive the code GitHub's Confirm-access
 * page asks for, when it offers an authenticator app or an email code: six digits, or a request
 * that GitHub email one. The drive types the code into the page; it is never shown or logged.
 */
const sudoForm = (state: string) => `<h2>GitHub asking to confirm access?</h2><p>Confirming once in your own Chrome on any sudo-protected GitHub page (such as https://github.com/settings/apps/new) lets setup continue by itself. Or hand it the 6-digit code from your authenticator app or an email:</p><form method="post" action="/sudo-code"><input type="hidden" name="state" value="${state}"><input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" aria-label="6-digit code" required> <button>Send code</button></form><form method="post" action="/sudo-code"><input type="hidden" name="state" value="${state}"><input type="hidden" name="email" value="1"><button>Email me a code</button></form>`;

export async function startGithubSetup(root: string, repository: string, deployment: string, port = 4311, dependencies: {
  convert?: (code: string) => Promise<any>;
  verify?: (app: AppCredentials, installationId: number) => Promise<void>;
  resolveBot?: (slug: string) => Promise<{ id: number; type: string }>;
  // A caller that must keep registration credentials outside every repository supplies its own
  // path, and learns the verified installation through record rather than re-reading the file.
  file?: string;
  record?: (app: AppCredentials & { installationId: number }) => Promise<void>;
  /**
   * GY-1442: Apps saved on this host that the page offers to reuse instead of creating one, and the
   * reuse itself (reuseExistingApp with apply): it adds the repository to that App's installation.
   */
  reusable?: string[];
  reuse?: (slug: string) => Promise<AppCredentials & { installationId: number }>;
} = {}, reviewer?: string) {
  if (reviewer !== undefined && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(reviewer)) throw new Error('Reviewer name must be a lowercase identifier');
  // Refused before the page opens, not when the human first loads it.
  manifestOrigin(repository, deployment);
  await localDirectory(root);
  const file = dependencies.file ?? credentialFile(root, reviewer);
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
    // Both writes are atomic: the manifest flow polls this file and must never read it half-written.
    const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
    if (!initial) return rename(temporary, file);
    // link() refuses an existing file, keeping the initial write's exclusive-create guarantee.
    try { await link(temporary, file); } finally { await unlink(temporary); }
  }
  const http = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'self'; form-action 'self' https://github.com; frame-ancestors 'none'; base-uri 'none'");
    const html = (code: number, text: string) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Graphyard setup</title><link rel="stylesheet" href="/style.css"></head><body><main><div class="brand">g / graphyard</div><small>REPOSITORY SETUP</small><h1>Connect your work<br>to its proof.</h1><h2>Connect Graphyard to GitHub</h2>${text}<footer>Graphyard coordinates the work. Your agents write the code.</footer></main></body></html>`); };
    try {
      const address = `127.0.0.1:${(http.address() as any).port}`;
      const url = new URL(req.url!, `http://${address}`);
      // The one form posted to this page: a Confirm-access code for the drive waiting on it (GY-1450).
      const posting = req.method === 'POST' && url.pathname === '/sudo-code';
      if (req.headers.host !== address || req.method !== 'GET' && !posting) return html(400, '<p>Use the exact local setup URL.</p>');
      if (posting) {
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 1_000) return html(413, '<p>Too long.</p>'); }
        const form = new URLSearchParams(body);
        const received = Buffer.from(form.get('state') ?? ''), expected = Buffer.from(state);
        if (received.length !== expected.length || !timingSafeEqual(received, expected)) return html(409, '<p>Invalid setup session.</p>');
        const { submitSudoCode } = await import('./master-browser.js');
        // The code is never echoed: the answer names only what was handed over.
        try { const kind = await submitSudoCode(root, form.get('email') ? 'email' : form.get('code') ?? ''); return html(200, `<p>${kind === 'email' ? 'Asked GitHub to email you a code: enter it here once it arrives.' : 'Code handed to setup; it is typed into GitHub\'s Confirm-access page within seconds.'}</p><p><a href="/">Back</a></p>`); }
        catch (error) { return html(400, `<p>${escape(error instanceof Error ? error.message : String(error))}</p><p><a href="/">Back</a></p>`); }
      }
      if (url.pathname === '/style.css') {
        res.writeHead(200, { 'Content-Type': 'text/css' });
        return res.end('html{color-scheme:dark;background:#101714;color:#e4eee7;font:17px/1.65 system-ui,sans-serif}body{margin:0}main{max-width:660px;margin:8vh auto;padding:32px}.brand{font-size:25px;font-weight:700;margin-bottom:64px;color:#a9d8bb}small{letter-spacing:.15em;color:#9eaea3}h1{font-size:clamp(38px,7vw,58px);line-height:1.08;letter-spacing:-.045em;font-weight:550;margin:20px 0 42px}h2{font-size:22px}p{color:#b5c6ba}a{color:#acd9bc}button{background:#b9e7c8;color:#132319;border:0;border-radius:8px;padding:14px 24px;font:600 16px system-ui;cursor:pointer;margin:18px 0}button:focus-visible,a:focus-visible{outline:3px solid #fff;outline-offset:4px}footer{border-top:1px solid #304337;padding-top:24px;margin-top:56px;color:#91a198;font-size:13px}');
      }
      if (url.pathname === '/') {
        if (app?.installationId) return html(200, reviewer
          ? `<p>Reviewer App registered and installation verified. Add this entry to the server's <code>GRAPHYARD_REVIEWER_APPS</code> registry, then name <code>${escape(reviewer)}</code> from a reviewer profile:</p><pre>${escape(JSON.stringify({ id: reviewer, runtime: reviewer, appId: app.appId, botUserId: app.botUserId }, null, 2))}</pre><p>Set <code>runtime</code> to the agent runtime that will post the verdicts. The private key stays in this machine's credential file and is never needed by Graphyard.</p>`
          : '<p>App registered and installation verified. Credentials are saved locally with restricted file permissions. You may close setup and configure Railway.</p>');
        if (app) return html(200, `<p>App registered. Install it only on ${escape(repository)}.</p><a href="https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new">Install GitHub App</a>${sudoForm(state)}`);
        const manifest = reviewer ? reviewerAppManifest(reviewer, repository, deployment, `http://${address}`) : appManifest(repository, deployment, `http://${address}`);
        const reusable = dependencies.reuse ? dependencies.reusable ?? [] : [];
        const reuse = reusable.length ? `<h2>Or reuse an App you already have</h2><p>Skips creating an App: the repository is added to the chosen App's existing installation, after its permissions${reviewer ? '' : ' and webhook'} are checked.</p><form method="get" action="/reuse"><input type="hidden" name="state" value="${state}"><select name="slug" aria-label="App to reuse">${reusable.map(slug => `<option value="${escape(slug)}">${escape(slug)}</option>`).join('')}</select> <button>Reuse this App →</button></form>` : '';
        return html(200, (reviewer
          ? `<p>Register a private reviewer App named <strong>${escape(reviewer)}</strong> for <strong>${escape(repository)}</strong>. Its runtime signs in as this App to post review verdicts.</p><p>The reviewer App reads code and writes pull request comments. It cannot publish Graphyard's gate check, change branch protection, or write source code. Use a GitHub account that is not the pull request author.</p><form method="post" action="https://github.com/settings/apps/new?state=${state}"><input type="hidden" name="manifest" value="${escape(JSON.stringify(manifest))}"><button>Register reviewer App →</button></form>`
          : `<p>Register a private App for <strong>${escape(repository)}</strong>. GitHub will ask you to sign in, name the App, and choose the repository.</p><p>The App reads code and branch protection, publishes its gate check and the graphyard/landable status, writes PR review requests, and moves release and revert branches, which is why it holds Contents: read and write. It never writes an agent's code and never merges a pull request: GitHub merges it once branch protection's required checks pass. Credentials return directly to this machine; no key copying is needed.</p><form method="post" action="https://github.com/settings/apps/new?state=${state}"><input type="hidden" name="manifest" value="${escape(JSON.stringify(manifest))}"><button>Register Graphyard App →</button></form>`) + reuse + sudoForm(state));
      }
      if (url.pathname === '/reuse') {
        const received = Buffer.from(url.searchParams.get('state') ?? ''), expected = Buffer.from(state);
        if (received.length !== expected.length || !timingSafeEqual(received, expected) || exchanging || app || !dependencies.reuse) return html(409, '<p>Invalid or already used setup session.</p>');
        const slug = url.searchParams.get('slug') ?? '';
        if (!(dependencies.reusable ?? []).includes(slug)) return html(400, '<p>Choose one of the Apps this page offers.</p>');
        exchanging = true;
        let reused: AppCredentials & { installationId: number };
        // A refusal names the App and why (permissions, another control plane's webhook); it holds no secret.
        try { reused = await dependencies.reuse(slug); }
        catch (error) { exchanging = false; return html(409, `<p>${escape(error instanceof Error ? error.message : String(error))}</p><p><a href="/">Back</a></p>`); }
        const next: AppCredentials = { ...reused, repository, ...(reviewer ? { reviewer } : {}) };
        await persist(next, true); app = next;
        if (dependencies.record) await dependencies.record(next as AppCredentials & { installationId: number });
        res.writeHead(303, { Location: '/' }); return res.end();
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
        if (dependencies.record) await dependencies.record(next as AppCredentials & { installationId: number });
        res.writeHead(303, { Location: '/' }); return res.end();
      }
      html(404, '<p>Page not found.</p>');
    } catch { html(502, '<p>Setup could not complete. Credentials are never included in this page or its logs. Check the App installation and restart setup to resume from saved credentials.</p>'); }
  });
  // Validate before binding; port 0 is useful for isolated tests.
  if (reviewer) reviewerAppManifest(reviewer, repository, deployment, 'http://127.0.0.1'); else appManifest(repository, deployment, 'http://127.0.0.1');
  await new Promise<void>((accept, reject) => { http.once('error', reject); http.listen(port, '127.0.0.1', accept); })
    .catch((error: any) => { throw error?.code === 'EADDRINUSE' ? appPageBusy(port) : error; });
  return { http, url: `http://127.0.0.1:${(http.address() as any).port}`, file };
}
