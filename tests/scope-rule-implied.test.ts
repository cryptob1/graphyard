import { test } from 'node:test';
import assert from 'node:assert/strict';
import { automaticScopeGrounds, emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { barrelSuccessorGround, criterionSymbolGround, criterionSymbols, criterionTestGround } from '../src/model/criterion-scope.js';
import type { ScopeCriterion, ScopeRequestState } from '../src/model/scope.js';
import type { Work } from '../src/model.js';

// GY-438: on 2026-09-25 the master granted six scope requests by hand — GY-259, GY-402, GY-406,
// GY-409 and GY-413 twice — each refused as "outside what this item's own criteria and the
// repository's documentation rule imply", though each path held a function or behaviour a
// criterion names. These tests replay those requests with the items' own criteria, verbatim, and
// the base-branch lines each requested file held when it was asked for. Each test is named for the
// proof it produces.

const clock = Date.parse('2026-09-26T03:30:00Z');
const criteria: Record<string, ScopeCriterion[]> = {
  "GY-259": [
    {
      "id": "AC-1",
      "text": "A research step runs before build for feature items (and for any item whose intent sets \"research\": true): the loop launches a Pi session through the GY-169 runner on the cheapest configured research model (a master.json setting, default the Z.AI GLM flash account). It records a research brief on the item as a typed tool result with these sections: existing code and conventions to reuse (paths), relevant external patterns and prior art (with sources), risks and edge cases, a recommended approach, and a list of product questions. A new module src/research.ts (the item creates it) owns this. A test in tests/research-phase.test.ts runs the step with a fake runner and asserts the brief is stored with every section and that bug/chore items skip it unless opted in."
    },
    {
      "id": "AC-2",
      "text": "Product questions go to the operator in Graphyard, never in chat: each question becomes a human request of kind goals-and-priorities with the question, why it matters, a recommended answer and a deadline (default 4 hours). It shows under Needs you on the dashboard (web/pages/human-requests.tsx). The item proceeds to build immediately with the recommended answers in its brief, marked provisional, and an answer that arrives later is added to the brief and, if it differs, triggers a rework decision. A test asserts that the requests are created with a recommendation and deadline, that build is not held, and that a differing late answer requests rework."
    },
    {
      "id": "AC-3",
      "text": "The worker starts from the brief: the worker's launch request includes the brief (or its path) and the answered or provisional product decisions, and the reviewer prompt checks the change against the brief's recommended approach and any answered questions. A test asserts that both prompts carry the brief."
    },
    {
      "id": "AC-4",
      "text": "Research is bounded and cheap: one session per item per requirements revision, with a time limit (default 15 minutes) and a token budget from the model settings. A failed or timed-out research step records its failure and lets build proceed without a brief, never blocking the item. docs/master-agent.md describes the research step. A test asserts the timeout path proceeds to build."
    }
  ],
  "GY-402": [
    {
      "id": "AC-1",
      "text": "Review follow-ups are one item per parent: a later approval of the same parent appends its new findings to the parent's existing open follow-up item, deduplicated by path and finding text, instead of creating another item. An approval with no findings files nothing. A test in tests/review-followups-dedupe.test.ts approves three successive heads of one item with overlapping findings, and asserts one follow-up item holding the union of findings, and no item for a findings-free approval."
    },
    {
      "id": "AC-2",
      "text": "A one-time migration, recorded in history, merges each parent's existing duplicate follow-up items into its oldest open one and closes the others as superseded by it. It deletes nothing and reports the count merged. A test runs the migration over 3 duplicates for one parent and asserts one open item with every finding and 2 closed items naming it."
    },
    {
      "id": "AC-3",
      "text": "The loop triages machine-filed backlog items (review follow-ups and recurring-fault items): a triage agent role judges each one within 24 hours, then releases it with a priority, closes it with a reason (already fixed by a named delivered item, or not worth doing), or merges it into another. Its decision is recorded, and an independent approver approves closures. master status and the dashboard count machine-filed untriaged items separately from operator-created backlog. A test asserts that an untriaged follow-up older than 24 hours raises an attention item naming the triage step."
    }
  ],
  "GY-406": [
    {
      "id": "AC-1",
      "text": "`graphyard master protection --apply` configures a branch ruleset on the base branch whose only bypass actor is the Graphyard control-plane GitHub App (actor_type Integration), in pull-request mode only. Required checks, required reviews and every other rule stay in force for everyone else, and the classic protection's enforce_admins stays on. The plan shows the bypass actor, and the protection report states it. A test asserts the planned ruleset has exactly one bypass actor, the App, in pull_request mode."
    },
    {
      "id": "AC-2",
      "text": "A work item may carry `\"repair\": \"merge-path\"` only when its plannedFiles are within the merge path (src/github.ts, src/merge-queue.ts, src/model/queue.ts, src/daemon/ merge steps, .github/workflows/). The repair lane merges such an item's PR with the App's bypass only when every condition holds: its required CI checks passed on the exact head; an independent approver agent approved a `repair-merge` decision naming the head SHA, requested with `graphyard master decide GY-N repair-merge REASON`, where the reason must name the merge-path fault; and the normal guarded merge has been refused or pending for at least 15 minutes. The merge is head-bound (expectedHeadOid). Any other item, or a missing condition, is refused with the condition named. A test covers each refusal and the one allowed path."
    },
    {
      "id": "AC-3",
      "text": "Every repair-lane merge appends an audit entry (item, PR, head, decision id, approver, the refusal it bypassed) and raises a master status attention item until the next normal merge succeeds, proving the merge path healthy again. AGENTS.md and docs/master-agent.md describe the repair lane as the one sanctioned exception to 'never use an administrative merge bypass', within the docs word budget. A test asserts the audit entry and the attention item."
    }
  ],
  "GY-409": [
    {
      "id": "AC-1",
      "text": "Settings › Agents opens on the operator's accounts as cards: provider, health (logged in, quota, exhausted until), and the roles that use each account. There is one primary 'Connect an account' button. The six registry forms move behind a collapsed 'Advanced' section, and nothing on the default view asks for an executable, home variable, host path or CLI flag. A UI test asserts the default view shows the account cards and the connect button, and no form field outside Advanced."
    },
    {
      "id": "AC-2",
      "text": "Connecting an API-key provider (z.ai, Anthropic API, OpenAI API): the operator picks the provider and pastes the key. The browser encrypts it to the agent host's public key (a sealed box; the host registers its public key with the control plane), so the server stores and relays only ciphertext and never logs or persists the plaintext. The host's executor decrypts it, writes it into a new login home under ~/.coding_agents/<name>/ in the provider's own auth file at mode 0600, and registers the environment and a Pi or OpenCode wrapper where the runtime needs one. It then runs a one-line smoke prompt and reports healthy or the provider's error on the card. Tests assert the server-side payload is ciphertext only, the file mode is 0600, a failed smoke test is shown on the card, and no key appears in history, logs or API responses."
    },
    {
      "id": "AC-3",
      "text": "Connecting a subscription login (Claude, ChatGPT/Codex, Cursor): the host's executor starts the provider's own login in a new login home, and the UI shows the device or sign-in URL and code it prints. The operator completes it in their own browser, and the card turns healthy once the login file appears and the smoke prompt passes. A test with a fake login CLI asserts that the URL and code reach the UI and the account becomes healthy."
    },
    {
      "id": "AC-4",
      "text": "A newly connected account joins roles by default by capability: strong-model accounts join worker and reviewer, and cheap models (GLM, Flash-class) join research, approver and the unit producer, each appended to the failover order. The card states what it joined and offers 'change', which opens the role editor. docs/onboarding.md replaces its shell steps for adding accounts with the UI flow, within the docs word budget. A test asserts the default role placement for a strong and a cheap account."
    }
  ],
  "GY-413": [
    {
      "id": "AC-1",
      "text": "A worker, reviewer, producer or approver launch that fails before its runtime starts (start timeout, refusal, error) closes the Herdr tab or pane it created through the same close path the loop uses for finished sessions, and records the close in the launch failure, before releasing the claim. A test with a fake Herdr in which the runtime never starts asserts that the created pane is closed and the claim released."
    },
    {
      "id": "AC-2",
      "text": "Containment settlement treats a process in the workspace as a live worker only if it is the supervisor, the runtime, or a descendant of the runtime. The interactive shell of a Herdr pane (a child of `herdr server` with no runtime descendant) is not a live worker: settlement closes that pane through the loop's close path and then settles. A test asserts that a pane shell with no runtime child is closed and settled, and that a shell with a live runtime child still blocks settlement."
    },
    {
      "id": "AC-3",
      "text": "The runtime start timeout scales with observed load: it is configurable (run.launchStartSeconds, default 60) and logs how long the start actually took, since 'command still echoing' at 30 s under load is a slow start, not a failure. A test asserts the configured timeout is honored."
    }
  ]
};

/** The base tree as the loop read it: each file's lines that matter, quoted from the base the request was judged against. */
const tree: Record<string, string> = {
  // GY-259 (base e50f23039): src/master-daemon.ts and src/master.ts are re-export barrels over their split modules.
  'src/master-daemon.ts': [
    '// The durable coordination loop. Every step is a pure decision over one Graphyard snapshot plus',
    '// Its modules live under src/daemon/, one concern each (GY-177); this path re-exports every public',
    '// name so existing imports keep working.',
    "export { threadResolutionGraceMs, threadsAwaitReview } from './merge-queue.js';",
    "export { reconcilePendingActions, dispatchKey, scopeKey } from './daemon/reconcile.js';",
    "export { reworkDecisionReason, approvalStep, type ApprovalStep } from './daemon/decisions.js';",
    "export { daemonEffects, type DaemonEffects } from './daemon/effects.js';",
    "export { runCycle } from './daemon/cycle.js';",
  ].join('\n'),
  'src/master.ts': [
    "export { setupAutonomy, agentToken, approverSessionName, type ApproverLaunch } from './master/autonomy.js';",
    "export { workerPrompt, dispatchWorker } from './master/dispatch.js';",
    "export { runSettingsSchema, profileConcurrency } from './master/profiles.js';",
  ].join('\n'),
  'src/daemon/cycle.ts': "export async function runCycle(config: MasterConfig, state: DaemonState, effects: DaemonEffects, clock: () => number) {",
  'src/daemon/cycle-dispatch.ts': '// Concern: cycle step 3 — dispatch ready items to free profiles.\nexport async function dispatchStep(cycle: Cycle) {',
  'src/daemon/decisions.ts': 'export function reworkDecisionReason(work: Work, grounds: string) {',
  'src/daemon/effects.ts': 'export function daemonEffects(config: () => MasterConfig, deps: EffectDeps): DaemonEffects {',
  'src/master/dispatch.ts': [
    "import { createdHerdrTab, type HerdrAgent, herdrJson, stopCreatedHerdrTab } from './herdr.js';",
    '    const created = createdHerdrTab(await herdrJson(tabArgs, run)); pane = created.pane; tabId = created.tab;',
  ].join('\n'),
  'src/master/profiles.ts': 'export const runSettingsSchema = z.object({',
  'src/model/human-request.ts': 'export const humanRequestSchema = z.object({',
  'src/server/routes/work.ts': [
    "  { method: 'GET', path: '/api/human-requests', handle: ({ actor, services }) => listHumanRequests(services, actor) },",
    "      return action === 'decide' ? requestDecision(context.services, context.actor, target, data, key) : approveDecision(context.services, context.actor, target, data, key);",
  ].join('\n'),
  'integrations/pi/index.ts': "export interface ToolResult { content: { type: 'text'; text: string }[]; details: unknown; terminate?: boolean }",
  // GY-402 (base 419c23e31).
  'src/master-status.ts': [
    "import { agentOwner, buildMasterStatus, type AttentionItem, type MasterConfig } from './master.js';",
    '  const attentionItems = [...status.attentionItems.filter(entry => !superseded(entry)), ...items];',
  ].join('\n'),
  'src/reviewer.ts': [
    "import { accountLaunch, createdHerdrTab, herdrJson, stopCreatedHerdrTab, type HerdrAgent } from './master.js';",
    'const followUpsOwed = (record: LedgerRecord) => !!record.followUps && !record.followUps.item && !!record.followUps.failure && !record.followUps.releasedAt;',
    "        const created = createdHerdrTab(await herdrJson(['tab', 'create', '--cwd', root], run));",
  ].join('\n'),
  'src/model/approval.ts': 'export const decisionRequestSchema = z.object({',
  'src/model/interventions.ts': 'export const interventionRecordSchema = z.object({',
  'src/server/close.ts': 'export async function closeWork(services: Services, caller: Principal, id: string, body: unknown, key: string) {',
  'src/server/decision-ledger.ts': 'export async function listDecisions(db: Queryable, workId: string) {',
  'src/server/decision-refusal.ts': 'export async function refuseDecision(services: Services, actor: Principal, id: string) {',
  // GY-406 (base 419c23e31).
  'src/model/work.ts': [
    'export const createSchema = z.object({',
    '  plannedFiles: z.array(z.string().min(1).max(500)).max(100).default([]),',
  ].join('\n'),
  'src/engine.ts': '  repair: z.object({ reason: z.string().trim().min(1).max(2000) }).strict(),',
  'src/server/decisions.ts': [
    '    const decisionId = randomUUID();',
    "    await record(db, work!, actor.id, 'decision.requested', { id: decisionId, action: data.action, input, reason: data.reason });",
  ].join('\n'),
  'src/cli/master-status.ts': "export { actionReport, agentRequestAttention, agentRequestReport, sessionReport } from './loop-report.js';",
  // GY-409 (base 2f76b9b7e): the browser test pins the page's labels, never the source.
  'browser-tests/agents-settings.spec.ts': [
    '// GY-170 AC-3: Settings › Agents lists, from the agent registry, every runtime; every account with',
    "  await page.getByRole('navigation', { name: 'Pages in this section' }).getByRole('button', { name: 'Agents', exact: true }).click();",
  ].join('\n'),
  // GY-413 (base 2f76b9b7e).
  'src/master/herdr.ts': 'export function createdHerdrTab(value: unknown): { tab: string; pane: string } {',
  'src/producer.ts': "      const created = createdHerdrTab(await herdrJson(['tab', 'create', '--cwd', root], run));",
  'src/quarantine.ts': 'export function containmentSettlementRefusals(',
  'tests/launch-delivery.test.ts': '    assert.equal(refusal.message, `the claude runtime never started within 30 s in pane w1V:pR6 (command still echoing); the pane last showed: "${echoLine}"`);',
  // Unrelated to every criterion above.
  'src/ci-guard.ts': "export function guardedCheckName(name: string) { return name.trim().toLowerCase(); }",
  'tests/ci-guard.test.ts': "test('a check name is trimmed', () => assert.equal(guardedCheckName(' Test '), 'test'));",
};
tree['src/master/launch.ts'] = 'export async function startAgentSession(config: MasterConfig) {';

/** The base-tree search: how many files mention an identifier as a whole word. */
const mentions = async (identifier: string) => Object.values(tree).filter(text => new RegExp(`(?<![\\w$])${identifier}(?![\\w$])`).test(text)).length;
const read = async (path: string) => tree[path] ?? null;
const exists = (path: string) => path in tree;

function item(key: string, plannedFiles: string[], extra: Partial<Work> = {}): Work {
  return {
    id: `00000000-0000-4000-8000-${key.replace(/\D/g, '').padStart(12, '0')}`, key, title: key, description: '', type: 'feature', priority: 1,
    dependencies: [], criteria: criteria[key].map(criterion => ({ proofs: ['unit:scope-rule-criteria-implied'], ...criterion })), policy: { checks: ['test'], review: true },
    plannedFiles, stage: 'build', revision: 3, policyRevision: 1, createdAt: '2026-09-25T07:39:46.044Z', updatedAt: '2026-09-26T00:00:00.000Z',
    stageEnteredAt: '2026-09-26T00:00:00.000Z', ready: true, epoch: 1, lease: null, workspaces: [], submission: null, candidate: null, reworkRequested: false,
    scenarioRequirements: [], evidence: [], observation: null, blocker: null, violations: [], gates: [], exclusiveResources: [], producerProofs: [],
    ...extra,
  } as unknown as Work;
}
const ask = (paths: string[], reason = 'the worker needs these files'): ScopeRequestState => ({ epoch: 1, paths, reason, requestedBy: 'graphyard-worker', at: '2026-09-26T01:00:00.000Z' });
const grounds = async (work: Work, paths: string[]) => automaticScopeGrounds(work, ask(paths), paths, [], exists, read, async () => [], mentions);

/** Today's six requests: the item as planned when it asked, the paths it asked for, and the ground each path is granted on. */
const replays: { key: string; planned: string[]; granted: Record<string, string>; approver?: string[] }[] = [
  { key: 'GY-259', planned: ['src/research.ts', 'src/master-daemon.ts', 'src/master.ts', 'src/model/work.ts', 'src/reviewer.ts', 'web/pages/human-requests.tsx', 'docs/master-agent.md', 'tests/research-phase.test.ts'], granted: {
    'src/model/human-request.ts': 'src/model/human-request.ts defines humanRequestSchema, the "human request" AC-2 names',
    'src/server/routes/work.ts': 'src/server/routes/work.ts calls listHumanRequests, the "human request" AC-2 names',
    'src/daemon/cycle.ts': 'successor of src/master-daemon.ts, which re-exports it',
    'src/daemon/cycle-dispatch.ts': 'successor of src/master-daemon.ts, a barrel over src/daemon/ where it was split',
    'src/daemon/decisions.ts': 'successor of src/master-daemon.ts, which re-exports it',
    'src/daemon/effects.ts': 'successor of src/master-daemon.ts, which re-exports it',
    'src/master/dispatch.ts': 'successor of src/master.ts, which re-exports it',
    'src/master/profiles.ts': 'successor of src/master.ts, which re-exports it',
    'integrations/pi/index.ts': 'integrations/pi/index.ts defines ToolResult, the "tool result" AC-1 names',
  } },
  // GY-402 asked for five files the item creates and for seams no criterion names (the close,
  // decision and intervention models): those are judgement, and still go to the approver.
  { key: 'GY-402', planned: ['src/review-threads.ts', 'src/daemon/', 'src/master/', 'src/cli/master-status.ts', 'web/', 'tests/review-followups-dedupe.test.ts', 'tests/followup-migration.test.ts', 'docs/master-agent.md'], granted: {
    'src/master-status.ts': 'src/master-status.ts defines attentionItems, the "attention item" AC-3 names',
    'src/reviewer.ts': 'src/reviewer.ts defines followUpsOwed, the "follow ups" AC-1 names',
  }, approver: ['integrations/pi/index.ts', 'src/model/machine-backlog.ts', 'src/model/approval.ts', 'src/model/interventions.ts', 'src/model/work.ts', 'src/server/followups.ts', 'src/server/close.ts', 'src/server/decision-ledger.ts', 'src/server/decision-refusal.ts', 'src/server/decisions.ts', 'src/server/routes/work.ts', 'src/triage.ts', 'tests/machine-backlog-routes.test.ts', 'tests/machine-backlog-triage.test.ts'] },
  { key: 'GY-406', planned: ['src/github.ts', 'src/merge-queue.ts', 'src/protection.ts', 'src/daemon/', 'src/master/', 'src/model/approval.ts', 'AGENTS.md', 'docs/master-agent.md', 'docs/github.md', 'tests/repair-lane.test.ts', 'src/model/queue.ts'], granted: {
    'src/model/work.ts': 'src/model/work.ts defines plannedFiles, which AC-2 names',
    'src/engine.ts': 'src/engine.ts declares the config key repair, which AC-2 names',
    'src/server/decisions.ts': 'src/server/decisions.ts defines decisionId, the "decision id" AC-3 names',
    'src/cli/master-status.ts': 'src/cli/master-status.ts is the `master status` command AC-3 names',
  } },
  { key: 'GY-409', planned: ['web/pages/fleet.tsx', 'web/', 'src/server/routes/', 'src/master/environments.ts', 'src/executor.ts', 'src/fleet.ts', 'docs/onboarding.md', 'tests/connect-account.test.ts'], granted: {
    'browser-tests/agents-settings.spec.ts': 'browser-tests/agents-settings.spec.ts pins the label or output "Settings › Agents" that AC-1 changes',
  } },
  { key: 'GY-413', planned: ['src/master/launch.ts', 'src/master/autonomy.ts', 'src/master/containment.ts', 'src/master/profiles.ts', 'src/daemon/', 'tests/failed-launch-pane.test.ts'], granted: {
    'src/master/dispatch.ts': 'src/master/dispatch.ts calls createdHerdrTab, the "herdr tab" AC-1 names',
    'src/reviewer.ts': 'src/reviewer.ts calls createdHerdrTab, the "herdr tab" AC-1 names',
    'src/producer.ts': 'src/producer.ts calls createdHerdrTab, the "herdr tab" AC-1 names',
    'src/quarantine.ts': 'src/quarantine.ts defines containmentSettlementRefusals, the "containment settlement" AC-2 names',
    'src/master.ts': 'src/master.ts exports ApproverLaunch, the "approver launch" AC-1 names',
  } },
  { key: 'GY-413', planned: ['src/master/launch.ts', 'src/master/autonomy.ts', 'src/master/containment.ts', 'src/master/profiles.ts', 'src/daemon/', 'tests/failed-launch-pane.test.ts', 'src/master/dispatch.ts', 'src/reviewer.ts', 'src/producer.ts', 'src/quarantine.ts', 'src/master.ts'], granted: {
    'tests/launch-delivery.test.ts': 'tests/launch-delivery.test.ts pins the label or output "command still echoing" that AC-3 changes',
  } },
];

test('unit:scope-rule-criteria-implied — today\'s six hand-granted requests are granted on what their criteria name, each with its ground; an unrelated path is still refused', async () => {
  for (const replay of replays) {
    const work = item(replay.key, replay.planned);
    const paths = [...Object.keys(replay.granted), ...(replay.approver ?? [])];
    const result = await grounds(work, paths);
    assert.deepEqual(Object.fromEntries((result.grounds ?? []).map(entry => [entry.path, entry.ground])), replay.granted, `${replay.key}: every criteria-implied path is granted with its ground`);
    if (replay.approver) {
      assert.ok('refusal' in result, `${replay.key}: what no rule grounds still goes to the approver`);
      for (const path of replay.approver) assert.match(result.refusal, new RegExp(`names ${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), `${replay.key}: ${path} is left for the approver`);
    } else assert.ok(!('refusal' in result), `${replay.key}: nothing is left for an operator: ${'refusal' in result ? result.refusal : ''}`);
  }
  // An unrelated source file and test are refused for every one of those items: no symbol, label
  // or split ties them to a criterion, so they are the approver's to judge.
  for (const replay of replays) {
    const result = await grounds(item(replay.key, replay.planned), ['src/ci-guard.ts', 'tests/ci-guard.test.ts']);
    assert.ok('refusal' in result && !result.grounds?.length, `${replay.key}: an unrelated path is still refused`);
  }
});

test('unit:scope-rule-criteria-implied — (a) a definition or direct call grounds a file; an import, a comment or a widely shared callee does not', () => {
  const symbols = criterionSymbols([{ id: 'AC-1', text: 'A failed launch closes the Herdr tab it created, and `run.launchStartSeconds` (default 60) bounds the start; `graphyard master decide GY-N repair-merge` requests it and GET /api/human-requests lists it.' }]);
  const kinds = new Set(symbols.map(entry => `${entry.kind}:${entry.symbol}`));
  for (const expected of ['phrase:herdr tab', 'key:launchStartSeconds', 'command:master decide', 'route:/api/human-requests']) assert.ok(kinds.has(expected), `${expected} is read from the criterion`);
  assert.equal(criterionSymbolGround('src/a.ts', 'export function createdHerdrTab() {}', symbols), 'src/a.ts defines createdHerdrTab, the "herdr tab" AC-1 names');
  assert.equal(criterionSymbolGround('src/b.ts', 'const bound = config.run.launchStartSeconds * 1000;', symbols), 'src/b.ts reads the config key launchStartSeconds, which AC-1 names');
  assert.equal(criterionSymbolGround('src/c.ts', "if (id === 'decide') {", symbols), null, 'a bare subcommand word outside its command\'s files grounds nothing');
  assert.equal(criterionSymbolGround('src/master/c.ts', "if (id === 'decide') {", symbols), 'src/master/c.ts dispatches the `master decide` command AC-1 names');
  assert.equal(criterionSymbolGround('src/d.ts', "router.get('/api/human-requests', handler);", symbols), 'src/d.ts holds the route /api/human-requests, which AC-1 names');
  // A call of a phrase-spelled identifier grounds only where the base-tree search finds it in few files.
  assert.equal(criterionSymbolGround('src/e.ts', 'createdHerdrTab(value);', symbols, new Map([['createdHerdrTab', 4]])), 'src/e.ts calls createdHerdrTab, the "herdr tab" AC-1 names');
  assert.equal(criterionSymbolGround('src/e.ts', 'createdHerdrTab(value);', symbols, new Map([['createdHerdrTab', 40]])), null, 'a callee half the tree shares is plumbing');
  assert.equal(criterionSymbolGround('src/e.ts', 'createdHerdrTab(value);', symbols), null, 'an unsearched callee grounds nothing');
  assert.equal(criterionSymbolGround('src/f.ts', "import { createdHerdrTab } from './herdr.js';\n// the Herdr tab it created", symbols), null, 'an import or a comment is a mention, not a definition or a call');
});

test('unit:scope-rule-criteria-implied — (b) a test is granted for a label or route a criterion changes, not for the command it runs', () => {
  const symbols = criterionSymbols([{ id: 'AC-1', text: "Settings › Agents shows one 'Connect an account' button and the `master status` report lists it." }]);
  assert.equal(criterionTestGround('browser-tests/x.spec.ts', "await page.getByRole('button', { name: 'Connect an account' }).click();", symbols), 'browser-tests/x.spec.ts pins the label or output "Connect an account" that AC-1 changes');
  assert.equal(criterionTestGround('browser-tests/y.spec.ts', "test('Settings › Agents lists every runtime', async () => {});", symbols), 'browser-tests/y.spec.ts pins the label or output "Settings › Agents" that AC-1 changes');
  assert.equal(criterionTestGround('tests/z.test.ts', "run(['master', 'status']); // master status", symbols), null, 'running a command is not pinning its output');
  assert.equal(criterionTestGround('src/w.ts', "'Connect an account'", symbols), null, 'only a test file is granted on what it pins');
});

test('unit:scope-rule-criteria-implied — (c) a planned re-export barrel names the files it was split into', () => {
  const barrel = [{ path: 'src/big.ts', text: "// split into src/big/\nexport { a } from './big/a.js';\nexport * from './big/b.js';" }];
  assert.equal(barrelSuccessorGround('src/big/a.ts', barrel), 'successor of src/big.ts, which re-exports it');
  assert.equal(barrelSuccessorGround('src/big/c.ts', barrel), 'successor of src/big.ts, a barrel over src/big/ where it was split');
  assert.equal(barrelSuccessorGround('src/other.ts', barrel), null, 'a file outside the split is no successor');
  const mixed = [{ path: 'src/big.ts', text: "export { a } from './big/a.js';\nexport function own() {}" }];
  assert.equal(barrelSuccessorGround('src/big/a.ts', mixed), 'successor of src/big.ts, which re-exports it');
  assert.equal(barrelSuccessorGround('src/big/c.ts', mixed), null, 'a module that still holds code of its own is no barrel over the directory');
});

const loopConfig = () => masterConfigSchema.parse({ version: 1, url: 'http://127.0.0.1:9', credentialFile: '/nonexistent/criteria-implied.token', cliPath: 'bin/graphyard.mjs',
  repository: 'owner/criteria-implied', baseBranch: 'main', githubAppId: 4242, hostId: 'loop-host', masterAgentName: 'graphyard-master-implied', workers: [] }) as MasterConfig;
const loopEffects = (work: () => Work[], overrides: Partial<DaemonEffects>): DaemonEffects => ({
  agents: () => [], credentials: async () => ({}),
  snapshot: async () => ({ work: work(), now: new Date(clock).toISOString() }),
  closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}),
  observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date(clock).toISOString(), reason: 'no deployment in this test', deployed: [], pending: [] }),
  recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
  ...overrides,
} as DaemonEffects);

test('unit:scope-rule-criteria-implied — the loop widens by what the criteria ground, audited, and leaves only the rest refused for the approver', async () => {
  const lease = { epoch: 1, owner: 'graphyard-worker', expiresAt: new Date(clock + 600_000).toISOString() };
  const refused = (paths: string[]) => ({ ...ask(paths), decision: { state: 'refused', reason: 'outside what the criteria imply', at: '2026-09-26T01:00:01.000Z', decidedBy: 'graphyard', waitedMs: 1000, paths, requestedBy: 'graphyard-worker', requestedAt: '2026-09-26T01:00:00.000Z', epoch: 1 } });
  const whole = item('GY-413', replays[4].planned, { lease, scopeRequest: refused(Object.keys(replays[4].granted)) } as Partial<Work>);
  const part = item('GY-406', replays[2].planned, { lease, scopeRequest: refused(['src/cli/master-status.ts', 'src/ci-guard.ts']) } as Partial<Work>);
  const widened: { key: string; paths: string[]; reason: string }[] = [];
  const state = emptyDaemonState(loopConfig());
  await runCycle(loopConfig(), state, loopEffects(() => [whole, part], {
    basePaths: async paths => new Set(paths.filter(exists)), baseText: read, baseMentions: mentions,
    widenScope: async (work, _request, paths, reason) => { widened.push({ key: work.key, paths, reason }); return { ...work, plannedFiles: [...(work.plannedFiles ?? []), ...paths], policyRevision: work.policyRevision + 1 }; },
  }), () => clock);
  assert.deepEqual(widened.map(entry => [entry.key, entry.paths]), [['GY-413', Object.keys(replays[4].granted)], ['GY-406', ['src/cli/master-status.ts']]]);
  assert.match(widened[0].reason, /src\/quarantine\.ts \(src\/quarantine\.ts defines containmentSettlementRefusals, the "containment settlement" AC-2 names\)/);
  const audited = Object.values(state.actions).find(action => action.work === 'GY-413' && /^Widened /.test(action.detail));
  assert.match(audited?.detail ?? '', /on what the item's criteria name/, audited?.detail);
  const partly = Object.values(state.actions).find(action => action.work === 'GY-406' && /^Partly widened /.test(action.detail));
  assert.match(partly?.detail ?? '', /src\/cli\/master-status\.ts \(src\/cli\/master-status\.ts is the `master status` command AC-3 names\)\. The rest goes to the approver: no unresolved review finding on the head names src\/ci-guard\.ts/, partly?.detail);
});
