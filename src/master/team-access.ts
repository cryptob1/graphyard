// GY-3294: this host's half of team access (src/team-access.ts). Each install's master loop, every
// 15 seconds beside the connect worker, carries what the owner saved on its Setup page into the
// machine directory every install on this host shares, reports the machine's record back (so every
// install shows the same link) with the address Tailscale serves this install at, and makes the single-use Tailscale device invites its server asks for.
// The Tailscale API token is opened from its sealed form, written 0600, and read only here; it is never
// sent to the control plane, printed or put in a process argument.
import { readFile, rm, stat } from 'node:fs/promises';
import { fleetRequest } from '../fleet.js';
import { atomicPrivateText } from '../private-file.js';
import { createDeviceInvite, defaultTailscaleApi, machineDirectory, readMachine, readTailnet, servedUrl, tailscaleTokenFile, writeMachine, type ShareLink } from '../team-access.js';
import { hostKeyPair, unsealToHost } from './connect-accounts.js';
import type { MasterConfig } from './profiles.js';

type Sealed = { ephemeral: string; iv: string; ciphertext: string };
interface HostWork { share: { op: string; shareLink: ShareLink } | null; token: { op: string; sealed?: Sealed; remove?: boolean } | null; deviceInvites: { id: string }[]; applied: { share: string | null; token: string | null } }
export interface TeamAccessOptions { machineDir?: string; tailscaleApi?: string; fetch?: typeof fetch; keyFile?: string }

export async function syncTeamAccess(config: Pick<MasterConfig, 'url' | 'credentialFile'>, options: TeamAccessOptions = {}) {
  if (!config.url) return;
  const dir = options.machineDir ?? machineDirectory(), fetcher = options.fetch ?? fetch, request = { url: config.url, credentialFile: config.credentialFile };
  const work = await fleetRequest(request, 'team-access/host', { fetch: fetcher }) as HostWork;
  const { privateKey, publicKey } = await hostKeyPair(config.credentialFile, options.keyFile);
  if (work.share) await writeMachine(dir, { ...await readMachine(dir), shareLink: work.share.shareLink });
  const tokenFile = tailscaleTokenFile(dir);
  if (work.token?.remove) await rm(tokenFile, { force: true });
  else if (work.token?.sealed) await atomicPrivateText(tokenFile, `${unsealToHost(privateKey, work.token.sealed).trim()}\n`);
  // GY-3480: the node and the address serving this install come from the tailscale CLI on every pass, not from what up once recorded.
  const machine = { ...await readMachine(dir), ...await readTailnet() }, url = await servedUrl(new URL(config.url).port || '80'), tokenSaved = await stat(tokenFile).then(() => true, () => false);
  for (const invite of work.deviceInvites) {
    const result = await (async () => {
      if (!tokenSaved) return { error: 'No Tailscale API token is saved on this machine' };
      if (!machine.deviceId) return { error: 'graphyard up has not recorded this machine\'s Tailscale device; rerun graphyard up' };
      const token = (await readFile(tokenFile, 'utf8')).trim();
      return createDeviceInvite({ api: options.tailscaleApi ?? process.env.GRAPHYARD_TAILSCALE_API ?? defaultTailscaleApi, token, deviceId: machine.deviceId })
        .then(url => ({ url }), (error: Error) => ({ error: error.message }));
    })();
    await fleetRequest(request, `team-access/device-invites/${invite.id}/result`, { body: result, fetch: fetcher });
  }
  await fleetRequest(request, 'team-access/host', { fetch: fetcher, body: {
    dnsName: machine.dnsName ?? null, ip: machine.ip ?? null, url, shareLink: machine.shareLink ?? null, tokenSaved, publicKey,
    applied: { share: work.share?.op ?? work.applied.share, token: work.token?.op ?? work.applied.token },
  } });
}
