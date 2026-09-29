import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { baseTree, derivedIntent, releaseSpecGate } from '../src/cli/planned-files-intent.js';
import { baseSpecSearch, specCheck, specCheckRefusal, specRulesPrompt, symbolDeclarationNeedle, type SpecSearch } from '../src/model/spec-check.js';
import { criteriaRuleSection, followUpItem, type LaunchThread } from '../src/review-threads.js';
import { triagePrompt } from '../src/triage.js';
import { researchPrompt } from '../src/research.js';
import type { Work } from '../src/model.js';

// GY-881: task specs, not code, drive most rework — GY-864 planned src/server/routes/work.ts while
// the route its criterion named lived in status.ts. The spec check grades an intent against the
// base tree at create, requirements and release: every path, route and exported symbol a criterion
// names must resolve into plannedFiles or be a file a criterion describes creating, and every
// criterion must carry a proof. The git repository here is real; the control plane is a recorder,
// since what is under test is what the master sends it, or refuses to send. Each test is named for
// the proof it produces.
let root: string, dir: string;
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: root, stdio: 'pipe' });
const baseFiles: Record<string, string> = {
  'src/server/routes/status.ts': `export const statusRoutes = { work: { path: '/api/work' } };\n`,
  'src/model/work.ts': `export function derivePlannedFiles() { return null; }\n`,
  'src/other.ts': `export function derivePlannedFiles() { return null; }\n`,
  'docs/guide.md': `// guide\n`,
};

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'gy881-'));
  dir = await mkdtemp(join(tmpdir(), 'gy881-intent-'));
  git('init', '--quiet', '--initial-branch=main');
  for (const [file, text] of Object.entries(baseFiles)) { await mkdir(join(root, dirname(file)), { recursive: true }); await writeFile(join(root, file), text); }
  git('add', '.'); git('commit', '--quiet', '-m', 'base');
});
after(async () => { await rm(root, { recursive: true, force: true }); await rm(dir, { recursive: true, force: true }); });

const intentFile = async (intent: object) => { const file = join(dir, `${Math.random().toString(36).slice(2)}.json`); await writeFile(file, JSON.stringify(intent)); return file; };
function recorder(work: Partial<Work>[] = []) {
  const sent: { path: string; data: any; credential?: string }[] = [];
  return { sent, deps: { coordinator: async () => ({ work }), token: async () => 'operator-agent-token', mutate: async (path: string, data: unknown, _id?: string, credential?: string) => { sent.push({ path, data, credential }); return { key: 'GY-1' }; } } };
}
/** A search whose holders are keyed by a plain needle fragment: the key any searched needle contains answers, and `fallback` answers the rest. */
function stubSearch(holders: Record<string, string[]>, fallback: string[] = []): SpecSearch {
  return { async filesMatching(_kind, needle) { const key = Object.keys(holders).find(entry => needle.includes(entry)); return new Set(key ? holders[key]! : fallback); } };
}
const treeOf = async () => (await baseTree(root, 'main')).files;

test('integration:spec-references-resolve — the GY-864 case: a criterion naming a route that the base holds outside plannedFiles refuses the create naming the holder and the criterion, and records nothing', async () => {
  const { sent, deps } = recorder();
  const file = await intentFile({
    title: 'Work routes module',
    criteria: [
      { id: 'AC-1', text: 'A new module src/server/routes/work.ts serves the work routes.', proofs: ['unit:a'] },
      { id: 'AC-2', text: 'GET /api/work returns the work item.', proofs: ['unit:b'] },
    ],
    plannedFiles: ['src/server/routes/work.ts'],
  });
  await assert.rejects(derivedIntent(root, { baseBranch: 'main' }, 'create', [file, 'file', 'it'], deps), (error: Error) => {
    assert.match(error.message, /AC-2 names the route \/api\/work, held by src\/server\/routes\/status\.ts/);
    assert.match(error.message, /\bmain\b/, 'the refusal names the base it was graded against');
    assert.doesNotMatch(error.message, /AC-1/, 'a criterion whose references resolve is not named');
    return true;
  });
  assert.equal(sent.length, 0, 'nothing is recorded for a refused item');
});

test('integration:spec-references-resolve — a create whose every route resolves into plannedFiles is recorded, and so is a release gate on an item whose spec resolves', async () => {
  const { sent, deps } = recorder();
  const file = await intentFile({
    title: 'Work routes',
    criteria: [{ id: 'AC-2', text: 'GET /api/work returns the work item.', proofs: ['unit:b'] }],
    plannedFiles: ['src/server/routes/status.ts'],
  });
  const result = await derivedIntent(root, { baseBranch: 'main' }, 'create', [file, 'file', 'it'], deps);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].path, 'work');
  assert.equal(result.plannedFilesDerived.base, 'main');
  const work = { key: 'GY-9', criteria: [{ id: 'AC-2', text: 'GET /api/work returns the work item.', proofs: ['unit:b'] }], plannedFiles: ['src/server/routes/status.ts'] } as unknown as Work;
  const gated = await releaseSpecGate(root, 'main', work);
  assert.equal(gated?.ref, 'main', 'the gate grades against the base it fetched');
});

test('integration:spec-references-resolve — the release gate refuses an item whose criteria name a route outside plannedFiles, naming the holder', async () => {
  const work = { key: 'GY-10',
    criteria: [{ id: 'AC-1', text: 'GET /api/work/:id/decisions returns the decisions.', proofs: ['unit:a'] }],
    plannedFiles: ['src/server/routes/work.ts'] } as unknown as Work;
  await assert.rejects(releaseSpecGate(root, 'main', work), (error: Error) => {
    assert.match(error.message, /AC-1 names the route \/api\/work\/:id\/decisions, held by src\/server\/routes\/status\.ts/);
    return true;
  });
  const proofless = { key: 'GY-11', criteria: [{ id: 'AC-1', text: 'It works.', proofs: [] }], plannedFiles: ['src/server/routes/work.ts'] } as unknown as Work;
  await assert.rejects(releaseSpecGate(root, 'main', proofless), /AC-1 has no proof/);
});

test('unit:spec-references-resolve — a symbol declared in a planned file passes; the same symbol declared only outside plannedFiles is refused naming its holder and criterion', async () => {
  const criteria = [{ id: 'AC-1', text: 'derivePlannedFiles carries every file the criteria name.', proofs: ['unit:x'] }];
  const tree = await treeOf();
  const asked: { kind: string; needle: string }[] = [];
  const search: SpecSearch = { async filesMatching(kind, needle) { asked.push({ kind, needle }); return new Set(['src/model/work.ts']); } };
  const passing = await specCheck({ criteria, plannedFiles: ['src/model/work.ts'] }, tree, search);
  assert.deepEqual(passing, { unresolved: [], proofless: [] });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].kind, 'symbol');
  assert.match(asked[0].needle, /export\\s\+\(declare\\s\+\)\?\(abstract\\s\+\)\?\(async\\s\+\)\?/, 'a symbol is resolved by an export declaration, never a mention');
  assert.doesNotMatch(asked[0].needle, /\(\?:/, 'the needle stays POSIX ERE: git grep -E refuses the (?:… group');
  assert.match(asked[0].needle, /derivePlannedFiles\\b/);
  const refusing = await specCheck({ criteria, plannedFiles: ['src/model/work.ts'] }, tree, { async filesMatching() { return new Set(['src/other.ts']); } });
  assert.deepEqual(refusing.unresolved, [{ criterion: 'AC-1', kind: 'symbol', reference: 'derivePlannedFiles', holder: 'src/other.ts' }]);
  assert.match(specCheckRefusal(refusing, 'main'), /AC-1 names the symbol derivePlannedFiles, held by src\/other\.ts/);
});

test('unit:spec-references-resolve — a symbol the base declares nowhere passes as one the item creates; a directory-scope plannedFiles entry covers its holders', async () => {
  const criteria = [{ id: 'AC-1', text: 'A new specCheck module checks a task spec against the base tree.', proofs: ['unit:x'] }];
  const tree = await treeOf();
  const created = await specCheck({ criteria, plannedFiles: ['src/model/spec-check.ts'] }, tree, stubSearch({}));
  assert.deepEqual(created, { unresolved: [], proofless: [] }, 'a symbol with no declaration on the base is created by the item');
  const covered = await specCheck({ criteria, plannedFiles: ['src/model/'] }, tree, { async filesMatching() { return new Set(['src/model/spec-check.ts']); } });
  assert.deepEqual(covered, { unresolved: [], proofless: [] }, 'a holder under a planned directory scope is covered');
});

test('unit:spec-references-resolve — a creation-word criterion excuses the holder it names, and a path the tree holds outside plannedFiles is refused unless a criterion describes creating it', async () => {
  const tree = new Set(['src/routes/extra.ts', 'src/supervisor.ts', 'src/registry.ts']);
  const excused = await specCheck({
    criteria: [{ id: 'AC-1', text: 'Add the route GET /api/work to src/routes/extra.ts.', proofs: ['unit:x'] }],
    plannedFiles: ['src/elsewhere.ts'],
  }, tree, stubSearch({ '/api/work': ['src/routes/extra.ts'] }));
  assert.deepEqual(excused, { unresolved: [], proofless: [] });
  const pathRefused = await specCheck({
    criteria: [{ id: 'AC-1', text: 'src/supervisor.ts stops renewing the lease.', proofs: ['unit:x'] }],
    plannedFiles: ['src/other.ts'],
  }, tree, stubSearch({}));
  assert.deepEqual(pathRefused.unresolved, [{ criterion: 'AC-1', kind: 'path', reference: 'src/supervisor.ts' }]);
  const describedNew = await specCheck({
    criteria: [{ id: 'AC-1', text: 'A new module src/registry.ts holds the registry.', proofs: ['unit:x'] }],
    plannedFiles: [],
  }, tree, stubSearch({}));
  assert.deepEqual(describedNew, { unresolved: [], proofless: [] });
});

test('unit:spec-references-resolve — a criterion with no proof is refused naming it, beside any unresolved reference', async () => {
  const result = await specCheck({
    criteria: [
      { id: 'AC-1', text: 'derivePlannedFiles carries every file the criteria name.', proofs: [] },
      { id: 'AC-2', text: 'It is fast.', proofs: ['unit:y'] },
    ],
    plannedFiles: ['src/model/work.ts'],
  }, await treeOf(), { async filesMatching() { return new Set(['src/model/work.ts']); } });
  assert.deepEqual(result.proofless, ['AC-1']);
  const refusal = specCheckRefusal(result, 'main');
  assert.match(refusal, /AC-1 has no proof; every criterion carries at least one/);
  assert.doesNotMatch(refusal, /AC-2/, 'a criterion with a proof is not named');
});

test('unit:spec-references-resolve — the release gate reads the tree only when a criterion names a reference, and fails closed on an unreadable base when one does', async () => {
  const noTree = async () => { throw new Error('no tree was read'); };
  const vacuous = await releaseSpecGate(root, 'main', { criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }] }, { tree: noTree });
  assert.equal(vacuous, null, 'criteria naming no path, route or symbol need no tree');
  await assert.rejects(releaseSpecGate(root, 'main', { criteria: [{ id: 'AC-1', text: 'GET /api/work returns the item.', proofs: ['unit:x'] }] }, { tree: noTree }), /no tree was read/,
    'an unreadable base refuses rather than passing a reference unresolved');
});

test('unit:spec-references-resolve — the git-backed search grades a symbol needle with real git grep -E: the declaration is found and an undeclared name returns empty, never aborting', async () => {
  const search = baseSpecSearch(root, 'main');
  assert.deepEqual([...await search.filesMatching('symbol', symbolDeclarationNeedle('derivePlannedFiles'))].sort(), ['src/model/work.ts', 'src/other.ts'],
    'the export declaration line resolves every holder');
  assert.deepEqual([...await search.filesMatching('symbol', symbolDeclarationNeedle('noSuchSymbolAnywhere'))], [],
    'a symbol declared nowhere is created by the item, not unresolved');
});

test('unit:task-writing-prompts-carry-rules — the triage, research and review follow-up prompts each carry the three task-writing rules', () => {
  const rules = specRulesPrompt.split(/(?<=\.)\s+/).filter(Boolean);
  assert.equal(rules.length, 3, 'the constant carries exactly the three rules');
  const work = { id: 'id-1', key: 'GY-1', title: 'Follow-ups', description: '1. Finding with no thread: src/a.ts — the retry is unbounded', type: 'chore', priority: 2, createdAt: '2026-09-26T12:00:00Z' } as Work;
  const triage = triagePrompt({ repository: 'vishrog/graphyard' }, work, [work]);
  const research = researchPrompt({ repository: 'vishrog/graphyard' }, { key: 'GY-2', title: 'T', type: 'feature', description: '', criteria: [{ id: 'AC-1', text: 'Works.', proofs: ['unit:x'] }], plannedFiles: ['src/a.ts'] } as Work, { timeoutMinutes: 10, tokenBudget: 100_000 });
  const followUp = followUpItem({ key: 'GY-2', workId: 'id-2', pr: 7, sha: 'a'.repeat(40), reviewId: 5 },
    [{ id: 't1', author: 'reviewer', path: 'src/a.ts', line: 3, outdated: false, excerpt: 'the retry is unbounded' }] as LaunchThread[]);
  for (const [name, text] of [['triage', triage], ['research', research], ['follow-up', followUp.description]] as const) {
    for (const rule of rules) assert.ok(text.includes(rule), `the ${name} prompt carries the rule: ${rule}`);
  }
  assert.match(triage, /release gate/, 'the rules bind triage as its release gate');
  assert.match(triage, /do not release an item whose criteria name code the plannedFiles do not cover/i);
  assert.match(research, /risks/, 'the research names unresolved references in the risks it files');
  assert.match(criteriaRuleSection('GY-2', 'a'.repeat(40)), /the file that holds it/, 'each follow-up finding names the file that holds it');
  assert.match(criteriaRuleSection('GY-2', 'a'.repeat(40)), /searching for the symbols and routes/);
});
