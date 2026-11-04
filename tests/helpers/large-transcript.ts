import { open } from 'node:fs/promises';

/** Real >2 GiB native-file boundary with bounded allocated storage and row size.
 * Sparse padding is malformed JSONL (as an interrupted native write can be); meaningful
 * native rows on both sides must still be parsed and every padding byte retained. */
export async function largeTranscript(path: string, first: object[], last: object[]) {
  const file = await open(path, 'w');
  try {
    await file.write(first.map(row => JSON.stringify(row)).join('\n') + '\n', 0, 'utf8');
    const size = 2 ** 31 + 1024;
    for (let offset = 1024 * 1024; offset < size; offset += 1024 * 1024) await file.write('\n', offset, 'utf8');
    await file.write('\n' + last.map(row => JSON.stringify(row)).join('\n'), size, 'utf8');
  } finally { await file.close(); }
}
