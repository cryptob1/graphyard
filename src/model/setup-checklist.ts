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

export type SetupItemId = `account:${RequiredSetupRole}` | 'master-loop';
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
 * off so the sign-in page sees the exact fragment it redeems. `#master` (or `&master`) opens the Master
 * page the same way (GY-3211). Any other fragment opens no page.
 */
export function requestedView(hash: string): { view: 'setup' | 'master' | null; hash: string } {
  if (hash === '#setup' || hash === '#master') return { view: hash.slice(1) as 'setup' | 'master', hash };
  const signIn = /^(#(?:sign-in|claim)=[A-Za-z0-9_-]{16,200})&(setup|master)$/.exec(hash);
  return signIn ? { view: signIn[2] as 'setup' | 'master', hash: signIn[1] } : { view: null, hash };
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
/**
 * The checklist for STATUS (the control plane's `/api/status` answer, or null while it does not
 * answer). Items stay in the order a new installation completes them. The control plane is the only
 * merge writer (GY-1553): no GitHub App opens pull requests and no reviewer App signs reviews, so
 * the checklist judges accounts and the coordinator alone.
 */
export function setupChecklist(status: any | null): SetupItem[] {
  return accountItems(status);
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
/** `master` is the pane the master session holds (GY-3211), which the Master page attaches to. */
export interface PaneServer { configHome: string | null; session: string | null; host: string | null; running: boolean | null; master?: string | null }
/** The value `status.setup.panes` carries, or the default instance on an unknown host when it carries none. */
export function paneServer(status: any | null): PaneServer {
  const reported = status?.setup?.panes;
  const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null;
  const configHome = text(reported?.configHome), session = text(reported?.session);
  return { configHome: configHome && session ? configHome : null, session: configHome && session ? session : null, host: text(reported?.host), running: typeof reported?.running === 'boolean' ? reported.running : null };
}

export const checklistGreen = (items: readonly SetupItem[]) => items.every(item => item.done);
