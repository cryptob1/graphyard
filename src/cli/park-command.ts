import { humanDecisionKinds, type HumanChoice, type HumanDecisionKind } from '../model/human-request.js';
import { shortAskIssues } from '../model/human-ask.js';
import { workMutation, type CliCommand } from './registry.js';

/**
 * The worker half of a human-only wait (GY-89): record the decision only a human may make as a
 * typed request. The same call ends the attempt's lease and parks the item, so the session exits
 * owning nothing; the human answers it and the loop dispatches the item again. The request leads
 * with a short ask the human reads (GY-1408); NEEDED and REASON are the next agent's detail.
 */
export const parkCommand: CliCommand = {
  name: 'park',
  scope: 'work',
  help: [
    '  park GY-N EPOCH KIND NEEDED... --ask ASK [--step STEP]... [--why WHY] [--choice LABEL]... -- REASON',
    '                                Record a decision only a human may make and end this attempt:',
    `                                KIND is ${humanDecisionKinds.join(', ')};`,
    '                                ASK, STEP and WHY are what the human reads: write them for a',
    '                                non-technical reader. ASK is one sentence naming the action',
    '                                they take (at most 140 characters), each --step one plain',
    '                                instruction (at most 5, 160 characters each), WHY one plain',
    '                                sentence (200). Branches, commit shas, file paths, commands',
    '                                and resume steps go only in NEEDED and REASON, the detail for',
    '                                agents: ASK and STEP refuse them.',
    '                                NEEDED is the exact thing the human must provide: every human',
    '                                step the item still needs, never one at a time (a scope',
    '                                widening is refused: use scope-request). The item',
    '                                parks without a lease and nothing else waits on it. Each',
    '                                --choice is a button the human presses (--choice-text asks for',
    '                                their words too, --choice-secret for a value sealed to this',
    '                                host); Decline is always offered. Without any, the kind\'s',
    '                                defaults are offered',
  ],
  async run(context, work) {
    const { args, print } = context;
    const epoch = Number(args[0]), kind = args[1], separator = args.indexOf('--');
    const { needed, choices, ask, steps, why } = parkArgs(args.slice(2, separator < 0 ? args.length : separator));
    const reason = separator < 0 ? '' : args.slice(separator + 1).join(' ').trim();
    if (!Number.isInteger(epoch) || epoch < 1 || !humanDecisionKinds.includes(kind as HumanDecisionKind) || !needed || !ask || !reason) throw new Error(`Use park GY-N EPOCH KIND NEEDED... --ask ASK [--step STEP]... [--why WHY] [--choice LABEL]... -- REASON, where KIND is ${humanDecisionKinds.join(', ')}`);
    const issues = shortAskIssues({ ask, steps, why });
    if (issues.length) throw new Error(`${issues.join('. ')}.`);
    // A credential is sealed to this host when the human provides it, so the host's key goes with the request.
    // Imported here: session-commands.ts lists this command, so a static import would be a cycle.
    const { hostSealKey } = await import('./session-commands.js');
    const sealTo = kind === 'credentials-for-people' || choices?.some(choice => choice.input === 'secret') ? await hostSealKey(context.individualHostId()).catch(() => undefined) : undefined;
    return print(await workMutation(context, work)('park', { epoch, kind, needed, reason, ask, ...(steps ? { steps } : {}), ...(why ? { why } : {}), ...(choices ? { choices } : {}), ...(sealTo ? { sealTo } : {}) }));
  },
};

const choiceFlags = { '--choice': 'none', '--choice-text': 'text', '--choice-secret': 'secret' } as const;
const askFlags: readonly string[] = ['--ask', '--step', '--why'];
/**
 * NEEDED, the short ask and the requester's choices from the words between KIND and `--`. `--ask`,
 * `--why` and each `--step` take the next word as their text; each choice flag takes the next word
 * as its label, and the choices become buttons in that order, each resuming the item.
 */
export function parkArgs(words: readonly string[]) {
  const needed: string[] = [], choices: HumanChoice[] = [], steps: string[] = [];
  let ask: string | undefined, why: string | undefined;
  for (let index = 0; index < words.length; index++) {
    const flag = words[index], input = choiceFlags[flag as keyof typeof choiceFlags];
    if (!input && !askFlags.includes(flag)) { needed.push(flag); continue; }
    const value = words[++index]?.trim();
    if (!value || value.startsWith('--')) throw new Error(input ? `${flag} needs a LABEL, such as --choice "Approve up to €50/month"` : `${flag} needs its text, such as --ask "Create the install-proof repository on GitHub"`);
    if (flag === '--ask') ask = value;
    else if (flag === '--why') why = value;
    else if (flag === '--step') steps.push(value);
    else choices.push({ id: `choice-${choices.length + 1}`, label: value, outcome: 'provided', input });
  }
  return { needed: needed.join(' ').trim(), choices: choices.length ? choices : undefined, ...(ask ? { ask } : {}), ...(steps.length ? { steps } : {}), ...(why ? { why } : {}) };
}
