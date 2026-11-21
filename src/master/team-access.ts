// GY-3294: this host's half of team access (src/team-access.ts). Each install's master loop, every
// 15 seconds beside the connect worker, carries the owner's teammate changes into the machine
// directory every install on this host shares and reports the machine's record back with the
// address that opens this install — its Funnel address once Funnel serves it (GY-3514).
import { fleetRequest } from '../fleet.js';
import { applyTeamChange, machineDirectory, readMachine, readTailnet, servedUrl, writeMachine, type MachineTeam, type TeamChange } from '../team-access.js';
import type { MasterConfig } from './profiles.js';

interface HostWork { repository?: string; team?: TeamChange[]; applied: { team?: string | null } }
export interface TeamAccessOptions { machineDir?: string; fetch?: typeof fetch }

export async function syncTeamAccess(config: Pick<MasterConfig, 'url' | 'credentialFile'>, options: TeamAccessOptions = {}) {
  if (!config.url) return;
  const dir = options.machineDir ?? machineDirectory(), fetcher = options.fetch ?? fetch, request = { url: config.url, credentialFile: config.credentialFile };
  const work = await fleetRequest(request, 'team-access/host', { fetch: fetcher }) as HostWork;
  // GY-3480: the node and the address serving this install come from the tailscale CLI on every pass, not from what up once recorded.
  const served = await servedUrl(new URL(config.url).port || '80'), url = served.url;
  // GY-3486: the owner's teammate changes go into the machine's roster, and this install is listed on it by its address.
  const saved = await readMachine(dir), before: MachineTeam = saved.team ?? { installs: {}, members: {} };
  let team = (work.team ?? []).reduce(applyTeamChange, before);
  if (url && work.repository && team.installs[url]?.name !== work.repository) team = { ...team, installs: { ...team.installs, [url]: { name: work.repository } } };
  if (team !== before) await writeMachine(dir, { ...saved, team });
  const machine = { ...await readMachine(dir), ...await readTailnet() };
  await fleetRequest(request, 'team-access/host', { fetch: fetcher, body: {
    dnsName: machine.dnsName ?? null, ip: machine.ip ?? null, url, public: served.public, team: machine.team ?? null,
    applied: { team: work.team?.at(-1)?.op ?? work.applied.team ?? null },
  } });
}
