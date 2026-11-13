// Concern: the prices Graphyard seeds its price sheet with (GY-3289). The registry's models are the
// sheet; `master registry model seed` writes these onto it, and the master checks them monthly
// against the providers' public price pages with `master registry model set`.
// US dollars per million tokens: [id, provider, input, output, cache read, cache write (null: none charged), as of].
const sheet: [string, string, number, number, number, number | null, string][] = [
  // Anthropic's pricing page — cache writes are the 5-minute rate.
  ['claude-fable-5-2', 'Anthropic', 8, 40, 0.2, 10, '2026-11-03'],
  ['claude-fable-5-1', 'Anthropic', 10, 50, 1, 12.5, '2026-11-03'],
  ['claude-opus-5-5', 'Anthropic', 4, 20, 0.2, 5, '2026-11-03'],
  ['claude-opus-5', 'Anthropic', 5, 25, 0.5, 6.25, '2026-11-03'],
  ['claude-opus-4-8', 'Anthropic', 5, 25, 0.5, 6.25, '2026-11-03'],
  ['claude-sonnet-5-5', 'Anthropic', 2, 10, 0.1, 2.5, '2026-11-03'],
  ['claude-sonnet-5', 'Anthropic', 2, 10, 0.2, 2.5, '2026-11-03'],
  ['claude-haiku-5-5', 'Anthropic', 0.1, 0.5, 0.01, 0.125, '2026-11-03'],
  ['claude-haiku-4-5', 'Anthropic', 1, 5, 0.1, 1.25, '2026-11-03'],
  // OpenAI's API pricing page — prompts up to 272K tokens; cache writes are the 30-minute rate.
  ['gpt-5.6-sol', 'OpenAI', 4, 20, 0.4, 5, '2026-11-13'],
  ['gpt-5.6-terra', 'OpenAI', 2, 12, 0.2, 2.5, '2026-11-13'],
  ['gpt-5.6-luna', 'OpenAI', 0.2, 1.2, 0.02, 0.25, '2026-11-13'],
  ['gpt-5.3-codex', 'OpenAI', 1.75, 14, 0.175, null, '2026-11-13'],
  // Z.AI's pricing page.
  ['glm-5.3', 'Z.AI', 1.4, 4.4, 0.26, null, '2026-11-13'],
  ['glm-5.3-flash', 'Z.AI', 0.15, 0.5, 0.03, null, '2026-11-13'],
  // Google's Gemini API pricing page.
  ['gemini-4-carbon', 'Google', 2, 10, 0.1, null, '2026-11-13'],
  ['gemini-3.8-flash', 'Google', 0.75, 3.75, 0.075, null, '2026-11-13'],
  ['gemini-3.1-pro-preview', 'Google', 2, 12, 0.2, null, '2026-11-13'],
  // Cursor's models page.
  ['composer-2.5', 'Cursor', 0.5, 2.5, 0.2, null, '2026-11-13'],
  // The operator's figure for Muse Ember.
  ['muse-ember-1.0', 'Muse', 0.1, 0.5, 0.1, null, '2026-11-13'],
];
export const seedPrices = sheet.map(([id, provider, inputPerMTok, outputPerMTok, cacheReadPerMTok, cacheWrite, asOf]) =>
  ({ id, provider, cost: { inputPerMTok, outputPerMTok, cacheReadPerMTok, cacheWritePerMTok: cacheWrite ?? 0, asOf } }));
