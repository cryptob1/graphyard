import { useEffect, useState } from 'react';
import { costFigure, costText, costWindows, dollars, lineTokens, priceCheckDays, pricesDue, tokenCount, tokensText, type CostLine, type CostSummary } from '../../src/model/token-costs';
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

// Numbers sit right in tabular figures, under right-aligned headers; the token split folds away on a phone.
const breakdown = (title: string, lines: CostLine[]) => {
  if (!lines.length) return null;
  const notReported = lines.some(entry => entry.notReported > 0);
  return <section className="panel" aria-label={title}><h2>{title}</h2><div className="table-scroll">
    <table className="cost-table" aria-label={title}><thead><tr><th>{title.replace('By ', '')}</th><th className="num">Tokens</th><th className="num detail">Input</th><th className="num detail">Output</th><th className="num detail">Cache read</th><th className="num detail">Cache write</th><th className="num">Cost</th>{notReported && <th className="num">Not reported</th>}</tr></thead>
      <tbody>{lines.map(entry => <tr key={entry.name} data-cost-line={entry.name}><td>{entry.name}</td><td className="num">{tokenCount(lineTokens(entry))}</td><td className="num detail">{tokenCount(entry.input)}</td><td className="num detail">{tokenCount(entry.output)}</td><td className="num detail">{tokenCount(entry.cacheRead)}</td><td className="num detail">{tokenCount(entry.cacheWrite)}</td>
        <td className="num">{lineTokens(entry) ? costFigure(entry) : '—'}{entry.monthlyFee != null ? ` · plan ${dollars(entry.monthlyFee)}/month` : ''}</td>{notReported && <td className="num">{entry.notReported ? `${entry.notReported} session${entry.notReported === 1 ? '' : 's'}` : '—'}</td>}</tr>)}</tbody>
    </table></div></section>;
};

/** The page as rendered from one read, so it can be drawn and tested without the network. */
export function CostsView({ costs, error, now }: { costs: CostSummary | null; error: string; now: number }) {
  const due = costs ? pricesDue(costs, now) : [], unpriced = costs ? costs.models.filter(entry => entry.unpriced > 0) : [];
  return <section className="costs-page" aria-label="Costs">
    <div className="page-heading"><div><h1>Costs</h1><p className="summary">The tokens this project's agents spent, priced from the price sheet below.</p></div></div>
    {error && <p role="alert" className="amber">{error}</p>}
    {!costs && !error && <p className="muted">Reading costs…</p>}
    {costs && <>
      <div className="tiles" role="group" aria-label="Totals">{costWindows.map(([window, label]) => { const entry = costs.windows[window], tokens = lineTokens(entry); return <div key={window} className="tile" data-cost-window={window}>
        <span className="tile-label">{label}</span><strong>{tokens && entry.unpriced >= tokens ? 'price unknown' : `${entry.unpriced ? 'at least ' : ''}${dollars(entry.cost)}`}</strong>
        <small>{tokenCount(tokens)} tokens{entry.apiEquivalent > 0 ? ` · ${dollars(entry.apiEquivalent)} API-equivalent` : ''}{entry.perShipped === null ? '' : ` · ${dollars(entry.perShipped)} per shipped item (${entry.shipped})`}</small>
      </div>; })}</div>
      {unpriced.length > 0 && <p className="muted" data-unpriced>No price for {unpriced.map(entry => `${entry.name} (${tokenCount(entry.unpriced)} tokens)`).join(', ')}: totals count only priced tokens. Add a price with <code>master registry model set NAME --input-cost USD --output-cost USD</code>.</p>}
      {costs.monthlyFees > 0 && <p className="muted">Accounts on a flat plan are not billed per token: their figures are API-equivalent, what the same tokens would cost at list price. Those plans cost {dollars(costs.monthlyFees)} a month.</p>}
      {costs.windows.all.notReported > 0 && <p className="muted">{costs.windows.all.notReported} session{costs.windows.all.notReported === 1 ? '' : 's'} ran on a runtime that reported no usage: not counted.</p>}
      {breakdown('By role', costs.roles)}
      {breakdown('By model', costs.models)}
      {breakdown('By account', costs.accounts)}
      <section className="panel" aria-label="Price sheet"><h2>Price sheet <small>US dollars per million tokens, from each provider's public price page</small></h2>
        {due.length > 0 && <p className="amber">Due a check (no price, or read more than {priceCheckDays} days ago): {due.join(', ')}. The master sets prices with <code>master registry model set</code>.</p>}
        <div className="table-scroll"><table className="cost-table" aria-label="Price sheet"><thead><tr><th>Model</th><th className="num">Input</th><th className="num">Output</th><th className="num detail">Cache read</th><th className="num detail">Cache write</th><th className="num detail">As of</th></tr></thead>
          <tbody>{costs.prices.map(price => <tr key={price.name} data-price={price.name}><td>{price.name}{price.id && price.id !== price.name ? <small className="muted"> · {price.id}</small> : null}</td>
            {price.input === null || price.output === null ? <td className="num" colSpan={5}>price unknown</td>
              : <><td className="num">${price.input}</td><td className="num">${price.output}</td><td className="num detail">{price.cacheRead === null ? '—' : `$${price.cacheRead}`}</td><td className="num detail">{price.cacheWrite === null ? '—' : `$${price.cacheWrite}`}</td><td className="num detail">{price.asOf ?? 'not recorded'}</td></>}</tr>)}</tbody>
        </table></div></section>
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
