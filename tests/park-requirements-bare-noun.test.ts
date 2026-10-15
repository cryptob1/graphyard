import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { humanRequestSchema, parkRefusal, requirementsQuestionRefusal } from '../src/model/human-request.js';

// GY-1819, follow-up from GY-1818 (threads PRRT_kwDOUZby-s6snGag, PRRT_kwDOUZby-s6snGai,
// PRRT_kwDOUZby-s6snWK8): the structural guard's outcome for the bare noun 'requirements' turned on
// the rewrite's verb — "Whether the requirements rewrite lands" refused while "Whether the
// requirements rewrite happens before the release cut" parked. One rule settles both sentences: the
// bare noun alone — no criterion id (AC-N), no work-item key, no tests/ path — names the rewrite as
// work, not the requirements, so its change-noun never asks whatever its verb while the change word
// keeps a predicate of its own. Whether that work lands, happens or sits in the order is goals and
// priorities, the operator's (GY-1818's approved record names the ordering sentence an operator
// ordering question and its refusal over-refusal); the requirements are asked about when a change
// verb targets them directly ("revise the requirements", "the requirements are revised", "the
// requirements change", "the requirements drop X" — the change word is the sentence's verb, with no
// predicate of its own after it) or when a named object is present (AC-N, the criteria, another
// item's key with tests) — those still refuse, and every GY-1816 and GY-1818
// fixture outside the four bare-noun pins this rule re-homes keeps its outcome, asserted in
// tests/park-requirements-question-refused.test.ts and tests/park-requirements-question-structural.test.ts.
// A negation scopes only its own clause, never past an although, though or but boundary (AC-2,
// review thread PRRT_kwDOUZby-s6snWK8): "AC-1 is not changed although the requirements are revised"
// asks a requirements revision and is refused.

const clean = { kind: 'goals-and-priorities', needed: 'A decision the build cannot make for itself', reason: 'The item cannot pass its gates as written' };

test('unit:park-requirements-bare-noun — GY-1819 AC-1: a park whose requirements mention is only the bare noun is judged the same way whatever its verb — both review-thread sentences park — while a change verb targeting the requirements or a named object still refuses', () => {
  // The two thread sentences get one outcome, and every bare-noun change-noun form with them:
  // lands, goes ahead, happens, merges, waits, and the forms an ordering ask schedules.
  const parked = [
    // The exact sentences of PRRT_kwDOUZby-s6snGag and PRRT_kwDOUZby-s6snGai.
    'Whether the requirements rewrite lands',
    'Whether the requirements rewrite happens before the release cut',
    // The other predicates of the same threads, judged by the noun, not the verb.
    'Whether the requirements rewrite goes ahead',
    'Whether the requirements rewrite happens',
    'Whether the requirements rewrite merges after GY-1700',
    'Whether the requirements rewrite waits until the release cut',
    'Whether the requirements rewrite lands first or after GY-1700',
    'Whether the requirements update should be prioritized above the docs trim',
    'Whether the requirements rewrite lands before the docs ship',
    'Whether a requirements revision happens and the docs ship',
    // The same scheduling asks behind a modal, with the work's predicate in the subjunctive.
    'Should the requirements rewrite land?',
    'Should the requirements rewrite go ahead?',
    'Might the requirements rewrite happen?',
    // Any predicate, named or not, base or past (review of c30e9e3e6951, PRRT_kwDOUZby-s6somYt).
    'Whether the requirements rewrite succeeds',
    'Should the requirements rewrite succeed?',
    'Whether the requirements rewrite succeeded',
    'Whether the requirements rewrite stalled before the release cut',
    'Did the requirements rewrite quietly fail?',
    'Whether the requirements update survives the release cut',
  ];
  for (const needed of parked) {
    assert.equal(requirementsQuestionRefusal({ ...clean, needed }), null, needed);
    assert.equal(parkRefusal({ ...clean, needed }), null, needed);
    // The server's own composition — parse, then refuse — says the same through the endpoint.
    assert.equal(parkRefusal(humanRequestSchema.parse({ epoch: 1, ...clean, needed })), null, needed);
  }

  // The bare noun is not a requirements object only as the noun of a change: a change verb targeting
  // the requirements directly still refuses (every GY-1816 fixture of this class keeps its outcome).
  // The change word as the sentence's verb — no predicate of its own follows it, so it is not the
  // work's noun — refuses too, clause end, object, "to" and "so" alike (review of c679d5f77786, B1).
  const refused = [
    'Should we revise the requirements?',
    'Whether the requirements need to be revised',
    'Should the requirements for the importer be changed?',
    'The worker asks to revise the requirements so the proof resolves, or to weaken AC-1 instead',
    'Should the requirements change?',
    'Whether the requirements change',
    'Should the requirements change to match the new API?',
    'Should the requirements drop the importer clause?',
    'The requirements change so the proof resolves',
    // An object opening with a determiner, pronoun, quantifier, preposition or particle is still an
    // object, never the work's own predicate (review of 0fe4d3fb684e, B1); any other word is.
    'Should the requirements drop this clause?',
    'Should the requirements drop its importer clause?',
    'Should the requirements change this clause?',
    'Should the requirements change its scope?',
    'Should the requirement change as the API did?',
    'Should the requirements change his clause?',
    'Should the requirements change us over to the new API?',
    'Should the requirements change significantly?',
    'Should the requirements drop all importer clauses?',
    'Should the requirements change in this release?',
    'Should the requirements change or stay?',
    // Named objects keep the GY-1818 outcomes: a bare predicate on the criteria or on AC-N still asks.
    'Whether the criteria revision ships',
    'Whether AC-1\'s rewrite happens',
    'Whether the criteria update is needed before the release ships',
  ];
  for (const needed of refused) {
    assert.match(requirementsQuestionRefusal({ ...clean, needed })!, /^Not a human-only decision/, needed);
    assert.match(parkRefusal({ ...clean, needed })!, /^Not a human-only decision/, needed);
  }

  // The question is scoped to the kind that claims it, as before.
  assert.equal(requirementsQuestionRefusal({ kind: 'money-or-accounts', needed: 'Whether the requirements rewrite lands' }), null);

  // docs/master-agent-reference.md states the outcome and why, as AC-1 requires.
  const docs = readFileSync(join(fileURLToPath(new URL('..', import.meta.url)), 'docs/master-agent-reference.md'), 'utf8');
  assert.match(docs, /the bare noun `requirements` alone \(no AC-N, item key or tests\/ path\) names the rewrite as work, not the requirements/, 'the docs state the bare-noun outcome');
  assert.match(docs, /a change verb targeting the requirements or a named object refuses/, 'the docs state what still refuses');
});

test('unit:park-requirements-bare-noun — GY-1819 AC-2: a negation scopes only its own clause, never past an although, though or but boundary, so "AC-1 is not changed although the requirements are revised by the selected option" refuses as a requirements question', () => {
  // The review-thread sentence (PRRT_kwDOUZby-s6snWK8) and its though and but forms: the positive
  // revision past the boundary is asked, whatever the negation in the first clause assures.
  // A boundary is a boundary whatever its case (review thread PRRT_kwDOUZby-s6soQxv).
  for (const boundary of ['although', 'though', 'but', 'Although', 'Though', 'But', 'ALTHOUGH']) {
    const needed = `AC-1 is not changed ${boundary} the requirements are revised by the selected option`;
    assert.match(requirementsQuestionRefusal({ ...clean, needed })!, /^Not a human-only decision/, needed);
    assert.match(parkRefusal({ ...clean, needed })!, /^Not a human-only decision/, needed);
    // The server's own composition — parse, then refuse — says the same through the endpoint.
    assert.match(parkRefusal(humanRequestSchema.parse({ epoch: 1, ...clean, needed }))!, /^Not a human-only decision/, needed);
  }
  // The boundary cuts both ways: a negated revision past it leaves the criterion's own change asked.
  assert.match(requirementsQuestionRefusal({ ...clean, needed: 'The requirements are not revised although AC-1 is revised' })!, /^Not a human-only decision/);
  // Both clauses negated assures, and a negated question still asks; a negated statement assures (GY-1818 keeps these).
  assert.equal(requirementsQuestionRefusal({ ...clean, needed: 'AC-1 is not changed although the requirements are not revised' }), null);
  assert.match(requirementsQuestionRefusal({ ...clean, ask: 'Should AC-1 not be weakened instead?' })!, /^Not a human-only decision/);
  assert.equal(requirementsQuestionRefusal({ ...clean, ask: 'AC-1 is not being rewritten by this item' }), null);
});
