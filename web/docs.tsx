import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const pages = [
  ['README', 'Documentation home'], ['onboarding', 'Onboard a repository'], ['quickstart', 'Local quickstart'], ['how-graphyard-works', 'How Graphyard works'],
  ['deployment', 'Deploy Graphyard'], ['install', 'Install & upgrade'], ['github', 'GitHub enforcement'], ['herdr', 'Herdr integration'], ['master-agent', 'Master-agent setup'],
  ['delegation', 'Slice-lead delegation'],
  ['architecture', 'Architecture reference'], ['protocol', 'Agent protocol & API'],
  ['operations', 'Operations & recovery'], ['development', 'Development & dogfooding'],
  ['operator-automation', 'Operator automation'],
  ['coordination', 'Coordination & recovery drills'],
  ['visual-identity', 'Visual identity'],
  ['test-cases', 'E2E test cases'], ['validation', 'Validation runner protocol'], ['runner-setup', 'Runner preparation & artifacts'], ['delivery', 'Releases & observed delivery'],
  ['first-pr', 'Graphyard repository bootstrap'],
  ['turnkey-delivery-roadmap', 'Turnkey E2E & delivery roadmap'],
  ['shipping-pulse', 'Shipping pulse'],
  ['history/implementation-audit-2026-09-13', 'Historical implementation audit'],
  ['history/huck-engineer-comparison', 'Historical Huck investigation'],
];
const sources = import.meta.glob('../docs/**/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
function docLink(href: string | undefined, slug: string) {
  if (!href) return '#';
  if (href.startsWith('http') || href.startsWith('#') || href.startsWith('/')) return href;
  const [path, anchor] = href.split('#');
  const repositoryPath = ['docs', ...slug.split('/').slice(0, -1), ...path.split('/')].reduce<string[]>((parts, part) => {
    if (part === '..') parts.pop();
    else if (part !== '.' && part) parts.push(part);
    return parts;
  }, []).join('/');
  if (repositoryPath.startsWith('docs/') && repositoryPath.endsWith('.md')) {
    return `/${repositoryPath.replace(/\.md$/, '')}${anchor ? `#${anchor}` : ''}`;
  }
  return `https://github.com/cryptob1/graphyard/blob/main/${repositoryPath}${anchor ? `#${anchor}` : ''}`;
}
const headingId = (children: unknown) => String(children).toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');
export default function Docs() {
  const slug = location.pathname.split('/').slice(2).filter(Boolean).join('/') || 'README';
  const source = sources[`../docs/${slug}.md`];
  return <div className="docs-shell"><aside className="docs-nav"><a href="/" className="brand"><img className="mark" src="/graphyard-symbol.svg" alt="" width="32" height="32"/> graphyard</a><div className="workspace-label">DOCUMENTATION</div>{pages.map(([id, title]) => <a key={id} className={`nav ${slug === id ? 'active' : ''}`} href={`/docs/${id}`}>{title}</a>)}<a className="nav docs-back" href="/">← Open control plane</a></aside><main className={`docs-content${slug === 'how-graphyard-works' ? ' how-guide' : ''}`}><div className="eyebrow">GRAPHYARD / V0.1</div><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => <a href={docLink(href, slug)}>{children}</a>, h2: ({ children }) => <h2 id={headingId(children)}>{children}</h2>, h3: ({ children }) => <h3 id={headingId(children)}>{children}</h3> }}>{source ?? '# Page not found\n\nChoose a guide from the navigation.'}</ReactMarkdown><footer>Graphyard documentation <a href={`https://github.com/cryptob1/graphyard/blob/main/docs/${slug}.md`}>View source ↗</a></footer></main></div>;
}
