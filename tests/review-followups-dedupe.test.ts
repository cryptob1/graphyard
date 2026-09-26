import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileFollowUpThreads, type FollowUpItem } from '../src/review-threads.js';
import { appendedDescription, followUpEntries, followUpEntryKey, mergeFollowUpEntries, openFollowUpItem, type FollowUpEntry } from '../src/model/machine-backlog.js';
import type { Work } from '../src/model.js';

// GY-402, 2026-09-25: every approval of a new head that named findings filed another "Follow-ups
// from the approved review of GY-N" item — 170 of them for 40 parents, GY-259 alone holding
// GY-396, GY-399 and GY-401 for overlapping findings. A later approval now appends its new findings
// to the parent's open follow-up item, deduplicated by path and finding text.

const reviewer = 'graphyard-reviewer[bot]';
const heads = ['a1', 'b2', 'c3', 'd4'].map(prefix => prefix.padEnd(40, 'f'));
const bodies = [
  'AC-1 met.\nFollow-up finding: src/a.ts:10 — the retry is unbounded\nFollow-up finding: docs/x.md — stale wording\nFollow-up threads: none',
  // The same retry finding at a moved line, and one new finding.
  'AC-1 met.\nFollow-up finding: src/a.ts:14 — the retry is unbounded\nFollow-up finding: src/b.ts:3 — the cache never expires\nFollow-up threads: none',
  // Both earlier findings again, reworded only in punctuation and quoting, and one new finding.
  'AC-1 met.\nFollow-up finding: `docs/x.md` - Stale wording.\nFollow-up finding: src/b.ts:3 — the cache never expires\nFollow-up finding: src/c.ts — the name hides what it counts\nFollow-up threads: none',
  // No findings at all.
  'AC-1 met. Nothing beyond the criteria.\nFollow-up finding: none\nFollow-up threads: none',
];

/** GitHub as the loop's gh sees it: approval N of head N, with its body. */
const gh = (_command: string, args: string[]) => {
  const review = /reviews\/(\d+)$/.exec(args[1] ?? '');
  if (!review) throw new Error(`unexpected gh ${args.join(' ')}`);
  const index = Number(review[1]) - 100;
  return JSON.stringify({ id: Number(review[1]), state: 'APPROVED', commit_id: heads[index], user: { login: reviewer }, submitted_at: `2026-09-25T1${index}:00:00Z`, body: bodies[index] });
};

/** The control plane: the create route files an item, the followups route appends as the server does (src/server/followups.ts). */
function plane(parent: Work) {
  const work: Work[] = [parent], created: FollowUpItem[] = [], appended: { item: string; offered: number; added: number }[] = [];
  const create = async (item: FollowUpItem) => {
    const key = `GY-${300 + created.length}`;
    created.push(item);
    work.push({ ...parent, id: `work-${key}`, key, title: item.title, description: item.description, type: 'chore', stage: 'backlog', ready: false, origin: item.origin, createdAt: `2026-09-25T0${created.length}:00:00Z`, candidate: null } as Work);
    return { key };
  };
  const append = async (key: string, findings: FollowUpEntry[]) => {
    const item = work.find(entry => entry.key === key)!;
    assert.notEqual(item.stage, 'done');
    const merged = mergeFollowUpEntries(followUpEntries(item), findings);
    item.origin = { ...item.origin, reviewFollowUps: { parent: parent.key, findings: merged.findings } };
    item.description = appendedDescription(item.description, merged.added, `Added by a later approval of ${parent.key}:`);
    appended.push({ item: key, offered: findings.length, added: merged.added.length });
    return { key, added: merged.added.length };
  };
  return { work, created, appended, create, append };
}

test('unit:one-followup-per-parent — three successive approved heads with overlapping findings file one follow-up item holding their union; a findings-free approval files nothing', async () => {
  const parent = { id: 'work-64', key: 'GY-64', title: 'Frobs', description: '', stage: 'review', createdAt: '2026-09-24T00:00:00Z' } as Work;
  const control = plane(parent);
  const outcomes = [];
  for (const [index, sha] of heads.entries()) {
    // The loop's own lookup (src/reviewer.ts fileApprovedFollowUp): the parent's open follow-up item, if any.
    const existing = openFollowUpItem(control.work, parent.key)?.key;
    outcomes.push(await fileFollowUpThreads({ repository: 'owner/project', key: parent.key, workId: parent.id, pr: 64, sha, reviewId: 100 + index, reviewer, ...(existing ? { existing, append: control.append } : {}) },
      gh, control.create, new Date(`2026-09-25T1${index}:30:00Z`)));
  }
  // One item, filed by the first approval; the second and third appended to it.
  assert.equal(control.created.length, 1, 'never a second follow-up item for the same parent');
  assert.deepEqual(outcomes.map(outcome => outcome.item), ['GY-300', 'GY-300', 'GY-300', undefined]);
  assert.deepEqual(control.appended, [{ item: 'GY-300', offered: 2, added: 1 }, { item: 'GY-300', offered: 3, added: 1 }]);
  const item = control.work.find(entry => entry.key === 'GY-300')!;
  assert.equal(item.origin?.reviewFollowUps?.parent, 'GY-64');
  // The union, each finding once: the retry named at two lines, the stale wording twice, the cache twice.
  const findings = followUpEntries(item);
  assert.deepEqual(findings.map(finding => [finding.path, finding.text]), [
    ['src/a.ts', 'src/a.ts:10 — the retry is unbounded'],
    ['docs/x.md', 'docs/x.md — stale wording'],
    ['src/b.ts', 'src/b.ts:3 — the cache never expires'],
    ['src/c.ts', 'src/c.ts — the name hides what it counts'],
  ]);
  assert.equal(new Set(findings.map(followUpEntryKey)).size, findings.length);
  for (const text of ['the retry is unbounded', 'stale wording', 'the cache never expires', 'the name hides what it counts']) assert.ok(item.description.includes(text), text);
  assert.equal(item.description.match(/the cache never expires/g)?.length, 1, 'a finding named on two heads is listed once');
  // The findings-free approval filed nothing: no item, no append.
  assert.equal(outcomes[3].item, undefined);
  assert.deepEqual(outcomes[3].findings, []);
  assert.equal(control.appended.length, 2);
  assert.equal(control.work.filter(entry => entry.key !== parent.key).length, 1);
});

test('unit:one-followup-per-parent — a parent whose follow-up item was closed or delivered gets a new one; an append the plane refuses as not open is filed as the new item', async () => {
  const parent = { id: 'work-64', key: 'GY-64', title: 'Frobs', description: '', stage: 'review', createdAt: '2026-09-24T00:00:00Z' } as Work;
  const control = plane(parent);
  await control.create({ title: 'Follow-ups from the approved review of GY-64 (PR #64)', description: '1. Finding with no thread: src/z.ts — old', origin: { reviewFollowUps: { parent: 'GY-64', findings: [{ path: 'src/z.ts', text: 'src/z.ts — old' }] } } } as FollowUpItem);
  control.work[1]!.stage = 'done';
  assert.equal(openFollowUpItem(control.work, 'GY-64'), null, 'a delivered or closed follow-up item takes no more findings');
  // Chosen while open, closed before the append landed: the plane refuses it and the findings file a new item.
  const refusing = async () => { throw Object.assign(new Error('Graphyard refused the follow-ups for GY-300 (409): GY-300 is not an open follow-up item'), { notOpen: true }); };
  const outcome = await fileFollowUpThreads({ repository: 'owner/project', key: 'GY-64', workId: parent.id, pr: 64, sha: heads[0]!, reviewId: 100, reviewer, existing: 'GY-300', append: refusing }, gh, control.create, new Date('2026-09-25T10:30:00Z'));
  assert.equal(outcome.failure, undefined);
  assert.equal(outcome.item, 'GY-301');
  assert.equal(control.created.length, 2);
  // Any other append failure is retried against the same item, never filed twice.
  const failing = async () => { throw new Error('Graphyard refused the follow-ups for GY-301 (503): unavailable'); };
  const retried = await fileFollowUpThreads({ repository: 'owner/project', key: 'GY-64', workId: parent.id, pr: 64, sha: heads[1]!, reviewId: 101, reviewer, existing: 'GY-301', append: failing }, gh, control.create, new Date('2026-09-25T11:30:00Z'));
  assert.match(retried.failure ?? '', /could not be appended to GY-301/);
  assert.equal(retried.item, undefined);
  assert.equal(control.created.length, 2);
});
