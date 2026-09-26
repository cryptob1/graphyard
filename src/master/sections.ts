// Concern: `master status` degrading per section (GY-422) instead of failing whole.

/**
 * A section of the report that could not be built: which one, the server route it reads, and the
 * error that route answered with (a failure or a timeout, in the reader's own words).
 */
export interface UnavailableSection { section: string; route: string | null; error: string }

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * The optional sections of one report build. On 2026-09-25 `master status` returned nothing twice
 * because one route behind one panel timed out: a report is the whole fleet's view, and a panel
 * that cannot be read is named as unavailable, with its route and the error, while every other
 * section is still built. The snapshot the report is derived from is not optional; everything read
 * beside it is.
 */
export class ReportSections {
  readonly unavailable: UnavailableSection[] = [];
  /** Record `section` as unavailable, once, however many readers noticed. */
  mark(section: string, route: string | null, error: unknown) {
    if (!this.unavailable.some(entry => entry.section === section)) this.unavailable.push({ section, route, error: message(error) });
  }
  /** `read`, or — when it throws — `fallback`, with the section marked unavailable. */
  async optional<T>(section: string, route: string | null, read: () => Promise<T>, fallback: (error: string) => T): Promise<T> {
    try { return await read(); } catch (error) { this.mark(section, route, error); return fallback(message(error)); }
  }
}
