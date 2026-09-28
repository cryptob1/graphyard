import { readFile } from 'node:fs/promises';
import { wholeDocument } from '../model/work-summary.js';
import { randomUUID } from 'node:crypto';
import { defaultChildRun, type ChildRun } from '../child-runner.js';
import { decisionInput, type MasterConfig } from '../master.js';
import { derivePlannedFiles, plannedFilesRefusal, type Work } from '../model/work.js';
import { baseSpecSearch, specCheck, specCheckRefusal, specNamesReferences, type SpecCriterion } from '../model/spec-check.js';

/**
 * The files of the base branch an item will be worked on, read from the coordinator checkout
 * after a best-effort fetch: the remote-tracking branch when there is one, the local branch
 * otherwise. Unreadable, it refuses — plannedFiles is never recorded against a tree nobody read.
 */
export async function baseTree(root: string, baseBranch: string, run: ChildRun = defaultChildRun) {
  try { await run('git', ['fetch', '--quiet', 'origin', baseBranch], { cwd: root, timeoutMs: 30_000 }); } catch { /* resolve against the last fetched base */ }
  for (const [ref, name] of [[`refs/remotes/origin/${baseBranch}`, `origin/${baseBranch}`], [`refs/heads/${baseBranch}`, baseBranch]]) {
    try {
      const listed = await run('git', ['ls-tree', '-r', '--name-only', '-z', ref], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
      return { ref: name, files: new Set(String(listed).split('\0').filter(Boolean)) };
    } catch { /* try the next ref */ }
  }
  throw new Error(`plannedFiles cannot be resolved: neither origin/${baseBranch} nor ${baseBranch} is readable in ${root}`);
}

/**
 * `master create FILE REASON` and `master requirements GY-N FILE REASON` (GY-140): plannedFiles
 * is resolved against the base branch before the intent is recorded. A planned path the tree does
 * not hold, which no criterion describes creating, refuses the item naming it; every file a
 * criterion names that the tree holds is carried in, and reported with the criterion that named it.
 * The spec check (GY-881) then grades the whole intent against the same tree: every path, route
 * and exported symbol a criterion names must resolve into plannedFiles, and every criterion must
 * carry a proof — a failing spec refuses before anything is recorded.
 */
export async function derivedIntent(root: string, config: Pick<MasterConfig, 'baseBranch'>, id: 'create' | 'requirements', args: string[],
  deps: { coordinator: (path: string) => Promise<any>; mutate: (path: string, data: unknown, requestId?: string, credential?: string) => Promise<any>; token: () => Promise<string>; tree?: typeof baseTree; search?: typeof baseSpecSearch }) {
  const file = id === 'create' ? args[0] : args[1], reason = args.slice(id === 'create' ? 1 : 2).join(' ').trim();
  if (!file || id === 'requirements' && !args[0]) throw new Error(id === 'create' ? 'Use master create FILE REASON' : 'Use master requirements GY-N FILE REASON');
  if (!reason) throw new Error(`master ${id} needs a REASON; every agent decision is attributable`);
  const input = JSON.parse(await readFile(file, 'utf8'));
  const listed: Work | undefined = id === 'requirements' ? (await deps.coordinator('work-snapshot')).work.find((item: Work) => item.id === args[0] || item.key === args[0]) : undefined;
  // A settled delivery is a summary in the snapshot (GY-422); its requirements are read whole.
  const work = listed && await wholeDocument(listed, deps.coordinator);
  if (id === 'requirements' && !work) throw new Error(`Unknown work item ${args[0]}`);
  const intent = work ? decisionInput('requirements', work, input) : input;
  const tree = await (deps.tree ?? baseTree)(root, config.baseBranch);
  const derived = derivePlannedFiles({ plannedFiles: intent.plannedFiles ?? [], criteria: intent.criteria ?? [] }, tree.files);
  if (derived.missing.length) throw new Error(plannedFilesRefusal(derived.missing, tree.ref));
  const spec = await specCheck({ criteria: intent.criteria ?? [], plannedFiles: derived.plannedFiles }, tree.files, (deps.search ?? baseSpecSearch)(root, tree.ref));
  if (spec.unresolved.length || spec.proofless.length) throw new Error(specCheckRefusal(spec, tree.ref));
  const result = await deps.mutate(work ? `work/${work.id}/requirements` : 'work', { ...intent, plannedFiles: derived.plannedFiles, reason }, process.env.GRAPHYARD_REQUEST_ID ?? randomUUID(), await deps.token());
  return { ...result, plannedFilesDerived: { base: tree.ref, added: derived.added } };
}

/**
 * `master release GY-N REASON` passes the same gate before the item is made ready (GY-881): the
 * item's spec is graded against the base branch it will be worked on — every path, route and
 * exported symbol its criteria name must resolve into its plannedFiles or be one a criterion
 * describes creating, and every criterion must carry a proof. A failing spec refuses the release
 * naming each unresolved reference, so the master rewrites the requirements (`master requirements`)
 * instead of dispatching a task whose worker must come back for scope; an open item authored
 * before the check shipped is hard-refused the same way, and the refusal is its fix list.
 */
export async function releaseSpecGate(root: string, baseBranch: string, work: { criteria?: SpecCriterion[]; plannedFiles?: readonly string[] },
  deps: { tree?: typeof baseTree; search?: typeof baseSpecSearch } = {}) {
  const criteria = work.criteria ?? [];
  const proofless = criteria.filter(entry => !entry.proofs?.length).map(entry => entry.id);
  // The tree is read only when there is something to resolve against it: criteria that name no
  // path, route or symbol, all of them proofed, grade the same on every tree, so none is fetched.
  if (!proofless.length && !specNamesReferences(criteria)) return null;
  const tree = await (deps.tree ?? baseTree)(root, baseBranch);
  const spec = await specCheck({ criteria, plannedFiles: work.plannedFiles ?? [] }, tree.files, (deps.search ?? baseSpecSearch)(root, tree.ref));
  if (spec.unresolved.length || spec.proofless.length) throw new Error(specCheckRefusal(spec, tree.ref));
  return tree;
}
