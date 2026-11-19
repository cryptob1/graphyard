import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { demand } from '../../model.js';
import { defineRoutes, parseJson, type RouteContext } from '../routes.js';
import { humanSignIn } from '../auth.js';
import { sealedSchema } from './agent-registry.js';
import { aclExample, aclGuidance, applyTeamChange, invitationMessage, missingShareGuidance, missingTailnetGuidance, shareLink, shareState, teamAccessSummary, teamInvitation, type MachineTailnet, type MachineTeam, type ShareLink, type TeamChange } from '../../team-access.js';
import { teamRoles } from '../principals.js';
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
interface HostReport { dnsName: string | null; ip: string | null; url?: string | null; shareLink: ShareLink | null; tokenSaved: boolean; publicKey: string | null; team?: MachineTeam | null; applied: { share: string | null; token: string | null; team?: string | null } }
interface DeviceInvite { id: string; name?: string; logins?: string[]; multiUse?: boolean; role: string; at: number; url: string | null; error: string | null; used: boolean }

const configuredIds = (context: RouteContext) => context.services.principals.map(entry => entry.actor.id);
const now = (context: RouteContext) => (context.services.clock ?? Date.now)();
const port = (context: RouteContext) => context.services.teamAccess?.port ?? String(context.req.socket.localPort ?? '');
/** GY-3480: the port the tailnet reaches this install on — the served address's own (`:8447`) once the host reported one, else the server's. */
const tailnetPort = (url: string | null, context: RouteContext) => url ? new URL(url).port || (url.startsWith('https:') ? '443' : '80') : port(context);
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
  // GY-3486: teammate changes after the last one the host applied to the machine's roster, oldest first.
  const changes = rows.filter(row => row.kind === `${prefix}team`).map(row => row.payload as TeamChange).reverse();
  const pendingTeam = changes.slice(changes.findIndex(change => change.op === report?.applied.team) + 1);
  return {
    report, invites, pendingShare, pendingToken, pendingTeam,
    team: pendingTeam.reduce(applyTeamChange, report?.team ?? { installs: {}, members: {} }),
    shareLink: pendingShare ? pendingShare.shareLink : report ? report.shareLink : share?.shareLink ?? null,
    tokenSaved: pendingToken ? !pendingToken.remove : !!report?.tokenSaved,
  };
}

async function view(context: RouteContext) {
  operator(context);
  const state = await fold(context), machine: MachineTailnet = state.report ?? {}, share = shareState(state.shareLink, now(context));
  const url = state.report?.url ?? null, served = tailnetPort(url, context);
  return {
    summary: teamAccessSummary, port: served, installUrl: url, hostSynced: !!state.report, hostKey: state.report?.publicKey ?? null,
    mode: state.tokenSaved ? 'api' : 'reusable', shareLink: share,
    guidance: !url ? missingTailnetGuidance(port(context)) : !share && !state.tokenSaved ? missingShareGuidance : null,
    acl: aclExample(machine, served), aclGuidance, tokenSaved: state.tokenSaved,
    installs: url ? Object.entries({ [url]: { name: context.services.repository }, ...state.team.installs }).map(([address, { name }]) => ({ url: address, name })) : [{ url: '', name: context.services.repository }],
    teammates: await teammates(context, state.team, url),
  };
}

/** GY-3486: every teammate: the machine's roster, and those invited to this install alone (`graphyard invite`). */
async function teammates(context: RouteContext, team: MachineTeam, url: string | null) {
  const local = (await context.services.engine.store.pool.query<{ name: string; team: string }>('SELECT name, team FROM team_members ORDER BY name')).rows;
  const listed = Object.entries(team.members).map(([login, member]) => ({ login, role: member.role, installs: member.installs }));
  for (const row of local) if (!team.members[row.name]) listed.push({ login: row.name, role: row.team, installs: url ? [url] : [] });
  return listed.sort((x, y) => x.login.localeCompare(y.login));
}
const members = (report: HostReport | undefined) => new Map(report?.url ? Object.entries(report.team?.members ?? {}).filter(([, member]) => member.installs.includes(report.url!)).map(([login, member]) => [login, member.role]) : []);

const hostReportSchema = z.object({
  dnsName: z.string().max(300).nullable(), ip: z.string().max(100).nullable(), url: z.string().url().max(400).nullable().optional(), tokenSaved: z.boolean(), publicKey: z.string().max(200).nullable(),
  shareLink: z.object({ url: z.string().max(2000), createdOn: z.string().max(10), expiresAt: z.string().max(40) }).strict().nullable(),
  team: z.object({
    installs: z.record(z.string().max(400), z.object({ name: z.string().max(300) }).strict()),
    members: z.record(z.string().max(100), z.object({ role: z.enum(teamRoles), installs: z.array(z.string().max(400)).max(50) }).strict()),
  }).strict().nullable().optional(),
  applied: z.object({ share: z.string().max(100).nullable(), token: z.string().max(100).nullable(), team: z.string().max(100).nullable().optional() }).strict(),
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
    return { repository: context.services.repository, share: state.pendingShare, token: state.pendingToken, team: state.pendingTeam, applied: state.report?.applied ?? { share: null, token: null, team: null },
      deviceInvites: [...state.invites.values()].filter(invite => !invite.url && !invite.error && invite.at > cutoff).map(({ id, multiUse }) => ({ id, multiUse: !!multiUse })) };
  } },
  { method: 'POST', path: '/api/team-access/host', handle: async context => {
    host(context);
    const report = hostReportSchema.parse(await parseJson(context));
    // Every loop reports each pass; only a change is recorded, so the ledger grows with the owner's actions alone.
    const previous = (await fold(context)).report;
    if (isDeepStrictEqual(previous, report)) return { recorded: true };
    // GY-3486: the machine's roster admits and removes this install's teammates; one invited here alone is left as it is.
    const signIns = humanSignIn(context.services), before = members(previous);
    for (const [login, role] of members(report)) if (before.get(login) !== role) await signIns.admit(login, role, 'machine');
    for (const login of before.keys()) if (!members(report).has(login)) await signIns.remove(login);
    await record(context, 'host', report);
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
    const body = await parseJson(context) as { name: string; logins?: unknown; role: string; origin?: string; deviceInvite?: string; share?: string; installs?: unknown };
    if (body.logins !== undefined) return inviteLogins(context, body);
    const { name, role, origin, deviceInvite, share: choice } = body;
    const signIns = humanSignIn(context.services);
    signIns.checkInvite(context.actor, configuredIds(context), name, role);
    const state = await fold(context), url = state.report?.url ?? null, served = tailnetPort(url, context);
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
    return { ...invite, installUrl: url, port: served, link, share,
      message: url && share && link ? invitationMessage({ name, role, url, port: served, signIn: link, signInExpiresAt: invite.expiresAt, share }) : null,
      missing: url && share ? null : !url ? missingTailnetGuidance(port(context)) : missingShareGuidance };
  } },
  // Revoke removes the teammate from every install on the machine and ends their sessions here at once.
  { method: 'POST', path: /^\/api\/invites\/([^/]+)\/revoke$/, handle: async (context, [encoded]) => {
    const name = decodeURIComponent(encoded);
    operator(context);
    const listed = !!(await fold(context)).team.members[name];
    if (listed) await record(context, 'team', { op: randomUUID(), login: name, remove: true });
    const local = (await context.services.engine.store.pool.query('SELECT 1 FROM team_members WHERE name=$1', [name])).rowCount;
    return listed && !local ? { revoked: name, sessionsEnded: 0 } : humanSignIn(context.services).revoke(context.actor, configuredIds(context), name);
  } },
]);

const noShareGuidance = 'Tailscale access is missing from this message: paste a Tailscale API token above, then invite again.';
/**
 * GY-3486: Invite from the top bar. Each Tailscale login becomes a teammate row on the chosen installs
 * of this machine (here at once, the others through the machine's roster at their loop's next pass),
 * and one message carries Tailscale's share and each install's address. With an API token saved the
 * host first makes one device invite, multi-use for several people; nothing is recorded if it fails.
 */
async function inviteLogins(context: RouteContext, body: { logins?: unknown; role: string; installs?: unknown; deviceInvite?: string }) {
  operator(context);
  const logins = Array.isArray(body.logins) ? [...new Set(body.logins.map(login => String(login).trim()).filter(Boolean))] : [];
  demand(logins.length >= 1 && logins.length <= 20, 'Name 1-20 Tailscale logins, such as ana@example.com', 400);
  for (const login of logins) humanSignIn(context.services).checkInvite(context.actor, configuredIds(context), login, body.role);
  const state = await fold(context), url = state.report?.url ?? null;
  const installs = Array.isArray(body.installs) ? body.installs.filter((entry): entry is string => typeof entry === 'string') : [];
  demand(installs.length, 'Choose at least one install', 400);
  let share: { url: string; kind: 'reusable' | 'single-use' | 'multi-use' } | null = null;
  if (body.deviceInvite) {
    const invite = state.invites.get(body.deviceInvite);
    demand(invite?.url && !invite.used && isDeepStrictEqual(invite.logins, logins) && invite.role === body.role, 'That Tailscale invite is not ready for these people; invite again', 409);
    await record(context, 'device-invite-used', { id: body.deviceInvite });
    share = { url: invite.url, kind: invite.multiUse ? 'multi-use' : 'single-use' };
  } else if (state.tokenSaved && url) {
    const id = randomUUID();
    await record(context, 'device-invite', { id, logins, role: body.role, multiUse: logins.length > 1, at: now(context) });
    return { pending: id };
  } else {
    const saved = shareState(state.shareLink, now(context));
    demand(saved?.state !== 'expired', `This machine's Tailscale share link expired ${saved?.expiresAt.slice(0, 10)}; paste a Tailscale API token in Invite, then invite again`, 409);
    if (saved) share = { url: saved.url, kind: 'reusable' };
  }
  const addresses = installs.filter(Boolean);
  for (const login of logins) {
    if (addresses.length) await record(context, 'team', { op: randomUUID(), login, role: body.role, installs: addresses });
    if (installs.includes(url ?? '')) await humanSignIn(context.services).admit(login, body.role, context.actor.id);
  }
  return {
    invited: logins, role: body.role,
    message: share && addresses.length ? teamInvitation({ logins, role: body.role, installs: addresses, share }) : null,
    missing: !url ? missingTailnetGuidance(port(context)) : !share ? noShareGuidance : null,
    teammates: (await view(context)).teammates,
  };
}
