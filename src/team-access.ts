// GY-3294: team access across the installs on one Tailscale machine.
//
// One machine runs many Graphyard installs, one port each, all served on the tailnet by
// `tailscale serve --bg --http=PORT` (up.ts). The machine's Tailscale facts live in one host-owned
// directory (`~/.config/graphyard/machine`) that only the host reads: `up` records the node there and
// each install's master loop (master/team-access.ts) keeps the machine's teammate roster in it.
// GY-3514: the loop also exposes its own install, and nothing else, through Tailscale Funnel, so the
// one-link invite opens on a device with no Tailscale.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const machineDirectory = (config = process.env.GRAPHYARD_CONFIG_HOME ?? join(homedir(), '.config', 'graphyard')) => join(config, 'machine');
const machineFile = (dir: string) => join(dir, 'tailnet.json');

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
/** What the machine directory records: this host's tailnet node and the teammates. */
export interface MachineTailnet { dnsName?: string | null; ip?: string | null; deviceId?: string | null; team?: MachineTeam | null }

export async function readMachine(dir: string): Promise<MachineTailnet> {
  try { return JSON.parse(await readFile(machineFile(dir), 'utf8')) ?? {}; } catch { return {}; }
}
export async function writeMachine(dir: string, value: MachineTailnet) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(machineFile(dir), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
/** `up` records this host's tailnet node, keeping the roster. */
export async function recordMachineNode(dir: string, node: { dnsName: string | null; ip: string | null; deviceId: string | null }) {
  await writeMachine(dir, { ...await readMachine(dir), ...node });
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
type ServeStatus = { TCP?: Record<string, { HTTPS?: boolean }>; Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>; AllowFunnel?: Record<string, boolean> };
/** The public ports Tailscale Funnel accepts. */
export const funnelPorts = ['443', '8443', '10000'];
/**
 * GY-3514: the one command that puts this install on the public internet: Funnel on the first public
 * port nothing on this machine serves yet, proxying to this install's own loopback PORT and nothing else.
 */
export function funnelCommand(port: string, status: ServeStatus): string[] | null {
  const free = funnelPorts.find(candidate => !status.TCP?.[candidate]);
  return free ? ['tailscale', 'funnel', '--bg', `--https=${free}`, `http://127.0.0.1:${port}`] : null;
}
/**
 * GY-3480: the address that opens this install: a `tailscale serve` or Funnel mapping whose proxy
 * targets the server's loopback PORT (`up` serves `--http=PORT`; an owner may serve `:8447` over HTTPS
 * instead), from `tailscale serve status --json`. A Funnel address wins (`public`), then HTTPS; null when nothing serves it.
 */
function mapped(status: ServeStatus, port: string): { url: string | null; public: boolean } {
  const targets = (proxy?: string) => { try { return new URL(proxy!).port === port; } catch { return false; } };
  // GY-3486: up serves the install's serve socket on its own port number once the server opened one.
  const socketOnPort = (address: string, proxy?: string) => !!proxy?.startsWith('unix:') && address.slice(address.lastIndexOf(':') + 1) === port;
  const urls = Object.entries(status.Web ?? {}).filter(([address, web]) => Object.values(web?.Handlers ?? {}).some(handler => targets(handler?.Proxy) || socketOnPort(address, handler?.Proxy))).map(([address]) => {
    const https = !!status.TCP?.[address.slice(address.lastIndexOf(':') + 1)]?.HTTPS;
    return { url: https ? `https://${address.replace(/:443$/, '')}` : `http://${address.replace(/:80$/, '')}`, public: https && !!status.AllowFunnel?.[address] };
  });
  return urls.find(entry => entry.public) ?? urls.find(entry => entry.url.startsWith('https:')) ?? urls[0] ?? { url: null, public: false };
}
const funnelTried = new Set<string>();
/** The address that opens this install; the first time Funnel does not serve it, the loop turns Funnel on for it (`funnelCommand`). */
export async function servedUrl(port: string): Promise<{ url: string | null; public: boolean }> {
  const read = () => tailscaleJson(['serve', 'status', '--json']).then((status: ServeStatus | null) => status ?? {}, () => null);
  const status = await read();
  if (!status) return { url: null, public: false };
  const found = mapped(status, port), command = funnelCommand(port, status);
  if (found.public || funnelTried.has(port) || !command) return found;
  funnelTried.add(port);
  await promisify(execFile)(command[0], command.slice(1), { timeout: 10_000 }).catch(() => null);
  return mapped(await read() ?? status, port);
}

export const missingTailnetGuidance = (port: string) => `Tailscale is not serving this machine's port ${port}, where this install runs, so nobody else can open it. Install Tailscale (https://tailscale.com/download), sign in, and rerun graphyard up.`;
