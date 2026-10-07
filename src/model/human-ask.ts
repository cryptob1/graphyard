// ---------------------------------------------------------------------------
// The short ask a human request leads with (GY-1408).
//
// A parked request used to reach the human as its worker's own note: ~150 words of branch shas,
// resume commands and proof names, rendered three times on one card, with the two things the
// human had to do buried in the middle. A park now carries a short ask apart from that detail:
// ASK, one sentence naming the action the human takes; optional STEPS, a few plain lines; WHY,
// one plain sentence. Agent shorthand is refused in ASK and STEPS, naming the offending text, so
// it goes in REASON, which the card folds away under "Details for agents".
// ---------------------------------------------------------------------------

export const askLimits = { ask: 140, steps: 5, step: 160, why: 200 } as const;

// URLs are left alone: "open github.com/settings/apps" is a step a person takes, not a path.
const url = /\bhttps?:\/\/\S+|\b[\w-]+(?:\.[\w-]+)*\.(?:com|org|net|io|dev|app|ai)\/\S*/gi;
const jargon: [string, RegExp][] = [
  ['a commit sha', /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/i],
  ['a branch name', /\b(?:origin|refs\/heads|graphyard|feature|fix|hotfix|release)\/[\w./-]+|\bgy-\d+-\d+\b/i],
  ['a graphyard or gh command', /\bgraphyard(?:\.mjs)? (?:[a-z]+-)*[a-z]+ (?:GY-\d+|--?[a-z])|\bgraphyard (?:park|answer|unseal|status|complete|blocked|master|login|setup|install|verify|scope-request|watch|doctor|claim|sync|handoff|human-requests)\b|\bgh (?:auth|pr|api|repo|run|workflow|secret|release|issue|extension|config)\b/],
  ['a file path', /(?:^|[\s`'"(])(?:~|\.{1,2})?\/[\w.-]+(?:\/[\w.-]*)*|\b[\w.-]+\/[\w.-]+\/[\w./-]*|\b[\w-]+\/[\w-]+\.\w{1,5}\b|\b[\w-]+\.(?:ts|tsx|js|mjs|cjs|json|md|ya?ml|sh|pem|env|toml|txt|css|html)\b/],
];
/** The agent shorthand a line a human reads carries, as "a commit sha (abc1234)", or null when it has none. */
export function jargonIn(text: string): string | null {
  const plain = text.replace(url, ' ');
  for (const [what, pattern] of jargon) {
    const found = pattern.exec(plain);
    if (found) return `${what} (${found[0].trim()})`;
  }
  return null;
}

/** What a short ask breaks, one sentence each, naming the offending text; empty when it reads as a short note. */
export function shortAskIssues(data: { ask?: string; steps?: readonly string[]; why?: string }): string[] {
  const issues: string[] = [];
  if (data.ask !== undefined) {
    if (data.ask.length > askLimits.ask) issues.push(`ASK is ${data.ask.length} characters; keep it to ${askLimits.ask}`);
    if (/[.!?]\s+\S/.test(data.ask)) issues.push('ASK is one sentence: put further steps in STEPS and the rest in REASON');
    const found = jargonIn(data.ask);
    if (found) issues.push(`ASK names ${found}; put it in REASON, the detail for agents`);
  }
  if (data.steps && data.steps.length > askLimits.steps) issues.push(`STEPS has ${data.steps.length} lines; keep it to ${askLimits.steps}`);
  data.steps?.forEach((step, index) => {
    if (step.length > askLimits.step) issues.push(`STEP ${index + 1} is ${step.length} characters; keep it to ${askLimits.step}`);
    const found = jargonIn(step);
    if (found) issues.push(`STEP ${index + 1} names ${found}; put it in REASON, the detail for agents`);
  });
  if (data.why !== undefined && data.why.length > askLimits.why) issues.push(`WHY is ${data.why.length} characters; keep it to ${askLimits.why}`);
  return issues;
}

/** The first sentence of a longer text, cut to a readable length. */
export function firstSentence(text: string, limit = askLimits.ask + askLimits.step) {
  const sentence = text.trim().split(/(?<=[.!?])\s+/)[0] ?? '';
  return sentence.length > limit ? `${sentence.slice(0, limit - 1).trimEnd()}…` : sentence;
}
/**
 * What a card leads with: the request's own ask, or, for a request recorded before asks existed
 * (or raised by a rule that writes none), the first sentence of what it needs.
 */
export const humanAsk = (request: { ask?: string | null; needed: string }) => request.ask?.trim() || firstSentence(request.needed);
