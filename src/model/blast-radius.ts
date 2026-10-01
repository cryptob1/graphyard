import type { Gate, ScopeFile, Work } from './work.js';
import { pathScopeContains } from './scope.js';

/**
 * A candidate's merge danger and blast radius in plain sentences (GY-972): what the change
 * touches, whether it is a one-way or a two-way door, what reverting it restores, and what the
 * merge guard checks before it lands. Everything is derived from the item's own scope (its
 * plannedFiles and the files the latest observation read from the provider) and its landability
 * verdict (the gates, the conflict reading and the unlanded work the head carries), so the
 * summary never says anything those do not. Gate reasons are never quoted: each gate is named by
 * what it checks, in words a newcomer can read without the docs.
 */
export type Danger = 'low' | 'medium' | 'high' | 'unknown';
export interface BlastRadius {
  danger: Danger;
  /** One-way when some of the change outlives a revert of its merge commit; null until the files are known. */
  door: 'one-way' | 'two-way' | null;
  /** The label shown before the sentences, such as "Merge danger: low · two-way door". */
  headline: string;
  touches: string; doorway: string; reverts: string; guard: string;
  /** The four sentences above, in reading order. */
  sentences: string[];
}

interface Area { name: string; match: (path: string) => boolean; oneWay?: string }
/**
 * Where a file sits, in words. The areas with `oneWay` hold changes a revert of the merge commit
 * does not take back: they act outside the repository the moment they land (data a migration
 * rewrote, infrastructure a deploy applied, whatever a workflow published with repository secrets).
 * First match wins, so the one-way areas come first.
 */
const areas: Area[] = [
  { name: 'the database schema', match: path => /(^|\/)migrations?\//.test(path) || /(^|\/)schema\.(ts|js|sql|prisma)$/.test(path) || path.startsWith('src/store/tables/'), oneWay: 'data already migrated in a live database' },
  { name: 'installation and deployment', match: path => /(^|\/)(Dockerfile|compose\.ya?ml|docker-compose\.ya?ml)$/.test(path) || /^(deploy|helm|terraform|k8s|\.railway)\//.test(path) || path.startsWith('src/install/') || path.endsWith('.tf'), oneWay: 'infrastructure a deploy has already applied' },
  { name: 'the GitHub workflows', match: path => path.startsWith('.github/workflows/'), oneWay: 'anything the workflows published with repository secrets while they were live' },
  { name: 'tests', match: path => /^(tests?|browser-tests|e2e)\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) },
  { name: 'documentation', match: path => path.startsWith('docs/') || /\.md$/i.test(path) },
  { name: 'dependencies', match: path => /(^|\/)(package(-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(path) },
  { name: 'the dashboard', match: path => path.startsWith('web/') },
  { name: 'scripts', match: path => /^(scripts|bin)\//.test(path) },
  { name: 'the server code', match: path => path.startsWith('src/') },
];
const other: Area = { name: 'other files', match: () => true };
const areaOf = (path: string) => areas.find(area => area.match(path)) ?? other;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
/** "a", "a and b", "a, b and c". */
const list = (items: string[]) => items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

/** What each gate checks, as a clause after "the merge guard checks that". */
function guardClauses(work: Pick<Work, 'policy' | 'criteria'>, base: string): { gate: string; text: string }[] {
  const proofs = (work.criteria ?? []).reduce((sum, criterion) => sum + criterion.proofs.length, 0);
  const checks = work.policy?.checks ?? [];
  return [
    { gate: 'build', text: 'the builder has handed the work in' },
    ...(checks.length ? [{ gate: 'test', text: `the automated ${checks.length === 1 ? 'check' : 'checks'} ${list(checks)} ${checks.length === 1 ? 'passes' : 'pass'} on this exact code` }] : []),
    ...(work.policy?.review ? [{ gate: 'review', text: 'someone other than the builder approves this exact code' }] : []),
    ...(proofs ? [{ gate: 'acceptance', text: `${proofs === 1 ? 'the proof its requirements name passes' : `all ${proofs} proofs its requirements name pass`} on it` }] : []),
    { gate: 'merge', text: `it merges cleanly onto ${base} and puts back no file outside its plan` },
  ];
}
const gateWords: Record<string, string> = { build: 'hand-in', test: 'automated checks', review: 'approval', acceptance: 'proof', merge: 'clean merge' };

type Subject = Pick<Work, 'candidate' | 'observation' | 'plannedFiles' | 'policy' | 'criteria' | 'gates'>;

export function blastRadius(work: Subject): BlastRadius {
  const observation = work.observation;
  const base = observation?.landing?.base ?? 'the base branch';
  const clauses = guardClauses(work, base);
  const open = clauses.filter(clause => ((work.gates ?? []) as Gate[]).some(gate => gate.name === clause.gate && !gate.passed));
  const guard = `Before it merges, the merge guard checks that ${list(clauses.map(clause => clause.text))}. `
    + (open.length ? `Still missing: ${list(open.map(clause => gateWords[clause.gate]))}.` : 'Every one of these holds now.');
  // Only a reading of the current head describes what this candidate touches.
  const current = !!work.candidate && !!observation && observation.candidate?.sha === work.candidate.sha;
  if (!current) {
    const touches = work.candidate ? 'Graphyard has not read which files the latest code changes yet, so its reach is not known.' : 'There is no pull request yet, so nothing is touched.';
    const doorway = 'Whether it can be undone is decided once its files are known.';
    const reverts = 'Nothing has landed, so there is nothing to revert.';
    return { danger: 'unknown', door: null, headline: 'Merge danger: not known yet', touches, doorway, reverts, guard, sentences: [touches, doorway, reverts, guard] };
  }
  const files: Pick<ScopeFile, 'path' | 'status' | 'additions' | 'deletions'>[] = observation!.scopeFiles?.length
    ? observation!.scopeFiles : (observation!.files ?? []).map(path => ({ path, status: 'changed', additions: 0, deletions: 0 }));
  const lines = files.reduce((sum, file) => sum + file.additions + file.deletions, 0);
  const removed = files.filter(file => file.status === 'removed').length;
  const counts = new Map<Area, number>();
  for (const file of files) { const area = areaOf(file.path); counts.set(area, (counts.get(area) ?? 0) + 1); }
  const planned = work.plannedFiles ?? [];
  const outside = planned.length ? files.filter(file => !planned.some(scope => pathScopeContains(scope, file.path))).length : 0;
  const touches = !files.length ? 'It changes no files.'
    : `It changes ${plural(files.length, 'file')}${lines ? ` (${plural(lines, 'line')})` : ''} in ${list([...counts].sort((a, b) => b[1] - a[1]).map(([area, count]) => `${area.name} (${count})`))}`
      + `${removed ? `, deleting ${plural(removed, 'file')}` : ''}.`
      + (outside ? ` ${outside === 1 ? 'One of them is' : `${outside} of them are`} outside its plan.` : '');
  const lasting = [...counts.keys()].filter(area => area.oneWay);
  const door = lasting.length ? 'one-way' : 'two-way';
  const doorway = lasting.length
    ? `One-way door: it changes ${list(lasting.map(area => area.name))}, which acts outside the code once it lands.`
    : 'Two-way door: it changes only code and text in the repository, so undoing it is a revert.';
  const foreign = [...new Set([...(observation!.landing?.foreign ?? []), ...(observation!.landing?.carried ?? [])].map(entry => entry.key))];
  const restores = `${observation!.merged ? 'Reverting its merge commit restores' : 'If it lands and misbehaves, reverting its merge commit restores'} ${files.length === 1 ? 'that file' : `those ${plural(files.length, 'file')}`}`;
  const reverts = `${restores}${lasting.length ? `, but not ${list(lasting.map(area => area.oneWay!))}` : ''}.`
    + (foreign.length ? ` Its branch also carries unfinished work from ${list(foreign)}, which a revert would take out too.` : '');
  const conflicting = !!observation!.conflicting;
  const danger: Danger = lasting.length || foreign.length || outside || conflicting ? 'high'
    : files.length > 10 || lines > 400 || removed ? 'medium' : 'low';
  const headline = `Merge danger: ${danger} · ${door} door${conflicting ? ' · conflicts with the base branch' : ''}`;
  return { danger, door, headline, touches, doorway, reverts, guard, sentences: [touches, doorway, reverts, guard] };
}
