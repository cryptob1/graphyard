<!-- page: Operate Graphyard | 11 | the role time box, the retry ladder and the cap decision. -->
# Disposable attempts

A worker attempt is disposable compute; the task, its commits and its pull request are the state.
Two rules end an attempt that cannot finish, and a bounded ladder retries what it ends.

## The role time box

Every session kind carries a maximum (`src/model/sessions.ts`): implementation 4h, review 1h,
proof 2h, coordination 12h. An implementation attempt that runs past its role's maximum without
submitting is ended within one cycle past the bound, through the same path an attempt that
blocks again after its clearance takes (GY-867):

- what it left uncommitted is kept on its branch, and the next attempt's request names that commit;
- its supervisor is stopped and its pane is closed, so no session keeps running past its box;
- the attempt ends on the record as an interruption whose reason names the run and the bound, and
  the item is dispatched again, preferring a profile on another runtime — a runtime that hung once
  is the one likeliest to hang again.

An attempt inside its box is never touched by this rule. `master status` lists overlong sessions
while they run.

## The retry ladder

Ending an attempt is not a verdict on the item, so the loop retries — bounded:

- the first retry waits **5 minutes**, the second **15 minutes** after the failure before it;
- when **three attempts in a row** have ended without submitting, the item is **held** instead of
  being redispatched again, with the cause of every ended attempt named; `master status` shows
  why attempts die, per item;
- the hold is resolved only through the **rework decision an independent approver judges**: the
  loop requests it with its operator-agent identity, launches the approver session, and never
  judges its own request. A refusal is the approver's considered judgement — the loop stops
  asking and names the recovery (`graphyard master decisions GY-N`);
- the round an applied decision approves waits the longest backoff, **45 minutes**, before it
  dispatches, and a submission breaks the row: the count is of attempts since the item last
  submitted.

Every rung of the ladder is computed from the item's own record — its capacity exhaustions and
its decision history — so a restarted daemon holds exactly what the record holds, and no local
cursor keeps an item held past what the record says.
