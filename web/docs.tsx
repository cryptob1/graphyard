import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const pages = [
  ['README', 'Documentation home'], ['install', 'Install & upgrade'], ['how-graphyard-works', 'How Graphyard works'], ['glossary', 'Glossary'], ['onboarding', 'Onboard a repository'],
  ['deployment', 'Deploy Graphyard'], ['github', 'GitHub enforcement'], ['dashboard', 'Reading the dashboard'],
  ['master-agent', 'Master-agent operating mode'], ['master-agent-sessions', 'Master-agent sessions'], ['master-agent-reference', 'Master-agent reference'],
  ['operations', 'Operations & recovery'], ['operations-reference', 'Operations reference'], ['coordination', 'Coordinating agents'], ['delegation', 'Slice-lead delegation'],
  ['protocol', 'Agent protocol & API'], ['validation', 'E2E validation'], ['runner-setup', 'Runner & collector'], ['delivery', 'Releases & delivery'], ['recovery', 'Runner capacity & rollback'], ['evidence-reuse', 'Evidence reuse & replay'],
  ['development', 'Development & dogfooding'],
];
const sources = import.meta.glob('../docs/**/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
// Repo-native diagrams live beside the Markdown so GitHub renders them from the same relative
// path; Vite emits them as assets and this map resolves that path to the served URL.
const diagrams = import.meta.glob('../docs/**/*.svg', { query: '?url', import: 'default', eager: true }) as Record<string, string>;
function repositoryPath(href: string, slug: string) {
  return ['docs', ...slug.split('/').slice(0, -1), ...href.split('/')].reduce<string[]>((parts, part) => {
    if (part === '..') parts.pop();
    else if (part !== '.' && part) parts.push(part);
    return parts;
  }, []).join('/');
}
function docImage(src: string | undefined, slug: string) {
  if (!src || src.startsWith('http') || src.startsWith('/')) return src ?? '';
  return diagrams[`../${repositoryPath(src, slug)}`] ?? `https://github.com/cryptob1/graphyard/raw/main/${repositoryPath(src, slug)}`;
}
function docLink(href: string | undefined, slug: string) {
  if (!href) return '#';
  if (href.startsWith('http') || href.startsWith('#') || href.startsWith('/')) return href;
  const [path, anchor] = href.split('#');
  const target = repositoryPath(path, slug);
  if (target.startsWith('docs/') && target.endsWith('.md')) {
    return `/${target.replace(/\.md$/, '')}${anchor ? `#${anchor}` : ''}`;
  }
  return `https://github.com/cryptob1/graphyard/blob/main/${target}${anchor ? `#${anchor}` : ''}`;
}
const headingId = (children: unknown) => String(children).toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');
export default function Docs() {
  const slug = location.pathname.split('/').slice(2).filter(Boolean).join('/') || 'README';
  const source = sources[`../docs/${slug}.md`];
  return <div className="docs-shell"><aside className="docs-nav"><a href="/" className="brand"><img className="mark" src="/graphyard-symbol.svg" alt="" width="32" height="32"/> graphyard</a><div className="workspace-label">DOCUMENTATION</div>{pages.map(([id, title]) => <a key={id} className={`nav ${slug === id ? 'active' : ''}`} href={`/docs/${id}`}>{title}</a>)}<a className="nav docs-back" href="/">← Open control plane</a></aside><main className={`docs-content${slug === 'how-graphyard-works' ? ' how-guide' : ''}`}><div className="eyebrow">GRAPHYARD / V0.1</div><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => <a href={docLink(href, slug)}>{children}</a>, img: ({ src, alt }) => <img className="docs-diagram" src={docImage(typeof src === 'string' ? src : undefined, slug)} alt={alt ?? ''}/>, h2: ({ children }) => <h2 id={headingId(children)}>{children}</h2>, h3: ({ children }) => <h3 id={headingId(children)}>{children}</h3> }}>{source ?? '# Page not found\n\nChoose a guide from the navigation.'}</ReactMarkdown><footer>Graphyard documentation <a href={`https://github.com/cryptob1/graphyard/blob/main/docs/${slug}.md`}>View source ↗</a></footer></main></div>;
}
