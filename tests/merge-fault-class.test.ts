import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHub, wordMergeMarker } from '../src/github.js';
import { mergeText } from '../src/text-merge.js';
import { Refusal, SpeculativeConflict } from '../src/model.js';
import { carryRefusal } from '../src/model/carry.js';

// GY-444: three base-conflict faults in 24 hours (GY-402 twice, GY-406 once). Each fixture holds
// the conflicting hunks of one instance exactly as git reported them — the merge base, the
// candidate (ours) and the base branch tip (theirs) — so the suite needs no history the CI
// checkout lacks. Every hunk is two items' independent edits on one line, or on adjacent lines,
// which a line-granular merge (git's, and GitHub's merge API with it) refuses.

interface FaultFile { path: string; base: string; ours: string; theirs: string }
interface FaultInstance { id: string; subject: string; candidate: string; baseTip: string; files: FaultFile[] }
const instances: FaultInstance[] = JSON.parse(readFileSync(new URL('./fixtures/merge-faults-2026-09-26.json', import.meta.url), 'utf8'));
const prose = (path: string) => path.endsWith('.md');

/** git's own line-granular three-way merge of one file: the merge the base branch relies on. */
function gitMerge(file: FaultFile): { conflicts: number; merged: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gy-444-'));
  try {
    for (const [name, text] of [['ours', file.ours], ['base', file.base], ['theirs', file.theirs]]) writeFileSync(join(dir, name), text);
    const run = spawnSync('git', ['merge-file', '-p', join(dir, 'ours'), join(dir, 'base'), join(dir, 'theirs')], { encoding: 'utf8' });
    assert.ok(run.status !== null && run.status >= 0, run.stderr);
    return { conflicts: run.status!, merged: run.stdout };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const words = (text: string) => new Set(text.match(/[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g) ?? []);
/** Every word a side introduced — one its base version of the file does not contain anywhere. */
const introduced = (base: string, side: string) => [...words(side)].filter(word => !words(base).has(word));

test('manual:fault-class-merge — every listed base-conflict instance conflicts under the line-granular merge the base uses, and merges without a conflict under the candidate, keeping both sides\' changes', () => {
  assert.deepEqual(instances.map(instance => instance.id), [
    'base-conflict|GY-402|2026-09-26T01:40:41.240Z',
    'base-conflict|GY-406|2026-09-26T01:42:44.085Z',
    'base-conflict|GY-402|2026-09-26T03:31:45.185Z',
  ], 'the fixture holds exactly the instances GY-444 lists');
  for (const instance of instances) {
    assert.ok(instance.files.length > 0, `${instance.id} names its conflicting files`);
    for (const file of instance.files) {
      // Against the base: git refuses, exactly as GitHub's merge API refused with 409.
      assert.ok(gitMerge(file).conflicts > 0, `${instance.id} ${file.path} reproduces: a line-granular merge conflicts`);
      // Against the candidate: the word-level merge resolves it.
      const result = mergeText(file.base, file.ours, file.theirs, { prose: prose(file.path) });
      assert.ok(!('conflict' in result), `${instance.id} ${file.path} does not recur: ${'conflict' in result ? result.conflict : ''}`);
      if ('conflict' in result) continue;
      assert.ok(result.resolved > 0, `${file.path} needed the word-level pass`);
      for (const word of introduced(file.base, file.ours)) assert.ok(result.merged.includes(word), `${file.path} keeps the candidate's "${word}"`);
      for (const word of introduced(file.base, file.theirs)) assert.ok(result.merged.includes(word), `${file.path} keeps the base branch's "${word}"`);
    }
  }
});

test('unit:word-merge-results — the resolved instances read as the two changes combined', () => {
  const file = (subject: string, path: string) => instances.flatMap(instance => instance.subject === subject ? instance.files : []).find(entry => entry.path === path)!;
  const merged = (entry: FaultFile) => { const result = mergeText(entry.base, entry.ours, entry.theirs, { prose: prose(entry.path) }); assert.ok('merged' in result); return result; };
  // GY-402 × GY-413: each added names to a different import on adjacent lines of src/reviewer.ts.
  const reviewer = merged(file('GY-402', 'src/reviewer.ts')).merged;
  assert.match(reviewer, /import \{ closeFailedLaunch, launchStartMs, withLaunchClose, accountLaunch, /);
  assert.match(reviewer, /unaccountedThreads, type AppendFollowUpFindings, type CreateFollowUpItem, /);
  // GY-406 × GY-413: each trimmed a different clause of one sentence.
  assert.match(merged(file('GY-406', 'docs/master-agent-sessions.md')).merged,
    /^Add reviewers with `master reviewer setup` and `master reviewer add FILE` \(\[Claude\]\([^)]*\), \[opencode\]\([^)]*\)\); `master review GY-N \[PROFILE\]` recovers a refused launch or unsatisfied attempt\.$/m);
  // GY-402 × GY-406: both appended one decision action to the same array; both are kept, ours first.
  const approval = merged(file('GY-402', 'src/model/approval.ts')).merged;
  assert.match(approval, /'recover', 'grant', 'close', 'repair-merge'\] as const;/);
  // Both trimmed "Reviewers approve candidates, proof producers …": the base branch's landed trim
  // is kept over the candidate's deletions, and the merge says so.
  const glossary = merged(file('GY-402', 'docs/glossary.md'));
  assert.match(glossary.merged, /proof grants, repair-lane merges and merge with automatic merging off go through `graphyard master decide GY-N ACTION REASON`/);
  assert.match(glossary.merged, / Reviewers, producers and the merge gate decide the rest\. /);
  assert.equal(glossary.notes.length, 1);
  assert.match(glossary.notes[0], /^kept the base branch's "and" over this side's trim/);
});

test('unit:word-merge-refusals — colliding words, binary content and code deletions stay conflicts', () => {
  // Both sides rewrote the same words.
  assert.match((mergeText('a\nconst x = 1;\nb\n', 'a\nconst x = 2;\nb\n', 'a\nconst x = 3;\nb\n') as { conflict: string }).conflict, /both sides changed the same words: const x = 2;/);
  // Edits separated by whitespace alone are one phrase.
  assert.ok('conflict' in mergeText('one two three\n', 'one TWO three\n', 'one two THREE\n'));
  assert.ok('conflict' in mergeText('one two\n', 'ONE two\n', 'one TWO\n'));
  // The trim rule is for Markdown only: code keeps a deletion that collides as a conflict.
  const trim = ['Reviewers approve candidates, proof producers produce evidence.\n', 'Reviewers approve candidates, producers produce evidence.\n', 'Reviewers and producers decide.\n'] as const;
  assert.ok('conflict' in mergeText(...trim));
  const kept = mergeText(...trim, { prose: true });
  assert.ok('merged' in kept && kept.merged === trim[2] && kept.notes.length === 1 && /^kept the base branch's "and" over this side's trim of "approve candidates, proof"/.test(kept.notes[0]), JSON.stringify(kept));
  // A candidate that rewrote (not only deleted) the words the base trimmed stays a conflict in prose too.
  assert.ok('conflict' in mergeText(trim[0], 'Reviewers approve candidates, trusted producers produce evidence.\n', trim[2], { prose: true }));
  assert.deepEqual(mergeText('a\0b', 'a\0c', 'a\0d'), { conflict: 'binary content' });
  // Edits a word apart on one line, and two insertions at one point, merge.
  assert.deepEqual(mergeText('import { a, b, c } from "x";\n', 'import { a0, a, b, c } from "x";\n', 'import { a, b, c, d } from "x";\n'), { merged: 'import { a0, a, b, c, d } from "x";\n', resolved: 1, notes: [] });
  assert.deepEqual(mergeText('x\ny\n', 'x\nours\ny\n', 'x\ntheirs\ny\n'), { merged: 'x\nours\ntheirs\ny\n', resolved: 1, notes: [] });
});

test('unit:word-merge-line-diff — edits far apart merge exactly as the line merge does, on randomized files', () => {
  let seed = 444;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let round = 0; round < 200; round++) {
    const base = Array.from({ length: 20 + Math.floor(random() * 40) }, (_, index) => `line ${index} ${Math.floor(random() * 5)}\n`);
    const half = Math.floor(base.length / 2);
    const edit = (from: number, to: number, tag: string) => base.flatMap((line, index) => {
      if (index < from || index >= to || random() > 0.3) return [line];
      const roll = random();
      return roll < 0.33 ? [] : roll < 0.66 ? [`${tag} ${index}\n`] : [line, `${tag} added ${index}\n`];
    });
    const ours = edit(0, half - 2, 'ours'), theirs = edit(half + 2, base.length, 'theirs');
    const result = mergeText(base.join(''), ours.join(''), theirs.join(''));
    const expected = gitMerge({ path: 'x', base: base.join(''), ours: ours.join(''), theirs: theirs.join('') });
    assert.equal(expected.conflicts, 0);
    assert.ok('merged' in result && result.merged === expected.merged, `round ${round} matches git`);
  }
});

// ---- The provider merge: GitHub's refusal is resolved through the Git Data API --------------

const blobSha = (text: string) => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0${text}`).digest('hex');
const commitSha = (label: string) => createHash('sha1').update(label).digest('hex');

/** A fake GitHub over three commits (merge base, ours, theirs), refusing `/merges` as GitHub did. */
function repository(trees: { base: Record<string, string>; ours: Record<string, string>; theirs: Record<string, string> }) {
  const shas = { base: commitSha('base'), ours: commitSha('ours'), theirs: commitSha('theirs') };
  const blobs = new Map<string, string>(), writes: { path: string; method: string; body: any }[] = [];
  const refs = new Map<string, string>([['graphyard/gy-402-1', shas.ours]]);
  for (const tree of Object.values(trees)) for (const text of Object.values(tree)) blobs.set(blobSha(text), text);
  const commitOf = (sha: string) => (Object.keys(shas) as (keyof typeof shas)[]).find(key => shas[key] === sha)!;
  const changes = (from: Record<string, string>, to: Record<string, string>) => [...new Set([...Object.keys(from), ...Object.keys(to)])].sort()
    .filter(path => from[path] !== to[path]).map(path => ({ filename: path, status: !(path in from) ? 'added' : !(path in to) ? 'removed' : 'modified', ...(path in to ? { sha: blobSha(to[path]) } : {}) }));
  const github = new GitHub({ repository: 'owner/repo', base: 'main', appId: 1234, installationId: 1, privateKey: 'not-used' });
  github.request = async (path: string, method = 'GET', body?: any) => {
    if (method !== 'GET') writes.push({ path, method, body });
    if (path === '/merges') throw new Refusal('GitHub POST /merges failed (409)', 502);
    let match: RegExpMatchArray | null;
    if ((match = path.match(/^\/git\/ref\/heads\/(.+)$/))) return { object: { sha: refs.get(match[1]) } };
    if ((match = path.match(/^\/git\/refs\/heads\/(.+)$/)) && method === 'PATCH') { refs.set(match[1], body.sha); return {}; }
    if (method === 'DELETE') return {};
    if ((match = path.match(/^\/compare\/([a-f0-9]{40})\.\.\.([a-f0-9]{40})$/))) {
      const [from, to] = [commitOf(match[1]), commitOf(match[2])];
      return { merge_base_commit: { sha: shas.base }, files: changes(trees.base, trees[to as keyof typeof trees]), status: from === to ? 'identical' : 'diverged' };
    }
    if ((match = path.match(/^\/git\/commits\/([a-f0-9]{40})$/))) return { tree: { sha: commitSha(`tree ${match[1]}`) } };
    if ((match = path.match(/^\/git\/trees\/([a-f0-9]{40})\?recursive=1$/))) {
      const tree = trees[commitOf(commitSha(`tree ${shas.theirs}`) === match[1] ? shas.theirs : shas.ours) as keyof typeof trees];
      return { truncated: false, tree: Object.entries(tree).map(([entry, text]) => ({ path: entry, mode: '100644', type: 'blob', sha: blobSha(text) })) };
    }
    if ((match = path.match(/^\/contents\/(.+)\?ref=([a-f0-9]{40})$/))) return { sha: blobSha(trees[commitOf(match[2]) as keyof typeof trees][decodeURIComponent(match[1])]) };
    if ((match = path.match(/^\/git\/blobs\/([a-f0-9]{40})$/))) return { content: Buffer.from(blobs.get(match[1])!).toString('base64'), encoding: 'base64' };
    if (path === '/git/blobs') { const sha = blobSha(body.content); blobs.set(sha, body.content); return { sha }; }
    if (path === '/git/trees') return { sha: commitSha(JSON.stringify(body)) };
    if (path === '/git/commits') return { sha: commitSha(JSON.stringify(body)) };
    if (/^\/git\/refs/.test(path)) return {};
    throw new Error(`Unexpected request ${method} ${path}`);
  };
  return { github, shas, writes, blobs, refs };
}

test('integration:word-merge-provider — each instance, refused by GitHub\'s merge, is merged by Graphyard: one commit with both parents, the resolved files named, the branch moved only from the tip it read', async () => {
  for (const instance of instances) {
    const pick = (side: 'base' | 'ours' | 'theirs') => ({ 'README.md': 'untouched\n', 'docs/only-theirs.md': side === 'theirs' ? 'changed on the base branch\n' : 'original\n', ...Object.fromEntries(instance.files.map(file => [file.path, file[side]])) });
    const repo = repository({ base: pick('base'), ours: pick('ours'), theirs: pick('theirs') });
    // The refresh's test merge (GY-375) is the call that recorded each instance: it is clean now.
    assert.equal(await repo.github.testMerge(instance.subject, repo.shas.ours, repo.shas.theirs), null, `${instance.id} does not recur at the refresh's test merge`);
    const merged = await repo.github.mergeBranch('graphyard/gy-402-1', repo.shas.theirs, `Graphyard speculative tip for ${instance.subject} behind main`);
    const tree = repo.writes.filter(write => write.path === '/git/trees').at(-1)!.body;
    const commit = repo.writes.filter(write => write.path === '/git/commits').at(-1)!.body;
    assert.deepEqual(commit.parents, [repo.shas.ours, repo.shas.theirs], 'the parents are the branch tip and the merged-in head, as GitHub would have them');
    assert.equal(tree.base_tree, commitSha(`tree ${repo.shas.ours}`));
    assert.match(commit.message, new RegExp(`^Graphyard speculative tip for ${instance.subject} behind main\\n\\n${wordMergeMarker}: ${instance.files.map(file => file.path.replace(/[.]/g, '\\.')).join(', ')}\\.`));
    assert.deepEqual(tree.tree.map((entry: any) => entry.path).sort(), ['docs/only-theirs.md', ...instance.files.map(file => file.path)].sort(), 'the base branch\'s own changes and the resolved files, nothing else');
    for (const file of instance.files) {
      const entry = tree.tree.find((item: any) => item.path === file.path);
      const expected = mergeText(file.base, file.ours, file.theirs, { prose: prose(file.path) });
      assert.ok('merged' in expected && repo.blobs.get(entry.sha) === expected.merged, `${file.path} holds the word-level merge`);
    }
    assert.equal(tree.tree.find((item: any) => item.path === 'docs/only-theirs.md').sha, blobSha('changed on the base branch\n'));
    const move = repo.writes.filter(write => write.method === 'PATCH' && write.path === '/git/refs/heads/graphyard/gy-402-1').at(-1)!;
    assert.deepEqual(move.body, { sha: merged, force: false }, 'the branch is moved, never forced, to the new commit');
  }
});

test('integration:word-merge-provider-refusal — a file whose words collide is still refused as a speculative conflict, and nothing is written', async () => {
  const repo = repository({ base: { 'src/a.ts': 'const x = 1;\n' }, ours: { 'src/a.ts': 'const x = 2;\n' }, theirs: { 'src/a.ts': 'const x = 3;\n' } });
  await assert.rejects(repo.github.mergeBranch('graphyard/gy-402-1', repo.shas.theirs, 'merge'),
    (error: unknown) => error instanceof SpeculativeConflict && /conflicts and cannot be resolved by Graphyard: src\/a\.ts: both sides changed the same words/.test(error.message));
  assert.deepEqual(repo.writes.map(write => `${write.method} ${write.path}`), ['POST /merges'], 'nothing but the refused merge was asked');
});

test('unit:word-merge-no-carry — a tip Graphyard resolved word by word carries no review and no proof', () => {
  const from = { sha: commitSha('head'), baseSha: commitSha('bound') }, to = { sha: commitSha('tip'), baseSha: commitSha('predicted') };
  const merge = { from: from.sha, parents: [from.sha, to.baseSha], author: 'graphyard[bot]', authoredByApp: true, conflicts: true, baseChanges: [] };
  assert.match(carryRefusal({ from, to, merge, predecessor: { key: null, validated: true }, app: 'graphyard' } as Parameters<typeof carryRefusal>[0])!, /needed conflict resolution, which is new content nobody reviewed or proved/);
});

test('unit:word-merge-describe — describeMerge records a Graphyard word-level merge commit as resolved', async () => {
  const github = new GitHub({ repository: 'owner/repo', base: 'main', appId: 1234, installationId: 1, privateKey: 'not-used' });
  github.controlPlaneLogin = async () => 'graphyard-owner-repo[bot]';
  const message = { resolved: `Graphyard speculative tip for GY-1 behind main\n\n${wordMergeMarker}: src/a.ts.`, plain: 'Graphyard speculative tip for GY-1 behind main' };
  let current = message.plain;
  github.request = async (path: string) => {
    if (path.startsWith('/commits/')) return { sha: path.slice(9), parents: [], author: null, commit: { message: current, author: { email: 'noreply@github.com' } } };
    if (path.startsWith('/compare/')) return { status: 'ahead', files: [] };
    throw new Error(`Unexpected request ${path}`);
  };
  const describe = (github as unknown as { describeMerge: (from: string, tip: string, bound: string, predicted: string) => Promise<{ conflicts: boolean }> }).describeMerge.bind(github);
  assert.equal((await describe(commitSha('a'), commitSha('b'), commitSha('c'), commitSha('d'))).conflicts, false);
  current = message.resolved;
  assert.equal((await describe(commitSha('a'), commitSha('b'), commitSha('c'), commitSha('d'))).conflicts, true);
});

test('integration:word-merge-provider-fallback — a word-level merge that cannot complete leaves GitHub\'s conflict as it was, never a different error', async () => {
  const instance = instances[0];
  const pick = (side: 'base' | 'ours' | 'theirs') => Object.fromEntries(instance.files.map(file => [file.path, file[side]]));
  const repo = repository({ base: pick('base'), ours: pick('ours'), theirs: pick('theirs') });
  const request = repo.github.request.bind(repo.github);
  repo.github.request = async (path: string, method = 'GET', body?: any) => {
    if (path === '/git/trees' && method === 'POST') throw new Refusal('GitHub POST /git/trees failed (500)', 502);
    return request(path, method, body);
  };
  await assert.rejects(repo.github.mergeBranch('graphyard/gy-402-1', repo.shas.theirs, 'merge'),
    (error: unknown) => error instanceof SpeculativeConflict && /cannot be resolved by Graphyard: the word-level merge could not be completed \(GitHub POST \/git\/trees failed \(500\)\)/.test(error.message));
  assert.equal(repo.refs.get('graphyard/gy-402-1'), repo.shas.ours, 'the branch is not moved');
  const conflict = await repo.github.testMerge(instance.subject, repo.shas.ours, repo.shas.theirs);
  assert.match(conflict ?? '', /conflicts and cannot be resolved by Graphyard/);
});
