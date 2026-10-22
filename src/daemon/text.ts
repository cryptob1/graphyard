// Concern: the wording of a loop action's detail — bounded, compared and listing paths.
import { actionDetailMax } from './state.js';

/**
 * An action detail within its bound. A detail that lists paths — or quotes an error that does — is cut, never left to fail record()
 * after the action it records has already happened. record() applies it to every detail it stores.
 */
export function boundDetail(detail: string, max = actionDetailMax): string {
  return detail.length <= max ? detail : `${detail.slice(0, max - 1)}…`;
}

/**
 * Whether a detail differs from the one an action already stores. record() stores the bounded form,
 * so a stable detail over the bound compares equal and is not re-recorded every cycle (GY-179).
 */
export function detailChanged(previous: { detail: string } | undefined, detail: string): boolean {
  return previous?.detail !== boundDetail(detail);
}

/** Paths named in a detail: every one while short, else the first few and a count of the rest. */
export function namePaths(paths: readonly string[], room = 600): string {
  const named: string[] = [];
  let used = 0;
  for (const path of paths) {
    const text = path.length > 200 ? `${path.slice(0, 199)}…` : path;
    if (named.length && used + text.length + 2 > room) break;
    named.push(text);
    used += text.length + 2;
  }
  const more = paths.length - named.length;
  return `${paths.length} file${paths.length === 1 ? '' : 's'} (${named.join(', ')}${more ? ` and ${more} more` : ''})`;
}
