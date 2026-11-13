import { readFile } from 'node:fs/promises';
import { demand } from '../../model.js';
import { defineRoutes, parseJson, type RouteContext } from '../routes.js';
import { humanSignIn } from '../auth.js';
import { aclExample, createDeviceInvite, installUrl, invitationMessage, missingShareGuidance, readMachine, saveShareLink, saveTailscaleToken, shareState, tailscaleTokenFile, tailscaleTokenSaved, teamAccessSummary } from '../../team-access.js';

/** GY-3294: the operator's team access for this install on its machine (team-access.ts): the shared link, the optional API token, and invites carrying both locks. */
const configuredIds = (context: RouteContext) => context.services.principals.map(entry => entry.actor.id);
const settings = (context: RouteContext) => {
  const access = context.services.teamAccess ?? { machineDir: null, tailscaleApi: '', port: null };
  return { ...access, port: access.port ?? String(context.req.socket.localPort ?? ''), now: (context.services.clock ?? Date.now)() };
};
const machineDir = (context: RouteContext) => {
  const dir = settings(context).machineDir;
  demand(!!dir, 'This install has no machine directory to share Tailscale settings through; rerun graphyard up on its machine', 409);
  return dir!;
};

async function view(context: RouteContext) {
  humanSignIn(context.services).checkOperator(context.actor, configuredIds(context));
  const { machineDir: dir, port, now } = settings(context);
  const machine = dir ? await readMachine(dir) : {};
  const share = shareState(machine.shareLink, now);
  return {
    summary: teamAccessSummary, port, installUrl: installUrl(machine, port), tailnet: !!installUrl(machine, port),
    mode: dir && await tailscaleTokenSaved(dir) ? 'api' : 'reusable', shareLink: share, guidance: share ? null : missingShareGuidance, acl: aclExample(machine, port),
  };
}

export const teamAccessRoutes = defineRoutes('team-access', [
  { method: 'GET', path: '/api/team-access', handle: view },
  { method: 'POST', path: '/api/team-access/share-link', handle: async context => {
    humanSignIn(context.services).checkOperator(context.actor, configuredIds(context));
    const { url } = await parseJson(context) as { url?: unknown };
    try { await saveShareLink(machineDir(context), String(url ?? ''), settings(context).now); } catch (error) { demand(false, (error as Error).message, 400); }
    return view(context);
  } },
  // The token is written and never answered back: the reply says only whether one is saved.
  { method: 'POST', path: '/api/team-access/tailscale-token', handle: async context => {
    humanSignIn(context.services).checkOperator(context.actor, configuredIds(context));
    const { token } = await parseJson(context) as { token?: unknown };
    demand(typeof token === 'string' && token.length <= 500 && !/[\s]/.test(token.trim()), 'Paste the Tailscale API access token as one line', 400);
    await saveTailscaleToken(machineDir(context), token as string);
    return view(context);
  } },
  // Invite someone: both links in one action. In API mode Tailscale's single-use invite is made first, so a refusal leaves no Graphyard invite behind.
  { method: 'POST', path: '/api/invites', handle: async context => {
    const { name, role, origin } = await parseJson(context) as { name: string; role: string; origin?: string };
    const signIns = humanSignIn(context.services);
    signIns.checkInvite(context.actor, configuredIds(context), name, role);
    const { machineDir: dir, port, now, tailscaleApi } = settings(context);
    const machine = dir ? await readMachine(dir) : {};
    let share: { url: string; kind: 'reusable' | 'single-use'; expiresAt?: string | null } | null = null;
    if (dir && await tailscaleTokenSaved(dir)) {
      demand(!!machine.deviceId, 'The Tailscale API token is saved, but graphyard up has not recorded this machine\'s Tailscale device yet; rerun graphyard up, then invite again', 409);
      const token = (await readFile(tailscaleTokenFile(dir), 'utf8')).trim();
      try { share = { url: await createDeviceInvite({ api: tailscaleApi, token, deviceId: machine.deviceId! }), kind: 'single-use' }; }
      catch (error) { demand(false, `${(error as Error).message}; no invite was made. Fix the token on Setup, or remove it to use the machine's share link`, 502); }
    } else {
      const saved = shareState(machine.shareLink, now);
      demand(saved?.state !== 'expired', `This machine's Tailscale share link expired ${saved?.expiresAt.slice(0, 10)}; make a fresh one in the Tailscale admin console and paste it on Setup, then invite again`, 409);
      if (saved) share = { url: saved.url, kind: 'reusable', expiresAt: saved.expiresAt };
    }
    const invite = await signIns.invite(context.actor, configuredIds(context), name, role);
    const url = installUrl(machine, port) ?? (typeof origin === 'string' && /^https?:\/\//.test(origin) ? origin.replace(/\/$/, '') : `http://127.0.0.1:${port}`);
    const link = `${url}/#sign-in=${invite.code}`;
    return { ...invite, installUrl: url, port, link, share, message: invitationMessage({ name, role, url, port, signIn: link, signInExpiresAt: invite.expiresAt, share }) };
  } },
]);
