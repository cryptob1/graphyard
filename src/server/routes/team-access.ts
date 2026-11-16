import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { demand } from '../../model.js';
import { defineRoutes, parseJson, type RouteContext } from '../routes.js';
import { humanSignIn } from '../auth.js';
import { sealedSchema } from './agent-registry.js';
import { aclExample, aclGuidance, installUrl, invitationMessage, missingShareGuidance, missingTailnetGuidance, shareLink, shareState, teamAccessSummary, type MachineTailnet, type ShareLink } from '../../team-access.js';
import { unownedFamilySql } from '../../store/tables/work.js';

/**
 * GY-3294: the operator's team access for this install on its machine (team-access.ts). The server
 * never reads the host's machine directory: what the owner saves here is a `team-access.*` event the
 * install's master loop carries to the machine (master/team-access.ts), and the loop's report back is
 * the mirror every install shows — so a link saved on one install appears on the others at their next sync.
 * The Tailscale API token arrives sealed to the host in the browser; only the host opens and uses it.
 */
const prefix = 'team-access.';
/** A device invite the host has not answered within this long has failed: the loop is not running. */
export const deviceInviteWaitMs = 2 * 60_000;
type Row = { kind: string; payload: any };
interface HostReport { dnsName: string | null; ip: string | null; shareLink: ShareLink | null; tokenSaved: boolean; publicKey: string | null; applied: { share: string | null; token: string | null } }
interface DeviceInvite { id: string; name: string; role: string; at: number; url: string | null; error: string | null; used: boolean }

const configuredIds = (context: RouteContext) => context.services.principals.map(entry => entry.actor.id);
const now = (context: RouteContext) => (context.services.clock ?? Date.now)();
const port = (context: RouteContext) => context.services.teamAccess?.port ?? String(context.req.socket.localPort ?? '');
const operator = (context: RouteContext) => humanSignIn(context.services).checkOperator(context.actor, configuredIds(context));
const host = (context: RouteContext) => demand(['admin', 'coordinator'].includes(context.actor.role), 'Team access is synchronized by the host\'s master loop identity', 403);
const record = (context: RouteContext, kind: string, payload: unknown) =>
  context.services.engine.store.pool.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [context.actor.id, prefix + kind, JSON.stringify(payload)]);

/** The newest events fold into: the latest host report, the latest owner changes and the device invites. */
async function fold(context: RouteContext) {
  const rows = (await context.services.engine.store.pool.query<Row>(`SELECT kind, payload FROM events WHERE ${unownedFamilySql(prefix)} ORDER BY seq DESC LIMIT 200`)).rows;
  const latest = (kind: string) => rows.find(row => row.kind === prefix + kind)?.payload;
  const report = latest('host') as HostReport | undefined;
  const share = latest('share-link') as { op: string; shareLink: ShareLink } | undefined;
  const token = latest('token') as { op: string; sealed?: unknown; remove?: boolean } | undefined;
  const invites = new Map<string, DeviceInvite>();
  for (const { kind, payload } of [...rows].reverse()) {
    if (kind === `${prefix}device-invite`) invites.set(payload.id, { ...payload, url: null, error: null, used: false });
    const invite = invites.get(payload?.id);
    if (!invite) continue;
    if (kind === `${prefix}device-invite-result`) Object.assign(invite, { url: payload.url ?? null, error: payload.error ?? null });
    if (kind === `${prefix}device-invite-used`) invite.used = true;
  }
  // The owner's newest change shows at once; once the host applied it, the machine's own record is the truth.
  const pendingShare = share && share.op !== report?.applied.share ? share : null;
  const pendingToken = token && token.op !== report?.applied.token ? token : null;
  return {
    report, invites, pendingShare, pendingToken,
    shareLink: pendingShare ? pendingShare.shareLink : report ? report.shareLink : share?.shareLink ?? null,
    tokenSaved: pendingToken ? !pendingToken.remove : !!report?.tokenSaved,
  };
}

/** GY-3415: the address the owner opens this install at — its tailnet name when the host reported one, else the address this request reached. */
export async function installAddress(context: RouteContext) {
  return installUrl((await fold(context)).report ?? {}, port(context)) ?? `http://${context.req.headers.host}`;
}

async function view(context: RouteContext) {
  operator(context);
  const state = await fold(context), machine: MachineTailnet = state.report ?? {}, share = shareState(state.shareLink, now(context));
  return {
    summary: teamAccessSummary, port: port(context), installUrl: installUrl(machine, port(context)), hostSynced: !!state.report, hostKey: state.report?.publicKey ?? null,
    mode: state.tokenSaved ? 'api' : 'reusable', shareLink: share,
    guidance: !installUrl(machine, port(context)) ? missingTailnetGuidance : !share && !state.tokenSaved ? missingShareGuidance : null,
    acl: aclExample(machine, port(context)), aclGuidance,
  };
}

const hostReportSchema = z.object({
  dnsName: z.string().max(300).nullable(), ip: z.string().max(100).nullable(), tokenSaved: z.boolean(), publicKey: z.string().max(200).nullable(),
  shareLink: z.object({ url: z.string().max(2000), createdOn: z.string().max(10), expiresAt: z.string().max(40) }).strict().nullable(),
  applied: z.object({ share: z.string().max(100).nullable(), token: z.string().max(100).nullable() }).strict(),
}).strict();

export const teamAccessRoutes = defineRoutes('team-access', [
  { method: 'GET', path: '/api/team-access', handle: view },
  { method: 'POST', path: '/api/team-access/share-link', handle: async context => {
    operator(context);
    const { url, createdOn } = await parseJson(context) as { url?: unknown; createdOn?: unknown };
    let link: ShareLink;
    try { link = shareLink(String(url ?? ''), typeof createdOn === 'string' && createdOn ? createdOn : new Date(now(context)).toISOString().slice(0, 10)); }
    catch (error) { demand(false, (error as Error).message, 400); }
    await record(context, 'share-link', { op: randomUUID(), shareLink: link! });
    return view(context);
  } },
  // The token travels sealed to the host's key (web/seal.ts) and only the host opens it; the reply says only whether one is saved.
  { method: 'POST', path: '/api/team-access/tailscale-token', handle: async context => {
    operator(context);
    const body = await parseJson(context) as { sealed?: unknown; remove?: unknown };
    if (body.remove === true) await record(context, 'token', { op: randomUUID(), remove: true });
    else await record(context, 'token', { op: randomUUID(), sealed: sealedSchema.parse(body.sealed) });
    return view(context);
  } },
  // The host's master loop: what it should apply to the machine, and what the machine holds.
  { method: 'GET', path: '/api/team-access/host', handle: async context => {
    host(context);
    const state = await fold(context), cutoff = now(context) - deviceInviteWaitMs;
    return { share: state.pendingShare, token: state.pendingToken, applied: state.report?.applied ?? { share: null, token: null }, deviceInvites: [...state.invites.values()].filter(invite => !invite.url && !invite.error && invite.at > cutoff).map(({ id }) => ({ id })) };
  } },
  { method: 'POST', path: '/api/team-access/host', handle: async context => {
    host(context);
    const report = hostReportSchema.parse(await parseJson(context));
    // Every loop reports each pass; only a change is recorded, so the ledger grows with the owner's actions alone.
    if (!isDeepStrictEqual((await fold(context)).report, report)) await record(context, 'host', report);
    return { recorded: true };
  } },
  { method: 'POST', path: /^\/api\/team-access\/device-invites\/([0-9a-f-]{36})\/result$/, handle: async (context, [id]) => {
    host(context);
    const { url, error } = await parseJson(context) as { url?: unknown; error?: unknown };
    demand((await fold(context)).invites.has(id), 'Unknown device invite', 404);
    await record(context, 'device-invite-result', typeof url === 'string' && url.startsWith('https://') ? { id, url } : { id, error: String(error ?? 'Tailscale answered without a device invite link').slice(0, 500) });
    return { id };
  } },
  { method: 'GET', path: /^\/api\/team-access\/device-invites\/([0-9a-f-]{36})$/, handle: async (context, [id]) => {
    operator(context);
    const invite = (await fold(context)).invites.get(id);
    demand(invite, 'Unknown device invite', 404);
    if (invite.url) return { id, state: 'ready' };
    if (invite.error) return { id, state: 'failed', error: `${invite.error}; no invite was made` };
    if (invite.at <= now(context) - deviceInviteWaitMs) return { id, state: 'failed', error: 'This machine\'s master loop did not make the Tailscale invite in time (is it running?); no invite was made' };
    return { id, state: 'pending' };
  } },
  /**
   * Invite someone: both links in one message. With an API token saved, the first call asks the host
   * for a single-use Tailscale invite (`pending`); the Graphyard invite is made only once Tailscale's
   * is ready (`deviceInvite`), so a refusal leaves nothing behind. `share: 'reusable'` uses the
   * machine's share link instead. Without a link (or a tailnet) the sign-in link is made but the
   * message is withheld, naming the missing step.
   */
  { method: 'POST', path: '/api/invites', handle: async context => {
    const { name, role, origin, deviceInvite, share: choice } = await parseJson(context) as { name: string; role: string; origin?: string; deviceInvite?: string; share?: string };
    const signIns = humanSignIn(context.services);
    signIns.checkInvite(context.actor, configuredIds(context), name, role);
    const state = await fold(context), machine: MachineTailnet = state.report ?? {}, url = installUrl(machine, port(context));
    let share: { url: string; kind: 'reusable' | 'single-use'; expiresAt?: string | null } | null = null;
    if (deviceInvite) {
      const invite = state.invites.get(deviceInvite);
      demand(invite?.url && !invite.used && invite.name === name && invite.role === role, 'That Tailscale invite is not ready for this person; invite again', 409);
      await record(context, 'device-invite-used', { id: deviceInvite });
      share = { url: invite.url, kind: 'single-use' };
    } else if (state.tokenSaved && url && choice !== 'reusable') {
      const id = randomUUID();
      await record(context, 'device-invite', { id, name, role, at: now(context) });
      return { pending: id };
    } else {
      const saved = shareState(state.shareLink, now(context));
      demand(saved?.state !== 'expired', `This machine's Tailscale share link expired ${saved?.expiresAt.slice(0, 10)}; make a fresh one in the Tailscale admin console and paste it on Setup, then invite again`, 409);
      if (saved) share = { url: saved.url, kind: 'reusable', expiresAt: saved.expiresAt };
    }
    const invite = await signIns.invite(context.actor, configuredIds(context), name, role);
    const base = url ?? (typeof origin === 'string' && /^https?:\/\//.test(origin) ? origin.replace(/\/$/, '') : null);
    const link = base ? `${base}/#sign-in=${invite.code}` : null;
    return { ...invite, installUrl: url, port: port(context), link, share,
      message: url && share && link ? invitationMessage({ name, role, url, port: port(context), signIn: link, signInExpiresAt: invite.expiresAt, share }) : null,
      missing: url && share ? null : !url ? missingTailnetGuidance : missingShareGuidance };
  } },
]);
