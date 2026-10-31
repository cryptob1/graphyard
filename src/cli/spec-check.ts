import { postSpecCheck, SpecCheckPostRefusal, specCheckPostExample } from '../spec-check-post.js';
import { cliPath } from './context.js';
import { defineCommands } from './registry.js';

/**
 * `spec-check post` (GY-2992): the spec-check session's one report — the paraphrase, the gaps, the
 * verdict — posted through Graphyard as its launch's one-time token. It never reads the repository
 * connection file: a spec checker holds no Graphyard credential.
 */
export const specCheckCommands = defineCommands([{
  name: 'spec-check',
  readsConnection: () => false,
  help: [
    '  spec-check post --verdict ready|gaps --paraphrase TEXT [--gap TEXT]...',
    '                                Spec-check session only: post its one report on the bound item',
    '                                (the paraphrase, one --gap per named gap) as its launch token; the',
    '                                report gates the item\'s dispatch and shows on its dashboard',
  ],
  async run(context) {
    const { id, args, print } = context;
    const flag = (name: string) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
    if (id !== 'post') throw new Error(`Use spec-check post --verdict ready|gaps --paraphrase TEXT [--gap TEXT]..., like this:\n${specCheckPostExample(cliPath, 'ready')}`);
    const gaps: string[] = [];
    for (let at = args.indexOf('--gap'); at >= 0; at = args.indexOf('--gap', at + 1)) gaps.push(args[at + 1] ?? '');
    try { print(await postSpecCheck({ verdict: flag('--verdict'), paraphrase: flag('--paraphrase'), gaps, cliPath, environment: process.env }, { fetch })); }
    catch (error) { if (error instanceof SpecCheckPostRefusal) { console.error(error.message); process.exitCode = 1; return; } throw error; }
  },
}]);
