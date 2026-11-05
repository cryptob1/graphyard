import { activeLease, demand } from '../../model.js';
import { liveDispatchHandleIds } from '../../model/dispatch.js';
import { recordSession, sessionObservationFields } from '../../model/sessions.js';
import type { Ctx } from './types.js';

export function run(c: Ctx) {
  const { actor, data, now, work } = c;
  demand(['worker', 'producer', 'coordinator', 'admin'].includes(actor.role), 'Worker, producer or coordinator permission required', 403);
  const existing = (work.sessions ?? []).find(handle => handle.id === data.id);
  // A launcher records the handle of a session it started under somebody else's credential,
  // and names whose: that is what lets the session itself fill in the tab and transcript
  // only it has. Naming another principal is the launch authority a coordinator already
  // holds, so nobody below it may claim a handle on another session's behalf.
  demand(!data.principal || data.principal === actor.id || actor.role === 'coordinator' || actor.role === 'admin',
    'Only a coordinator or an admin records a handle on behalf of the session it launched', 403);
  // An implementation session names the attempt it runs under and must hold that lease; a
  // reviewer or producer session holds none, and records its handle under its own identity.
  if (data.epoch !== undefined) activeLease(work, actor, data.epoch, now);
  else {
    demand(actor.role !== 'worker', 'An implementation session records its handle under its assignment epoch');
    // Creating a lease-less handle is the launch authority: a coordinator or an admin
    // records what it launched, and a session the control plane itself asked for records
    // the handle of that request. Anything else would let a credential that merely reaches
    // this item mint handles — enough of them to push a running session off a bounded list,
    // or to squat the predictable id of a session about to be launched and so take the
    // ownership its own launcher needs.
    const requested = liveDispatchHandleIds(work);
    demand(existing || ['coordinator', 'admin'].includes(actor.role) || requested.includes(data.id),
      requested.length ? `A handle without an attempt epoch is recorded by its launcher or by the session of a live dispatch request on ${work.key} (${requested.join(', ')})`
        : `A handle without an attempt epoch is recorded by its launcher; ${work.key} has no live dispatch request whose session could record one`, 403);
  }
  // An existing handle is the attach command master status and the dashboard show an
  // operator. Overwriting one — marking a running worker finished, or replacing the command
  // somebody is about to run — belongs to that session, its launcher, or an admin, never to
  // any credential that happens to reach this item.
  demand(!existing || existing.principal === actor.id || actor.role === 'coordinator' || actor.role === 'admin',
    `Session handle ${data.id} belongs to ${existing?.principal}; only that session, its launcher or an admin may update it`, 403);
  // What the loop observed of a session is the one state every reader shows (GY-172): only
  // the observer writes it, never the session it describes, and never ahead of the clock.
  demand(!sessionObservationFields.some(field => data[field] !== undefined) || actor.role === 'coordinator' || actor.role === 'admin',
    'Only the coordinator that observes sessions, or an admin, records what was observed of one', 403);
  // A running handle belongs to the launch attempt that registered it (GY-172): two launches
  // for one request racing from the same snapshot both reach this point, and the one the
  // launcher then refuses must neither close nor re-coordinate the session the other started.
  // So a launch writes only a handle no other live attempt holds; an attempt whose runtime did
  // start after its registration was refused supersedes the record, since the launcher let it run.
  demand(!data.launch || data.supersede || existing?.state !== 'running' || !existing.launch || existing.launch === data.launch,
    `Session handle ${data.id} is held by another launch attempt that is still recorded running`, 409);
  // An observation dated ahead of this clock would read fresh for good, so it is stored as of now.
  const observedAt = data.observedAt && Date.parse(data.observedAt) > now.getTime() ? now.toISOString() : data.observedAt;
  const { supersede: _supersede, ...handle } = data;
  // One worker principal runs one implementation session on an item at a time, so a launcher
  // recording that principal's session running under a new id moves it: the running record
  // the same principal held under another id — the one registered before the claim under the
  // epoch the snapshot guessed (cycle-dispatch.ts rekeyLaunchedSession, GY-1791) — is closed in
  // this same transaction, naming where the session now is. One write moves the handle, so
  // no failure between two can leave the attempt with two running handles or with none.
  if (handle.kind === 'implementation' && handle.state === 'running' && ['coordinator', 'admin'].includes(actor.role)) {
    const owner = handle.principal ?? existing?.principal ?? actor.id;
    for (const other of (work.sessions ?? []).filter(entry => entry.id !== handle.id && entry.kind === 'implementation' && entry.state === 'running' && entry.principal === owner))
      recordSession(work, { id: other.id, kind: other.kind, runtime: other.runtime, host: other.host, subject: other.subject, state: 'finished',
        outcome: `superseded: ${owner} runs one implementation session on ${work.key} at a time, and its launcher recorded that session as ${handle.id}`.slice(0, 500) }, actor.id, now);
  }
  recordSession(work, { ...handle, ...(observedAt ? { observedAt } : {}) }, actor.id, now);
}

export function delivered({ work, actor, data }: Ctx) {
  // Ending a session handle an item still carries is the other thing a delivered item accepts,
  // and only that: a review or proof session is often still running when its candidate merges,
  // and the liveness sweep must be able to close its record (GY-113). A closure is a record of
  // a runtime fact, never a decision — it decides no gate, ends no lease and binds no
  // candidate — and this one may only finish a handle the item already carries, so nothing new
  // is recorded on a delivered item and nothing it holds is reopened.
  // The loop's observation of a session still open on it is the same kind of runtime fact
  // (GY-172): a session that outlives its item's delivery is still observed, or every reader
  // would show a live session as unseen until it closed. It keeps the handle open, never reopens one.
  return work.stage === 'done'
    && (work.sessions ?? []).some(handle => handle.id === data.id
      && (data.state === 'finished' || handle.state === 'running' && data.observed !== undefined && ['coordinator', 'admin'].includes(actor.role)));
}
