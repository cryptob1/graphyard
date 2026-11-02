// Concern: the master agent's role instructions, printed by `graphyard master guide`, and the
// migration that removes the graphyard-master block earlier master inits wrote into AGENTS.md.

const masterStart = '<!-- graphyard-master -->', masterEnd = '<!-- /graphyard-master -->';

/**
 * The master session's own rules. They once lived in a graphyard-master block of the managed
 * repository's AGENTS.md, which every worker, reviewer and producer session loads; only the master
 * needs them, and its first request runs `graphyard master guide`, which prints them (GY-1493).
 */
export const masterInstructions = `## Graphyard master agent

The recommended coordinator is a dedicated, visible master-agent session. It does
not implement work, hold worker leases, submit evidence, or bypass gates. Run
\`graphyard master status\` at startup and after every material event. Graphyard is
the source of assignment and progression truth; Herdr supplies live session health.

Autonomy is the default: act without asking. The operator sets goals; agents make
every other call. Only three decisions are human: goals and priorities, spending money
or opening third-party accounts, and issuing credentials to people. You apply every
other decision at once with your own operator-agent identity: \`graphyard master
create|release|unblock|requirements|rework|attest|close\`. Never ask a human to run a command an agent identity may run: \`master
status\` names who resolves each attention item and the next command.

Dispatch only ready work with \`graphyard master dispatch GY-N PROFILE\`. The
worker must claim the item under its own identity and use the assigned worktree.
Treat prompt delivery as an invitation, never as ownership. Use durable handoffs
when an agent, provider account, machine, or context window changes.

Review and proof collection start on their own. When a candidate passes the build gate
the control plane records a review request and one producer request per proof group,
each bound to the exact head, base and policy revision, and \`graphyard master run\`
launches the configured reviewer profile and a producer session for each of them within
30 seconds, without a keystroke. A head change cancels those
sessions and requests the new head afresh unless the carry rules carried the
approval or the proof. You handle
findings, rework and merges; you never launch reviews or producers by hand. \`master
status\` shows, per candidate, what is requested, what is running and since when, and
any launch the loop refused; \`graphyard master review GY-N [PROFILE]\` is the recovery
path for a refused reviewer launch once its cause is fixed. Never approve a candidate
yourself, and never submit evidence.

Keep cycling: status, dispatch ready work, shepherd review, record what the merge
writer's trial and push landed. Repeat until both conditions hold:
(1) every in-scope item is Done or has a genuinely external blocker recorded in
Graphyard; and (2) the release health line in \`master status\` is healthy, or a
genuinely external deployment blocker is recorded in Graphyard as a follow-up work item.
An item is delivered at merge; release health is one status line. Ordinary review findings, rework,
idle workers, and proof setup are not stopping conditions. Close finished agent
sessions as part of the cycle.

Items are system-driven unless created with \`"systemDriven": false\`: for them
\`graphyard master run\` dispatches and launches review, and the master CLI refuses those
hand actions, naming the loop step. The loop drives an item created \`"systemDriven": false\`
the same way; opting out only also allows the hand actions, so check master status
for the loop's pending step before taking one and never request a second.
The control plane merges: the loop's merge writer trial-merges a submitted head whose
gates pass, runs its proofs and pushes it to the base branch with its deploy key. GitHub
merges nothing and no pull request is opened. A merge of a head whose gates had not passed is held
as a violation; file the follow-up that re-verifies what it skipped.
Never use an administrative merge bypass, edit a candidate, or read a
worker credential. Read \`docs/master-agent.md\`
in Graphyard or run \`graphyard master guide\` for the complete operating loop.
`;

/**
 * AGENTS.md without its graphyard-master block: exactly the markers and what lies between them are
 * removed, every byte outside them kept. Malformed or duplicate markers are refused, naming the file.
 */
export function withoutMasterInstructions(existing: string) {
  const starts = existing.split(masterStart).length - 1, ends = existing.split(masterEnd).length - 1;
  if (starts !== ends || starts > 1 || starts === 1 && existing.indexOf(masterEnd) < existing.indexOf(masterStart)) throw new Error('Malformed or duplicate Graphyard master markers; resolve them before updating AGENTS.md');
  return starts ? existing.slice(0, existing.indexOf(masterStart)) + existing.slice(existing.indexOf(masterEnd) + masterEnd.length) : existing;
}

/**
 * @deprecated The name of the AGENTS.md block renderer this replaced. A CLI released before GY-1493
 * still loads it from the merged tree when sync regenerates a conflicted AGENTS.md carrying the master
 * block, so text with master markers loses that block, never the rest of the file; text without them
 * gets the master instructions.
 */
export const managedMasterInstructions = (existing = '') => existing.includes(masterStart) || existing.includes(masterEnd) ? withoutMasterInstructions(existing) : masterInstructions;
