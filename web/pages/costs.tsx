import { useEffect, useState } from 'react';
import { costText, costWindows, dollars, lineTokens, priceCheckDays, pricesDue, tokenCount, tokensText, type CostLine, type CostSummary } from '../../src/model/token-costs';
import type { Work } from '../../src/model';

type Api = (path: string) => Promise<any>;
const useCosts = (api: Api, path: string, key: unknown) => {
  const [costs, setCosts] = useState<CostSummary | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { let live = true; api(path).then(next => { if (live) setCosts(next?.windows ? next : null); }, e => { if (live) setError((e as Error).message); }); return () => { live = false; }; }, [key]);
  return { costs, error };
};

/** The Costs page (GY-3289): the tokens this project's agents spent and what they cost, from the price sheet the registry keeps. */
export default function CostsPage({ api, observedAt }: { api: Api; observedAt: number }) {
  // Read again each minute the dashboard stays open, not on every poll.
  const { costs, error } = useCosts(api, 'costs', Math.floor(observedAt / 60_000));
  return <CostsView costs={costs} error={error} now={Number.isNaN(observedAt) ? Date.now() : observedAt}/>;
}

const breakdown = (title: string, lines: CostLine[]) => lines.length > 0 && <section className="panel" aria-label={title}><h2>{title}</h2>
  <table className="sessions-table" aria-label={title}><thead><tr><th>{title.replace('By ', '')}</th><th>Tokens</th><th>Input</th><th>Output</th><th>Cache read</th><th>Cache write</th><th>Cost</th></tr></thead>
    <tbody>{lines.map(entry => <tr key={entry.name} data-cost-line={entry.name}><td>{entry.name}</td><td>{tokenCount(lineTokens(entry))}</td><td>{tokenCount(entry.input)}</td><td>{tokenCount(entry.output)}</td><td>{tokenCount(entry.cacheRead)}</td><td>{tokenCount(entry.cacheWrite)}</td><td>{costText(entry)}</td></tr>)}</tbody>
  </table></section>;

/** The page as rendered from one read, so it can be drawn and tested without the network. */
export function CostsView({ costs, error, now }: { costs: CostSummary | null; error: string; now: number }) {
  const due = costs ? pricesDue(costs, now) : [];
  return <section className="costs-page" aria-label="Costs">
    <div className="page-heading"><div><h1>Costs</h1><p className="summary">The tokens this project's agents spent, priced from the price sheet below.</p></div></div>
    {error && <p role="alert" className="amber">{error}</p>}
    {!costs && !error && <p className="muted">Reading costs…</p>}
    {costs && <>
      <div className="tiles" role="group" aria-label="Totals">{costWindows.map(([window, label]) => { const entry = costs.windows[window]; return <div key={window} className="tile" data-cost-window={window}>
        <span className="tile-label">{label}</span><strong>{lineTokens(entry) > entry.unpriced ? dollars(entry.cost) : lineTokens(entry) ? 'price unknown' : '$0.00'}</strong>
        <small>{tokenCount(lineTokens(entry))} tokens{entry.apiEquivalent > 0 ? ` · ${dollars(entry.apiEquivalent)} API-equivalent` : ''}{entry.unpriced && lineTokens(entry) > entry.unpriced ? ` · price unknown for ${tokenCount(entry.unpriced)}` : ''}{entry.perShipped === null ? '' : ` · ${dollars(entry.perShipped)} per shipped item (${entry.shipped})`}</small>
      </div>; })}</div>
      {costs.monthlyFees > 0 && <p className="muted">Accounts on a flat plan are not billed per token: their figures are API-equivalent, what the same tokens would cost at list price. Those plans cost {dollars(costs.monthlyFees)} a month.</p>}
      {costs.windows.all.notReported > 0 && <p className="muted">{costs.windows.all.notReported} session{costs.windows.all.notReported === 1 ? '' : 's'} ran on a runtime that reported no usage: not counted.</p>}
      {breakdown('By role', costs.roles)}
      {breakdown('By model', costs.models)}
      {breakdown('By account', costs.accounts)}
      <section className="panel" aria-label="Price sheet"><h2>Price sheet <small>US dollars per million tokens, from each provider's public price page</small></h2>
        {due.length > 0 && <p className="amber">Due a check (no price, or read more than {priceCheckDays} days ago): {due.join(', ')}. The master sets prices with <code>master registry model set</code>.</p>}
        <table className="sessions-table" aria-label="Price sheet"><thead><tr><th>Model</th><th>Input</th><th>Output</th><th>Cache read</th><th>Cache write</th><th>As of</th></tr></thead>
          <tbody>{costs.prices.map(price => <tr key={price.name} data-price={price.name}><td>{price.name}{price.id && price.id !== price.name ? <small className="muted"> · {price.id}</small> : null}</td>
            {price.input === null || price.output === null ? <td colSpan={5}>price unknown</td>
              : <><td>${price.input}</td><td>${price.output}</td><td>{price.cacheRead === null ? '—' : `$${price.cacheRead}`}</td><td>{price.cacheWrite === null ? '—' : `$${price.cacheWrite}`}</td><td>{price.asOf ?? 'not recorded'}</td></>}</tr>)}</tbody>
        </table></section>
    </>}
  </section>;
}

/** The item page's own figures: what this item's sessions spent, by role. Nothing is drawn for an item no session reported on. */
export function ItemCosts({ item, api }: { item: Pick<Work, 'id' | 'key' | 'revision'>; api: Api }) {
  const { costs } = useCosts(api, `costs?work=${encodeURIComponent(item.key)}`, `${item.id}:${item.revision}`);
  return <ItemCostsView costs={costs}/>;
}
export function ItemCostsView({ costs }: { costs: CostSummary | null }) {
  const all = costs?.windows.all;
  if (!all || (!lineTokens(all) && !all.notReported)) return null;
  return <section className="panel" aria-label="Tokens and cost"><h2>Tokens and cost <small>{costText(all)}</small></h2>
    <p className="muted">{tokensText(all)}</p>
    <ul className="test-case-list">{costs!.roles.map(entry => <li key={entry.name} data-cost-line={entry.name}>{entry.name}: {tokenCount(lineTokens(entry))} tokens · {costText(entry)}</li>)}</ul>
  </section>;
}
