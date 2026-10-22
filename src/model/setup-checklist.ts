/**
 * The first-run checklist (GY-1419): what a new installation needs before it can build anything,
 * read live from the control plane's `/api/status`. `graphyard up` waits on it and the dashboard's
 * Setup page shows it, so both judge one checklist. Every line is plain language: no sha, file path
 * or command.
 */

/** The roles a first installation needs an agent account for: one writes the code, one reviews it. */
export const requiredSetupRoles = ['worker', 'reviewer'] as const;
export type RequiredSetupRole = typeof requiredSetupRoles[number];

/** What the one button on a checklist item does. */
export type SetupAction =
  | { kind: 'link'; label: string; href: string }
  | { kind: 'connect'; label: string; role: RequiredSetupRole }
  | { kind: 'wait'; label: string };

export type SetupItemId = 'github-app' | 'reviewer-app' | `account:${RequiredSetupRole}` | 'master-loop';
export interface SetupItem {
  id: SetupItemId;
  title: string;
  /** Green when the control plane reports the step done. */
  done: boolean;
  /** One plain-language sentence: what this is, or what is still missing. */
  line: string;
  /** The single action that moves it forward; null once it is done. */
  action: SetupAction | null;
  /** Steps only a person can do (a click on GitHub, an account sign-in); the rest Graphyard does itself. */
  human: boolean;
}

/**
 * The address `graphyard up` prints (GY-1419): the dashboard's Setup page, signed in. A one-time
 * sign-in link (`#sign-in=CODE`, or a host install's `#claim=CODE`) carries `&setup`, so the person
 * who opens it lands on the Setup page once the link signs them in; without a link it is `#setup`.
 */
export function setupAddress(server: string, signIn?: string | null) {
  return signIn ? `${signIn}&setup` : `${server.replace(/\/+$/, '')}/#setup`;
}

/**
 * The page an address opens and the fragment the sign-in page reads (GY-1419): `#setup` alone, or a
 * sign-in or claim fragment followed by `&setup`, opens the Setup page; the `&setup` marker is taken
 * off so the sign-in page sees the exact fragment it redeems. Any other fragment opens no page.
 */
export function requestedView(hash: string): { view: 'setup' | null; hash: string } {
  if (hash === '#setup') return { view: 'setup', hash };
  const signIn = /^(#(?:sign-in|claim)=[A-Za-z0-9_-]{16,200})&setup$/.exec(hash);
  return signIn ? { view: 'setup', hash: signIn[1] } : { view: null, hash };
}

const roleTitle: Record<RequiredSetupRole, string> = { worker: 'An agent account that writes code', reviewer: 'An agent account that reviews code' };

/**
 * Whether ROLE has an account that is connected, signed in and allowed to take that role now: the
 * fleet's own `eligible` judgement (runtime and model configured, quota left) counts, so an account
 * every session would be refused never turns the item green.
 */
function roleReady(fleet: any, role: RequiredSetupRole) {
  const entry = Array.isArray(fleet?.roles) ? fleet.roles.find((candidate: any) => candidate?.role === role) : null;
  if (!entry || !Array.isArray(entry.accounts) || !entry.accounts.length) return false;
  const accounts: any[] = Array.isArray(fleet?.accounts) ? fleet.accounts : [];
  return accounts.some(account => entry.accounts.includes(account?.name) && account.enabled !== false && account.loggedIn !== false && account.eligible !== false && account.smoke?.result !== 'fail');
}

/**
 * The checklist for STATUS (the control plane's `/api/status` answer, or null while it does not
 * answer). Items stay in the order a new installation completes them.
 */
/** SUPERVISED (GY-1501, `up --local`): as the live loop names it in the status (`setup.supervision`); the checklist is the same either way (GY-1978). */
export const statusSupervised = (status: any | null) => status?.setup?.supervision === 'supervised';
/** Where the pull-request-era installer served its GitHub App page; a status from before GY-2010 may still name it. */
const defaultAppSetupUrl = 'http://127.0.0.1:4311';
/**
 * CONTROL-PLANE MERGER (GY-1553): the control plane is the only merge writer, so no GitHub App opens
 * pull requests and no reviewer App signs reviews: those items pass as not required. No GitHub
 * branch protection is used. `doctor`'s setup-from-zero checks (src/setup-from-zero.ts) say the
 * same words for the same ids.
 */
export const mergerNotRequired = 'not required (merger: control-plane)';
export function setupChecklist(status: any | null, options: { githubApps?: boolean } = {}): SetupItem[] {
  const notRequired = (id: SetupItemId, title: string): SetupItem => ({ id, title, done: true, human: false, line: mergerNotRequired, action: null });
  // Only `up`'s App path (a run recorded before every `up` took the control plane) judges the App items.
  if (!options.githubApps) return [notRequired('github-app', 'GitHub App'), notRequired('reviewer-app', 'Reviewer App'), ...accountItems(status)];
  const missing: unknown[] = status?.appPermissions?.missing ?? [];
  const appBound = !!status?.github;
  const appDone = appBound && missing.length === 0;
  const reviewerDone = Array.isArray(status?.reviewerApps) && status.reviewerApps.length > 0;
  return [{ id: 'github-app', title: 'GitHub App', done: appDone, human: true,
    line: appDone ? 'Graphyard can open pull requests and read checks in your repository.'
      : appBound ? 'The App needs a few more permissions before Graphyard can use it.'
      : 'Create the App that lets Graphyard work in your repository, then install it there.',
    action: appDone ? null : appBound && status?.appPermissions?.installationUrl ? { kind: 'link', label: 'Accept the new permissions', href: status.appPermissions.installationUrl }
      : { kind: 'link', label: 'Create the GitHub App', href: defaultAppSetupUrl } },
  { id: 'reviewer-app', title: 'Reviewer App', done: reviewerDone, human: true,
    line: reviewerDone ? 'A second App signs the independent code reviews.' : 'Create a second App so every change is reviewed by someone other than its author.',
    action: reviewerDone ? null : appBound ? { kind: 'link', label: 'Create the reviewer App', href: defaultAppSetupUrl } : { kind: 'wait', label: 'Waiting for the GitHub App' } }, ...accountItems(status)];
}
function accountItems(status: any | null): SetupItem[] {
  const items: SetupItem[] = [];
  for (const role of requiredSetupRoles) {
    const done = roleReady(status?.fleet, role);
    items.push({ id: `account:${role}`, title: roleTitle[role], done, human: true,
      line: done ? 'Connected and signed in.' : role === 'worker' ? 'Connect an AI coding account (an API key or a subscription sign-in) to write the code.' : 'Connect an AI coding account to review the code. It may be the same account.',
      action: done ? null : { kind: 'connect', label: 'Connect an account', role } });
  }
  const loop = status?.setup?.loop === true;
  items.push({ id: 'master-loop', title: 'Coordinator running', done: loop, human: false,
    line: loop ? 'The coordinator is running and will hand out work.' : 'The setup command starts the coordinator on your machine; this turns green once it runs.',
    action: loop ? null : { kind: 'wait', label: 'Check again' } });
  return items;
}

/**
 * The pane server that holds this install's agent sessions, as the master loop reports it (GY-1511):
 * its own instance (a config home and a session name) when the host's default one serves another
 * install, else the default (both null); the host the loop runs on, when recorded; and whether the
 * loop last reached that server (null while unknown). A sibling module outside the model turns it into commands.
 */
export interface PaneServer { configHome: string | null; session: string | null; host: string | null; running: boolean | null }
/** The value `status.setup.panes` carries, or the default instance on an unknown host when it carries none. */
export function paneServer(status: any | null): PaneServer {
  const reported = status?.setup?.panes;
  const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null;
  const configHome = text(reported?.configHome), session = text(reported?.session);
  return { configHome: configHome && session ? configHome : null, session: configHome && session ? session : null, host: text(reported?.host), running: typeof reported?.running === 'boolean' ? reported.running : null };
}

export const checklistGreen = (items: readonly SetupItem[]) => items.every(item => item.done);
