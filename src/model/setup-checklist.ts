/**
 * The first-run checklist (GY-1419): what a new installation needs before it can build anything,
 * read live from the control plane's `/api/status`. `graphyard up` waits on it and the dashboard's
 * Setup page shows it, so both judge one checklist. Every line is plain language: no command, sha
 * or file path, because the person reading it may never have opened a terminal.
 */

/** The roles a first installation needs an agent account for: one writes the code, one reviews it. */
export const requiredSetupRoles = ['worker', 'reviewer'] as const;
export type RequiredSetupRole = typeof requiredSetupRoles[number];

/** What the one button on a checklist item does. */
export type SetupAction =
  | { kind: 'link'; label: string; href: string }
  | { kind: 'connect'; label: string; role: RequiredSetupRole }
  | { kind: 'wait'; label: string };

export type SetupItemId = 'github-app' | 'reviewer-app' | `account:${RequiredSetupRole}` | 'branch-protection' | 'master-loop';
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

/** Where the installer serves the GitHub App manifest page while it waits for the App (src/install/manifest.ts). */
export const defaultAppSetupUrl = 'http://127.0.0.1:4311';

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
/**
 * SUPERVISED (GY-1501, `up --local`): the operator reviews and merges on GitHub, so the reviewer App
 * and the reviewing agent account are not part of this installation and are never reported missing.
 * `graphyard up` says so itself; the dashboard reads it from the status (`setup.supervision`, as the
 * live loop names it).
 */
export const statusSupervised = (status: any | null) => status?.setup?.supervision === 'supervised';
export function setupChecklist(status: any | null, options: { appSetupUrl?: string; supervised?: boolean } = {}): SetupItem[] {
  const supervised = options.supervised ?? statusSupervised(status);
  const appUrl = options.appSetupUrl ?? defaultAppSetupUrl;
  const repository = status?.githubRepository?.fullName ?? status?.githubRepository ?? status?.repository ?? null;
  const missing: unknown[] = status?.appPermissions?.missing ?? [];
  const appBound = !!status?.github;
  const appDone = appBound && missing.length === 0;
  const items: SetupItem[] = [];
  items.push({ id: 'github-app', title: 'GitHub App', done: appDone, human: true,
    line: appDone ? 'Graphyard can open pull requests and read checks in your repository.'
      : appBound ? 'The App needs a few more permissions before Graphyard can use it.'
      : 'Create the App that lets Graphyard work in your repository, then install it there.',
    action: appDone ? null : appBound && status?.appPermissions?.installationUrl ? { kind: 'link', label: 'Accept the new permissions', href: status.appPermissions.installationUrl }
      : { kind: 'link', label: 'Create the GitHub App', href: appUrl } });
  const reviewerDone = Array.isArray(status?.reviewerApps) && status.reviewerApps.length > 0;
  if (!supervised) items.push({ id: 'reviewer-app', title: 'Reviewer App', done: reviewerDone, human: true,
    line: reviewerDone ? 'A second App signs the independent code reviews.' : 'Create a second App so every change is reviewed by someone other than its author.',
    action: reviewerDone ? null : appBound ? { kind: 'link', label: 'Create the reviewer App', href: appUrl } : { kind: 'wait', label: 'Waiting for the GitHub App' } });
  for (const role of requiredSetupRoles) {
    if (supervised && role === 'reviewer') continue;
    const done = roleReady(status?.fleet, role);
    items.push({ id: `account:${role}`, title: roleTitle[role], done, human: true,
      line: done ? 'Connected and signed in.' : role === 'worker' ? 'Connect an AI coding account (an API key or a subscription sign-in) to write the code.' : 'Connect an AI coding account to review the code. It may be the same account.',
      action: done ? null : { kind: 'connect', label: 'Connect an account', role } });
  }
  // `checks` is protected enough to start: Graphyard requires its own merge check once the first change reports it.
  const protection = status?.setup?.protection;
  const protectedBranch = protection === 'complete' || protection === 'checks';
  items.push({ id: 'branch-protection', title: 'Branch protection', done: protectedBranch, human: false,
    line: protection === 'complete' ? 'Changes reach your main branch only after they pass review and tests.'
      : protectedBranch ? 'Your main branch requires its tests to pass; Graphyard adds its own check after the first change.' : appDone ? 'Graphyard turns this on by itself; if it stays off, open your repository\'s branch settings.' : 'Turned on by itself once the GitHub App is installed.',
    action: protectedBranch ? null : appDone && repository ? { kind: 'link', label: 'Open branch settings', href: `https://github.com/${repository}/settings/branches` } : { kind: 'wait', label: 'Waiting for the GitHub App' } });
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

/** The goal box's limits: a sentence to a few paragraphs, within a goal statement's bound. */
export const goalLimits = { min: 10, max: 2000 } as const;

/**
 * A goal described in plain words (GY-1419), as the goals API records it (GY-1443): the same
 * input as `graphyard goal FILE`, so the acceptance role drafts its customer outcomes and locked
 * E2E cases and the planner splits it into dependency-ordered items. The person names only what
 * to build; the users and deploy target stay general for the acceptance role to make concrete.
 */
export function goalSubmission(text: string) {
  const statement = text.replace(/\r\n/g, '\n').trim();
  if (statement.length < goalLimits.min) throw new Error(`Describe what you want built in at least ${goalLimits.min} characters`);
  if (statement.length > goalLimits.max) throw new Error(`Keep the description under ${goalLimits.max} characters`);
  return {
    statement,
    users: ['The people this repository serves'],
    constraints: [],
    deployTarget: 'This repository\'s production deployment',
  };
}
