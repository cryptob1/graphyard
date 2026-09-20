/**
 * The one glossary behind every hover definition in the dashboard. A technical word that stays
 * visible is wrapped in <Term> (web/components/term.tsx), which reads its meaning from here, so a
 * definition is written once and reads the same everywhere. Plain words only: a definition
 * that needs another definition is too long. docs/glossary.md holds the precise versions.
 */
export const glossary = {
  'work item': 'One piece of work with a goal and a list of things that must be true when it is done.',
  'acceptance criterion': 'One thing that must be true when the work is done, written so it can be checked.',
  proof: 'A named test or check that shows an acceptance criterion is true, for example unit:login-works. It only counts when it passes on the latest code and comes from someone who did not build the work.',
  'pull request': 'The proposed code change on GitHub, written PR #42. It is merged into the main branch once every step passes.',
  commit: 'One saved version of the code. Its long name — a SHA, forty letters and numbers — belongs to that exact version, and Graphyard judges one commit at a time.',
  'handed in': 'The moment the worker hands the code in to be checked. Pushing new code hands it in again, and the checks start over on the new version.',
  review: 'Someone other than the builder reads the change and approves it on GitHub.',
  'automated checks': 'Tests that GitHub runs on every change, such as “test” and “typecheck”.',
  'merge queue': 'The line of approved changes waiting to merge, one at a time, each re-tested with the changes ahead of it.',
  worker: 'The agent or person building a work item. Only one worker builds an item at a time.',
  reviewer: 'The agent or person who approves a change. It is never the one who built it.',
  blocker: 'A note saying the item cannot move until someone deals with something outside the normal steps.',
  'bootstrap obligation': 'A proof that was put off when Graphyard was first set up. The next change to the same files must provide it.',
  'post-deploy check': 'A test run against the live site after a change is deployed (e2e:deploy-smoke).',
  'end-to-end test': 'A test that uses the finished product the way a person would, from start to finish, usually through a browser. Its proof names start with e2e:.',
  'unit test': 'A fast test of one piece of code on its own. Its proof names start with unit:.',
  'integration test': 'A test of several pieces working together against a real database or service. Its proof names start with integration:.',
  'manual check': 'A person looks and writes down what they saw. It still has to be someone who did not build the work. Its proof names start with manual:.',
  release: 'A recorded set of build artifacts that an environment should run.',
  validation: 'An end-to-end test run on a prepared test environment for one proof.',
  'test case': 'A written, versioned description of an end-to-end test: what to set up, what to do, what to expect.',
  'proof authority': 'Which agents may submit a passing result for which proofs. Builders never can.',
  'operator automation': 'Limited agent identities that can create and release work on the operator’s behalf.',
  'delivery slice': 'An area of the codebase with its own coordinating lead.',
  'planned files': 'The files and folders the work says it will change. A change anywhere else is flagged so someone looks at it.',
  'exclusive resource': 'Something only one work item may use at a time, such as a shared test account. It is held only while someone is working on the item.',
  'review provider': 'Who does the code review: a person approving on GitHub, or a reviewing agent.',
  dependency: 'Another work item that has to ship before this one can start moving.',
  stage: 'Where an item is on its way to shipping: not started, needs a worker, being built, in review, automated checks, proving it works, merging, shipped.',
  'required check': 'A GitHub check that must pass before anything merges.',
  'shipping pulse': 'Counts of merged work per week and how long delivery took, for the whole repository. It never ranks people.',
  'flow analytics': 'Where work waits and how long each step takes, measured from Graphyard’s history.',
  'p50 / p90': 'Half of the items took less than the p50 time; nine in ten took less than the p90 time.',
} as const;
export type GlossaryTerm = keyof typeof glossary;
