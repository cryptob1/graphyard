import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

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

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log(`Checked ${files.length} Markdown files; all relative links and anchors resolve.`);
