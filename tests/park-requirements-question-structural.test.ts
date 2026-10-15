import { test } from 'node:test';
import assert from 'node:assert/strict';
import { humanRequestSchema, parkRefusal, requirementsQuestionRefusal } from '../src/model/human-request.js';

// GY-1818: GY-1816 guarded the goals-and-priorities park route with a phrasing regex over the ask,
// needed text and reason (verb-then-criterion, criterion-then-verb, a compound scanner, a matcher
// for proofs pointed at another item's tests, an ordering carve-out). Every review round taught it
// one more wording, and the independent reviewer still found a test-ordering question it refused
// (PRRT_kwDOUZby-s6smF0P) and requirement rewrites it let park. The guard now asks two structural
// questions of each sentence, whatever its word order: which requirements object it names — one of
// this item's criterion ids (AC-N), its criteria by name, or another work item's key (GY-N)
// together with a criterion or tests reference, a tests/ path among them — and whether one of the
// change operations has that object as its target, as a verb in one clause with it (either order)
// or as the work itself ("a criteria revision"). A change whose target is another noun ("the schema
// change", "the importer update", "replacing the legacy importer") counts nowhere, and another
// item's key is a target only in the passive voice, never as the actor ("GY-12 removes it"). A
// negated change in a statement assures rather than asks; a change an ordering ask schedules
// ("whether the requirements rewrite lands before the cut") is an ordering decision, still the
// human's. So the reworded test-ordering, scope, ordering and product-direction questions from
// GY-1816's fixtures and review threads are accepted without a per-wording exception, and every
// GY-1816 refusal fixture still refuses.

const clean = { kind: 'goals-and-priorities', needed: 'A decision the build cannot make for itself', reason: 'The item cannot pass its gates as written' };

test('unit:park-requirements-question-structural — GY-1818 AC-1: a goals-and-priorities park is refused as a requirements question only when a sentence names a requirements object and asks a change of it, so every reworded test-ordering, scope, ordering and product-direction question is accepted and every GY-1816 refusal fixture still refuses', async () => {
  // Every GY-1816 refusal fixture, in its original wording: each refuses on structure now, with no
  // wording-specific pattern anywhere in the guard.
  const refused = [
    // The ask GY-1814 parked (request 46a6f027), phrased as its worker wrote it.
    { ...clean, ask: 'Decide which yields: rewrite AC-1 to match GY-1762\'s test assertions, or reverse GY-1762' },
    { kind: 'goals-and-priorities', needed: 'Whether the acceptance criteria are matched to GY-1762\'s test assertions or GY-1762 is reversed', reason: clean.reason },
    { ...clean, reason: 'AC-1 and GY-1762\'s suite contradict each other as written, so one criterion must be revised before either gate can pass; the worker cannot choose' },
    // The verb-first, weakening and noun-compound wordings the same ask hides behind.
    { ...clean, reason: 'The worker asks to revise the requirements so the proof resolves, or to weaken AC-1 instead' },
    { ...clean, reason: 'The request reduces to a criteria revision, which the worker cannot make' },
    // Matching proofs to another item's tests without naming a criterion in the same sentence.
    { ...clean, ask: 'Decide whether this item\'s test assertions should match GY-1700\'s' },
    // The ordinary revision verbs (review thread PRRT_kwDOUZby-s6sl1Cc): update, amend, change, edit.
    { ...clean, ask: 'Should we update AC-1?' },
    { ...clean, ask: 'Should we amend the acceptance criterion?' },
    { ...clean, ask: 'Should we change AC-2 so the proof resolves?' },
    { ...clean, reason: 'The criteria should be edited before either gate can pass' },
    { ...clean, reason: 'AC-1 should be updated or amended, which the worker cannot decide' },
    { ...clean, reason: 'This needs a criteria amendment' },
    // A need connector between the criterion and its verb (review thread PRRT_kwDOUZby-s6smCFc).
    { ...clean, ask: 'Does AC-1 need to be rewritten?' },
    { ...clean, needed: 'Whether the requirements need to be revised' },
    { ...clean, reason: 'The criterion needs to be relaxed, or it never passes' },
    // Whether the rewrite happens at all names no order (review thread PRRT_kwDOUZby-s6smFz9); a negated question still asks.
    { ...clean, needed: 'Whether the requirements rewrite happens' },
    { ...clean, ask: 'Should AC-1 not be weakened instead?' },
    { ...clean, needed: 'Whether the criteria are no longer matched to GY-1762' },
    // A scoping qualifier between the criterion and its verb (review thread PRRT_kwDOUZby-s6smNd6).
    { ...clean, needed: 'Whether the acceptance criteria for CSV exports should be revised' },
    { ...clean, needed: 'Whether AC-1 in the current release should be weakened' },
    { ...clean, ask: 'Should the requirements for the importer be changed?' },
    // The rewordings the phrasing regex still needed a patch for when GY-1816 landed (review
    // threads PRRT_kwDOUZby-s6snUqz and PRRT_kwDOUZby-s6snUq0: deletion verbs, modifiers before
    // the change verb). Structure refuses them with no new pattern: the sentence names AC-N or the
    // criteria and asks a change of that object.
    { ...clean, ask: 'Should we remove AC-1?' },
    { ...clean, needed: 'Whether AC-1 should be deleted' },
    { ...clean, needed: 'Whether AC-1 should be materially revised' },
    { ...clean, ask: 'Should the criterion be substantially weakened?' },
  ];
  for (const body of refused) {
    const refusal = parkRefusal(body)!;
    assert.match(refusal, /^Not a human-only decision: the request asks whether this item's criteria are rewritten, revised or matched to another item's tests/, JSON.stringify(body));
    assert.match(refusal, /graphyard blocked GY-N EPOCH REASON/, 'the refusal names the conflict route');
    assert.match(refusal, /graphyard master decide GY-N requirements/, 'the refusal names the requirements decision the master requests');
    assert.equal(requirementsQuestionRefusal(body), refusal);
    // The server's own composition — parse, then refuse — says the same through the endpoint.
    assert.equal(parkRefusal(humanRequestSchema.parse({ epoch: 1, ...body })), refusal);
  }

  // The ordering of two objects is decided by what is named and what is asked, never by the
  // phrasing: every reworded test-ordering, scope, ordering and product-direction question from the
  // GY-1816 fixtures and the PRRT_kwDOUZby-s6smF0P example, plus rewordings of each, is accepted.
  const accepted = [
    // Scope and product direction.
    'Whether the importer rewrite also covers CSV export, or only the ledger format',
    'Whether the importer rewrite should also cover CSV export, or only the ledger format',
    'Whether the legacy importer stays a goal this quarter',
    'Decide whether the legacy importer is still a goal before GY-12 removes it',
    // Ordering: two items, or a rewrite named as the work an order schedules.
    'Whether GY-1700 lands before the release cut or after it',
    'Whether the soak gate orders GY-1762\'s suite before this item\'s tests',
    'Whether the requirements rewrite lands before the release cut',
    'Whether the criteria revision ships after GY-1700 or before it',
    'Whether the requirements update should be prioritized above the docs trim',
    'Whether the criteria work is prioritized above the docs trim',
    'Whether the criteria in the current release are prioritized above the docs trim',
    'Whether the requirements for the importer are met by the soak run',
    // Test ordering (PRRT_kwDOUZby-s6smF0P) and rewordings of it: matching names tests, runs first asks an order.
    'Whether GY-1700\'s matching tests or the other tests should run first',
    'Whether the tests that match GY-1700 should run first',
    'Should GY-1762\'s suite run before or after this item\'s tests?',
    'Do the tests that match GY-1700 come first or last?',
    'Whether the soak gate runs GY-1700\'s suite next or this item\'s tests first',
    // The sentences the review of 48267e1edb38 ran head and base on: each names a requirements
    // object beside a change word, but the change targets another noun, so both park.
    'Whether GY-1700\'s tests should run before the schema change lands',
    'Should GY-1762\'s suite run before or after the importer update?',
    'Whether GY-1700\'s tests run before the migration is merged',
    'Whether the soak gate runs GY-1762\'s tests before or after the changes to billing',
    'Whether the product requirements call for replacing the legacy importer',
    'Whether the release requirements allow dropping Safari support',
    'Whether we drop CSV export this quarter given the requirements from sales',
    // A change verb behind a connector names an unrelated noun phrase, not the object.
    'Whether the changes to the criteria land before the release cut',
    // Another item's key acts, it is not targeted: an ordering ask about its own work.
    'Whether GY-12 removes the legacy importer before this item\'s tests run',
    // Naming another item's tests never turns into an ask against the key itself.
    'Should the tests that match GY-1700 be deleted?',
    'Whether the tests that align with GY-1762 should run first',
  ];
  for (const needed of accepted) assert.equal(parkRefusal({ kind: 'goals-and-priorities', needed, reason: 'the operator owns goals and priorities' }), null, needed);
  // A reason stating the requirements stay as they are (PRRT_kwDOUZby-s6smF0G) assures, it does not ask.
  assert.equal(parkRefusal({ kind: 'goals-and-priorities', needed: 'Whether GY-1700 lands before the release cut', reason: 'The requirements are not changed by this scheduling decision' }), null);

  // The structural arms, one each: what the sentence names × what it asks.
  //   An own criterion id (AC-N) with a change ask — the ask is a change whatever word order carries it.
  assert.match(requirementsQuestionRefusal({ ...clean, ask: 'rewrite AC-1' })!, /^Not a human-only decision/);
  assert.match(requirementsQuestionRefusal({ ...clean, ask: 'AC-1 should be rewritten' })!, /^Not a human-only decision/);
  //   Another work item's key together with a criterion id or a tests/ path, with a change ask.
  assert.match(requirementsQuestionRefusal({ ...clean, needed: 'Whether this item\'s criteria should be aligned with GY-1762\'s' })!, /^Not a human-only decision/);
  assert.match(requirementsQuestionRefusal({ ...clean, ask: 'Decide whether GY-1700\'s criteria should match the cases in tests/e2e/cases/preview-isolation-cleanup.json' })!, /^Not a human-only decision/);
  //   A key alone names no requirements object: ordering another item around is the operator's call.
  assert.equal(requirementsQuestionRefusal({ ...clean, ask: 'Decide whether the legacy importer is still a goal before GY-12 removes it' }), null);
  //   A negated change asks only in a question; in a statement it assures.
  assert.match(requirementsQuestionRefusal({ ...clean, ask: 'Should AC-1 not be rewritten instead?' })!, /^Not a human-only decision/);
  assert.equal(requirementsQuestionRefusal({ ...clean, ask: 'AC-1 is not being rewritten by this item' }), null);
  //   The change named as the work itself asks for it, unless an ordering ask schedules it.
  assert.match(requirementsQuestionRefusal({ ...clean, needed: 'Whether AC-1\'s rewrite happens' })!, /^Not a human-only decision/);
  assert.equal(requirementsQuestionRefusal({ ...clean, needed: 'Whether AC-1\'s rewrite is scheduled before the cut' }), null);
  //   The verb must target the object: another item's key in the passive voice is a target, as the actor it is not.
  assert.match(requirementsQuestionRefusal({ ...clean, needed: 'Whether GY-1762 is reversed so its suite passes' })!, /^Not a human-only decision/);
  assert.equal(requirementsQuestionRefusal({ ...clean, needed: 'Whether GY-1762 removes the duplicated cases itself' }), null);
  //   Each field is judged on its own, and the question is scoped to the kind that claims it.
  assert.match(requirementsQuestionRefusal({ ...clean, ask: 'Decide whether the acceptance criteria are rewritten' })!, /^Not a human-only decision/);
  assert.match(requirementsQuestionRefusal({ ...clean, needed: 'Whether the acceptance criteria are rewritten' })!, /^Not a human-only decision/);
  assert.match(requirementsQuestionRefusal({ ...clean, reason: 'The acceptance criteria are rewritten by whichever answer wins' })!, /^Not a human-only decision/);
  assert.equal(requirementsQuestionRefusal({ kind: 'money-or-accounts', needed: 'Whether AC-1 should be rewritten to match GY-1762\'s test assertions' }), null);
});
