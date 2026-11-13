// GY-3294: one-click team access across the installs on one Tailscale machine.
//
// One machine runs many Graphyard installs, one port each, all served on the tailnet by
// `tailscale serve --bg --http=PORT` (up.ts). Two locks keep each one private: the machine's
// tailnet (a Tailscale share of this machine) and the install's own Graphyard sign-in. The machine's
// Tailscale facts live in one machine-scoped directory every install on the host reads
// (GRAPHYARD_MACHINE_DIR, `~/.config/graphyard/machine`): `up` records the node there, and the share
// link the owner pastes on one install's Setup page is saved there, so every other install shows it.
// Optionally the owner saves a Tailscale API token there (0600, never read back): each invite then
// gets its own single-use device invite instead of the reusable link.
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Tailscale expires a machine share link 30 days after it was made; Setup asks for a fresh one in its last seven. */
export const shareLinkTtlMs = 30 * 86_400_000;
export const shareRefreshMs = 7 * 86_400_000;
export const defaultTailscaleApi = 'https://api.tailscale.com';

export const machineDirectory = (config = process.env.GRAPHYARD_CONFIG_HOME ?? join(homedir(), '.config', 'graphyard')) => join(config, 'machine');
const machineFile = (dir: string) => join(dir, 'tailnet.json');
export const tailscaleTokenFile = (dir: string) => join(dir, 'tailscale-api-token');

/** What the machine directory records: this host's tailnet node and the owner's saved share link. */
export interface MachineTailnet {
  dnsName?: string | null; ip?: string | null; deviceId?: string | null;
  shareLink?: { url: string; savedAt: string } | null;
}

export async function readMachine(dir: string): Promise<MachineTailnet> {
  try { return JSON.parse(await readFile(machineFile(dir), 'utf8')) ?? {}; } catch { return {}; }
}
async function writeMachine(dir: string, value: MachineTailnet) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(machineFile(dir), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
/** `up` records this host's tailnet node, keeping the saved share link. */
export async function recordMachineNode(dir: string, node: { dnsName: string | null; ip: string | null; deviceId: string | null }) {
  await writeMachine(dir, { ...await readMachine(dir), ...node });
}

/** Saving the share link: a repeated paste of the same link keeps when it was first saved, so its expiry stays real. */
export async function saveShareLink(dir: string, url: string, now: number) {
  let parsed: URL | null = null;
  try { parsed = new URL(url.trim()); } catch { /* refused below */ }
  if (!parsed || parsed.protocol !== 'https:' || !/(^|\.)tailscale\.com$/.test(parsed.hostname)) throw new Error('Paste the https://login.tailscale.com/… share link Tailscale gave you for this machine');
  const machine = await readMachine(dir);
  const savedAt = machine.shareLink?.url === parsed.href ? machine.shareLink.savedAt : new Date(now).toISOString();
  await writeMachine(dir, { ...machine, shareLink: { url: parsed.href, savedAt } });
}

/** The owner's Tailscale API token: written 0600, removed when empty, and never answered back. */
export async function saveTailscaleToken(dir: string, token: string) {
  const file = tailscaleTokenFile(dir);
  if (!token.trim()) { await rm(file, { force: true }); return { saved: false }; }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(file, `${token.trim()}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
  return { saved: true };
}
export const tailscaleTokenSaved = async (dir: string) => stat(tailscaleTokenFile(dir)).then(() => true, () => false);

export type ShareState = { url: string; savedAt: string; expiresAt: string; state: 'ok' | 'refresh' | 'expired' };
export function shareState(link: MachineTailnet['shareLink'], now: number): ShareState | null {
  if (!link) return null;
  const expires = Date.parse(link.savedAt) + shareLinkTtlMs;
  return { ...link, expiresAt: new Date(expires).toISOString(), state: expires <= now ? 'expired' : expires - now <= shareRefreshMs ? 'refresh' : 'ok' };
}

/** This install's address on the tailnet: the machine's name and the install's own port. */
export const installUrl = (machine: MachineTailnet, port: number | string) => {
  const host = machine.dnsName?.replace(/\.$/, '') || machine.ip;
  return host ? `http://${host}${String(port) === '80' ? '' : `:${port}`}` : null;
};

/** Optional tailnet policy: people this machine is shared with reach this install's port alone. */
export const aclExample = (machine: MachineTailnet, port: number | string) =>
  JSON.stringify({ grants: [{ src: ['autogroup:shared'], dst: [machine.ip ?? machine.dnsName?.replace(/\.$/, '') ?? 'THIS-MACHINE'], ip: [`tcp:${port}`] }] }, null, 2);

export const teamAccessSummary = 'One machine, many installs, one port each. Two locks keep each install private: the machine\'s tailnet (Tailscale), then this install\'s own Graphyard sign-in.';
export const missingShareGuidance = 'No Tailscale share link is saved for this machine yet. In the Tailscale admin console open Machines, choose this machine, pick Share, copy the link and paste it here; every install on this machine then uses it.';

/**
 * The one invitation message Setup copies: both links, the install it opens and both expiries, so the
 * person invited needs nothing else. Tailscale's share link and Graphyard's sign-in link expire separately.
 */
export function invitationMessage(input: { name: string; role: string; url: string; port: number | string; signIn: string; signInExpiresAt: string; share: { url: string; kind: 'reusable' | 'single-use'; expiresAt?: string | null } | null }) {
  const tailscale = !input.share ? 'Tailscale: the owner has not saved this machine\'s share link yet; ask them to share the machine with you on Tailscale.'
    : `${input.share.url} (Tailscale share link, ${input.share.kind === 'single-use' ? 'single use, made for you' : `reusable, Tailscale expires it ${input.share.expiresAt?.slice(0, 10)}`})`;
  return [
    `Hi ${input.name}, you are invited to Graphyard at ${input.url} as ${input.role}.`,
    `One machine runs several Graphyard installs, one port each; this invite opens port ${input.port} only.`,
    'Two locks keep it private:',
    `1. Join the machine's tailnet: ${tailscale}`,
    `2. Sign in to this install: ${input.signIn} (Graphyard invite, single use, expires in 24 hours, at ${input.signInExpiresAt}).`,
  ].join('\n');
}

/**
 * The optional API path: one single-use device invite for this machine, made with the owner's token.
 * Throws a plain reason, never the token, when Tailscale refuses or answers without an invite URL.
 */
export async function createDeviceInvite(input: { api: string; token: string; deviceId: string; fetch?: typeof fetch }) {
  const response = await (input.fetch ?? fetch)(`${input.api.replace(/\/$/, '')}/api/v2/device/${encodeURIComponent(input.deviceId)}/device-invites`, {
    method: 'POST', headers: { Authorization: `Bearer ${input.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([{ multiUse: false, allowExitNode: false }]),
  }).catch((error: Error) => { throw new Error(`Tailscale could not be reached (${error.message})`); });
  const body = await response.json().catch(() => null) as { inviteUrl?: string }[] | { message?: string } | null;
  if (!response.ok) throw new Error(`Tailscale refused the device invite (${response.status}${body && !Array.isArray(body) && body.message ? `: ${String(body.message).slice(0, 200)}` : ''})`);
  const url = Array.isArray(body) ? body[0]?.inviteUrl : undefined;
  if (typeof url !== 'string' || !url.startsWith('https://')) throw new Error('Tailscale answered without a device invite link');
  return url;
}
