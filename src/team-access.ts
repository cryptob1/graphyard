// GY-3294: one-click team access across the installs on one Tailscale machine.
//
// One machine runs many Graphyard installs, one port each, all served on the tailnet by
// `tailscale serve --bg --http=PORT` (up.ts). Two locks keep each one private: the machine's
// tailnet (a Tailscale share of this machine, reaching it as far as the tailnet policy allows) and
// the install's own Graphyard sign-in. The machine's Tailscale facts live in one host-owned directory
// (`~/.config/graphyard/machine`) that only the host reads: `up` records the node there, and each
// install's master loop (master/team-access.ts) carries the share link the owner saved on its Setup
// page into it and reports it back, so every install on the machine shows the same link. Servers
// never read that directory. Optionally the owner saves a Tailscale API token there (0600, sealed to
// the host in the browser, never read back): the host then makes one single-use device invite per invite.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Tailscale expires an unused machine share link 30 days after it was made; Setup asks for a fresh one in its last seven. */
export const shareLinkTtlMs = 30 * 86_400_000;
export const shareRefreshMs = 7 * 86_400_000;
export const defaultTailscaleApi = 'https://api.tailscale.com';

export const machineDirectory = (config = process.env.GRAPHYARD_CONFIG_HOME ?? join(homedir(), '.config', 'graphyard')) => join(config, 'machine');
const machineFile = (dir: string) => join(dir, 'tailnet.json');
export const tailscaleTokenFile = (dir: string) => join(dir, 'tailscale-api.token');

/** The share link the owner pasted, with the day it was made (the owner says; a URL does not prove its age) and so when Tailscale expires it. */
export interface ShareLink { url: string; createdOn: string; expiresAt: string }
/**
 * GY-3486: the machine's teammates, one row per Tailscale login with the installs it may open, and
 * the installs on this machine by the address the tailnet opens them at, which each install's loop records.
 */
export interface MachineTeam { installs: Record<string, { name: string }>; members: Record<string, { role: string; installs: string[] }> }
export type TeamChange = { op: string; login: string; role: string; installs: string[] } | { op: string; login: string; remove: true };
export function applyTeamChange(team: MachineTeam, change: TeamChange): MachineTeam {
  const members = { ...team.members };
  if ('remove' in change) delete members[change.login];
  else members[change.login] = { role: change.role, installs: [...new Set([...members[change.login]?.installs ?? [], ...change.installs])] };
  return { ...team, members };
}
/** What the machine directory records: this host's tailnet node, the owner's saved share link and the teammates. */
export interface MachineTailnet { dnsName?: string | null; ip?: string | null; deviceId?: string | null; shareLink?: ShareLink | null; team?: MachineTeam | null }

export async function readMachine(dir: string): Promise<MachineTailnet> {
  try { return JSON.parse(await readFile(machineFile(dir), 'utf8')) ?? {}; } catch { return {}; }
}
export async function writeMachine(dir: string, value: MachineTailnet) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(machineFile(dir), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
/** `up` records this host's tailnet node, keeping the saved share link. */
export async function recordMachineNode(dir: string, node: { dnsName: string | null; ip: string | null; deviceId: string | null }) {
  await writeMachine(dir, { ...await readMachine(dir), ...node });
}

/** A pasted share link and the day it was made (YYYY-MM-DD, today unless the owner says otherwise). */
export function shareLink(url: string, createdOn: string): ShareLink {
  let parsed: URL | null = null;
  try { parsed = new URL(url.trim()); } catch { /* refused below */ }
  if (!parsed || parsed.protocol !== 'https:' || !/(^|\.)tailscale\.com$/.test(parsed.hostname)) throw new Error('Paste the https://login.tailscale.com/… share link Tailscale gave you for this machine');
  const made = Date.parse(`${createdOn}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(createdOn) || Number.isNaN(made)) throw new Error('Give the day the share link was made as YYYY-MM-DD');
  return { url: parsed.href, createdOn, expiresAt: new Date(made + shareLinkTtlMs).toISOString() };
}

export type ShareState = ShareLink & { state: 'ok' | 'refresh' | 'expired' };
export function shareState(link: ShareLink | null | undefined, now: number): ShareState | null {
  if (!link) return null;
  const expires = Date.parse(link.expiresAt);
  return { ...link, state: expires <= now ? 'expired' : expires - now <= shareRefreshMs ? 'refresh' : 'ok' };
}

/** The loop asks every pass, so a slow tailscale never blocks it: bounded, and off the event loop. */
const tailscaleJson = async (args: string[]) => JSON.parse((await promisify(execFile)('tailscale', args, { encoding: 'utf8', timeout: 10_000 })).stdout);
/** This host's Tailscale node from `tailscale status --json`; no Tailscale, or one not running, is no tailnet (the install carries on locally). */
export async function readTailnet(): Promise<{ dnsName: string | null; ip: string | null; deviceId: string | null } | null> {
  try {
    const self = (await tailscaleJson(['status', '--json']))?.Self;
    if (!self || self.Online === false) return null;
    const ip = Array.isArray(self?.TailscaleIPs) ? self.TailscaleIPs.find((address: unknown) => typeof address === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(address)) ?? null : null;
    const deviceId = typeof self?.ID === 'string' && self.ID ? self.ID : null;
    return typeof self?.DNSName === 'string' || ip ? { dnsName: typeof self?.DNSName === 'string' && self.DNSName ? self.DNSName : null, ip, deviceId } : null;
  } catch { return null; }
}
/**
 * GY-3480: the address the tailnet opens this install at: the `tailscale serve` mapping whose proxy
 * targets the server's loopback PORT (`up` serves `--http=PORT`; an owner may serve `:8447` over HTTPS
 * instead), from `tailscale serve status --json`. HTTPS wins when both serve it; null when nothing does.
 */
export async function servedUrl(port: string): Promise<string | null> {
  let config: { TCP?: Record<string, { HTTPS?: boolean }>; Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> };
  try { config = await tailscaleJson(['serve', 'status', '--json']) ?? {}; } catch { return null; }
  const targets = (proxy?: string) => { try { return new URL(proxy!).port === port; } catch { return false; } };
  // GY-3486: up serves the install's serve socket on its own port number once the server opened one.
  const socketOnPort = (address: string, proxy?: string) => !!proxy?.startsWith('unix:') && address.slice(address.lastIndexOf(':') + 1) === port;
  const urls = Object.entries(config.Web ?? {}).filter(([address, web]) => Object.values(web?.Handlers ?? {}).some(handler => targets(handler?.Proxy) || socketOnPort(address, handler?.Proxy))).map(([address]) => {
    const https = !!config.TCP?.[address.slice(address.lastIndexOf(':') + 1)]?.HTTPS;
    return https ? `https://${address.replace(/:443$/, '')}` : `http://${address.replace(/:80$/, '')}`;
  });
  return urls.find(url => url.startsWith('https:')) ?? urls[0] ?? null;
}

/** Optional tailnet policy: the teammate reaches this machine on this install's port alone. */
export const aclExample = (machine: MachineTailnet, port: number | string) =>
  JSON.stringify({ grants: [{ src: ['TEAMMATE@example.com'], dst: [machine.ip ?? machine.dnsName?.replace(/\.$/, '') ?? 'THIS-MACHINE'], ip: [`tcp:${port}`] }] }, null, 2);
export const aclGuidance = 'Replace TEAMMATE@example.com with the person\'s Tailscale login. This grant only adds access: broader grants already in your tailnet policy (a catch-all rule, autogroup:shared, a group they belong to) still apply, and this snippet does not revoke them, so review those too.';

export const teamAccessSummary = 'One machine, many installs, one port each. Two locks: the Tailscale share lets a person\'s devices reach this machine (as far as your tailnet policy allows), and each install still needs its own Graphyard sign-in.';
export const missingShareGuidance = 'No Tailscale share link is saved for this machine yet, so Invite cannot make a complete message. In the Tailscale admin console open Machines, choose this machine, pick Share, copy the link and paste it here; every install on this machine then uses it.';
export const missingTailnetGuidance = (port: string) => `Tailscale is not serving this machine's port ${port}, where this install runs, so nobody else can open it. Install Tailscale (https://tailscale.com/download), sign in, and rerun graphyard up.`;

/**
 * The one invitation message Setup copies: both links, the install it opens and both expiries, so the
 * person invited needs nothing else. Tailscale's share link and Graphyard's sign-in link expire separately.
 */
export function invitationMessage(input: { name: string; role: string; url: string; port: number | string; signIn: string; signInExpiresAt: string; share: { url: string; kind: 'reusable' | 'single-use'; expiresAt?: string | null } }) {
  const kind = input.share.kind === 'single-use' ? 'single-use Tailscale invite, made for you' : `reusable Tailscale share link; Tailscale expires it ${input.share.expiresAt?.slice(0, 10)}`;
  return [
    `Hi ${input.name}, you are invited to Graphyard at ${input.url} as ${input.role}.`,
    `One machine runs several Graphyard installs, one port each; this one is on port ${input.port}.`,
    'Two locks:',
    `1. Tailscale: accept this machine share: ${input.share.url} (${kind}). It lets your devices reach this machine, as far as the owner's tailnet policy allows.`,
    `2. Graphyard: sign in to this install: ${input.signIn} (Graphyard invite, single use, expires in 24 hours, at ${input.signInExpiresAt}). Each install has its own sign-in; this one does not sign you in to the others.`,
  ].join('\n');
}

/** GY-3486: the one message Invite copies: Tailscale's share and each install's address; the person's Tailscale login is their sign-in. */
export function teamInvitation(input: { logins: string[]; role: string; installs: string[]; share: { url: string; kind: 'reusable' | 'single-use' | 'multi-use' } }) {
  const kind = { reusable: 'reusable share link', 'single-use': 'single-use invite, made for you', 'multi-use': 'invite made for the people named here' }[input.share.kind];
  return [
    `Hi ${input.logins.join(', ')}, you are invited to Graphyard as ${input.role}.`,
    `1. Accept this Tailscale share of the machine: ${input.share.url} (${kind}).`,
    `2. Open ${input.installs.length > 1 ? 'these installs' : 'this install'} on a device signed in to Tailscale as yourself:`,
    ...input.installs.map(url => `   ${url}`),
    'Tailscale signs you in; there is no other link or password.',
  ].join('\n');
}

/**
 * The optional API path: one single-use device invite for this machine, made by the host with the owner's token.
 * Throws a plain reason, never the token, when Tailscale refuses or answers without an invite URL.
 */
export async function createDeviceInvite(input: { api: string; token: string; deviceId: string; multiUse?: boolean; fetch?: typeof fetch }) {
  const response = await (input.fetch ?? fetch)(`${input.api.replace(/\/$/, '')}/api/v2/device/${encodeURIComponent(input.deviceId)}/device-invites`, {
    method: 'POST', headers: { Authorization: `Bearer ${input.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([{ multiUse: !!input.multiUse, allowExitNode: false }]), signal: AbortSignal.timeout(30_000),
  }).catch((error: Error) => { throw new Error(`Tailscale could not be reached (${error.message})`); });
  const body = await response.json().catch(() => null) as { inviteUrl?: string }[] | { message?: string } | null;
  if (!response.ok) throw new Error(`Tailscale refused the device invite (${response.status}${body && !Array.isArray(body) && body.message ? `: ${String(body.message).slice(0, 200)}` : ''})`);
  const url = Array.isArray(body) ? body[0]?.inviteUrl : undefined;
  if (typeof url !== 'string' || !url.startsWith('https://')) throw new Error('Tailscale answered without a device invite link');
  return url;
}
