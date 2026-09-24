import { parseArgs } from 'node:util';
import type { CloseInput } from '../model/closure.js';

export const closeUsage = 'Use master close GY-N REASON --duplicate-of GY-M | --superseded-by COMMIT|GY-M | --obsolete';
export const closeHelp = [
  '  master close GY-N REASON --duplicate-of GY-M | --superseded-by COMMIT|GY-M | --obsolete',
  '                                Close work that will never be delivered; refused under a live',
  '                                lease or merge execution, never counted as delivered',
];

/** `master close` arguments as the close route takes them: the item and exactly one closure kind. */
export function closeRequest(args: string[]): { key: string; body: CloseInput } {
  const { values, positionals } = parseArgs({ args, options: { 'duplicate-of': { type: 'string' }, 'superseded-by': { type: 'string' }, obsolete: { type: 'boolean' } }, allowPositionals: true });
  const [key, ...words] = positionals, reason = words.join(' ').trim();
  const kinds = [values['duplicate-of'] !== undefined, values['superseded-by'] !== undefined, !!values.obsolete].filter(Boolean).length;
  if (!key || !reason || kinds !== 1) throw new Error(closeUsage);
  const body: CloseInput = values.obsolete ? { kind: 'obsolete', reason }
    : values['duplicate-of'] !== undefined ? { kind: 'duplicate', reason, ref: values['duplicate-of'] }
    : { kind: 'superseded', reason, ref: values['superseded-by'] };
  return { key, body };
}
