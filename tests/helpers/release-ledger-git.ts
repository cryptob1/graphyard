// GY-2010: the release ledger as the coordinator checkout holds it — `rc/` annotated tags, each
// carrying its candidate record — answered by a fake git runner, so a test of the import that binds
// runs to candidates needs no repository. `down` fails every read; `reads` counts them.
import type { GitResult, GitRunner } from '../../src/merge-writer/local-observation.js';

export function releaseLedgerGit(candidates: () => readonly { id: string; sha: string }[], tagObject: (index: number) => string) {
  const ledger = { down: false, reads: 0, run: (async (args: readonly string[]): Promise<GitResult> => {
    ledger.reads++;
    if (ledger.down) return { status: 128, stdout: '', stderr: 'fatal: the checkout is unreadable' };
    const listed = candidates();
    if (args[0] === 'for-each-ref' && String(args.at(-1)).startsWith('refs/tags/rc/'))
      return { status: 0, stdout: listed.map((entry, index) => `refs/tags/rc/${entry.id} ${tagObject(index)} tag\n`).join(''), stderr: '' };
    const index = args[0] === 'cat-file' && args[1] === 'tag' ? listed.findIndex((_, i) => tagObject(i) === args[2]) : -1;
    if (index >= 0) return { status: 0, stdout: `object ${listed[index]!.sha}\ntype commit\ntag rc/${listed[index]!.id}\ntagger graphyard-release <release@graphyard.invalid> 0 +0000\n\n${JSON.stringify(listed[index])}\n`, stderr: '' };
    return { status: 128, stdout: '', stderr: `fatal: unexpected git ${args.join(' ')}` };
  }) as GitRunner };
  return ledger;
}
