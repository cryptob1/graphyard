import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const pages = [
  ['quickstart', 'Quickstart'], ['architecture', 'How Graphyard works'], ['deployment', 'Deploy Graphyard'],
  ['github', 'GitHub enforcement'], ['protocol', 'Agent protocol & API'], ['herdr', 'Herdr integration'],
  ['operations', 'Operations & recovery'], ['development', 'Development & dogfooding'],
  ['test-cases', 'E2E test cases'],
  ['first-pr', 'First enforced PR'],
  ['implementation-audit', 'Implementation audit'],
  ['turnkey-delivery-roadmap', 'Turnkey E2E & delivery roadmap'],
  ['huck-engineer-comparison', 'Huck Engineer investigation'],
];
const sources = import.meta.glob('../docs/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
function docLink(href: string | undefined) {
  if (!href) return '#';
  if (href.startsWith('http') || href.startsWith('#')) return href;
  const [path, anchor] = href.split('#');
  if (path.startsWith('../')) return `https://github.com/cryptob1/graphyard/blob/main/${path.slice(3)}${anchor ? `#${anchor}` : ''}`;
  return `/docs/${path.replace(/\.md$/, '')}${anchor ? `#${anchor}` : ''}`;
}
const headingId = (children: unknown) => String(children).toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');
export default function Docs() {
  const slug = location.pathname.split('/')[2] || 'quickstart';
  const source = sources[`../docs/${slug}.md`];
  return <div className="docs-shell"><aside className="docs-nav"><a href="/" className="brand"><span className="mark">g</span> graphyard</a><div className="workspace-label">DOCUMENTATION</div>{pages.map(([id, title]) => <a key={id} className={`nav ${slug === id ? 'active' : ''}`} href={`/docs/${id}`}>{title}</a>)}<a className="nav docs-back" href="/">← Open control plane</a></aside><main className="docs-content"><div className="eyebrow">GRAPHYARD / V0.1</div><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => <a href={docLink(href)}>{children}</a>, h2: ({ children }) => <h2 id={headingId(children)}>{children}</h2>, h3: ({ children }) => <h3 id={headingId(children)}>{children}</h3> }}>{source ?? '# Page not found\n\nChoose a guide from the navigation.'}</ReactMarkdown><footer>Graphyard documentation <a href={`https://github.com/cryptob1/graphyard/blob/main/docs/${slug}.md`}>View source ↗</a></footer></main></div>;
}
