import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fleetRequestTimeoutMs } from '../src/fleet.js';

test('unit:registry-request-outlasts-lock-queue — a registry request waits 30 s, so a selection queued behind the coordination lock is not abandoned while the server completes it', () => {
  // 2026-10-01: 45 of 46 selects were abandoned at a 10 s bound; each still completed server-side and left a phantom live session.
  assert.ok(fleetRequestTimeoutMs >= 30_000, 'the registry request bound covers the coordination lock queue');
  // Every registry client takes that bound: heldAwareProbe built its own with a literal 10 s, which kept
  // every dispatch failing while any account was held spent.
  // A literal is refused however it is passed (GY-1042): as a fallback (`?? 10_000`), as the third
  // argument itself (`httpFleetClient(cfg, fetch, 10_000)`), or as a request's `timeoutMs: 10_000`.
  const sources = execFileSync('grep', ['-rlE', 'httpFleetClient\\(|fleetRequest\\(', fileURLToPath(new URL('../src', import.meta.url))], { encoding: 'utf8' }).trim().split('\n');
  const literal = /^\s*(?:[^,]*\?\?\s*)?\d[\d_]*(?:\s*\*\s*\d[\d_]*)*\s*$/;
  for (const file of sources) {
    const text = readFileSync(file, 'utf8');
    for (const call of fleetCalls(text, 'httpFleetClient')) assert.doesNotMatch(call[2] ?? '', literal, `${file} passes a literal timeout to httpFleetClient: ${call.join(', ')}`);
    for (const call of fleetCalls(text, 'fleetRequest')) assert.doesNotMatch(call.slice(2).join(', '), /\btimeoutMs\s*:\s*(?:[^,}]*\?\?\s*)?\d/, `${file} passes a literal timeoutMs to fleetRequest: ${call.join(', ')}`);
  }
  // The guard itself refuses each form.
  assert.match(fleetCalls('httpFleetClient(cfg, fetch, 10_000);', 'httpFleetClient')[0][2], literal);
  assert.match(fleetCalls('httpFleetClient(cfg, fetch, probe.timeoutMs ?? 10_000);', 'httpFleetClient')[0][2], literal);
  assert.doesNotMatch(fleetCalls('httpFleetClient(cfg, fetch, probe.timeoutMs ?? fleetRequestTimeoutMs);', 'httpFleetClient')[0][2], literal);
  assert.match(fleetCalls("fleetRequest(cfg, 'x', { fetch, timeoutMs: 10_000 });", 'fleetRequest')[0].slice(2).join(', '), /\btimeoutMs\s*:\s*(?:[^,}]*\?\?\s*)?\d/);
});

/** Each call of `name` in `text`, as its top-level arguments' source text (nested brackets and strings kept whole); a declaration is skipped. */
function fleetCalls(text: string, name: string): string[][] {
  const calls: string[][] = [];
  for (const match of text.matchAll(new RegExp(`\\b${name}\\(`, 'g'))) {
    if (/function\s+$/.test(text.slice(Math.max(0, match.index! - 20), match.index))) continue;
    const args: string[] = [];
    let depth = 0, quote: string | null = null, current = '';
    for (let index = match.index! + match[0].length; index < text.length; index++) {
      const char = text[index];
      if (quote) { current += char; if (char === '\\') current += text[++index]; else if (char === quote) quote = null; continue; }
      if (char === '\'' || char === '"' || char === '`') { quote = char; current += char; continue; }
      if ('([{'.includes(char)) depth++;
      if (')]}'.includes(char)) { if (depth === 0) { args.push(current.trim()); break; } depth--; }
      if (char === ',' && depth === 0) { args.push(current.trim()); current = ''; continue; }
      current += char;
    }
    calls.push(args);
  }
  return calls;
}
