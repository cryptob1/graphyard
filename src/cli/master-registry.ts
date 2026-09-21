import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import type { MasterConfig } from '../master.js';
import { discoverHostLogins, proposeFleet } from '../fleet.js';
import { fleetRoles, quotaStates, type AgentRegistry } from '../model/registry.js';

export const registryHelp = [
  '  master registry               The fleet the control plane holds: every account with its runtime,',
  '                                model, roles, live sessions, quota, reset and ineligible reason',
  '  master registry propose [--directory DIR] [--apply]',
  '                                Discover the agent CLIs logged in on this host and propose the',
  '                                runtimes, models, accounts and roles for them; --apply stores it',
  '  master registry runtime set NAME|@FILE [--kind K] [--arg A]… [--home-variable VAR]',
  '              [--model-flag FLAG] [--login COMMAND] [--login-file PATH] [--env K=V]… --reason R',
  '  master registry model set NAME|@FILE [--provider P] [--id ID] [--input-cost USD]',
  '              [--output-cost USD] [--tier frontier|strong|fast] [--context TOKENS] --reason R',
  '  master registry account set NAME|@FILE --runtime R --model M [--home PATH] [--host HOST]',
  '              [--max-sessions N] [--disable|--enable] [--note TEXT] --reason R',
  '  master registry account quota NAME exhausted|available|unknown [--resets-at ISO] --reason R',
  '  master registry role set ROLE ACCOUNT[,ACCOUNT…] [--concurrency N] --reason R',
  '  master registry runtime|model|account|role remove NAME --reason R',
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
  if (!['runtime', 'model', 'account', 'role'].includes(collection) || !action) throw new Error('Use master registry [propose|history|runtime|model|account|role …]; master guide lists every form');
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
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { reason: { type: 'string' }, kind: { type: 'string' }, arg: { type: 'string', multiple: true }, 'home-variable': { type: 'string' }, 'model-flag': { type: 'string' }, login: { type: 'string' }, 'login-file': { type: 'string' }, env: { type: 'string', multiple: true }, description: { type: 'string' } } });
    if (!positionals[0] || !values.reason) throw new Error('Use master registry runtime set NAME|@FILE [--kind K] [--arg A]… --reason REASON');
    if (positionals[0].startsWith('@')) return api.write('agent-registry/runtimes', { runtime: await fromFile(positionals[0]), reason: values.reason });
    const existing = current.runtimes.find(runtime => runtime.name === positionals[0]);
    const environment = values.env ? Object.fromEntries(values.env.map(pair => { const at = pair.indexOf('='); if (at < 1) throw new Error('--env takes NAME=VALUE'); return [pair.slice(0, at), pair.slice(at + 1)]; })) : undefined;
    const launch = { ...(existing?.launch ?? { kind: positionals[0] }), ...defined({ kind: values.kind, args: values.arg, homeVariable: values['home-variable'], modelFlag: values['model-flag'], login: values.login, loginFile: values['login-file'], environment }) };
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
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { reason: { type: 'string' }, runtime: { type: 'string' }, model: { type: 'string' }, home: { type: 'string' }, host: { type: 'string' }, 'max-sessions': { type: 'string' }, disable: { type: 'boolean' }, enable: { type: 'boolean' }, note: { type: 'string' } } });
    if (!positionals[0] || !values.reason) throw new Error('Use master registry account set NAME|@FILE --runtime R --model M [--home PATH] [--host HOST] --reason REASON');
    if (positionals[0].startsWith('@')) return api.write('agent-registry/accounts', { account: await fromFile(positionals[0]), reason: values.reason });
    const existing = current.accounts.find(account => account.name === positionals[0]);
    if (!existing && (!values.runtime || !values.model)) throw new Error(`${positionals[0]} is a new account; name its --runtime and --model (graphyard master registry lists both)`);
    const { quota: _observed, ...kept } = existing ?? { quota: null };
    const account = { ...kept, name: positionals[0], ...defined({ runtime: values.runtime, model: values.model, note: values.note, maxSessions: number(values['max-sessions'], '--max-sessions'), enabled: values.disable ? false : values.enable ? true : undefined }),
      // The credential stays where the runtime put it: the registry holds only where that is.
      credential: { host: values.host ?? existing?.credential.host ?? master.hostId, home: values.home ?? existing?.credential.home ?? null } };
    return api.write('agent-registry/accounts', { account, reason: values.reason });
  }
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { reason: { type: 'string' }, concurrency: { type: 'string' } } });
  const [name, list] = positionals;
  if (!(fleetRoles as readonly string[]).includes(name ?? '') || !values.reason) throw new Error(`Use master registry role set ${fleetRoles.join('|')} ACCOUNT[,ACCOUNT…] [--concurrency N] --reason REASON`);
  const existing = current.roles.find(role => role.name === name);
  const accounts = list === undefined ? existing?.accounts : list.split(',').map(entry => entry.trim()).filter(Boolean);
  const concurrency = number(values.concurrency, '--concurrency') ?? existing?.concurrency;
  if (!accounts || concurrency === undefined) throw new Error(`${name} is a new role; name its accounts in preference order and its --concurrency`);
  return api.write('agent-registry/roles', { role: { name, accounts, concurrency }, reason: values.reason });
}
