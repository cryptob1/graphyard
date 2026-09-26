import { constants as cryptoConstants, createDecipheriv, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Work } from '../model.js';
import { humanDecisionKinds, type HumanChoice, type HumanDecisionKind, type HumanRequestRow } from '../model/human-request.js';
import { configHome } from '../install/secrets.js';
import { scopeRequestOutcome } from '../model/scope.js';
import type { CliContext } from './context.js';
import { workMutation, type CliCommand } from './registry.js';

/**
 * The commands a session runs about its own item, rather than about the fleet: the worker's live
 * scope request, and the two halves of a human-only wait — the worker parks the item, the human
 * lists what waits and answers it. `master status` reports on them; none of them is a master
 * command, so they live beside it rather than in it.
 */

/** The worker half of live scope negotiation: ask, or withdraw, without leaving the lease. */
export const scopeRequestCommand: CliCommand = {
  name: 'scope-request',
  scope: 'work',
  help: [
    '  scope-request GY-N EPOCH PATH... -- REASON',
    '                                Ask to widen plannedFiles with PATH... for a reason; the',
    '                                widening rule, a review finding or the independent approver',
    '                                decides it and the attempt keeps its lease. `scope-request',
    '                                GY-N EPOCH --wait` waits up to 9 minutes and prints the',
    '                                outcome; `--wait` among the PATHs files the request and',
    '                                then waits the same way. Any other argument before -- that',
    '                                begins with - is refused. `scope-request GY-N EPOCH -`',
    '                                withdraws the request.',
    '                                A free-text blocker is never needed for scope',
  ],
  async run(context, work) {
    const { args, print } = context;
    const epoch = Number(args[0]);
    if (!Number.isInteger(epoch) || epoch < 1) throw new Error('Use scope-request GY-N EPOCH PATH... -- REASON, scope-request GY-N EPOCH --wait, or scope-request GY-N EPOCH - to withdraw');
    if (args[1] === '-') return print(await workMutation(context, work)('scope', { epoch, paths: [], reason: 'Withdrawn by the worker' }));
    if (args[1] === '--wait' && args.length === 2) return print(await awaitScopeOutcome(context, work, epoch));
    const { paths, reason, wait } = scopeRequestArgs(args.slice(1));
    const filed = await workMutation(context, work)('scope', { epoch, paths, reason });
    if (!wait) return print(filed);
    // `--wait` among the paths files the request first and then waits on it, as the first-position
    // form waits on one already filed (GY-522); the filed item carries the request the wait reads.
    return print(await awaitScopeOutcome(context, filed as Work, epoch));
  },
};

/**
 * The arguments of a scope request after EPOCH: PATH... before `--`, the REASON after it. `--wait`
 * may stand anywhere before `--` and asks to wait for the outcome once the request is filed; any
 * other argument there that begins with '-' is a flag this command does not have, and is refused
 * by name rather than recorded as a planned path (GY-522).
 */
export function scopeRequestArgs(args: readonly string[]) {
  const separator = args.indexOf('--');
  const before = args.slice(0, separator < 0 ? args.length : separator);
  const reason = separator < 0 ? '' : args.slice(separator + 1).join(' ').trim();
  const wait = before.includes('--wait');
  const paths = before.filter(arg => arg !== '--wait');
  const flag = paths.find(arg => arg.startsWith('-'));
  if (flag !== undefined) throw new Error(`scope-request does not accept ${flag}: only --wait may stand before --, and a PATH never begins with '-'`);
  if (!paths.length || !reason) throw new Error('Name at least one PATH outside plannedFiles and give a REASON after --');
  return { paths, reason, wait };
}

/**
 * The outcome of this attempt's open scope request, read from the item as the control plane holds
 * it (GY-176): the worker's own command reads durable state, so nothing is pasted into its session.
 * Polls until the request is decided or no longer open, or the wait (bounded under a shell tool's
 * ten-minute limit) runs out, and reports it pending then. Every read carries the control
 * plane's own time, which is what the lease deadline is measured against. An approval clears the request, so one
 * decided before the worker waits is read from the decision this attempt's request received.
 */
export async function awaitScopeOutcome(context: Pick<CliContext, 'api'>, work: Work, epoch: number, options: { waitMs?: number; everyMs?: number; cli?: string } = {}) {
  const decided = decisionOfAttempt(work, epoch);
  const request = work.scopeRequest?.epoch === epoch ? work.scopeRequest : decided && { at: decided.requestedAt, paths: decided.paths };
  if (!request) throw new Error(`${work.key} has no scope request for epoch ${epoch}; ask with scope-request ${work.key} ${epoch} PATH... -- REASON`);
  const ask = { epoch, at: request.at, paths: request.paths }, cli = options.cli ?? 'graphyard';
  const deadline = Date.now() + (options.waitMs ?? 540_000);
  for (;;) {
    // Liveness is judged on the control plane's clock, from the same read as the item: the lease
    // deadline it issued is compared with its own `now`, never this host's.
    const snapshot = await context.api('work-snapshot') as { work: Work[]; now: string };
    const item = snapshot.work.find(entry => entry.id === work.id) ?? work;
    const outcome = scopeRequestOutcome(item, ask, Date.parse(snapshot.now), cli);
    if (outcome.state !== 'pending' || Date.now() >= deadline) return { key: work.key, epoch, paths: ask.paths, ...outcome, ...(outcome.state === 'pending' ? { next: `Run scope-request ${work.key} ${epoch} --wait again` } : {}) };
    await new Promise(resolve => setTimeout(resolve, Math.min(options.everyMs ?? 10_000, Math.max(0, deadline - Date.now()))));
  }
}

/**
 * The decision this attempt's request received. One recorded before decisions carried their epoch
 * has none, so it is this attempt's only when the live lease is this epoch's, its holder asked,
 * and it was asked after this epoch's claim: a legacy outcome of an earlier attempt never is.
 */
function decisionOfAttempt(work: Work, epoch: number) {
  const decision = work.scopeDecision;
  if (!decision) return null;
  if (decision.epoch !== undefined) return decision.epoch === epoch ? decision : null;
  const claim = work.lastAssignment?.epoch === epoch ? work.lastAssignment.claimedAt : undefined;
  return work.lease?.epoch === epoch && decision.requestedBy === work.lease.owner && !!claim && Date.parse(decision.requestedAt) >= Date.parse(claim) ? decision : null;
}

/**
 * The worker half of a human-only wait (GY-89): record the decision only a human may make as a
 * typed request. The same call ends the attempt's lease and parks the item, so the session exits
 * owning nothing; the human answers it and the loop dispatches the item again.
 */
export const parkCommand: CliCommand = {
  name: 'park',
  scope: 'work',
  help: [
    '  park GY-N EPOCH KIND NEEDED... [--choice LABEL]... -- REASON',
    '                                Record a decision only a human may make and end this attempt:',
    `                                KIND is ${humanDecisionKinds.join(', ')};`,
    '                                NEEDED is the exact thing the human must provide. The item',
    '                                parks without a lease and nothing else waits on it. Each',
    '                                --choice is a button the human presses (--choice-text asks for',
    '                                their words too, --choice-secret for a value sealed to this',
    '                                host); Decline is always offered. Without any, the kind\'s',
    '                                defaults are offered',
  ],
  async run(context, work) {
    const { args, print } = context;
    const epoch = Number(args[0]), kind = args[1], separator = args.indexOf('--');
    const { needed, choices } = parkArgs(args.slice(2, separator < 0 ? args.length : separator));
    const reason = separator < 0 ? '' : args.slice(separator + 1).join(' ').trim();
    if (!Number.isInteger(epoch) || epoch < 1 || !humanDecisionKinds.includes(kind as HumanDecisionKind) || !needed || !reason) throw new Error(`Use park GY-N EPOCH KIND NEEDED... [--choice LABEL]... -- REASON, where KIND is ${humanDecisionKinds.join(', ')}`);
    // A credential is sealed to this host when the human provides it, so the host's key goes with the request.
    const sealTo = kind === 'credentials-for-people' || choices?.some(choice => choice.input === 'secret') ? await hostSealKey(context.individualHostId()).catch(() => undefined) : undefined;
    return print(await workMutation(context, work)('park', { epoch, kind, needed, reason, ...(choices ? { choices } : {}), ...(sealTo ? { sealTo } : {}) }));
  },
};

const choiceFlags = { '--choice': 'none', '--choice-text': 'text', '--choice-secret': 'secret' } as const;
/**
 * NEEDED and the requester's choices from the words between KIND and `--`. Each choice flag takes
 * the next word as its label; the choices become buttons in that order, each resuming the item.
 */
export function parkArgs(words: readonly string[]) {
  const needed: string[] = [], choices: HumanChoice[] = [];
  for (let index = 0; index < words.length; index++) {
    const input = choiceFlags[words[index] as keyof typeof choiceFlags];
    if (!input) { needed.push(words[index]); continue; }
    const label = words[++index]?.trim();
    if (!label || label.startsWith('--')) throw new Error(`${words[index - 1]} needs a LABEL, such as --choice "Approve up to €50/month"`);
    choices.push({ id: `choice-${choices.length + 1}`, label, outcome: 'provided', input });
  }
  return { needed: needed.join(' ').trim(), choices: choices.length ? choices : undefined };
}

/** This host's sealing key: an RSA key pair kept under the Graphyard configuration home, mode 0600; the public half is returned. */
export async function hostSealKey(hostId: string, home = configHome()) {
  const path = join(home, 'seal', `${hostId}.pem`);
  try { return (await readFile(`${path}.pub`, 'utf8')).trim(); } catch { /* first use on this host */ }
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, privateKey, { mode: 0o600, flag: 'wx' });
  await chmod(path, 0o600);
  await writeFile(`${path}.pub`, publicKey, { mode: 0o644 });
  return publicKey.trim();
}

/** Open a value sealed to this host (server/waits.ts `sealToHost`). */
export async function unsealOnHost(sealed: string, hostId: string, home = configHome()) {
  const box = JSON.parse(Buffer.from(sealed, 'base64').toString('utf8')) as { key: string; iv: string; tag: string; data: string };
  const key = privateDecrypt({ key: await readFile(join(home, 'seal', `${hostId}.pem`), 'utf8'), padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(box.key, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]).toString('utf8');
}

/** The worker half of a sealed answer: print the value the human provided, on the host it was sealed to. */
export const unsealCommand: CliCommand = {
  name: 'unseal',
  scope: 'work',
  help: ['  unseal GY-N                  Print the value the human provided for the item\'s last', '                                answered request, on the host it was sealed to'],
  async run(context, work) {
    const answered = [...((work as Work).humanRequests ?? [])].reverse().find(request => request.answer?.sealed);
    if (!answered) throw new Error(`${work.key} has no sealed answer`);
    process.stdout.write(`${await unsealOnHost(answered.answer!.sealed!, context.individualHostId())}\n`);
  },
};

/** The human half: list what waits on you, and answer it. The answer is what resumes the item. */
export const humanRequestsCommand: CliCommand = {
  name: 'human-requests',
  help: ['  human-requests               List every open human-only request: what is needed, why, how', '                                long it has waited, and the command that answers it'],
  async run({ api, print }) {
    const { now, requests } = await api('human-requests') as { now: string; requests: HumanRequestRow[] };
    return print({ observedAt: now, waiting: requests.length, requests: requests.map(row => ({ work: row.work, title: row.title, decision: row.decision, needed: row.request.needed, reason: row.request.reason,
      requestedBy: row.request.requestedBy, requestedAt: row.request.at, waited: waitedText(row.waitedMs), answer: row.answer.cli, decline: row.answer.decline })) });
  },
};
export const answerHumanCommand: CliCommand = {
  name: 'answer',
  scope: 'work',
  help: [
    '  answer GY-N [REQUEST] [--decline] ANSWER...',
    '                                Answer the item\'s open human-only request (operator). The item',
    '                                resumes on its own: the loop dispatches it on its next cycle.',
    '                                --decline keeps it parked with your reason as its blocker',
  ],
  async run(context, work) {
    const open = (work as Work).humanRequest;
    if (!open) throw new Error(`${work.key} has no open human-only request; graphyard human-requests lists the ones that wait`);
    const args = [...context.args];
    // The request id is optional on the command line: an item has at most one open request.
    const request = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args[0] ?? '') ? args.shift()! : open.id;
    const declined = args.includes('--decline');
    // The CLI keeps free words; the buttons are the page's (GY-738).
    const answer = args.filter(arg => arg !== '--decline').join(' ').trim();
    if (!answer) throw new Error('Use answer GY-N [REQUEST] [--decline] ANSWER...');
    return context.print(await workMutation(context, work)('answer', { request, outcome: declined ? 'declined' : 'provided', answer }));
  },
};
/**
 * The human operator's way into the dashboard (GY-738): a one-time link that opens a human
 * session in the browser, so no token is ever pasted into the page. Run with the operator's own
 * admin credential; the link is single use and expires in ten minutes.
 */
export const loginCommand: CliCommand = {
  name: 'login',
  help: ['  login                        Print a one-time link that signs the operator into the', '                                dashboard as a human (single use, expires in 10 minutes)'],
  async run({ api, base, print }) {
    const link = await api('sign-in-links', {}) as { code: string; principal: string; expiresAt: string };
    return print({ signIn: `${base.replace(/\/+$/, '')}/#sign-in=${link.code}`, principal: link.principal, expiresAt: link.expiresAt, singleUse: true });
  },
};
/** A wait as a person reads it: minutes under an hour, then hours, then days. */
export const waitedText = (ms: number) => ms < 3_600_000 ? `${Math.max(1, Math.round(ms / 60_000))}m` : ms < 172_800_000 ? `${Math.round(ms / 3_600_000)}h` : `${Math.round(ms / 86_400_000)}d`;

/** The session commands the CLI registers beside the master's, in the order the help prints them. */
export const sessionCommands: CliCommand[] = [scopeRequestCommand, parkCommand, humanRequestsCommand, answerHumanCommand, unsealCommand, loginCommand];
