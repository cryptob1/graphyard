// GY-3207: the Node major a checkout declares, and the PATH its install, build, test and serve
// commands run under so they get that major. A checkout declaring nothing runs as before.
import { readFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

const read = (root: string, file: string) => { try { return readFileSync(join(root, file), 'utf8'); } catch { return ''; } };
const lines = (text: string) => text.split('\n').map(line => line.replace(/#.*$/, '').trim()).filter(Boolean);
/** v22.1.0, 22, 22.x → 22; with `range`, ^22 and ~22.1 too. Anything else (lts/*, node, latest, >=22, *, ^22 || ^24) is no major. */
const major = (value: unknown, range = false): number | null => {
  const found = typeof value === 'string' ? (range ? /^[\^~]?v?(\d+)(?:\.\S*)?$/ : /^v?(\d+)(?:\.\S*)?$/).exec(value.trim()) : null;
  return found ? Number(found[1]) : null;
};
/** mise.toml's `[tools]` table: node = "22" or node = { version = "22" }. */
const miseNode = (text: string): string | undefined => {
  let table = '';
  for (const line of lines(text)) {
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) table = header[1]!.trim();
    else if (table === 'tools') {
      const node = /^(?:node|nodejs)\s*=\s*(?:\{\s*version\s*=\s*)?["']([^"']+)["']/.exec(line);
      if (node) return node[1];
    }
  }
};
const enginesNode = (text: string): unknown => { try { return JSON.parse(text)?.engines?.node; } catch { return undefined; } };

/**
 * The Node major the checkout pins, from the first of these that yields one: .nvmrc, .node-version,
 * mise.toml, .tool-versions, package.json engines.node. Null when none does.
 */
export function nodePin(root: string): number | null {
  return major(lines(read(root, '.nvmrc'))[0])
    ?? major(lines(read(root, '.node-version'))[0])
    ?? major(miseNode(read(root, 'mise.toml')))
    ?? major(lines(read(root, '.tool-versions')).map(line => /^(?:nodejs|node)\s+(\S+)/.exec(line)?.[1]).find(Boolean))
    ?? major(enginesNode(read(root, 'package.json')), true);
}

/**
 * Prints the path of a node of that major, fetched once into npm's cache (_npx) and reused from it.
 * `--package`, not `-p`: `npm exec -p` is npm's --parseable, which runs the package with `node -p …`
 * as its script. npm 12 runs an install script only for a package it is allowed for, and the node
 * package places its binary in one; npm 11 runs it regardless.
 */
export const nodeFetchArgv = (pin: number) => ['npm', 'exec', '--yes', '--allow-scripts=node', `--package=node@${pin}`, '--', 'node', '-p', 'process.execPath'];

/**
 * `path` with the pinned major's node first, or `path` itself when the checkout pins nothing or
 * the node `run` starts is already that major. `run` runs a command where the checkout's commands
 * run (the same sandbox, environment and npm cache) and answers its output; a fetch that fails throws.
 */
export async function pinnedNodePath(root: string, path: string | undefined, run: (command: string, args: string[]) => Promise<string>): Promise<string | undefined> {
  const pin = nodePin(root);
  if (pin === null) return path;
  if (major((await run('node', ['-p', 'process.versions.node'])).trim().split('\n').at(-1)) === pin) return path;
  const [command, ...args] = nodeFetchArgv(pin);
  const out = await run(command!, args);
  const node = out.split('\n').map(line => line.trim()).findLast(line => isAbsolute(line));
  if (!node) throw new Error(`node@${pin} could not be fetched: ${out.trim().slice(-500)}`);
  return [dirname(node), path].filter(Boolean).join(delimiter);
}
