// Concern: what the project's agents spent (GY-3289) — the tokens each session's runtime reported,
// priced from the registry's price sheet. Pure: the dashboard shares this module.
import type { AgentRegistry, FleetModel } from './registry.js';

export interface Tokens { input: number; output: number; cacheRead: number; cacheWrite: number }
/** One session's reported tokens on one model. `reported: false` is a runtime that printed no usage: stored, never counted as zero spend. */
export interface UsageRow extends Tokens { id: string; work: string | null; role: string; account: string | null; runtime: string; model: string | null; reported: boolean; at: string }

const zero = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const add = (into: Tokens, more: Tokens) => { into.input += more.input; into.output += more.output; into.cacheRead += more.cacheRead; into.cacheWrite += more.cacheWrite; return into; };
const count = (value: unknown) => Number.isFinite(Number(value)) && Number(value) > 0 ? Math.round(Number(value)) : 0;
const jsonLines = (text: string): any[] => text.split('\n').flatMap(line => { if (!/^\s*[[{]/.test(line)) return []; try { const value = JSON.parse(line); return Array.isArray(value) ? value : [value]; } catch { return []; } });

/**
 * What one headless run's runtime said of itself on its output: its reply, and the tokens it used
 * by model (null: the account's own). Read by shape, so a registry contract that asks a runtime for
 * JSON is read too: Claude Code's and Cursor's `result` object, Codex's `turn.completed` events,
 * OpenCode's `step_finish` parts and Pi's `message_end` records. `usage` is null for a run that
 * reported none, and `reply` null for output that is not one of these reports — plain text.
 */
export function runtimeReport(output: string): { reply: string | null; usage: { model: string | null; tokens: Tokens }[] | null } {
  const byModel = new Map<string | null, Tokens>();
  const spend = (model: string | null, tokens: Tokens) => { byModel.set(model, add(byModel.get(model) ?? zero(), tokens)); };
  let reply: string | null = null;
  const said: string[] = [];
  for (const row of jsonLines(output)) {
    if (!row || typeof row !== 'object') continue;
    if (row.type === 'result') {
      if (typeof row.result === 'string') reply = row.result;
      const models = row.modelUsage && typeof row.modelUsage === 'object' ? Object.entries<any>(row.modelUsage) : [];
      for (const [model, used] of models) spend(model, { input: count(used?.inputTokens), output: count(used?.outputTokens), cacheRead: count(used?.cacheReadInputTokens), cacheWrite: count(used?.cacheCreationInputTokens) });
      const used = row.usage;
      if (!models.length && used) spend(null, { input: count(used.input_tokens ?? used.inputTokens), output: count(used.output_tokens ?? used.outputTokens),
        cacheRead: count(used.cache_read_input_tokens ?? used.cacheReadTokens), cacheWrite: count(used.cache_creation_input_tokens ?? used.cacheWriteTokens) });
    } else if (row.type === 'turn.completed' && row.usage) {
      // Codex counts cached input inside input_tokens.
      const cached = count(row.usage.cached_input_tokens);
      spend(null, { input: Math.max(0, count(row.usage.input_tokens) - cached), output: count(row.usage.output_tokens), cacheRead: cached, cacheWrite: 0 });
    } else if (row.type === 'item.completed' && row.item?.type === 'agent_message' && typeof row.item.text === 'string') reply = row.item.text;
    else if (row.type === 'step_finish' && row.part?.tokens) spend(null, { input: count(row.part.tokens.input), output: count(row.part.tokens.output) + count(row.part.tokens.reasoning), cacheRead: count(row.part.tokens.cache?.read), cacheWrite: count(row.part.tokens.cache?.write) });
    else if (row.type === 'text' && typeof row.part?.text === 'string') said.push(row.part.text);
    else if (row.type === 'message_end' && row.message?.role === 'assistant' && row.message.usage) spend(typeof row.message.model === 'string' ? row.message.model : null,
      { input: count(row.message.usage.input), output: count(row.message.usage.output), cacheRead: count(row.message.usage.cacheRead), cacheWrite: count(row.message.usage.cacheWrite) });
  }
  return { reply: reply ?? (said.length ? said.join('\n') : null), usage: byModel.size ? [...byModel].map(([model, tokens]) => ({ model, tokens })) : null };
}

/**
 * The master session's tokens, read row by row from its runtime's own transcript and kept by day
 * and model. Claude Code repeats a message's usage on each of its rows, so a message counts once;
 * Codex reports a running total, so each report adds what it grew by.
 */
export function transcriptUsage(kind: string) {
  const messages = new Map<string, { key: string; at: string; tokens: Tokens }>();
  const totals = new Map<string, { at: string; tokens: Tokens }>();
  let model: string | null = null, running = 0, last = zero();
  const keyOf = (at: string, name: string | null) => `${at.slice(0, 10)}|${name ?? ''}`;
  return {
    read(row: any) {
      const at = typeof row?.timestamp === 'string' ? row.timestamp : null;
      if (!at) return;
      if (kind === 'claude') {
        const used = row.message?.usage, name = row.message?.model;
        if (row.type !== 'assistant' || !used || name === '<synthetic>') return;
        messages.set(String(row.message.id ?? row.uuid), { key: keyOf(at, name ?? null), at,
          tokens: { input: count(used.input_tokens), output: count(used.output_tokens), cacheRead: count(used.cache_read_input_tokens), cacheWrite: count(used.cache_creation_input_tokens) } });
      } else {
        if (row.type === 'turn_context' && typeof row.payload?.model === 'string') model = row.payload.model;
        const total = row.type === 'event_msg' && row.payload?.type === 'token_count' ? row.payload.info?.total_token_usage : null;
        if (!total) return;
        const cached = count(total.cached_input_tokens);
        const now = { input: Math.max(0, count(total.input_tokens) - cached), output: count(total.output_tokens), cacheRead: cached, cacheWrite: 0 };
        const sum = now.input + now.output + now.cacheRead;
        // A total below the last one is a new count (a resumed session): it is all new spend.
        const grown = sum < running ? now : { input: now.input - last.input, output: now.output - last.output, cacheRead: now.cacheRead - last.cacheRead, cacheWrite: 0 };
        running = sum; last = now;
        const entry = totals.get(keyOf(at, model)) ?? { at, tokens: zero() };
        totals.set(keyOf(at, model), { at, tokens: add(entry.tokens, grown) });
      }
    },
    /** One entry per day and model, keyed `DAY|MODEL`, with the last time it grew. */
    days(): Map<string, { at: string; model: string | null; tokens: Tokens }> {
      const days = new Map<string, { at: string; model: string | null; tokens: Tokens }>();
      const sources = kind === 'claude' ? [...messages.values()] : [...totals].map(([key, entry]) => ({ key, ...entry }));
      for (const { key, at, tokens } of sources) {
        const day = days.get(key) ?? { at, model: key.slice(11) || null, tokens: zero() };
        days.set(key, { ...day, at: at > day.at ? at : day.at, tokens: add(day.tokens, tokens) });
      }
      return days;
    },
  };
}

// ---- The price sheet -------------------------------------------------------------------------------

/** The registry model a session's model names: by id or name, or the longest registered id it starts with (a dated or `[1m]` variant). */
export function pricedModel(models: readonly FleetModel[], name: string | null): FleetModel | null {
  if (!name) return null;
  const bare = name.replace(/\[[^\]]*\]$/, '');
  return models.find(model => model.id === bare || model.name === bare)
    ?? models.filter(model => model.id && bare.startsWith(model.id)).sort((a, b) => b.id!.length - a.id!.length)[0] ?? null;
}
/** US dollars for these tokens at a model's prices; null — price unknown — when a rate the tokens need was never recorded. */
export function tokenCost(model: FleetModel | null, tokens: Tokens): number | null {
  if (!model) return null;
  const rates: [number, number | null | undefined][] = [[tokens.input, model.cost.inputPerMTok], [tokens.output, model.cost.outputPerMTok], [tokens.cacheRead, model.cost.cacheReadPerMTok], [tokens.cacheWrite, model.cost.cacheWritePerMTok]];
  if (model.cost.inputPerMTok == null || model.cost.outputPerMTok == null || rates.some(([used, rate]) => used > 0 && rate == null)) return null;
  return rates.reduce((sum, [used, rate]) => sum + used * (rate ?? 0), 0) / 1_000_000;
}

// ---- The Costs view --------------------------------------------------------------------------------

/** One line of the view: tokens, what they cost at list price, and how much of that is on flat plans. */
export interface CostLine extends Tokens {
  name: string;
  /** US dollars at the price sheet's rates, over the tokens whose model has a price. */
  cost: number;
  /** The part of `cost` spent on flat-plan accounts: API-equivalent, not billed. */
  apiEquivalent: number;
  /** Tokens on a model without a price: their cost is unknown, never zero. */
  unpriced: number;
  /** Sessions whose runtime reported no usage. */
  notReported: number;
  /** A flat plan's monthly fee, on an account line. */
  monthlyFee?: number | null;
  flat?: boolean;
}
export const costWindows = [['today', 'Today'], ['week', '7 days'], ['month', '30 days'], ['all', 'All time']] as const;
export type CostWindow = typeof costWindows[number][0];
export interface CostSummary {
  windows: Record<CostWindow, CostLine & { shipped: number; perShipped: number | null }>;
  /** The breakdowns over `days` (null: all time). */
  days: number | null;
  roles: CostLine[]; models: CostLine[]; accounts: CostLine[];
  /** The price sheet: every registry model with its rates and the day they were read. */
  prices: { name: string; id: string | null; input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null; asOf: string | null }[];
  /** The monthly fees of every flat-plan account: the real spend beside the API-equivalent figure. */
  monthlyFees: number;
}

const line = (name: string): CostLine => ({ name, ...zero(), cost: 0, apiEquivalent: 0, unpriced: 0, notReported: 0 });
const total = (tokens: Tokens) => tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
/** An account on a flat plan is not billed per token: its figure is API-equivalent. */
export const flatPlan = (account: { plan?: string; monthlyFee?: number } | undefined) => !!account && (!!account.plan || account.monthlyFee !== undefined);
const roleNames: Record<string, string> = { worker: 'Workers', reviewer: 'Reviewers', producer: 'Producers', master: 'Master' };

/** The project's Costs view: totals per window, the breakdowns over `days`, and the price sheet they were priced from. `shipped` are the keys of delivered items. */
export function costSummary(rows: readonly UsageRow[], registry: Pick<AgentRegistry, 'models' | 'accounts'>, shipped: ReadonlySet<string>, now: number, days: number | null = null): CostSummary {
  const day = 24 * 60 * 60_000;
  const since: Record<CostWindow, number> = { today: new Date(now).setUTCHours(0, 0, 0, 0), week: now - 7 * day, month: now - 30 * day, all: -Infinity };
  const tally = (into: CostLine, row: UsageRow) => {
    if (!row.reported) { into.notReported++; return null; }
    add(into, row);
    const cost = tokenCost(pricedModel(registry.models, row.model), row);
    if (cost === null) into.unpriced += total(row);
    else { into.cost += cost; if (flatPlan(registry.accounts.find(account => account.name === row.account))) into.apiEquivalent += cost; }
    return cost;
  };
  const windows = Object.fromEntries(costWindows.map(([window]) => {
    const all = line(window), items = new Set<string>();
    let onShipped = 0;
    for (const row of rows) if (Date.parse(row.at) >= since[window]) {
      const cost = tally(all, row);
      if (row.work && shipped.has(row.work) && row.reported) { items.add(row.work); onShipped += cost ?? 0; }
    }
    return [window, { ...all, shipped: items.size, perShipped: items.size ? onShipped / items.size : null }];
  })) as CostSummary['windows'];
  const from = days === null ? -Infinity : now - days * day, within = rows.filter(row => Date.parse(row.at) >= from);
  const group = (name: (row: UsageRow) => string) => {
    const lines = new Map<string, CostLine>();
    for (const row of within) { const key = name(row); if (!lines.has(key)) lines.set(key, line(key)); tally(lines.get(key)!, row); }
    return [...lines.values()].sort((a, b) => b.cost - a.cost || total(b) - total(a));
  };
  return {
    windows, days,
    roles: group(row => roleNames[row.role] ?? row.role),
    models: group(row => pricedModel(registry.models, row.model)?.name ?? row.model ?? 'model not reported'),
    accounts: group(row => row.account ?? 'account not recorded').map(entry => {
      const account = registry.accounts.find(candidate => candidate.name === entry.name);
      return { ...entry, flat: flatPlan(account), monthlyFee: account?.monthlyFee ?? null };
    }),
    prices: registry.models.map(model => ({ name: model.name, id: model.id, input: model.cost.inputPerMTok, output: model.cost.outputPerMTok, cacheRead: model.cost.cacheReadPerMTok ?? null, cacheWrite: model.cost.cacheWritePerMTok ?? null, asOf: model.cost.asOf ?? null })),
    monthlyFees: registry.accounts.reduce((sum, account) => sum + (account.monthlyFee ?? 0), 0),
  };
}

// ---- Wording, shared by the dashboard and `master usage` -------------------------------------------

export const tokenCount = (value: number) => value >= 1_000_000 ? `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 1 : 2)}M` : value >= 10_000 ? `${Math.round(value / 1000)}k` : value.toLocaleString('en-US');
export const dollars = (value: number) => `$${value >= 100 ? Math.round(value).toLocaleString('en-US') : value.toFixed(2)}`;
export const lineTokens = (entry: Tokens) => total(entry);
/** A line's cost in words: the list-price figure, 'API-equivalent' where a flat plan carried it, and 'price unknown' for tokens no price covers. */
export function costText(entry: CostLine): string {
  const priced = total(entry) > entry.unpriced;
  const parts = [
    ...(priced ? [`${dollars(entry.cost)}${entry.apiEquivalent > 0 ? entry.apiEquivalent >= entry.cost ? ' API-equivalent' : ` (${dollars(entry.apiEquivalent)} API-equivalent)` : ''}`] : []),
    ...(entry.unpriced ? [priced ? `price unknown for ${tokenCount(entry.unpriced)} tokens` : 'price unknown'] : []),
    ...(entry.monthlyFee != null ? [`plan ${dollars(entry.monthlyFee)}/month`] : []),
    ...(entry.notReported ? [`${entry.notReported} session${entry.notReported === 1 ? '' : 's'} not reported`] : []),
  ];
  return parts.join(' · ') || (total(entry) ? 'price unknown' : 'no usage reported');
}
/** A line's tokens in words. */
export const tokensText = (entry: Tokens) => `${tokenCount(total(entry))} tokens (${tokenCount(entry.input)} in, ${tokenCount(entry.output)} out, ${tokenCount(entry.cacheRead)} cache read, ${tokenCount(entry.cacheWrite)} cache write)`;
/** Prices are read from the providers' pages monthly: a model with no price or one older than this is due a check. */
export const priceCheckDays = 31;
export const pricesDue = (summary: Pick<CostSummary, 'prices'>, now: number) => summary.prices.filter(price => price.input === null || price.output === null || !price.asOf || now - Date.parse(price.asOf) > priceCheckDays * 24 * 60 * 60_000).map(price => price.name);

/** `master usage`: the Costs view as text. */
export function costReport(summary: CostSummary, now: number): string {
  const row = (entry: CostLine) => `  ${entry.name}: ${tokensText(entry)} · ${costText(entry)}`;
  const due = pricesDue(summary, now);
  return [
    'Tokens the project\'s agents spent, and what they cost at the price sheet\'s rates:',
    ...costWindows.map(([window, label]) => { const entry = summary.windows[window]; return `  ${label}: ${tokensText(entry)} · ${costText(entry)}${entry.perShipped === null ? '' : ` · ${dollars(entry.perShipped)} per shipped item (${entry.shipped})`}`; }),
    ...(summary.monthlyFees ? [`  Flat plans are not billed per token: their figures are API-equivalent, and the plans cost ${dollars(summary.monthlyFees)}/month.`] : []),
    ...([['By role', summary.roles], ['By model', summary.models], ['By account', summary.accounts]] as const).flatMap(([title, lines]) => lines.length ? [`${title}${summary.days === null ? '' : `, last ${summary.days} day${summary.days === 1 ? '' : 's'}`}:`, ...lines.map(row)] : []),
    'Price sheet (US dollars per million tokens: input / output / cache read / cache write):',
    ...summary.prices.map(price => `  ${price.name}${price.id ? ` (${price.id})` : ''}: ${price.input === null || price.output === null ? 'price unknown' : `${price.input} / ${price.output} / ${price.cacheRead ?? '?'} / ${price.cacheWrite ?? '?'} as of ${price.asOf ?? 'an unrecorded day'}`}`),
    ...(due.length ? [`Check against the providers' price pages (monthly): ${due.join(', ')} — graphyard master registry model set NAME --input-cost USD --output-cost USD --cache-read-cost USD --cache-write-cost USD --reason REASON`] : []),
  ].join('\n');
}
