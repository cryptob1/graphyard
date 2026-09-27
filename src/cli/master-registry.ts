import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import type { MasterConfig } from '../master.js';
import { discoverHostLogins, proposeFleet } from '../fleet.js';
import { emptyRolePolicy, fleetRoles, quotaStates, rolePolicy, type AgentRegistry } from '../model/registry.js';

export const registryHelp = [
  '  master registry               The fleet the control plane holds: every account with its runtime,',
  '                                model, roles, live sessions, quota, reset and ineligible reason',
  '  master registry propose [--directory DIR] [--apply]',
  '                                Discover the agent environments on this host (~/.coding_agents: Claude,',
  '                                Codex, Cursor, OpenCode, Pi) and propose the runtimes, models, accounts',
  '                                and roles for them; --apply stores it as a registry revision',
  '  master registry runtime set NAME|@FILE [--kind K] [--arg=A]… [--home-variable VAR]',
  '              [--model-flag=FLAG] [--tools-flag=FLAG] [--login COMMAND] [--login-file PATH] [--env K=V]… --reason R',
  '  master registry model set NAME|@FILE [--provider P] [--id ID] [--input-cost USD]',
  '              [--output-cost USD] [--tier frontier|strong|fast] [--context TOKENS] --reason R',
  '  master registry account set NAME|@FILE --runtime R --model M [--home PATH] [--host HOST]',
  '              [--max-sessions N] [--disable|--enable] [--note TEXT] [--key-file FILE --key-variable VAR|--no-key] --reason R',
  '                                --key-file names the provider key file in the login home (mode 0600) that a',
  '                                headless run reads into VAR at launch; the registry stores the reference only.',
  '                                Any change re-runs the account\'s smoke test and clears its holds',
  '  master registry account quota NAME exhausted|available|unknown [--resets-at ISO] --reason R',
  '  master registry role set ROLE ACCOUNT[,ACCOUNT…] [--concurrency N] [--arg=A]… [--tool T]… [--model M]',
  '              [--clear-policy] --reason R   The role\'s accounts and its launch policy: permission-mode /',
  '                                auto-approve flags, tool allowlist and model for every session of it',
  '  master registry runtime|model|account|role remove NAME --reason R',
  '  master registry session end ID --reason R   End one live session the registry still counts',
  '  master registry history [--limit N]   Every registry change and selection, newest first',
];

export interface RegistryCommandApi { read(path: string): Promise<any>; write(path: string, data: unknown): Promise<any> }
const fromFile = async (value: string) => JSON.parse(await readFile(value.slice(1), 'utf8'));
const defined = <T extends Record<string, unknown>>(value: T) => Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
const number = (value: string | undefined, flag: string) => { if (value === undefined) return undefined; const parsed = Number(value); if (!Number.isFinite(parsed)) throw new Error(`${flag} takes a number`); return parsed; };

/**
 * `graphyard master registry …`: the fleet is configured in the control plane, from any host that
 * holds the coordinator credential. A `set` names the entry and only what changes; the rest of an
 * existing entry stands. Every change carries a reason and appends to the registry's history.
 */
export async function registryCommand(master: Pick<MasterConfig, 'hostId'>, args: string[], api: RegistryCommandApi, options: { directory?: string; home?: string; executables?: (name: string) => boolean } = {}) {
  const [collection, action, ...rest] = args;
  if (!collection) return api.read(`agent-registry?host=${encodeURIComponent(master.hostId)}`);
  if (collection === 'history') {
    const { values } = parseArgs({ args: args.slice(1), options: { limit: { type: 'string' } }, allowPositionals: false });
    return api.read(`agent-registry/history?limit=${number(values.limit, '--limit') ?? 100}`);
  }
  if (collection === 'propose') {
    const { values } = parseArgs({ args: args.slice(1), options: { directory: { type: 'string' }, apply: { type: 'boolean' }, reason: { type: 'string' } }, allowPositionals: false });
    const current: AgentRegistry = await api.read('agent-registry/document');
    const logins = await discoverHostLogins({ directory: values.directory ?? options.directory, home: options.home, executables: options.executables });
    const proposal = proposeFleet(logins, master.hostId, current);
    const empty = !proposal.runtimes.length && !proposal.models.length && !proposal.accounts.length && !proposal.roles.length;
    const loggedOut = logins.filter(login => login.loggedIn === false);
    const report = { host: master.hostId, discovered: logins, proposal, applied: false,
      next: !logins.length ? 'No agent CLI login was found on this host; log one in (or create an isolated one with graphyard master environments --create claude --apply) and rerun'
        : empty ? `The registry already holds every login found on this host${loggedOut.length ? `; log in the rest (${loggedOut.map(login => login.login).filter(Boolean).join(' ; ')}) and rerun to add them` : ''}`
        : 'Rerun with --apply to store this proposal in the control plane; then name each model and its cost with graphyard master registry model set' };
    if (!values.apply || empty) return report;
    const applied = await api.write('agent-registry/apply', { ...proposal, reason: values.reason ?? `Setup proposal from the agent CLIs logged in on ${master.hostId}` });
    return { ...report, applied: true, revision: applied.revision, registry: applied.registry, next: 'The registry decides every launch from now on; graphyard master registry shows each account and why any is ineligible' };
  }
  // A session the registry still counts but that nothing is running any more: a launcher killed
  // mid-flight, a host that went away. Every other end is the control plane's own doing.
  if (collection === 'session') {
    const { values, positionals } = parseArgs({ args: rest, options: { reason: { type: 'string' } }, allowPositionals: true });
    if (action !== 'end' || !positionals[0] || !values.reason) throw new Error('Use master registry session end SESSION_ID --reason REASON');
    return api.write(`agent-registry/sessions/${encodeURIComponent(positionals[0])}/end`, { reason: values.reason });
  }
  if (!['runtime', 'model', 'account', 'role'].includes(collection) || !action) throw new Error('Use master registry [propose|history|runtime|model|account|role|session …]; master guide lists every form');
  const plural = `${collection}s`;
  if (action === 'remove') {
    const { values, positionals } = parseArgs({ args: rest, options: { reason: { type: 'string' } }, allowPositionals: true });
    if (!positionals[0] || !values.reason) throw new Error(`Use master registry ${collection} remove NAME --reason REASON`);
    return api.write(`agent-registry/${plural}/${encodeURIComponent(positionals[0])}/remove`, { reason: values.reason });
  }
  if (collection === 'account' && action === 'quota') {
    const { values, positionals } = parseArgs({ args: rest, options: { reason: { type: 'string' }, 'resets-at': { type: 'string' } }, allowPositionals: true });
    const [name, state] = positionals;
    if (!name || !(quotaStates as readonly string[]).includes(state ?? '') || !values.reason) throw new Error(`Use master registry account quota NAME ${quotaStates.join('|')} [--resets-at ISO] --reason REASON`);
    return api.write(`agent-registry/accounts/${encodeURIComponent(name)}/quota`, { quota: { state, resetsAt: values['resets-at'] ? new Date(values['resets-at']).toISOString() : null }, reason: values.reason });
  }
  if (action !== 'set') throw new Error(`Use master registry ${collection} set … or master registry ${collection} remove NAME --reason REASON`);
  const current: AgentRegistry = await api.read('agent-registry/document');
  if (collection === 'runtime') {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { reason: { type: 'string' }, kind: { type: 'string' }, arg: { type: 'string', multiple: true }, 'home-variable': { type: 'string' }, 'model-flag': { type: 'string' }, 'tools-flag': { type: 'string' }, login: { type: 'string' }, 'login-file': { type: 'string' }, env: { type: 'string', multiple: true }, description: { type: 'string' } } });
    if (!positionals[0] || !values.reason) throw new Error('Use master registry runtime set NAME|@FILE [--kind K] [--arg=A]… --reason REASON; a value that starts with a dash is written onto its flag with =, as --arg=--yes-always and --model-flag=--model');
    if (positionals[0].startsWith('@')) return api.write('agent-registry/runtimes', { runtime: await fromFile(positionals[0]), reason: values.reason });
    const existing = current.runtimes.find(runtime => runtime.name === positionals[0]);
    const environment = values.env ? Object.fromEntries(values.env.map(pair => { const at = pair.indexOf('='); if (at < 1) throw new Error('--env takes NAME=VALUE'); return [pair.slice(0, at), pair.slice(at + 1)]; })) : undefined;
    const launch = { ...(existing?.launch ?? { kind: positionals[0] }), ...defined({ kind: values.kind, args: values.arg, homeVariable: values['home-variable'], modelFlag: values['model-flag'], toolsFlag: values['tools-flag'], login: values.login, loginFile: values['login-file'], environment }) };
    return api.write('agent-registry/runtimes', { runtime: { ...defined({ description: values.description ?? existing?.description }), name: positionals[0], launch }, reason: values.reason });
  }
  if (collection === 'model') {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { reason: { type: 'string' }, provider: { type: 'string' }, id: { type: 'string' }, 'input-cost': { type: 'string' }, 'output-cost': { type: 'string' }, tier: { type: 'string' }, context: { type: 'string' }, notes: { type: 'string' } } });
    if (!positionals[0] || !values.reason) throw new Error('Use master registry model set NAME|@FILE [--id ID] [--input-cost USD] [--output-cost USD] [--tier T] --reason REASON');
    if (positionals[0].startsWith('@')) return api.write('agent-registry/models', { model: await fromFile(positionals[0]), reason: values.reason });
    const existing = current.models.find(model => model.name === positionals[0]);
    const model = { ...existing, name: positionals[0], ...defined({ provider: values.provider, id: values.id }),
      cost: { ...existing?.cost, ...defined({ inputPerMTok: number(values['input-cost'], '--input-cost'), outputPerMTok: number(values['output-cost'], '--output-cost') }) },
      capability: { ...existing?.capability, ...defined({ tier: values.tier, contextTokens: number(values.context, '--context'), notes: values.notes }) } };
    return api.write('agent-registry/models', { model, reason: values.reason });
  }
  if (collection === 'account') {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { reason: { type: 'string' }, runtime: { type: 'string' }, model: { type: 'string' }, home: { type: 'string' }, host: { type: 'string' }, 'max-sessions': { type: 'string' }, disable: { type: 'boolean' }, enable: { type: 'boolean' }, note: { type: 'string' },
      'key-file': { type: 'string' }, 'key-variable': { type: 'string' }, 'no-key': { type: 'boolean' } } });
    if (!positionals[0] || !values.reason) throw new Error('Use master registry account set NAME|@FILE --runtime R --model M [--home PATH] [--host HOST] --reason REASON');
    if (positionals[0].startsWith('@')) return api.write('agent-registry/accounts', { account: await fromFile(positionals[0]), reason: values.reason });
    const existing = current.accounts.find(account => account.name === positionals[0]);
    if (!existing && (!values.runtime || !values.model)) throw new Error(`${positionals[0]} is a new account; name its --runtime and --model (graphyard master registry lists both)`);
    const { quota: _observed, smoke: _smoke, unjudged: _held, ...kept } = existing ?? { quota: null };
    if (values['no-key'] && (values['key-file'] || values['key-variable'])) throw new Error('--no-key removes the account\'s key; it cannot be combined with --key-file or --key-variable');
    if (!!values['key-file'] !== !!values['key-variable']) throw new Error('Name the key by both --key-file FILE (inside the login home) and --key-variable VAR (the variable the runtime reads it from)');
    const existingKey = existing?.credential.key;
    const key = values['no-key'] ? undefined : values['key-file'] ? { file: values['key-file'], variable: values['key-variable']! } : existingKey;
    const account = { ...kept, name: positionals[0], ...defined({ runtime: values.runtime, model: values.model, note: values.note, maxSessions: number(values['max-sessions'], '--max-sessions'), enabled: values.disable ? false : values.enable ? true : undefined }),
      // The credential stays where the runtime put it: the registry holds only where that is.
      credential: { host: values.host ?? existing?.credential.host ?? master.hostId, home: values.home ?? existing?.credential.home ?? null, ...(key ? { key } : {}) } };
    return api.write('agent-registry/accounts', { account, reason: values.reason });
  }
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { reason: { type: 'string' }, concurrency: { type: 'string' },
    arg: { type: 'string', multiple: true }, tool: { type: 'string', multiple: true }, model: { type: 'string' }, 'clear-policy': { type: 'boolean' } } });
  const [name, list] = positionals;
  if (!(fleetRoles as readonly string[]).includes(name ?? '') || !values.reason) throw new Error(`Use master registry role set ${fleetRoles.join('|')} ACCOUNT[,ACCOUNT…] [--concurrency N] [--arg=A]… [--tool T]… [--model M] [--clear-policy] --reason REASON`);
  const existing = current.roles.find(role => role.name === name);
  const accounts = list === undefined ? existing?.accounts : list.split(',').map(entry => entry.trim()).filter(Boolean);
  const concurrency = number(values.concurrency, '--concurrency') ?? existing?.concurrency;
  if (!accounts || concurrency === undefined) throw new Error(`${name} is a new role; name its accounts in preference order and its --concurrency`);
  // The policy is changed only where a flag names it; --clear-policy starts it from empty. `--model none` drops the override.
  const base = values['clear-policy'] ? emptyRolePolicy() : rolePolicy(existing);
  const policy = { ...base, ...defined({ args: values.arg, tools: values.tool?.flatMap(entry => entry.split(',').map(tool => tool.trim()).filter(Boolean)), model: values.model === undefined ? undefined : values.model === 'none' ? null : values.model }) };
  const empty = !policy.args.length && !policy.tools.length && policy.model === null;
  return api.write('agent-registry/roles', { role: { name, accounts, concurrency, ...(empty && !existing?.policy ? {} : { policy }) }, reason: values.reason });
}

/**
 * What `master init` adds to its report: the logins this host already has and the registry they
 * imply, so a new installation reaches a working fleet without a hand-written profile. Nothing is
 * stored until the operator accepts it, and a failed discovery never fails the install.
 */
export async function initialFleetProposal(master: Pick<MasterConfig, 'url' | 'hostId'>, token: string, fetcher: typeof fetch = fetch) {
  try {
    const response = await fetcher(`${master.url}/api/agent-registry/document`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return { proposal: null, next: `The control plane at ${master.url} does not serve an agent registry (status ${response.status}); deploy a release that does, then run graphyard master registry propose` };
    const logins = await discoverHostLogins(), proposal = proposeFleet(logins, master.hostId, await response.json());
    return { discovered: logins.map(login => ({ account: login.name, runtime: login.runtime, home: login.home, loggedIn: login.loggedIn, login: login.login })), proposal,
      next: proposal.accounts.length ? 'graphyard master registry propose --apply stores this fleet in the control plane' : logins.length ? 'Every login found on this host is already registered (or logged out); graphyard master registry shows the fleet' : 'No agent CLI login was found on this host; log one in, then run graphyard master registry propose --apply' };
  } catch (error) { return { proposal: null, next: `The fleet proposal could not be prepared (${error instanceof Error ? error.message : 'unknown reason'}); run graphyard master registry propose once the control plane answers` }; }
}
