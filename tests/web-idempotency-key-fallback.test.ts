import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// GY-1661 AC-3: a page served over plain http is not a secure context, so crypto.randomUUID is
// undefined there; the web app's API calls still carry a well-formed UUID Idempotency-Key. The
// entry module renders on import, so its key function is read from source and compiled alone.
const root = fileURLToPath(new URL('..', import.meta.url));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type KeySource = { randomUUID?: () => string; getRandomValues?: <T extends ArrayBufferView>(array: T) => T } | undefined;

async function loadKey(): Promise<{ source: string; idempotencyKey: (source?: KeySource) => string }> {
  const source = await readFile(join(root, 'web/main.tsx'), 'utf8');
  const start = source.indexOf('export function idempotencyKey(');
  assert.ok(start >= 0, 'web/main.tsx defines idempotencyKey');
  const end = source.indexOf('\n}\n', start);
  const body = source.slice(start, end + 3).replace(/^export /, '');
  const { outputText } = ts.transpileModule(`${body}\nreturn idempotencyKey;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } });
  return { source, idempotencyKey: new Function(outputText)() };
}

test('unit:web-idempotency-key-fallback — the API call sends idempotencyKey(), never crypto.randomUUID() directly', async () => {
  const { source } = await loadKey();
  assert.match(source, /'Idempotency-Key': idempotencyKey\(\)/);
  assert.doesNotMatch(source.replace(/export function idempotencyKey[\s\S]*?\n}\n/, ''), /crypto\.randomUUID\(\)/, 'no other call reaches randomUUID unguarded');
});

test('unit:web-idempotency-key-fallback — without crypto.randomUUID the key is still a well-formed version-4 UUID', async () => {
  const { idempotencyKey } = await loadKey();
  // A secure context: randomUUID is used as is.
  assert.equal(idempotencyKey({ randomUUID: () => '11111111-2222-4333-8444-555555555555' }), '11111111-2222-4333-8444-555555555555');
  // Plain http: no randomUUID, getRandomValues still there.
  const insecure = { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) } as KeySource;
  const keys = new Set<string>();
  for (let index = 0; index < 200; index++) { const key = idempotencyKey(insecure); assert.match(key, uuid); keys.add(key); }
  assert.equal(keys.size, 200, 'each call is a fresh key');
  // Extreme bytes still yield the version and variant nibbles.
  assert.match(idempotencyKey({ getRandomValues: <T extends ArrayBufferView>(array: T) => { new Uint8Array(array.buffer).fill(0xff); return array; } }), uuid);
  assert.match(idempotencyKey({ getRandomValues: <T extends ArrayBufferView>(array: T) => { new Uint8Array(array.buffer).fill(0); return array; } }), uuid);
  // No crypto at all.
  assert.match(idempotencyKey(null as unknown as KeySource), uuid);
  assert.match(idempotencyKey({}), uuid);
});
