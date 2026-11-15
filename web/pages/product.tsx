import { useEffect, useRef, useState } from 'react';
import type { ProductBrief } from '../../src/model/project-memory';
import { EmptyState, PageHeader } from '../components/page-layout';

/** The dashboard's Product page (GY-3274): the install's one product brief, shown read-only. */
export default function ProductPage({ api }: { api: (path: string) => Promise<any> }) {
  const [brief, setBrief] = useState<ProductBrief | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const request = useRef(0);
  const load = async () => {
    const version = ++request.current; setLoading(true); setError('');
    try { const next = await api('product-brief'); if (version === request.current) setBrief(next.brief ?? null); }
    catch (e) { if (version === request.current) setError((e as Error).message); }
    finally { if (version === request.current) setLoading(false); }
  };
  useEffect(() => { void load(); return () => { request.current++; }; }, []);
  return <ProductView brief={brief} error={error} loading={loading} retry={() => void load()}/>;
}

/** The page as rendered from one read, so it can be drawn and tested without the network. */
export function ProductView({ brief, error, loading, retry }: { brief: ProductBrief | null; error: string; loading: boolean; retry(): void }) {
  const when = (at: string) => new Date(at).toLocaleString();
  return <section className="product-page" aria-label="Product">
    <PageHeader title="Product" fact={brief ? `What the product is for, set ${when(brief.updatedAt)} by ${brief.by}.` : loading ? 'Reading the product brief…' : error ? 'The product brief could not be read.' : 'No product brief yet.'}
      actions={error && <button type="button" onClick={retry}>Retry</button>}>{brief && <>{brief.why}. Kept by the master in project memory; this page is read-only.</>}</PageHeader>
    {error && <p role="alert" className="amber">{error}</p>}
    {!loading && !error && !brief && <EmptyState title="No product brief yet.">The master records one with <code>master brief set FILE REASON</code>.</EmptyState>}
    {brief && <article className="product-brief">{
      // The brief's own Markdown headings are trusted structure from the master: render each section as text.
      brief.markdown.split(/\n(?=##\s)/).map((section, index) => {
        const heading = /^##\s+(.*)$/.exec(section.split('\n')[0] ?? '');
        return heading
          ? <section key={index} className="panel product-section"><h2>{heading[1]}</h2><pre>{section.slice(section.indexOf('\n') + 1).trim()}</pre></section>
          : <p key={index}>{section.trim()}</p>;
      })
    }</article>}
    {brief && brief.history.length > 0 && <details className="panel product-history"><summary>Changes ({brief.history.length})</summary><ul>
      {brief.history.map(change => <li key={`${change.at}:${change.by}`}>{when(change.at)} — {change.by}: {change.why} ({change.words} words)</li>)}
    </ul></details>}
  </section>;
}
