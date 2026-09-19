// Verifies every relative link and anchor under README.md and docs/, and keeps the
// generated indexes current: `node scripts/check-docs.mjs` fails when an index block is
// stale; `node scripts/check-docs.mjs --write` regenerates them.
//
// A page declares where it is listed with one line near its top:
//   <!-- page: Section | order | summary -->
// An index page carries a block the script fills with every such page in the named
// directories (non-recursive), grouped by the sections in the order given:
//   <!-- index: docs, docs/history | Start here; Operate Graphyard -->
//   <!-- /index -->
// The first section is a numbered path; the others are bulleted.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const write = process.argv.includes('--write');

function markdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = join(directory, entry.name);
    return entry.isDirectory() ? markdownFiles(target) : entry.name.endsWith('.md') ? [target] : [];
  });
}

function headingSlugs(file) {
  const counts = new Map();
  return [...readFileSync(file, 'utf8').matchAll(/^#{1,6}\s+(.+)$/gm)].map(match => {
    let slug = match[1]
      .toLowerCase()
      .replace(/<[^>]+>/g, '')
      .replace(/[`*_~]/g, '')
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/\s+/g, '-');
    const duplicate = counts.get(slug) ?? 0;
    counts.set(slug, duplicate + 1);
    if (duplicate) slug += `-${duplicate}`;
    return slug;
  });
}

const files = ['README.md', ...markdownFiles('docs')];
const headings = new Map();
const failures = [];

// ---- Generated indexes -------------------------------------------------------------------

const pageLine = /^<!--\s*page:\s*([^|]+?)\s*\|\s*(\d+)\s*\|\s*(.+?)\s*-->\s*$/m;
const indexBlock = /^(<!--\s*index:\s*([^|]+?)\s*\|\s*(.+?)\s*-->)\n([\s\S]*?)(^<!--\s*\/index\s*-->)/m;

function pageEntry(file) {
  const content = readFileSync(file, 'utf8');
  const meta = content.slice(0, 500).match(pageLine);
  if (!meta) return null;
  const title = content.match(/^#\s+(.+)$/m)?.[1];
  if (!title) failures.push(`${file}: an indexed page needs a level-one heading`);
  return { file, section: meta[1], order: Number(meta[2]), summary: meta[3], title: title ?? file };
}

function renderIndex(indexFile, directories, sections) {
  const pages = directories.flatMap(directory => readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
    .map(entry => join(directory, entry.name)))
    .filter(file => file !== indexFile)
    .map(pageEntry).filter(Boolean);
  for (const page of pages) if (!sections.includes(page.section)) failures.push(`${page.file}: section "${page.section}" is not listed by the index in ${indexFile}`);
  const listed = new Set(pages.map(page => page.file));
  for (const directory of directories) for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (!entry.isFile() || !entry.name.endsWith('.md') || file === indexFile || listed.has(file)) continue;
    if (!indexBlock.test(readFileSync(file, 'utf8'))) failures.push(`${file}: add a <!-- page: Section | order | summary --> line so ${indexFile} lists it`);
  }
  return sections.map((section, position) => {
    const entries = pages.filter(page => page.section === section).sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
    if (!entries.length) failures.push(`${indexFile}: section "${section}" lists no pages`);
    const lines = entries.map((page, index) => `${position === 0 ? `${index + 1}.` : '-'} [${page.title}](${relative(dirname(indexFile), page.file)}) — ${page.summary}`);
    return `## ${section}\n\n${lines.join('\n')}\n`;
  }).join('\n');
}

for (const file of files) {
  const content = readFileSync(file, 'utf8');
  const block = content.match(indexBlock);
  if (!block) continue;
  const directories = block[2].split(',').map(part => part.trim()).filter(Boolean);
  const sections = block[3].split(';').map(part => part.trim()).filter(Boolean);
  const generated = `\n${renderIndex(file, directories, sections)}`;
  if (block[4] === generated) continue;
  if (!write) { failures.push(`${file}: the generated index is stale; run npm run docs:check -- --write`); continue; }
  writeFileSync(file, content.replace(indexBlock, () => `${block[1]}\n${generated}${block[5]}`));
  console.log(`Regenerated the index in ${file}`);
}

// ---- Links and anchors -------------------------------------------------------------------

for (const file of files) {
  const content = readFileSync(file, 'utf8');
  for (const match of content.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const link = match[1];
    if (/^(https?:|mailto:)/.test(link)) continue;
    const hash = link.indexOf('#');
    const target = hash < 0 ? link : link.slice(0, hash);
    const anchor = hash < 0 ? '' : link.slice(hash + 1).toLowerCase();
    const destination = target.startsWith('/docs/')
      ? resolve(`${target.slice(1)}${target.endsWith('.md') ? '' : '.md'}`)
      : resolve(dirname(file), target || file.split('/').at(-1));
    try {
      if (!statSync(destination).isFile()) throw new Error('not a file');
    } catch {
      failures.push(`${file}: missing ${link}`);
      continue;
    }
    if (anchor) {
      if (!headings.has(destination)) headings.set(destination, headingSlugs(destination));
      if (!headings.get(destination).includes(anchor)) failures.push(`${file}: missing anchor ${link}`);
    }
  }
}

// The one-command install is the documented primary path. These rules keep it that way:
// no guide may lead with a manual provisioning sequence, and the manual steps that remain
// live in one clearly labelled fallback beside the variables table.
const ONE_COMMAND = 'install --provider';
const MANUAL_MARKERS = [
  /scripts\/provision-railway\.mjs/g,
  /railway init\b/g,
  /railway add\b/g,
  /railway up\b/g,
  /railway variables?\b/g,
  /hcloud server create\b/g,
  /docker compose --profile full\b/g,
];
const SETUP_DOCS = /\(((?:docs\/)?(?:install|onboarding|quickstart|deployment)\.md)[^)]*\)/;
const FALLBACK_FILE = 'docs/deployment.md';
const FALLBACK_HEADING = '## Manual fallback';

const primary = [
  { file: 'README.md', link: 'docs/install.md', contains: [ONE_COMMAND, 'docs/install.md) is the primary install path'] },
  { file: 'docs/README.md', link: 'install.md', contains: [] },
  { file: 'docs/onboarding.md', link: 'install.md', contains: [ONE_COMMAND] },
  { file: 'docs/quickstart.md', link: 'install.md', contains: ['install --provider compose'] },
  { file: FALLBACK_FILE, link: 'install.md', contains: [ONE_COMMAND] },
];

const installFailures = [];
let runbook = '';
try {
  runbook = readFileSync('docs/install.md', 'utf8');
} catch {
  installFailures.push('docs/install.md: the primary install runbook is missing');
}

if (runbook) {
  const headings = [...runbook.matchAll(/^#{2,3}\s+(.+)$/gm)].map(match => match[1]);
  const needs = [[/precondition/i, 'preconditions'], [/hard rule|secret/i, 'secret rules'], [/failure/i, 'failure handling'], [/manual fallback/i, 'a manual fallback pointer']];
  for (const [pattern, label] of needs) {
    if (!headings.some(heading => pattern.test(heading))) installFailures.push(`docs/install.md: no section covering ${label}`);
  }
  const steps = headings.filter(heading => /^step \d/i.test(heading));
  if (steps.length < 3) installFailures.push(`docs/install.md: expected numbered steps with exact commands, found ${steps.length}`);
  for (const required of [ONE_COMMAND, '--plan', '--apply', 'railway', 'hetzner', 'docker-host', 'compose', '0600', 'idempotent', 'Verify']) {
    if (!runbook.includes(required)) installFailures.push(`docs/install.md: missing required content "${required}"`);
  }
}

for (const file of files) {
  const content = readFileSync(file, 'utf8');
  const relative = file.replace(`${process.cwd()}/`, '');
  const rule = primary.find(entry => entry.file === relative);
  const command = content.indexOf(ONE_COMMAND);
  const fallback = relative === FALLBACK_FILE ? content.indexOf(FALLBACK_HEADING) : -1;
  for (const marker of MANUAL_MARKERS) {
    for (const match of content.matchAll(marker)) {
      if (relative === FALLBACK_FILE) {
        if (fallback < 0 || match.index < fallback) installFailures.push(`${relative}: "${match[0]}" appears outside the labelled manual fallback`);
      } else if (!rule) {
        installFailures.push(`${relative}: stale manual provisioning step "${match[0]}"; link to docs/install.md instead`);
      } else if (command < 0 || match.index < command) {
        installFailures.push(`${relative}: "${match[0]}" precedes the one-command install path`);
      }
    }
  }
  if (!rule) continue;
  if (!content.includes(`(${rule.link}`)) installFailures.push(`${relative}: must link to ${rule.link}`);
  for (const required of rule.contains) if (!content.includes(required)) installFailures.push(`${relative}: must document "${required}"`);
  const firstSetupLink = SETUP_DOCS.exec(content)?.[1];
  if (relative !== 'docs/install.md' && firstSetupLink && firstSetupLink !== rule.link) {
    installFailures.push(`${relative}: the first setup link is ${firstSetupLink}; the one-command path must come first`);
  }
}

const deployment = readFileSync(FALLBACK_FILE, 'utf8');
if (!deployment.includes(FALLBACK_HEADING)) installFailures.push(`${FALLBACK_FILE}: the manual path must be labelled "${FALLBACK_HEADING}"`);
if (!/^\|\s*`GRAPHYARD_PRINCIPALS`\s*\|/m.test(deployment)) installFailures.push(`${FALLBACK_FILE}: the variables table must document GRAPHYARD_PRINCIPALS`);
if (!/variables listed above|variables table/.test(deployment.slice(deployment.indexOf(FALLBACK_HEADING)))) installFailures.push(`${FALLBACK_FILE}: the manual fallback must point at the variables table`);

failures.push(...installFailures);

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log(`Checked ${files.length} Markdown files; all relative links, anchors and generated indexes resolve, and the one-command install path leads every setup guide.`);
