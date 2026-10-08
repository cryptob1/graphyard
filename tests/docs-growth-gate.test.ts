import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as documentation from '../src/model/documentation.js';
import { cycleFaults, docsHeadroomStatus, docsTrimActionKey, fileDocsTrim } from '../src/daemon/faults.js';
import { emptyDaemonState } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import type { Work } from '../src/model.js';

/**
 * GY-1515 (manual:fault-class-resources): three resources faults in 24 hours on 8 October 2026.
 * Two were the documentation set on origin/main inside its headroom band (resource-bound on docs,
 * at 00:53Z and again at 04:59Z), one was the reclaim pass re-reporting a tree Git refused
 * (tests/worktree-reclaim.test.ts). The documentation's cause is structural: the total word budget
 * was never a merge gate — tests/docs-budget.test.ts warned and passed over it — so every change
 * documented itself into the set, main re-saturated within hours of every trim (GY-1503 trimmed it
 * to 14,972 words at 02:12Z; it was 15,766 by 05:00Z), and the set sat over its budget for 25
 * minutes from 01:37Z while seven changes landed green. The one-shot trim item the loop files is
 * then the only remedy, and each saturation it answers was counted as a fault.
 *
 * The candidate makes the budget self-enforcing: a saturated total fails any change that adds a
 * word to it (docsBudgetJudgement, the judgement tests/docs-budget.test.ts now gives), so each
 * change that documents itself into a saturated set trims first; the set inside the band is the
 * trim item's attention and no fault; only a set over its budget, which changes merged together
 * must have overrun, is the resource at its bound.
 */

const BUDGET = { total: 16_000, perPage: 1_200, paths: ['README.md', 'docs/'] };
/** A budgeted set of `total` words spread over twenty pages, every page inside its cap. */
const set = (total: number, count = 20): documentation.DocsWordCount => Object.fromEntries(Array.from({ length: count }, (_, index) =>
  [index === 0 ? 'README.md' : `docs/page-${index}.md`, Math.floor(total / count) + (index < total % count ? 1 : 0)]));
const config = (): MasterConfig => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/outside/graphyard.mjs',
  repository: 'cryptob1/graphyard', baseBranch: 'main', githubAppId: 1234, hostId: 'vishrog', masterAgentName: 'graphyard-master-graphyard', autoMerge: true, mergeMethod: 'merge', workers: [] });
const counted = (total: number) => ({ budget: { ...BUDGET, documentation: BUDGET.paths }, pages: set(total) });

test('manual:fault-class-resources — GY-1515 docs: the changes that carried main into its band (15406 → 15532 at 00:50Z) and over its budget (15986 → 16001 at 01:37Z) each passed the budget test on the base; the judgement now refuses both and passes a change that adds none', () => {
  // PR #967 (GY-1496) took main from 15,406 to 15,532 words: the first instance's saturation. On the base its test warned and passed.
  const intoBand = documentation.docsBudgetJudgement(set(15_532), BUDGET, set(15_406));
  assert.match(intoBand.failed!, /^The budgeted documentation \(README\.md, docs\/\) totals 15532 words, within 3% of its 16000-word budget \(over 15520\), and this change adds 126 to it: a saturated set may not grow, so trim it to 15200 or fewer; largest pages: /);
  // PR #972 (GY-1493) took it from 15,986 to 16,001, over the budget, and six more landed over it before the trim.
  const overBudget = documentation.docsBudgetJudgement(set(16_001), BUDGET, set(15_986));
  assert.match(overBudget.failed!, /^The budgeted documentation \(README\.md, docs\/\) totals 16001 words, over its 16000-word budget by 1, and this change adds 15 to it: a saturated set may not grow/);
  // PR #990 (GY-1514) took it from 15,287 to 15,639: the second instance.
  assert.match(documentation.docsBudgetJudgement(set(15_639), BUDGET, set(15_287)).failed!, /adds 352 to it: a saturated set may not grow/);
  // A change that adds no word to a saturated set — one that leaves the documentation alone, or trims it — still lands, with the warning.
  const flat = documentation.docsBudgetJudgement(set(15_639), BUDGET, set(15_639));
  assert.equal(flat.failed, null);
  assert.match(flat.warning!, /this change adds none, so it passes, and the loop's trim item restores the headroom: trim it to 15200 or fewer/);
  assert.equal(documentation.docsBudgetJudgement(set(15_500), BUDGET, set(15_639)).warning, null, 'a trim that restores the band passes clean');
  assert.match(documentation.docsBudgetJudgement(set(15_639), BUDGET, 'base-branch').warning!, /this is the base branch, where nothing can be refused, so it passes/, 'a push to main is never failed by growth the merges brought');
  assert.equal(documentation.docsHeadroom(set(15_639), BUDGET).band, 15_520, 'the band the budget test holds is the one the loop reports');
});

test('manual:fault-class-resources — GY-1515 docs: the set inside its band is the trim item\'s attention and no resources fault; over its budget it is one', async () => {
  const state = emptyDaemonState(config()), now = Date.parse('2026-10-08T04:59:25.667Z');
  const faults = (reported: Awaited<ReturnType<typeof docsHeadroomStatus>>) => cycleFaults(state, [], now, { config: config(), reported: reported.attention }).filter(fault => fault.faultClass === 'resources').map(fault => [fault.kind, fault.subject]);
  // Instance 2 as the loop read it: 15,639 of 16,000 words on origin/main (361 left, within 3%).
  const inBand = await docsHeadroomStatus('/repository', 'main', (_, ref) => ref === 'origin/main' ? counted(15_639) : null);
  assert.equal(inBand.attention.length, 1, 'the master still sees the line');
  assert.match(inBand.attention[0].text, /^The documentation \(README\.md, docs\/\) on origin\/main is 15639 of its 16000-word budget \(361 left, within 3% of it\): unit:docs-word-budget refuses every change that adds a word to it until the set is under 15520\. Trim to 15200 or fewer/);
  assert.deepEqual(faults(inBand), [], 'REPRODUCE: the base counted the set inside its band as a resource-bound resources fault');
  // The trim item is still filed for it, once.
  const filed: unknown[] = [], work: Work[] = [];
  await fileDocsTrim(state, { persist: async () => {}, fileFaultClass: async input => { filed.push(input); return { key: 'GY-1517', title: (input as { title: string }).title, stage: 'backlog' } as unknown as Work; } }, work, inBand.docs, () => now, []);
  assert.equal(filed.length, 1); assert.equal(state.actions[docsTrimActionKey].work, 'GY-1517');
  // Instance 1 as it stood at 02:00Z: 16,335 words, over the budget — the band was overrun by changes merged together, and that is a fault.
  const over = await docsHeadroomStatus('/repository', 'main', () => counted(16_335));
  assert.match(over.attention[0].text, /is 16335 of its 16000-word budget \(over it by 335\): changes merged together overran the band the docs budget test holds, and the test now fails on the base branch\. Trim to 15200 or fewer/);
  assert.deepEqual(faults(over), [['resource-bound', 'docs']], 'a set over its budget is a resource at its bound');
});

test('manual:fault-class-resources — GY-1515 docs: replaying the day\'s merges through the loop\'s own fault path, the base reached both instances and the candidate stops at the band', async () => {
  const state = emptyDaemonState(config());
  const resourcesFaults = async (total: number) => cycleFaults(state, [], 0, { config: config(), reported: (await docsHeadroomStatus('/repository', 'main', () => counted(total))).attention })
    .filter(fault => fault.faultClass === 'resources' && fault.subject === 'docs').length;
  // The merges of 8 October as the base took them (every one passed the warn-only budget test), after GY-1503's trim to 14,972.
  const merges = [14_972, 15_406, 15_532, 15_986, 16_001, 16_335];
  let base = 0, candidate = merges[0], previous = merges[0];
  for (const total of merges.slice(1)) {
    base += await resourcesFaults(total) > 0 ? 1 : 0;
    // The candidate refuses each change that adds a word once the set is within its band, so main stops where it stood.
    const judged = documentation.docsBudgetJudgement(set(total), BUDGET, set(candidate));
    if (!judged.failed) candidate = total;
    previous = total;
  }
  assert.equal(previous, 16_335, 'the base took every merge');
  assert.ok(base >= 2, 'REPRODUCE: on the base the replay reaches resources faults on docs (inside the band and over the budget)');
  assert.ok(candidate < 15_520 + 1 && candidate >= 15_406, `the candidate stops at the band: ${candidate}`);
  assert.equal(await resourcesFaults(candidate), 0, 'the candidate\'s main never reads as a resources fault');
});
